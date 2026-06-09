import { InMemoryCacheAdapter } from './in-memory-cache.adapter';

describe('InMemoryCacheAdapter', () => {
  it('miss na 1ª chamada, hit na 2ª (cache-aside + TTL)', async () => {
    const cache = new InMemoryCacheAdapter();
    let loads = 0;
    const loader = async () => {
      loads++;
      return { v: 42 };
    };

    const first = await cache.getOrLoad('k', 1000, loader);
    const second = await cache.getOrLoad('k', 1000, loader);

    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(loads).toBe(1);
  });

  it('single-flight: misses concorrentes disparam o loader uma única vez (anti-stampede)', async () => {
    const cache = new InMemoryCacheAdapter();
    let loads = 0;
    const loader = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return 'value';
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.getOrLoad('hot', 1000, loader)),
    );

    expect(loads).toBe(1); // stampede avoided
    expect(results.every((r) => r.value === 'value')).toBe(true);
  });

  it('expira após o TTL', async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set('k', 1, 10);
    expect(await cache.get('k')).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await cache.get('k')).toBeUndefined();
  });

  it('fallback stale-while-error serve o último valor bom quando o loader falha', async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set('k', 'bom', 5); // popula lastKnown
    await new Promise((r) => setTimeout(r, 10)); // expira

    const res = await cache.getOrLoad(
      'k',
      1000,
      async () => {
        throw new Error('ERP fora do ar');
      },
      { staleOnError: true },
    );

    expect(res.stale).toBe(true);
    expect(res.value).toBe('bom');
  });
});
