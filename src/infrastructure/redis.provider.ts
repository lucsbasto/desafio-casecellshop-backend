import { Inject, Injectable, Logger, OnModuleDestroy, Provider } from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from './config/app-config';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

function anyRedisDriver(cfg: AppConfig): boolean {
  return Object.values(cfg.drivers).some((d) => d === 'redis');
}

/**
 * Provides an ioredis connection only when at least one driver=redis. Otherwise,
 * returns null (in-memory mode, no Redis dependency — runs without Docker).
 * `maxRetriesPerRequest: null` is required by BullMQ.
 */
export const RedisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): Redis | null => {
    if (!anyRedisDriver(config)) return null;
    const logger = new Logger('RedisProvider');
    const client = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
    client.on('error', (err) => logger.error(`Redis: ${err.message}`));
    client.on('connect', () => logger.log(`Conectado ao Redis em ${config.redisUrl}`));
    return client;
  },
};

/**
 * Closes the shared ioredis connection on graceful shutdown so the process can
 * exit cleanly (and Jest doesn't warn about open handles). No-op in memory mode.
 * Requires `app.enableShutdownHooks()` in the bootstrap.
 */
@Injectable()
export class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis | null) {}

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit();
  }
}
