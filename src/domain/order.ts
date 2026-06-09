import { InvalidOrderTransitionError } from './errors';

export enum OrderStatus {
  /** Pedido criado e estoque reservado; aguardando processamento do worker. */
  PENDING = 'PENDING',
  /** Worker pegou o job e está faturando no ERP. */
  PROCESSING = 'PROCESSING',
  /** ERP faturou com sucesso. Estado final feliz. */
  CONFIRMED = 'CONFIRMED',
  /** Esgotadas as tentativas no ERP; reserva de estoque compensada. Estado final. */
  FAILED = 'FAILED',
}

export interface OrderItem {
  productId: string;
  quantity: number;
}

export interface OrderTransition {
  status: OrderStatus;
  at: string; // ISO timestamp
  reason?: string;
}

export interface Order {
  id: string;
  items: OrderItem[];
  status: OrderStatus;
  history: OrderTransition[];
  idempotencyKey: string;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
  /** Tentativas de processamento já feitas pelo worker (observabilidade/reconciliação). */
  attempts: number;
}

/** Transições válidas da máquina de estados. */
const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.FAILED],
  [OrderStatus.PROCESSING]: [OrderStatus.CONFIRMED, OrderStatus.FAILED, OrderStatus.PENDING],
  [OrderStatus.CONFIRMED]: [],
  [OrderStatus.FAILED]: [],
};

export function isTerminal(status: OrderStatus): boolean {
  return status === OrderStatus.CONFIRMED || status === OrderStatus.FAILED;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

/**
 * Aplica uma transição de status validando a máquina de estados.
 * Função pura: devolve um novo Order, não muta o original.
 */
export function transition(order: Order, to: OrderStatus, at: string, reason?: string): Order {
  if (order.status === to) return order; // idempotente: já está no destino
  if (!canTransition(order.status, to)) {
    throw new InvalidOrderTransitionError(order.status, to);
  }
  return {
    ...order,
    status: to,
    updatedAt: at,
    history: [...order.history, { status: to, at, reason }],
  };
}
