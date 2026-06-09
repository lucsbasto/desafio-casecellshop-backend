import { randomUUID } from 'node:crypto';
import { ErpPort } from '../../application/ports/erp.port';
import { Order } from '../../domain/order';

export interface FakeErpOptions {
  failRate: number; // 0..1
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Injeção determinística para testes (sem aleatoriedade). */
  random?: () => number;
}

export class ErpInvoiceError extends Error {
  constructor(orderId: string) {
    super(`ERP falhou ao faturar o pedido ${orderId}`);
    this.name = 'ErpInvoiceError';
  }
}

/**
 * ERP simulado: latência alta e falhas intermitentes — reproduz o ofensor #3 do
 * case ("API do ERP demora para faturar"). Usado pelo worker com retry/backoff.
 */
export class FakeErpClient implements ErpPort {
  private readonly random: () => number;

  constructor(private readonly opts: FakeErpOptions) {
    this.random = opts.random ?? Math.random;
  }

  async invoice(order: Order): Promise<{ erpInvoiceId: string }> {
    const span = this.opts.maxLatencyMs - this.opts.minLatencyMs;
    const latency = this.opts.minLatencyMs + Math.floor(this.random() * Math.max(0, span));
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));

    if (this.random() < this.opts.failRate) {
      throw new ErpInvoiceError(order.id);
    }
    return { erpInvoiceId: `ERP-${randomUUID().slice(0, 8)}` };
  }
}
