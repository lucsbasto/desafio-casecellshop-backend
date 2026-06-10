import { bootE2E } from '../support/harness';
import { getMetrics, metricValue, postCheckout, productStock } from '../support/helpers';

/**
 * TC-STOCK — Consistência de estoque / anti-overselling. P0: concorrência real
 * sem vender além do estoque, decremento atômico e devolução em falha definitiva.
 */
describe('TC-STOCK — Anti-overselling (e2e)', () => {
  it('TC-STOCK-01 — não vende além do estoque sob concorrência', async () => {
    const e = await bootE2E(); // CAPA-003 seed stock = 5
    try {
      const N = 5;
      const K = 15;
      const results = await Promise.all(
        Array.from({ length: N + K }, (_, i) =>
          postCheckout(e.http, { items: [{ productId: 'CAPA-003', quantity: 1 }] }, `stk-01-${i}`),
        ),
      );
      const accepted = results.filter((r) => r.status === 202).length;
      const rejected = results.filter((r) => r.status === 409).length;
      expect(accepted).toBe(N);
      expect(rejected).toBe(K);
      await e.queue.drain();
      expect(await productStock(e.http, 'CAPA-003')).toBe(0);
      const metrics = await getMetrics(e.http);
      expect(metricValue(metrics, 'oversell_prevented_total')).toBe(K);
    } finally {
      await e.close();
    }
  });

  it('TC-STOCK-02 — soma de unidades aceitas = estoque inicial', async () => {
    const e = await bootE2E();
    try {
      const initial = await productStock(e.http, 'CAPA-003'); // 5
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          postCheckout(e.http, { items: [{ productId: 'CAPA-003', quantity: 1 }] }, `stk-02-${i}`),
        ),
      );
      const accepted = results.filter((r) => r.status === 202).length;
      expect(accepted).toBe(initial);
    } finally {
      await e.close();
    }
  });

  it('TC-STOCK-03 — decremento atômico na última unidade (exatamente 1 vence)', async () => {
    const e = await bootE2E();
    try {
      // Reduz CAPA-003 (5) para 1 com 4 reservas sequenciais.
      for (let i = 0; i < 4; i++) {
        await postCheckout(
          e.http,
          { items: [{ productId: 'CAPA-003', quantity: 1 }] },
          `stk-03-pre-${i}`,
        ).expect(202);
      }
      // 2 simultâneos disputando a última unidade.
      const [a, b] = await Promise.all([
        postCheckout(e.http, { items: [{ productId: 'CAPA-003', quantity: 1 }] }, 'stk-03-a'),
        postCheckout(e.http, { items: [{ productId: 'CAPA-003', quantity: 1 }] }, 'stk-03-b'),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([202, 409]);
      await e.queue.drain();
    } finally {
      await e.close();
    }
  });

  it('TC-STOCK-04 — quantidade maior que o estoque é rejeitada (single-item)', async () => {
    // CAPA-003 tem seed stock = 5. Pedimos quantity 6 → deve ser rejeitado.
    const e = await bootE2E();
    try {
      const antes = await productStock(e.http, 'CAPA-003'); // espera 5
      const res = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-003', quantity: 6 }] },
        'stk-04',
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('INSUFFICIENT_STOCK');
      // Estoque não pode ter sido decrementado
      const depois = await productStock(e.http, 'CAPA-003');
      expect(depois).toBe(antes); // deve continuar 5
    } finally {
      await e.close();
    }
  });

  it('TC-STOCK-05 — pedido multi-item tudo-ou-nada: compensação libera reserva de A quando B falha (A primeiro)', async () => {
    // CAPA-001: 25 unidades; CAPA-004: 0 unidades (esgotado).
    // Pedido [A=CAPA-001(1), B=CAPA-004(1)]: A é reservado com sucesso primeiro,
    // depois B falha. O reserveItems DEVE compensar (liberar) a reserva de A.
    // Se CAPA-001 ficar com 24 (em vez de 25), é BUG de compensação.
    const e = await bootE2E();
    try {
      const stockA_antes = await productStock(e.http, 'CAPA-001'); // espera 25

      const res = await postCheckout(
        e.http,
        {
          items: [
            { productId: 'CAPA-001', quantity: 1 }, // item A — disponível
            { productId: 'CAPA-004', quantity: 1 }, // item B — esgotado
          ],
        },
        'stk-05-a-first',
      );

      // Pedido deve ser rejeitado integralmente (semântica tudo-ou-nada)
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('INSUFFICIENT_STOCK');

      // A reserva de CAPA-001 deve ter sido COMPENSADA (devolvida)
      const stockA_depois = await productStock(e.http, 'CAPA-001');
      // BUG se stockA_depois === stockA_antes - 1 (reserva presa, não compensada)
      expect(stockA_depois).toBe(stockA_antes);
    } finally {
      await e.close();
    }
  });

  it('TC-STOCK-05 — pedido multi-item tudo-ou-nada: B esgotado vem PRIMEIRO (sem reserva de A para compensar)', async () => {
    // Quando o item esgotado (CAPA-004) vem primeiro no array,
    // B falha antes de A ser processado → reserved[] está vazio → nenhuma compensação necessária.
    // CAPA-001 nunca chega a ser reservado, portanto estoque também deve permanecer intacto.
    const e = await bootE2E();
    try {
      const stockA_antes = await productStock(e.http, 'CAPA-001'); // espera 25

      const res = await postCheckout(
        e.http,
        {
          items: [
            { productId: 'CAPA-004', quantity: 1 }, // item B — esgotado, vem primeiro
            { productId: 'CAPA-001', quantity: 1 }, // item A — disponível, nunca chega a ser processado
          ],
        },
        'stk-05-b-first',
      );

      // Pedido também deve ser rejeitado (B falha imediatamente)
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('INSUFFICIENT_STOCK');

      // CAPA-001 nem foi tocado — estoque permanece 25
      const stockA_depois = await productStock(e.http, 'CAPA-001');
      expect(stockA_depois).toBe(stockA_antes);
    } finally {
      await e.close();
    }
  });

  it('TC-STOCK-07 — vitrine reflete decremento real após vendas confirmadas', async () => {
    // CAPA-005 seed = 50. Após 3 checkouts aceitos, productStock deve retornar 47.
    const e = await bootE2E();
    try {
      const inicial = await productStock(e.http, 'CAPA-005'); // espera 50

      for (let i = 0; i < 3; i++) {
        await postCheckout(
          e.http,
          { items: [{ productId: 'CAPA-005', quantity: 1 }] },
          `stk-07-${i}`,
        ).expect(202);
      }

      // Com estoque ao-vivo (in-memory), a vitrine converge imediatamente após a reserva.
      const apos_vendas = await productStock(e.http, 'CAPA-005');
      expect(apos_vendas).toBe(inicial - 3); // 50 - 3 = 47
    } finally {
      await e.close();
    }
  });

  it.todo('TC-STOCK-08 — anti-overselling com driver Redis: requer Docker/Redis (Tier B)');

  it('TC-STOCK-06 — estoque devolvido ao falhar definitivamente no ERP', async () => {
    const e = await bootE2E({
      env: { ERP_FAIL_RATE: '1', WORKER_MAX_ATTEMPTS: '2', WORKER_BACKOFF_MS: '0' },
    });
    try {
      const before = await productStock(e.http, 'CAPA-002'); // 10
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-002', quantity: 1 }] },
        'stk-06',
      ).expect(202);
      await e.queue.drain();
      // Aguarda o pedido virar FAILED e a compensação liberar a reserva.
      await e.queue.drain();
      const after = await productStock(e.http, 'CAPA-002');
      expect(after).toBe(before); // reserva devolvida (nada "preso")
      expect(created.body.orderId).toBeDefined();
    } finally {
      await e.close();
    }
  });
});
