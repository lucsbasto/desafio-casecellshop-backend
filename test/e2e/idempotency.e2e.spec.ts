import { bootE2E } from '../support/harness';
import {
  getMetrics,
  metricValue,
  postCheckout,
  productStock,
  settleOrder,
} from '../support/helpers';

/**
 * TC-IDEM — Idempotência. P0: duplo clique (mesma key => 1 pedido), retry
 * concorrente com a mesma key e keys distintas criando pedidos distintos.
 */
describe('TC-IDEM — Idempotência (e2e)', () => {
  it('TC-IDEM-01 — duplo clique com a mesma key cria 1 pedido', async () => {
    const e = await bootE2E();
    try {
      const before = await productStock(e.http, 'CAPA-001');
      const first = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'idem-01',
      ).expect(202);
      const second = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'idem-01',
      ).expect(202);

      expect(second.body.orderId).toBe(first.body.orderId);
      expect(second.body.replay).toBe(true);
      await e.queue.drain();
      // estoque decrementado exatamente 1 vez
      expect(await productStock(e.http, 'CAPA-001')).toBe(before - 1);
    } finally {
      await e.close();
    }
  });

  it('TC-IDEM-02 — retry concorrente com a mesma key cria 1 pedido', async () => {
    const e = await bootE2E();
    try {
      const before = await productStock(e.http, 'CAPA-001');
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          postCheckout(e.http, { items: [{ productId: 'CAPA-001', quantity: 1 }] }, 'idem-02'),
        ),
      );
      for (const r of results) expect(r.status).toBe(202);
      const orderIds = new Set(results.map((r) => r.body.orderId));
      expect(orderIds.size).toBe(1);
      await e.queue.drain();
      expect(await productStock(e.http, 'CAPA-001')).toBe(before - 1);
    } finally {
      await e.close();
    }
  });

  it('TC-IDEM-03 — keys diferentes criam pedidos diferentes', async () => {
    const e = await bootE2E();
    try {
      const before = await productStock(e.http, 'CAPA-001');
      const a = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'idem-03-a',
      ).expect(202);
      const b = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'idem-03-b',
      ).expect(202);
      expect(a.body.orderId).not.toBe(b.body.orderId);
      await e.queue.drain();
      expect(await productStock(e.http, 'CAPA-001')).toBe(before - 2);
    } finally {
      await e.close();
    }
  });

  /**
   * TC-IDEM-04 — Comportamento sem proteção: ausência de Idempotency-Key.
   *
   * Quando o cliente NÃO envia o header, o app gera uma UUID aleatória por
   * chamada (ver checkout.usecase.ts:73-77). Cada requisição é, portanto,
   * tratada como um pedido completamente novo: 2 pedidos distintos são criados
   * e o estoque é decrementado 2 vezes. Isso é o comportamento documentado
   * "sem proteção" — a idempotência é responsabilidade do chamador fornecer a key.
   */
  it('TC-IDEM-04 — sem Idempotency-Key: cada chamada cria pedido distinto (sem proteção, documentado)', async () => {
    const e = await bootE2E();
    try {
      const before = await productStock(e.http, 'CAPA-001');

      // Não passa o 3º argumento → postCheckout não envia o header Idempotency-Key
      const first = await postCheckout(e.http, {
        items: [{ productId: 'CAPA-001', quantity: 1 }],
      }).expect(202);
      const second = await postCheckout(e.http, {
        items: [{ productId: 'CAPA-001', quantity: 1 }],
      }).expect(202);

      // Sem key, o app gera UUIDs distintas → dois pedidos diferentes
      expect(first.body.orderId).toBeTruthy();
      expect(second.body.orderId).toBeTruthy();
      expect(second.body.orderId).not.toBe(first.body.orderId);

      // Nenhum dos dois é replay (cada um é um novo pedido)
      expect(first.body.replay).toBeFalsy();
      expect(second.body.replay).toBeFalsy();

      // Dois decrementos de estoque (sem proteção → dois pedidos reais)
      await e.queue.drain();
      expect(await productStock(e.http, 'CAPA-001')).toBe(before - 2);
    } finally {
      await e.close();
    }
  });

  /**
   * TC-IDEM-05 — Replay após pedido concluído (CONFIRMED).
   *
   * Depois de o worker ter levado o pedido ao estado terminal CONFIRMED, o
   * cliente reenvia a mesma Idempotency-Key. O app deve devolver o pedido
   * original com replay:true, sem criar um novo pedido nem decrementar o
   * estoque uma segunda vez.
   */
  it('TC-IDEM-05 — replay após pedido concluído retorna mesmo orderId sem re-decrementar', async () => {
    const e = await bootE2E();
    try {
      const before = await productStock(e.http, 'CAPA-001');

      // 1ª chamada: cria o pedido
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'idem-05',
      ).expect(202);
      const orderId: string = created.body.orderId;
      expect(created.body.replay).toBeFalsy();

      // Aguarda o worker levar o pedido a um estado terminal (CONFIRMED)
      const settled = await settleOrder(e.http, e.queue, orderId);
      expect(settled.status).toBe('CONFIRMED');

      // Estoque decrementado 1 vez após o primeiro checkout
      expect(await productStock(e.http, 'CAPA-001')).toBe(before - 1);

      // Reenvio com a mesma key após o pedido estar CONFIRMED
      const replay = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'idem-05',
      ).expect(202);

      // Deve retornar o mesmo pedido original com replay:true
      expect(replay.body.orderId).toBe(orderId);
      expect(replay.body.replay).toBe(true);

      // Estoque NÃO deve ter sido decrementado novamente
      await e.queue.drain();
      expect(await productStock(e.http, 'CAPA-001')).toBe(before - 1);
    } finally {
      await e.close();
    }
  });

  /**
   * TC-IDEM-06 — Mesma chave com payload diferente: retorna pedido original (replay).
   *
   * O app não valida se o payload do reenvio é idêntico ao original. A entrada de
   * idempotência persiste vinculada ao orderId original, portanto qualquer reenvio
   * com a mesma key devolve o pedido original sem processar o novo payload.
   * CAPA-005 NÃO deve ser reservado/decrementado.
   */
  it('TC-IDEM-06 — mesma chave com payload diferente retorna pedido original, sem efeito colateral', async () => {
    const e = await bootE2E();
    try {
      const stockCapa001Before = await productStock(e.http, 'CAPA-001');
      const stockCapa005Before = await productStock(e.http, 'CAPA-005');

      // 1ª chamada: cria pedido com CAPA-001 qty=1
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'idem-06',
      ).expect(202);
      const orderId: string = created.body.orderId;
      expect(created.body.replay).toBeFalsy();

      // 2ª chamada: mesma key, payload completamente diferente (CAPA-005 qty=2)
      const replay = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-005', quantity: 2 }] },
        'idem-06',
      ).expect(202);

      // Deve retornar o pedido ORIGINAL (idem-06 → CAPA-001), não o novo
      expect(replay.body.orderId).toBe(orderId);
      expect(replay.body.replay).toBe(true);

      // Processa a fila e verifica efeitos colaterais
      await e.queue.drain();

      // CAPA-001 decrementou 1 vez (pedido original)
      expect(await productStock(e.http, 'CAPA-001')).toBe(stockCapa001Before - 1);

      // CAPA-005 NÃO deve ter sido decrementado (payload do replay foi ignorado)
      expect(await productStock(e.http, 'CAPA-005')).toBe(stockCapa005Before);
    } finally {
      await e.close();
    }
  });

  /**
   * TC-IDEM-07 — Idempotência no reprocessamento do worker: não fatura 2×.
   *
   * O worker possui guarda explícita em checkout.worker.ts:57-59:
   *   if (isTerminal(order.status)) { ... return; }
   * Um job duplicado/reentregue para um orderId já CONFIRMED é silenciosamente
   * ignorado. A métrica erp_calls_total{result="success"} NÃO deve aumentar
   * na reentrega, provando que o ERP não foi chamado uma segunda vez.
   */
  it('TC-IDEM-07 — worker não fatura 2× em reprocessamento de job duplicado', async () => {
    const e = await bootE2E();
    try {
      // 1) Criar e confirmar um pedido normalmente
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'idem-07',
      ).expect(202);
      const orderId: string = created.body.orderId;

      const settled = await settleOrder(e.http, e.queue, orderId);
      expect(settled.status).toBe('CONFIRMED');

      // 2) Captura contagem de chamadas ERP após o processamento normal
      const metricsBefore = await getMetrics(e.http);
      const erpSuccessBefore = metricValue(metricsBefore, 'erp_calls_total', { result: 'success' });
      expect(erpSuccessBefore).toBeGreaterThanOrEqual(1);

      // 3) Força reentrega do mesmo job (simula duplicata de mensagem da fila)
      //    O worker deve reconhecer o pedido como terminal e ignorar sem chamar ERP
      await e.queue.enqueue({ orderId, correlationId: 'idem-07-redelivery' });
      await e.queue.drain();

      // 4) erp_calls_total{result="success"} NÃO deve ter aumentado
      const metricsAfter = await getMetrics(e.http);
      const erpSuccessAfter = metricValue(metricsAfter, 'erp_calls_total', { result: 'success' });
      expect(erpSuccessAfter).toBe(erpSuccessBefore);
    } finally {
      await e.close();
    }
  });
});
