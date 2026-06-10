import { Inject, Injectable } from '@nestjs/common';
import { ProductNotFoundError } from '../../domain/errors';
import { ProductView, toProductView } from '../../domain/product';
import { APP_CONFIG, AppConfig } from '../../infrastructure/config/app-config';
import { MetricsService } from '../../observability/metrics.service';
import { TracingService } from '../../observability/tracing.service';
import { CACHE_PORT, CachePort } from '../ports/cache.port';
import { PRODUCT_REPO_PORT, ProductRepositoryPort } from '../ports/repository.port';

const ALL_KEY = 'products:all';
const ONE_KEY = (id: string) => `products:${id}`;

/**
 * Storefront: reads products via cache-aside (TTL + single-flight) over the "fake ERP".
 * Records cache hit/miss and serves stale on ERP failure (fallback).
 */
@Injectable()
export class ListProductsUseCase {
  constructor(
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(PRODUCT_REPO_PORT) private readonly repo: ProductRepositoryPort,
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
    return value.map(toProductView);
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
    return toProductView(value);
  }
}
