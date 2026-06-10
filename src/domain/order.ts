import { InvalidOrderTransitionError } from './errors';

export enum OrderStatus {
  /** Order created and stock reserved; waiting for worker processing. */
  PENDING = 'PENDING',
  /** Worker picked up the job and is invoicing in the ERP. */
  PROCESSING = 'PROCESSING',
  /** ERP invoiced successfully. Happy final state. */
  CONFIRMED = 'CONFIRMED',
  /** ERP retries exhausted; stock reservation compensated. Final state. */
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
  /** Processing attempts already made by the worker (observability/reconciliation). */
  attempts: number;
}

/** Valid state machine transitions. */
const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.FAILED],
  // PROCESSING never goes back to PENDING: that would let reconciliation
  // re-enqueue an order that already has an active worker job (double-processing).
  [OrderStatus.PROCESSING]: [OrderStatus.CONFIRMED, OrderStatus.FAILED],
  [OrderStatus.CONFIRMED]: [],
  [OrderStatus.FAILED]: [],
};

export function isTerminal(status: OrderStatus): boolean {
  return status === OrderStatus.CONFIRMED || status === OrderStatus.FAILED;
}

/**
 * Builds a fresh PENDING order with its initial history entry. Centralizes the
 * "newborn order" shape (status, seed history, zeroed attempts) in the domain
 * instead of inlining the literal in the checkout use case.
 */
export function createPendingOrder(params: {
  id: string;
  items: OrderItem[];
  idempotencyKey: string;
  totalCents: number;
  now: string;
}): Order {
  const { id, items, idempotencyKey, totalCents, now } = params;
  return {
    id,
    items,
    status: OrderStatus.PENDING,
    history: [{ status: OrderStatus.PENDING, at: now }],
    idempotencyKey,
    totalCents,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

/**
 * Applies a status transition by validating the state machine.
 * Pure function: returns a new Order, does not mutate the original.
 */
export function transition(order: Order, to: OrderStatus, at: string, reason?: string): Order {
  if (order.status === to) return order; // idempotent: already at the target status
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
