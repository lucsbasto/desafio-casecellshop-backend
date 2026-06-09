import { AsyncLocalStorage } from 'node:async_hooks';

export interface CorrelationStore {
  correlationId: string;
  orderId?: string;
}

/**
 * Propaga o correlationId (e orderId quando existir) por toda a cadeia assíncrona
 * — request HTTP e também o worker — sem precisar passar por parâmetro.
 */
export const correlationStorage = new AsyncLocalStorage<CorrelationStore>();

export function runWithCorrelation<T>(store: CorrelationStore, fn: () => T): T {
  return correlationStorage.run(store, fn);
}

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

export function setOrderId(orderId: string): void {
  const store = correlationStorage.getStore();
  if (store) store.orderId = orderId;
}

export function getStore(): CorrelationStore | undefined {
  return correlationStorage.getStore();
}

export const CORRELATION_HEADER = 'x-correlation-id';
