/**
 * Catalog product. The source of truth is the "ERP" (here a fake repository).
 * `priceCents` avoids floating-point issues with monetary values.
 */
export interface Product {
  id: string;
  name: string;
  priceCents: number;
  /** Current availability. In the store's read model this would be projected from the ERP. */
  stock: number;
}

/** Public product view exposed by the storefront (does not leak internal details). */
export interface ProductView {
  id: string;
  name: string;
  priceCents: number;
  available: boolean;
  stock: number;
}

export function toProductView(p: Product): ProductView {
  return {
    id: p.id,
    name: p.name,
    priceCents: p.priceCents,
    available: p.stock > 0,
    stock: p.stock,
  };
}
