import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import { CORRELATION_HEADER } from './correlation';

/**
 * nestjs-pino configuration: structured JSON logs with correlationId.
 * Uses pino-pretty in dev; pure JSON in production (ideal for Datadog/collectors).
 */
export function buildLoggerParams(serviceName: string, level: string, env: string): Params {
  const isDev = env !== 'production';
  return {
    pinoHttp: {
      level,
      base: { service: serviceName },
      // Single source of truth for the correlationId. If the middleware already
      // set req.id, reuse it; otherwise read the header or mint a new UUID. This
      // keeps logs and the response header aligned regardless of execution order.
      genReqId: (req: IncomingMessage, res: ServerResponse): string => {
        const existing = (req as IncomingMessage & { id?: string }).id;
        const id = existing || (req.headers[CORRELATION_HEADER] as string) || randomUUID();
        res.setHeader(CORRELATION_HEADER, id);
        return id;
      },
      customProps: (req: IncomingMessage) => ({
        correlationId: (req as IncomingMessage & { id?: string }).id,
      }),
      // Reduces noise: health/metrics endpoints do not need request logging.
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === '/metrics' || req.url === '/health',
      },
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      transport: isDev
        ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
        : undefined,
    },
  };
}
