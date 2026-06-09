import { Order } from '../../domain/order';

export const ERP_PORT = Symbol('ERP_PORT');

/**
 * Central ERP client (billing). Here it is a fake that simulates high latency
 * and intermittent failures — offender #3 in the case study (ERP is slow to invoice).
 */
export interface ErpPort {
  /** Invoices the order in the ERP. Throws on failure (timeout/ERP error). */
  invoice(order: Order): Promise<{ erpInvoiceId: string }>;
}
