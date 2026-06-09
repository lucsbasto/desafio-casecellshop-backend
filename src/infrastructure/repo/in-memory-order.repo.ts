import { OrderRepositoryPort } from '../../application/ports/repository.port';
import { Order, OrderStatus } from '../../domain/order';

/** Persistência in-memory de pedidos (read model da loja). */
export class InMemoryOrderRepository implements OrderRepositoryPort {
  private readonly orders = new Map<string, Order>();

  async save(order: Order): Promise<void> {
    // Clona para evitar mutação externa acidental do estado guardado.
    this.orders.set(order.id, structuredClone(order));
  }

  async findById(id: string): Promise<Order | undefined> {
    const o = this.orders.get(id);
    return o ? structuredClone(o) : undefined;
  }

  async findPendingOlderThan(before: Date): Promise<Order[]> {
    const cutoff = before.getTime();
    return [...this.orders.values()]
      .filter(
        (o) =>
          o.status === OrderStatus.PENDING &&
          new Date(o.createdAt).getTime() < cutoff,
      )
      .map((o) => structuredClone(o));
  }
}
