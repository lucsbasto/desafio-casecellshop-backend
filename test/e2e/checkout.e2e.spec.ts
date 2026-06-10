import { bootE2E } from '../support/harness';
import { postCheckout, productStock } from '../support/helpers';

/**
 * TC-CHK — Checkout assíncrono (POST /checkout). P0: 202 Accepted, validação de
 * payload, rejeição sem estoque e contrato não-bloqueante (não espera o ERP).
 */
describe('TC-CHK — Checkout (e2e)', () => {
  it('TC-CHK-01 — checkout aceito retorna 202 com orderId e status', async () => {
    const e = await bootE2E();
    try {
      const res = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'chk-01',
      ).expect(202);
      expect(res.body.orderId).toBeDefined();
      expect(res.body.status).toBe('PENDING');
      await e.queue.drain();
    } finally {
      await e.close();
    }
  });

  it('TC-CHK-02 — payload inválido retorna 400 no schema de erro', async () => {
    const e = await bootE2E();
    try {
      const cases = [
        { items: [] },
        { items: [{ productId: 'CAPA-001', quantity: 0 }] },
        { items: [{ quantity: 1 }] },
        {},
      ];
      for (const [i, body] of cases.entries()) {
        const res = await postCheckout(e.http, body as never, `chk-02-${i}`).expect(400);
        expect(res.body).toHaveProperty('statusCode', 400);
        expect(res.body).toHaveProperty('message');
        expect(res.body).toHaveProperty('correlationId');
      }
    } finally {
      await e.close();
    }
  });

  it('TC-CHK-03 — produto inexistente retorna 404 com error=PRODUCT_NOT_FOUND', async () => {
    // ProductNotFoundError é um DomainError mapeado para HTTP 404 em domain-exception.filter.ts
    // (ver statusFor(): ProductNotFoundError => HttpStatus.NOT_FOUND)
    const e = await bootE2E();
    try {
      // Garante que o produto-válido de referência não seja afetado pelo pedido rejeitado
      const stockAntes = await productStock(e.http, 'CAPA-001');

      const res = await postCheckout(
        e.http,
        { items: [{ productId: 'NAO-EXISTE', quantity: 1 }] },
        'chk-03',
      ).expect(404); // ProductNotFoundError -> 404 (domain-exception.filter.ts linha 23)

      // Valida o schema de erro padronizado
      expect(res.body.statusCode).toBe(404);
      expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
      expect(res.body.message).toMatch(/NAO-EXISTE/);
      expect(res.body.correlationId).toBeDefined();
      expect(res.body.timestamp).toBeDefined();

      // Nenhum efeito colateral: estoque de produtos válidos permanece inalterado
      const stockDepois = await productStock(e.http, 'CAPA-001');
      expect(stockDepois).toBe(stockAntes);
    } finally {
      await e.close();
    }
  });

  it('TC-CHK-04 — checkout sem estoque é rejeitado (409 INSUFFICIENT_STOCK)', async () => {
    const e = await bootE2E();
    try {
      const res = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-004', quantity: 1 }] }, // CAPA-004 seed stock = 0
        'chk-04',
      ).expect(409);
      expect(res.body.error).toBe('INSUFFICIENT_STOCK');
    } finally {
      await e.close();
    }
  });

  it('TC-CHK-06 — reserva de estoque no aceite é refletida na vitrine (estoque vivo)', async () => {
    // Boot fresco para isolamento de estoque — CAPA-005 seed = 50
    const e = await bootE2E();
    try {
      const stockAntes = await productStock(e.http, 'CAPA-005');
      expect(stockAntes).toBe(50); // confirma seed antes de agir

      await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-005', quantity: 1 }] },
        'chk-06',
      ).expect(202);

      // Reserva atômica ocorre ANTES do 202 (checkout.usecase.ts: reserveItems -> save -> enqueue)
      // A vitrine (GET /products) deve refletir o estoque disponível subtraído da reserva
      const stockDepois = await productStock(e.http, 'CAPA-005');
      expect(stockDepois).toBe(49); // 50 - 1 reservado
    } finally {
      await e.close();
    }
  });

  it('TC-CHK-05 — resposta não bloqueia até faturar (202 rápido com ERP lento)', async () => {
    const e = await bootE2E({
      env: { ERP_MIN_LATENCY_MS: '600', ERP_MAX_LATENCY_MS: '600' },
    });
    try {
      const start = Date.now();
      const res = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-005', quantity: 1 }] },
        'chk-05',
      ).expect(202);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(400); // não esperou os 600ms do ERP
      expect(res.body.status).toBe('PENDING');
      await e.queue.drain();
    } finally {
      await e.close();
    }
  });
});
