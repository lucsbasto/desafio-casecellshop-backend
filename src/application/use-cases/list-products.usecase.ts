import { Inject, Injectable } from '@nestjs/common';
import { CACHE_PORT, CachePort } from '../ports/cache.port';
import {
  PRODUCT_REPO_PORT,
  ProductRepositoryPort,
} from '../ports/repository.port';
import { ProductNotFoundError } from '../../domain/errors';
import { ProductView, toProductView } from '../../domain/product';
import { MetricsService } from '../../observability/metrics.service';
import { TracingService } from '../../observability/tracing.service';
import { APP_CONFIG, AppConfig } from '../../infrastructure/config/app-config';

const ALL_KEY = 'products:all';
const ONE_KEY = (id: string) => `products:${id}`;

/**
 * Vitrine: lê produtos via cache-aside (TTL + single-flight) sobre o "ERP fake".
 * Registra cache hit/miss e serve stale em caso de falha do ERP (fallback).
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

  private ttl(): number {
    // Jitter no TTL para espalhar expirações e mitigar stampede.
    const base = this.config.cache.productsTtlMs;
    const jitter = Math.floor(Math.random() * this.config.cache.stampedeJitterMs);
    return base + jitter;
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
