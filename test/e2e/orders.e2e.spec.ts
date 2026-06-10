import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootE2E } from '../support/harness';
import { postCheckout, settleOrder } from '../support/helpers';

/**
 * TC-ORD — Status do pedido (GET /orders/{orderId}/status). P0: estado inicial,
 * evolução até terminal e pedido inexistente.
 */
describe('TC-ORD — Status do pedido (e2e)', () => {
  it('TC-ORD-01 — consulta status de pedido recém-criado (estado inicial)', async () => {
    // ERP lento para garantir que o status capturado ainda não é terminal.
    const e = await bootE2E({ env: { ERP_MIN_LATENCY_MS: '800', ERP_MAX_LATENCY_MS: '800' } });
    try {
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'ord-01',
      ).expect(202);
      const res = await request(e.http).get(`/orders/${created.body.orderId}/status`).expect(200);
      expect(['PENDING', 'PROCESSING']).toContain(res.body.status);
      expect(res.body.id).toBe(created.body.orderId);
      await e.queue.drain();
    } finally {
      await e.close();
    }
  });

  it('TC-ORD-02 — status evolui até estado terminal CONFIRMED', async () => {
    const e = await bootE2E();
    try {
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'ord-02',
      ).expect(202);
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      expect(final.status).toBe('CONFIRMED');
      expect(final.history.length).toBeGreaterThanOrEqual(2);
    } finally {
      await e.close();
    }
  });

  it('TC-ORD-03 — pedido inexistente retorna 404 no schema de erro', async () => {
    const e = await bootE2E();
    try {
      const res = await request(e.http).get(`/orders/${randomUUID()}/status`).expect(404);
      expect(res.body.error).toBe('ORDER_NOT_FOUND');
      expect(res.body).toHaveProperty('correlationId');
      expect(res.body).toHaveProperty('timestamp');
    } finally {
      await e.close();
    }
  });

  /**
   * TC-ORD-04 — Máquina de estados: sequência de transições no `history` é válida.
   *
   * Valida que, tanto no caminho feliz (CONFIRMED) quanto no caminho de falha
   * (FAILED com ERP_FAIL_RATE=1), o histórico começa em PENDING, termina em estado
   * terminal e nunca contém uma transição proibida pela máquina de estados.
   */
  it('TC-ORD-04 — máquina de estados: history respeita transições válidas (CONFIRMED e FAILED)', async () => {
    /** Transições permitidas, espelhando src/domain/order.ts ALLOWED. */
    const TRANSICOES_PERMITIDAS: Record<string, string[]> = {
      PENDING: ['PROCESSING', 'FAILED'],
      PROCESSING: ['CONFIRMED', 'FAILED'],
      CONFIRMED: [],
      FAILED: [],
    };
    const TERMINAIS = new Set(['CONFIRMED', 'FAILED']);

    function validarHistorico(history: { status: string }[], caminhoEsperado: string[]): void {
      // O primeiro status deve ser PENDING.
      expect(history[0].status).toBe('PENDING');

      // O último status deve ser terminal.
      expect(TERMINAIS.has(history[history.length - 1].status)).toBe(true);

      // Cada par (de, para) deve ser uma transição permitida.
      for (let i = 0; i < history.length - 1; i++) {
        const de = history[i].status;
        const para = history[i + 1].status;
        const permitidos = TRANSICOES_PERMITIDAS[de] ?? [];
        expect(permitidos).toContain(para);
      }

      // A sequência de statuses deve corresponder ao caminho esperado.
      expect(history.map((h) => h.status)).toEqual(caminhoEsperado);
    }

    // --- Caminho CONFIRMED (ERP_FAIL_RATE=0, padrão) ---
    const eConfirmed = await bootE2E();
    try {
      const criado = await postCheckout(
        eConfirmed.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'ord-04-confirmed',
      ).expect(202);
      const finalConfirmed = await settleOrder(
        eConfirmed.http,
        eConfirmed.queue,
        criado.body.orderId,
      );
      expect(finalConfirmed.status).toBe('CONFIRMED');
      validarHistorico(finalConfirmed.history, ['PENDING', 'PROCESSING', 'CONFIRMED']);
    } finally {
      await eConfirmed.close();
    }

    // --- Caminho FAILED (ERP_FAIL_RATE=1, tentativas esgotadas) ---
    const eFailed = await bootE2E({
      env: { ERP_FAIL_RATE: '1', WORKER_MAX_ATTEMPTS: '1', WORKER_BACKOFF_MS: '0' },
    });
    try {
      const criado = await postCheckout(
        eFailed.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'ord-04-failed',
      ).expect(202);
      const finalFailed = await settleOrder(eFailed.http, eFailed.queue, criado.body.orderId);
      expect(finalFailed.status).toBe('FAILED');
      validarHistorico(finalFailed.history, ['PENDING', 'PROCESSING', 'FAILED']);
    } finally {
      await eFailed.close();
    }
  });

  /**
   * TC-ORD-05 — Pedido falho expõe motivo (reason) na última entrada do history.
   *
   * Com ERP_FAIL_RATE=1 e WORKER_MAX_ATTEMPTS=2 o worker esgota as tentativas e
   * transita para FAILED. A última entrada do `history` deve conter um campo
   * `reason` com valor legível e não-vazio.
   */
  it('TC-ORD-05 — pedido falho expõe reason legível na última entrada do history', async () => {
    const e = await bootE2E({
      env: { ERP_FAIL_RATE: '1', WORKER_MAX_ATTEMPTS: '2', WORKER_BACKOFF_MS: '0' },
    });
    try {
      const criado = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'ord-05',
      ).expect(202);

      const final = await settleOrder(e.http, e.queue, criado.body.orderId);

      expect(final.status).toBe('FAILED');

      const ultimaEntrada = final.history[final.history.length - 1] as {
        status: string;
        reason?: string;
      };
      expect(ultimaEntrada.status).toBe('FAILED');

      // reason deve existir, ser string e ter conteúdo legível.
      expect(typeof ultimaEntrada.reason).toBe('string');
      expect((ultimaEntrada.reason as string).trim().length).toBeGreaterThan(0);
    } finally {
      await e.close();
    }
  });

  /**
   * TC-ORD-06 — Consulta de status é idempotente: não altera o pedido.
   *
   * Após o pedido atingir CONFIRMED, 10 leituras consecutivas de
   * GET /orders/{id}/status devem retornar exatamente o mesmo `status`,
   * o mesmo `updatedAt` e o mesmo tamanho de `history`.
   * Leitura não deve provocar nenhuma mutação no estado do pedido.
   */
  it('TC-ORD-06 — consulta de status é idempotente: não altera status, updatedAt nem history', async () => {
    const e = await bootE2E();
    try {
      const criado = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'ord-06',
      ).expect(202);

      // Aguarda o pedido atingir estado terminal.
      const terminal = await settleOrder(e.http, e.queue, criado.body.orderId);
      expect(terminal.status).toBe('CONFIRMED');

      // Primeira leitura de referência.
      const ref = await request(e.http).get(`/orders/${criado.body.orderId}/status`).expect(200);

      const statusRef = ref.body.status as string;
      const updatedAtRef = ref.body.updatedAt as string;
      const historySizeRef = (ref.body.history as unknown[]).length;

      // 9 leituras adicionais (total 10) devem ser idênticas à referência.
      for (let i = 0; i < 9; i++) {
        const res = await request(e.http).get(`/orders/${criado.body.orderId}/status`).expect(200);

        expect(res.body.status).toBe(statusRef);
        expect(res.body.updatedAt).toBe(updatedAtRef);
        expect((res.body.history as unknown[]).length).toBe(historySizeRef);
      }
    } finally {
      await e.close();
    }
  });
});
