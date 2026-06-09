import { AsyncLocalStorage } from 'node:async_hooks';

export interface CorrelationStore {
  correlationId: string;
  orderId?: string;
}

/**
 * Propagates the correlationId (and orderId when present) throughout the entire async chain
 * — HTTP request and also the worker — without needing to pass it as a parameter.
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
