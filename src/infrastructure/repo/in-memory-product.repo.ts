import { ProductRepositoryPort } from '../../application/ports/repository.port';
import { Product } from '../../domain/product';

/** Product catalog seed (phone cases). In production this would come from the read model / ERP. */
export const PRODUCT_SEED: Product[] = [
  { id: 'CAPA-001', name: 'Capinha Silicone Preta iPhone 15', priceCents: 4990, stock: 25 },
  { id: 'CAPA-002', name: 'Capinha Transparente Galaxy S24', priceCents: 3990, stock: 10 },
  { id: 'CAPA-003', name: 'Capinha Antichoque Moto G84', priceCents: 5990, stock: 5 },
  { id: 'CAPA-004', name: 'Capinha Couro Pixel 8', priceCents: 7990, stock: 0 },
  { id: 'CAPA-005', name: 'Capinha MagSafe iPhone 14', priceCents: 8990, stock: 50 },
];

/**
 * "Fake ERP": source of truth for product/price data. Simulates the latency of a
 * synchronous ERP REST API so that the cache gain is observable.
 */
export class InMemoryProductRepository implements ProductRepositoryPort {
  private readonly products: Map<string, Product>;

  constructor(
    seed: Product[] = PRODUCT_SEED,
    private readonly latencyMs = 40,
  ) {
    this.products = new Map(seed.map((p) => [p.id, { ...p }]));
  }

  private async simulateLatency(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }
  }

  async findAll(): Promise<Product[]> {
    await this.simulateLatency();
    return [...this.products.values()].map((p) => ({ ...p }));
  }

  async findById(id: string): Promise<Product | undefined> {
    await this.simulateLatency();
    const p = this.products.get(id);
    return p ? { ...p } : undefined;
  }
}
