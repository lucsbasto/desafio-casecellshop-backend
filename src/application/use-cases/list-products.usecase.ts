import { Inject, Injectable } from '@nestjs/common';
import { ProductNotFoundError } from '../../domain/errors';
import { Product, ProductView, toProductView } from '../../domain/product';
import { APP_CONFIG, AppConfig } from '../../infrastructure/config/app-config';
import { MetricsService } from '../../observability/metrics.service';
import { TracingService } from '../../observability/tracing.service';
import { CACHE_PORT, CachePort } from '../ports/cache.port';
import { PRODUCT_REPO_PORT, ProductRepositoryPort } from '../ports/repository.port';
import { STOCK_PORT, StockPort } from '../ports/stock.port';

const ALL_KEY = 'products:all';
const ONE_KEY = (id: string) => `products:${id}`;

/**
 * Storefront: reads products via cache-aside (TTL + single-flight) over the "fake ERP".
 * Records cache hit/miss and serves stale on ERP failure (fallback).
 *
 * Availability is intentionally NOT taken from the cached catalog snapshot: the
 * slow/immutable catalog (name/price) is cached, but `stock` is overlaid LIVE from
 * the reservation ledger (StockPort) on every read. This prevents the storefront
 * from advertising stock that has already been reserved/sold (stale availability)
 * and makes releases (failed orders) visible immediately — without weakening the
 * cache gain on the expensive catalog fetch.
 */
@Injectable()
export class ListProductsUseCase {
  constructor(
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(PRODUCT_REPO_PORT) private readonly repo: ProductRepositoryPort,
    @Inject(STOCK_PORT) private readonly stock: StockPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
    private readonly tracing: TracingService,
  ) {}

  /**
   * Semantic TTL for product reads. Stampede jitter is applied by the cache
   * adapter (infra concern), so the use case passes the plain configured TTL.
   */
  private ttl(): number {
    return this.config.cache.productsTtlMs;
  }

  async listAll(): Promise<ProductView[]> {
    const span = this.tracing.startSpan('cache.get', { key: ALL_KEY });
    const { value, hit, stale } = await this.cache.getOrLoad(
      ALL_KEY,
      this.ttl(),
      () => this.tracing.withSpan('erp.fetch', () => this.repo.findAll()),
      { staleOnError: true },
    );
    span.end({ hit, stale });
    this.metrics.cacheRequests.inc({ result: stale ? 'stale' : hit ? 'hit' : 'miss' });
    return Promise.all(value.map((p) => this.withLiveStock(p)));
  }

  async getById(id: string): Promise<ProductView> {
    const { value, hit, stale } = await this.cache.getOrLoad(
      ONE_KEY(id),
      this.ttl(),
      () => this.repo.findById(id),
      { staleOnError: true },
    );
    this.metrics.cacheRequests.inc({ result: stale ? 'stale' : hit ? 'hit' : 'miss' });
    if (!value) throw new ProductNotFoundError(id);
    return this.withLiveStock(value);
  }

  /** Overlays the live reservation-ledger balance onto a cached catalog entry. */
  private async withLiveStock(product: Product): Promise<ProductView> {
    const stock = await this.stock.get(product.id);
    return toProductView({ ...product, stock });
  }
}
