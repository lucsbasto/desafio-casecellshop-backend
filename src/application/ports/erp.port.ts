import { Order } from '../../domain/order';

export const ERP_PORT = Symbol('ERP_PORT');

/**
 * Cliente do ERP central (faturamento). Aqui é um fake que simula latência alta
 * e falhas intermitentes — o ofensor #3 do case (ERP demora para faturar).
 */
export interface ErpPort {
  /** Fatura o pedido no ERP. Lança em caso de falha (timeout/erro do ERP). */
  invoice(order: Order): Promise<{ erpInvoiceId: string }>;
}
