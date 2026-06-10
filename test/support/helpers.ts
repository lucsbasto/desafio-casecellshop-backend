import type { Server } from 'node:http';
import request from 'supertest';
import { InMemoryQueueAdapter } from '../../src/infrastructure/queue/in-memory-queue.adapter';

/**
 * Reads a single Prometheus counter/gauge sample value from a /metrics dump.
 * Matches the exact metric name and (optionally) a subset of labels. Returns 0
 * when the series has not been emitted yet (Prometheus omits zero series).
 */
export function metricValue(text: string, name: string, labels?: Record<string, string>): number {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || !line.startsWith(name)) continue;
    const m = line.match(/^(\S+?)(\{[^}]*\})?\s+([0-9.eE+-]+)$/);
    if (!m || m[1] !== name) continue;
    const lbl = m[2] ?? '';
    if (labels && !Object.entries(labels).every(([k, v]) => lbl.includes(`${k}="${v}"`))) {
      continue;
    }
    return Number(m[3]);
  }
  return 0;
}

export async function getMetrics(http: Server): Promise<string> {
  const res = await request(http).get('/metrics').expect(200);
  return res.text as string;
}

export interface CheckoutBody {
  items: { productId: string; quantity: number }[];
}

export function postCheckout(http: Server, body: CheckoutBody, idempotencyKey?: string) {
  const r = request(http).post('/checkout');
  if (idempotencyKey) r.set('Idempotency-Key', idempotencyKey);
  return r.send(body);
}

/** Reads the storefront-visible stock for a product id from GET /products. */
export async function productStock(http: Server, productId: string): Promise<number> {
  const res = await request(http).get('/products').expect(200);
  const found = (res.body as { id: string; stock: number }[]).find((p) => p.id === productId);
  return found?.stock ?? 0;
}

/**
 * Drains the in-memory queue and polls the order status until it reaches a
 * terminal state (CONFIRMED/FAILED) or the attempt budget runs out.
 */
export async function settleOrder(
  http: Server,
  queue: InMemoryQueueAdapter,
  orderId: string,
  attempts = 50,
): Promise<{ status: string; history: { status: string }[] }> {
  await queue.drain();
  for (let i = 0; i < attempts; i++) {
    const res = await request(http).get(`/orders/${orderId}/status`).expect(200);
    const body = res.body as { status: string; history: { status: string }[] };
    if (body.status === 'CONFIRMED' || body.status === 'FAILED') return body;
    await queue.drain();
  }
  const res = await request(http).get(`/orders/${orderId}/status`);
  return res.body;
}
