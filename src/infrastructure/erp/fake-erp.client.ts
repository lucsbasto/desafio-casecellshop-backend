import { randomUUID } from 'node:crypto';
import { ErpPort } from '../../application/ports/erp.port';
import { Order } from '../../domain/order';

export interface FakeErpOptions {
  failRate: number; // 0..1
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Deterministic injection for tests. Shared default for both draws below. */
  random?: () => number;
  /** Optional dedicated draws so latency and failure aren't correlated. */
  randomLatency?: () => number;
  randomFail?: () => number;
}

export class ErpInvoiceError extends Error {
  constructor(orderId: string) {
    super(`ERP falhou ao faturar o pedido ${orderId}`);
    this.name = 'ErpInvoiceError';
  }
}

/**
 * Simulated ERP: high latency and intermittent failures — reproduces offender #3 from
 * the case study ("ERP API takes too long to invoice"). Used by the worker with retry/backoff.
 */
export class FakeErpClient implements ErpPort {
  private readonly randomLatency: () => number;
  private readonly randomFail: () => number;

  constructor(private readonly opts: FakeErpOptions) {
    const shared = opts.random ?? Math.random;
    this.randomLatency = opts.randomLatency ?? shared;
    this.randomFail = opts.randomFail ?? shared;
  }

  async invoice(order: Order): Promise<{ erpInvoiceId: string }> {
    const span = this.opts.maxLatencyMs - this.opts.minLatencyMs;
    const latency = this.opts.minLatencyMs + Math.floor(this.randomLatency() * Math.max(0, span));
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));

    if (this.randomFail() < this.opts.failRate) {
      throw new ErpInvoiceError(order.id);
    }
    return { erpInvoiceId: `ERP-${randomUUID().slice(0, 8)}` };
  }
}
