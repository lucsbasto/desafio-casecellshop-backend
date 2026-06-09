import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { DuplicateRequestError } from '../../../application/use-cases/checkout.usecase';
import {
  DomainError,
  InsufficientStockError,
  InvalidOrderTransitionError,
  OrderNotFoundError,
  ProductNotFoundError,
} from '../../../domain/errors';
import { getCorrelationId } from '../../../observability/correlation';
import { ErrorDto } from '../dto/error.dto';

/** Maps domain errors -> HTTP status, keeping the domain agnostic of HTTP. */
function statusFor(err: unknown): number {
  if (err instanceof ProductNotFoundError || err instanceof OrderNotFoundError) {
    return HttpStatus.NOT_FOUND;
  }
  if (
    err instanceof InsufficientStockError ||
    err instanceof InvalidOrderTransitionError ||
    err instanceof DuplicateRequestError
  ) {
    return HttpStatus.CONFLICT;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const correlationId = getCorrelationId() ?? 'unknown';

    let statusCode: number;
    let error: string;
    let message: string;

    if (exception instanceof HttpException) {
      // Framework errors (class-validator validation => 400, etc.).
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      error = exception.name;
      message =
        typeof body === 'string'
          ? body
          : Array.isArray((body as { message?: unknown }).message)
            ? (body as { message: string[] }).message.join('; ')
            : ((body as { message?: string }).message ?? exception.message);
    } else if (exception instanceof DomainError || exception instanceof DuplicateRequestError) {
      statusCode = statusFor(exception);
      error = (exception as DomainError).code ?? exception.name;
      message = (exception as Error).message;
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      error = 'INTERNAL_ERROR';
      message = 'Erro interno inesperado';
      // Non-Error throws (e.g. `throw { ... }`) have no .stack; serialize them so
      // the log keeps useful context instead of `undefined`.
      if (exception instanceof Error) {
        this.logger.error(`Erro não tratado: ${exception.message}`, exception.stack);
      } else {
        this.logger.error(`Erro não tratado (não-Error): ${JSON.stringify(exception)}`);
      }
    }

    const payload: ErrorDto = {
      statusCode,
      error,
      message,
      correlationId,
      timestamp: new Date().toISOString(),
    };
    res.status(statusCode).json(payload);
  }
}
