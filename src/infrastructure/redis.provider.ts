import { Provider, Logger } from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from './config/app-config';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

function anyRedisDriver(cfg: AppConfig): boolean {
  return Object.values(cfg.drivers).some((d) => d === 'redis');
}

/**
 * Provê uma conexão ioredis somente quando algum driver=redis. Caso contrário,
 * retorna null (modo in-memory, sem dependência de Redis — roda sem Docker).
 * `maxRetriesPerRequest: null` é requisito do BullMQ.
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
