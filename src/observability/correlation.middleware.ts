import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { CORRELATION_HEADER, runWithCorrelation } from './correlation';

/**
 * Inicia o AsyncLocalStorage de correlação para cada request, garantindo que
 * logs, métricas e spans dentro do mesmo request compartilhem o correlationId.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Alinha com o req.id gerado pelo pino-http (que já lê o header ou cria um),
    // garantindo o mesmo correlationId em logs, métricas e spans.
    const fromPino = (req as Request & { id?: string }).id;
    const correlationId =
      fromPino || (req.headers[CORRELATION_HEADER] as string) || randomUUID();
    res.setHeader(CORRELATION_HEADER, correlationId);
    runWithCorrelation({ correlationId }, () => next());
  }
}
