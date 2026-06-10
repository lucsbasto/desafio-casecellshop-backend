import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import {
  DuplicateRequestError,
  InsufficientStockError,
  InvalidOrderTransitionError,
  OrderNotFoundError,
  ProductNotFoundError,
} from '../../../domain/errors';
import { ErrorDto } from '../dto/error.dto';
import { DomainExceptionFilter } from './domain-exception.filter';

/**
 * Characterization tests: pin the current HTTP mapping of the exception filter
 * before refactoring DuplicateRequestError into the DomainError hierarchy.
 */
describe('DomainExceptionFilter', () => {
  const filter = new DomainExceptionFilter();

  function run(exception: unknown): { status: number; body: ErrorDto } {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const res = { status, json } as unknown as Response;
    const host = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ArgumentsHost;

    filter.catch(exception, host);
    return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
  }

  it('DuplicateRequestError => 409 com code DUPLICATE_REQUEST', () => {
    const { status, body } = run(new DuplicateRequestError());
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body.error).toBe('DUPLICATE_REQUEST');
    expect(body.message).toContain('duplicada');
  });

  it('InsufficientStockError => 409 com code INSUFFICIENT_STOCK', () => {
    const { status, body } = run(new InsufficientStockError('CAPA-001'));
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body.error).toBe('INSUFFICIENT_STOCK');
  });

  it('InvalidOrderTransitionError => 409', () => {
    const { status, body } = run(new InvalidOrderTransitionError('CONFIRMED', 'PENDING'));
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body.error).toBe('INVALID_ORDER_TRANSITION');
  });

  it('ProductNotFoundError => 404', () => {
    const { status, body } = run(new ProductNotFoundError('NOPE'));
    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(body.error).toBe('PRODUCT_NOT_FOUND');
  });

  it('OrderNotFoundError => 404', () => {
    const { status, body } = run(new OrderNotFoundError('NOPE'));
    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(body.error).toBe('ORDER_NOT_FOUND');
  });

  it('HttpException com message array => junta com "; "', () => {
    const ex = new HttpException(
      { message: ['campo a inválido', 'campo b inválido'] },
      HttpStatus.BAD_REQUEST,
    );
    const { status, body } = run(ex);
    expect(status).toBe(HttpStatus.BAD_REQUEST);
    expect(body.message).toBe('campo a inválido; campo b inválido');
  });

  it('Error genérico => 500 INTERNAL_ERROR com mensagem fixa', () => {
    const { status, body } = run(new Error('boom interno'));
    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('Erro interno inesperado');
  });

  it('throw não-Error => 500 INTERNAL_ERROR', () => {
    const { status, body } = run({ foo: 1 });
    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.error).toBe('INTERNAL_ERROR');
  });

  it('payload sempre inclui correlationId e timestamp', () => {
    const { body } = run(new ProductNotFoundError('X'));
    expect(body.correlationId).toBe('unknown');
    expect(typeof body.timestamp).toBe('string');
  });
});
