import { ProductRepositoryPort } from '../../application/ports/repository.port';
import { Product } from '../../domain/product';

/** Seed do catálogo (capinhas). Em produção viria do read model / ERP. */
export const PRODUCT_SEED: Product[] = [
  { id: 'CAPA-001', name: 'Capinha Silicone Preta iPhone 15', priceCents: 4990, stock: 25 },
  { id: 'CAPA-002', name: 'Capinha Transparente Galaxy S24', priceCents: 3990, stock: 10 },
  { id: 'CAPA-003', name: 'Capinha Antichoque Moto G84', priceCents: 5990, stock: 5 },
  { id: 'CAPA-004', name: 'Capinha Couro Pixel 8', priceCents: 7990, stock: 0 },
  { id: 'CAPA-005', name: 'Capinha MagSafe iPhone 14', priceCents: 8990, stock: 50 },
];

/**
 * "ERP fake": origem da verdade de produto/preço. Simula a latência de uma API
 * REST síncrona do ERP para que o ganho do cache seja observável.
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
