import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CORRELATION_HEADER } from './correlation';

/**
 * Configuração do nestjs-pino: logs estruturados em JSON com correlationId.
 * Em dev usa pino-pretty; em produção, JSON puro (ideal para Datadog/coletores).
 */
export function buildLoggerParams(serviceName: string, level: string, env: string): Params {
  const isDev = env !== 'production';
  return {
    pinoHttp: {
      level,
      base: { service: serviceName },
      // Gera/propaga o correlationId e o expõe no header da resposta.
      genReqId: (req: IncomingMessage, res: ServerResponse): string => {
        const incoming = (req.headers[CORRELATION_HEADER] as string) || randomUUID();
        res.setHeader(CORRELATION_HEADER, incoming);
        return incoming;
      },
      customProps: (req: IncomingMessage) => ({
        correlationId: (req as IncomingMessage & { id?: string }).id,
      }),
      // Reduz ruído: health/metrics não precisam de log de request.
      autoLogging: {
        ignore: (req: IncomingMessage) =>
          req.url === '/metrics' || req.url === '/health',
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
