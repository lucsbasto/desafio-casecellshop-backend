export const IDEMPOTENCY_PORT = Symbol('IDEMPOTENCY_PORT');

export interface IdempotencyRecord {
  orderId: string;
  /** true se este chamador criou o registro agora; false se já existia (replay). */
  created: boolean;
}

/**
 * Porta de idempotência. Garante que uma mesma Idempotency-Key produza um único
 * recurso (orderId), tolerando retry e duplo clique.
 */
export interface IdempotencyPort {
  /**
   * Reserva atômica da chave:
   * - se a chave é nova, persiste `orderId` e retorna { created: true }.
   * - se já existe, retorna o orderId existente e { created: false } (replay).
   * Implementação: Redis SET NX EX / Map com lock.
   */
  remember(key: string, orderId: string, ttlMs: number): Promise<IdempotencyRecord>;
}
