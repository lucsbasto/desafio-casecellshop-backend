import {
  Order,
  OrderStatus,
  canTransition,
  isTerminal,
  transition,
} from './order';
import { InvalidOrderTransitionError } from './errors';

function makeOrder(status: OrderStatus): Order {
  const now = new Date().toISOString();
  return {
    id: 'o1',
    items: [{ productId: 'p1', quantity: 1 }],
    status,
    history: [{ status, at: now }],
    idempotencyKey: 'k1',
    totalCents: 100,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
}

describe('Order state machine', () => {
  it('permite PENDING -> PROCESSING -> CONFIRMED', () => {
    expect(canTransition(OrderStatus.PENDING, OrderStatus.PROCESSING)).toBe(true);
    expect(canTransition(OrderStatus.PROCESSING, OrderStatus.CONFIRMED)).toBe(true);
  });

  it('bloqueia transições inválidas (CONFIRMED é terminal)', () => {
    expect(canTransition(OrderStatus.CONFIRMED, OrderStatus.PROCESSING)).toBe(false);
    const confirmed = makeOrder(OrderStatus.CONFIRMED);
    expect(() =>
      transition(confirmed, OrderStatus.PROCESSING, new Date().toISOString()),
    ).toThrow(InvalidOrderTransitionError);
  });

  it('transição é idempotente quando já está no destino', () => {
    const o = makeOrder(OrderStatus.PROCESSING);
    const same = transition(o, OrderStatus.PROCESSING, new Date().toISOString());
    expect(same).toBe(o);
  });

  it('registra histórico e não muta o original', () => {
    const o = makeOrder(OrderStatus.PENDING);
    const next = transition(o, OrderStatus.PROCESSING, new Date().toISOString(), 'go');
    expect(next.status).toBe(OrderStatus.PROCESSING);
    expect(next.history).toHaveLength(2);
    expect(o.status).toBe(OrderStatus.PENDING); // immutable
  });

  it('isTerminal reconhece estados finais', () => {
    expect(isTerminal(OrderStatus.CONFIRMED)).toBe(true);
    expect(isTerminal(OrderStatus.FAILED)).toBe(true);
    expect(isTerminal(OrderStatus.PENDING)).toBe(false);
  });
});
