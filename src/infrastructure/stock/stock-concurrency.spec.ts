import { InMemoryStockAdapter } from './in-memory-stock.adapter';

/**
 * Core challenge proof: under N concurrent reservations for stock M (< N),
 * at most M succeed and the balance never goes negative (no overselling).
 */
describe('Reserva de estoque sob concorrência', () => {
  it('não permite overselling com 50 reservas concorrentes para estoque 10', async () => {
    const stock = new InMemoryStockAdapter();
    await stock.init('CAPA-X', 10);

    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () => stock.reserve('CAPA-X', 1)),
    );

    const success = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    expect(success).toBe(10);
    expect(failed).toBe(40);
    expect(await stock.get('CAPA-X')).toBe(0);
  });

  it('reserva multi-unidade respeita o saldo', async () => {
    const stock = new InMemoryStockAdapter();
    await stock.init('CAPA-Y', 5);

    const a = await stock.reserve('CAPA-Y', 3);
    const b = await stock.reserve('CAPA-Y', 3); // only 2 remaining -> fails
    const c = await stock.reserve('CAPA-Y', 2);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(c.ok).toBe(true);
    expect(await stock.get('CAPA-Y')).toBe(0);
  });

  it('release compensa o saldo', async () => {
    const stock = new InMemoryStockAdapter();
    await stock.init('CAPA-Z', 1);
    await stock.reserve('CAPA-Z', 1);
    await stock.release('CAPA-Z', 1);
    expect(await stock.get('CAPA-Z')).toBe(1);
  });
});
