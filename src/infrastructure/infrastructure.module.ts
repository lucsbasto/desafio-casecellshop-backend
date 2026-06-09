import { Global, Module, Provider, Logger, OnModuleInit, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { APP_CONFIG, AppConfig, loadConfig } from './config/app-config';
import { REDIS_CLIENT, RedisProvider } from './redis.provider';

import { CACHE_PORT } from '../application/ports/cache.port';
import { STOCK_PORT, StockPort } from '../application/ports/stock.port';
import { IDEMPOTENCY_PORT } from '../application/ports/idempotency.port';
import { QUEUE_PORT } from '../application/ports/queue.port';
import {
  ORDER_REPO_PORT,
  PRODUCT_REPO_PORT,
  ProductRepositoryPort,
} from '../application/ports/repository.port';
import { ERP_PORT } from '../application/ports/erp.port';

import { InMemoryCacheAdapter } from './cache/in-memory-cache.adapter';
import { RedisCacheAdapter } from './cache/redis-cache.adapter';
import { InMemoryStockAdapter } from './stock/in-memory-stock.adapter';
import { RedisStockAdapter } from './stock/redis-stock.adapter';
import { InMemoryIdempotencyAdapter } from './idempotency/in-memory-idempotency.adapter';
import { RedisIdempotencyAdapter } from './idempotency/redis-idempotency.adapter';
import { InMemoryQueueAdapter } from './queue/in-memory-queue.adapter';
import { BullMqQueueAdapter } from './queue/bullmq-queue.adapter';
import { InMemoryProductRepository } from './repo/in-memory-product.repo';
import { InMemoryOrderRepository } from './repo/in-memory-order.repo';
import { FakeErpClient } from './erp/fake-erp.client';

const requireRedis = (redis: Redis | null): Redis => {
  if (!redis) throw new Error('Driver=redis selecionado mas a conexão Redis é nula');
  return redis;
};

const ConfigProvider: Provider = { provide: APP_CONFIG, useFactory: loadConfig };

const CacheProvider: Provider = {
  provide: CACHE_PORT,
  inject: [APP_CONFIG, REDIS_CLIENT],
  useFactory: (cfg: AppConfig, redis: Redis | null) =>
    cfg.drivers.cache === 'redis'
      ? new RedisCacheAdapter(requireRedis(redis))
      : new InMemoryCacheAdapter(),
};

const StockProvider: Provider = {
  provide: STOCK_PORT,
  inject: [APP_CONFIG, REDIS_CLIENT],
  useFactory: (cfg: AppConfig, redis: Redis | null) =>
    cfg.drivers.stock === 'redis'
      ? new RedisStockAdapter(requireRedis(redis))
      : new InMemoryStockAdapter(),
};

const IdempotencyProvider: Provider = {
  provide: IDEMPOTENCY_PORT,
  inject: [APP_CONFIG, REDIS_CLIENT],
  useFactory: (cfg: AppConfig, redis: Redis | null) =>
    cfg.drivers.idempotency === 'redis'
      ? new RedisIdempotencyAdapter(requireRedis(redis))
      : new InMemoryIdempotencyAdapter(),
};

const QueueProvider: Provider = {
  provide: QUEUE_PORT,
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) =>
    cfg.drivers.queue === 'redis'
      ? new BullMqQueueAdapter(cfg.redisUrl, {
          maxAttempts: cfg.worker.maxAttempts,
          backoffMs: cfg.worker.backoffMs,
        })
      : new InMemoryQueueAdapter({
          maxAttempts: cfg.worker.maxAttempts,
          backoffMs: cfg.worker.backoffMs,
        }),
};

const ProductRepoProvider: Provider = {
  provide: PRODUCT_REPO_PORT,
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) =>
    new InMemoryProductRepository(undefined, cfg.env === 'test' ? 0 : 40),
};

const OrderRepoProvider: Provider = {
  provide: ORDER_REPO_PORT,
  useFactory: () => new InMemoryOrderRepository(),
};

const ErpProvider: Provider = {
  provide: ERP_PORT,
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) =>
    new FakeErpClient({
      failRate: cfg.erp.failRate,
      minLatencyMs: cfg.erp.minLatencyMs,
      maxLatencyMs: cfg.erp.maxLatencyMs,
    }),
};

/**
 * Initializes stock from the product catalog (seed). In production the balance
 * would come from the read model synced with the ERP; here we seed on boot for the demo.
 */
class StockSeeder implements OnModuleInit {
  private readonly logger = new Logger(StockSeeder.name);
  constructor(
    @Inject(STOCK_PORT) private readonly stock: StockPort,
    @Inject(PRODUCT_REPO_PORT) private readonly products: ProductRepositoryPort,
  ) {}

  async onModuleInit(): Promise<void> {
    const all = await this.products.findAll();
    for (const p of all) await this.stock.init(p.id, p.stock);
    this.logger.log(`Estoque semeado para ${all.length} produtos`);
  }
}

const PROVIDERS: Provider[] = [
  ConfigProvider,
  RedisProvider,
  CacheProvider,
  StockProvider,
  IdempotencyProvider,
  QueueProvider,
  ProductRepoProvider,
  OrderRepoProvider,
  ErpProvider,
  StockSeeder,
];

@Global()
@Module({
  providers: PROVIDERS,
  exports: [
    APP_CONFIG,
    REDIS_CLIENT,
    CACHE_PORT,
    STOCK_PORT,
    IDEMPOTENCY_PORT,
    QUEUE_PORT,
    PRODUCT_REPO_PORT,
    ORDER_REPO_PORT,
    ERP_PORT,
  ],
})
export class InfrastructureModule {}
