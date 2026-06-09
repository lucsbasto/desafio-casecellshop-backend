/** Configuração central tipada, lida de variáveis de ambiente com defaults seguros. */
export type Driver = 'redis' | 'memory';

function str(key: string, def: string): string {
  return process.env[key] ?? def;
}
function num(key: string, def: number): number {
  const v = process.env[key];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}
function driver(key: string, def: Driver): Driver {
  return str(key, def) === 'redis' ? 'redis' : 'memory';
}

export interface AppConfig {
  port: number;
  env: string;
  serviceName: string;
  logLevel: string;
  drivers: {
    cache: Driver;
    queue: Driver;
    stock: Driver;
    idempotency: Driver;
  };
  redisUrl: string;
  cache: { productsTtlMs: number; stampedeJitterMs: number };
  worker: { maxAttempts: number; backoffMs: number };
  erp: { failRate: number; minLatencyMs: number; maxLatencyMs: number };
  reconcile: { ageMs: number; maxAgeMs: number };
  idempotencyTtlMs: number;
}

export function loadConfig(): AppConfig {
  return {
    port: num('PORT', 3000),
    env: str('NODE_ENV', 'development'),
    serviceName: str('SERVICE_NAME', 'casecellshop-backend'),
    logLevel: str('LOG_LEVEL', 'info'),
    drivers: {
      cache: driver('CACHE_DRIVER', 'memory'),
      queue: driver('QUEUE_DRIVER', 'memory'),
      stock: driver('STOCK_DRIVER', 'memory'),
      idempotency: driver('IDEMPOTENCY_DRIVER', 'memory'),
    },
    redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
    cache: {
      productsTtlMs: num('PRODUCTS_CACHE_TTL_MS', 15000),
      stampedeJitterMs: num('CACHE_STAMPEDE_JITTER_MS', 2000),
    },
    worker: {
      maxAttempts: num('WORKER_MAX_ATTEMPTS', 3),
      backoffMs: num('WORKER_BACKOFF_MS', 500),
    },
    erp: {
      failRate: num('ERP_FAIL_RATE', 0.3),
      minLatencyMs: num('ERP_MIN_LATENCY_MS', 50),
      maxLatencyMs: num('ERP_MAX_LATENCY_MS', 300),
    },
    reconcile: {
      ageMs: num('RECONCILE_AGE_MS', 10000),
      maxAgeMs: num('RECONCILE_MAX_AGE_MS', 60000),
    },
    idempotencyTtlMs: num('IDEMPOTENCY_TTL_MS', 86400000),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
