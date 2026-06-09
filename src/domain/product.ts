/**
 * Produto do catálogo. Origem da verdade é o "ERP" (aqui um repositório fake).
 * `priceCents` evita problemas de ponto flutuante com dinheiro.
 */
export interface Product {
  id: string;
  name: string;
  priceCents: number;
  /** Disponibilidade corrente. No read model da loja seria projetada do ERP. */
  stock: number;
}

/** Visão pública do produto exposta pela vitrine (não vaza detalhes internos). */
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
