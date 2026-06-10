import type { Redis } from 'ioredis';
import { InMemoryCacheAdapter } from './in-memory-cache.adapter';
import { RedisCacheAdapter } from './redis-cache.adapter';

describe('InMemoryCacheAdapter', () => {
  // Fake timers: Date.now() e setTimeout avançam juntos e de forma determinística,
  // eliminando flakiness de wall-clock em janelas curtas (TTL/jitter) sob carga/CI.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

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

    const pending = Promise.all(
      Array.from({ length: 20 }, () => cache.getOrLoad('hot', 1000, loader)),
    );
    await jest.advanceTimersByTimeAsync(20); // libera o setTimeout do loader
    const results = await pending;

    expect(loads).toBe(1); // stampede avoided
    expect(results.every((r) => r.value === 'value')).toBe(true);
  });

  it('expira após o TTL', async () => {
    const cache = new InMemoryCacheAdapter({ jitterRatio: 0 });
    await cache.set('k', 1, 10);
    expect(await cache.get('k')).toBe(1);
    await jest.advanceTimersByTimeAsync(20);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('fallback stale-while-error serve o último valor bom quando o loader falha', async () => {
    const cache = new InMemoryCacheAdapter({ jitterRatio: 0 });
    await cache.set('k', 'bom', 5); // popula lastKnown
    await jest.advanceTimersByTimeAsync(10); // expira

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

describe('InMemoryCacheAdapter TTL jitter', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('estende o TTL do in-memory (jitter só aumenta a expiração)', async () => {
    // random=1, ratio=1 → jitter dobra o TTL: 40ms vira 80ms efetivos.
    const cache = new InMemoryCacheAdapter({ jitterRatio: 1, random: () => 1 });
    await cache.set('k', 1, 40);

    await jest.advanceTimersByTimeAsync(60); // sem jitter já teria expirado (40ms)
    expect(await cache.get('k')).toBe(1);

    await jest.advanceTimersByTimeAsync(40); // total 100ms > 80ms efetivos
    expect(await cache.get('k')).toBeUndefined();
  });

  it('jitterRatio 0 desativa o jitter (expiração determinística)', async () => {
    const cache = new InMemoryCacheAdapter({ jitterRatio: 0, random: () => 1 });
    await cache.set('k', 1, 20);

    await jest.advanceTimersByTimeAsync(40);
    expect(await cache.get('k')).toBeUndefined();
  });
});

describe('RedisCacheAdapter TTL jitter', () => {
  /** Minimal Redis fake capturing the PX (ttl in ms) passed to SET. */
  const fakeRedis = (sink: { px?: number }) =>
    ({
      set: (async (_key: string, _val: string, _mode: string, px: number) => {
        sink.px = px;
        return 'OK';
      }) as Redis['set'],
    }) satisfies Pick<Redis, 'set'> as unknown as Redis;

  it('extends the TTL within [ttl, ttl + ttl*ratio] (proportional jitter)', async () => {
    const sink: { px?: number } = {};
    // random() = 1 → maximum jitter; ratio 0.2 → +20%.
    const cache = new RedisCacheAdapter(fakeRedis(sink), { jitterRatio: 0.2, random: () => 1 });

    await cache.set('k', { v: 1 }, 1000);

    expect(sink.px).toBe(1200);
  });

  it('never expires earlier than requested (jitter only extends)', async () => {
    const sink: { px?: number } = {};
    // random() = 0 → no extension; TTL stays at the requested floor.
    const cache = new RedisCacheAdapter(fakeRedis(sink), { jitterRatio: 0.2, random: () => 0 });

    await cache.set('k', { v: 1 }, 1000);

    expect(sink.px).toBe(1000);
  });

  it('jitterRatio 0 disables jitter (deterministic TTL)', async () => {
    const sink: { px?: number } = {};
    const cache = new RedisCacheAdapter(fakeRedis(sink), { jitterRatio: 0, random: () => 1 });

    await cache.set('k', { v: 1 }, 1000);

    expect(sink.px).toBe(1000);
  });
});

describe('RedisCacheAdapter getOrLoad', () => {
  // Fake Redis backed by an in-memory Map, mirroring the get/set/del contract the
  // adapter relies on (set serializes JSON; get returns the raw string or null).
  const fakeRedis = () => {
    const data = new Map<string, string>();
    return {
      get: (async (key: string) => data.get(key) ?? null) as Redis['get'],
      set: (async (key: string, val: string) => {
        data.set(key, val);
        return 'OK';
      }) as Redis['set'],
      del: (async (key: string) => (data.delete(key) ? 1 : 0)) as Redis['del'],
    } as unknown as Redis;
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('miss: roda o loader uma vez e armazena o valor', async () => {
    const cache = new RedisCacheAdapter(fakeRedis());
    let loads = 0;
    const loader = async () => {
      loads++;
      return { v: 42 };
    };

    const res = await cache.getOrLoad('k', 1000, loader);

    expect(res.hit).toBe(false);
    expect(res.stale).toBe(false);
    expect(res.value).toEqual({ v: 42 });
    expect(loads).toBe(1);
    expect(await cache.get('k')).toEqual({ v: 42 });
  });

  it('2ª chamada é hit (sem rodar o loader)', async () => {
    const cache = new RedisCacheAdapter(fakeRedis());
    let loads = 0;
    const loader = async () => {
      loads++;
      return { v: 42 };
    };

    const first = await cache.getOrLoad('k', 1000, loader);
    const second = await cache.getOrLoad('k', 1000, loader);

    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(second.value).toEqual({ v: 42 });
    expect(loads).toBe(1);
  });

  it('single-flight: misses concorrentes disparam o loader uma única vez (anti-stampede)', async () => {
    const cache = new RedisCacheAdapter(fakeRedis());
    let loads = 0;
    const loader = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return 'value';
    };

    const pending = Promise.all(
      Array.from({ length: 20 }, () => cache.getOrLoad('hot', 1000, loader)),
    );
    await jest.advanceTimersByTimeAsync(20); // libera o setTimeout do loader
    const results = await pending;

    expect(loads).toBe(1); // stampede avoided
    expect(results.every((r) => r.value === 'value')).toBe(true);
  });

  it('fallback stale-while-error serve o último valor bom quando o loader falha', async () => {
    const cache = new RedisCacheAdapter(fakeRedis(), { jitterRatio: 0 });
    await cache.set('k', 'bom', 1000); // popula lastKnown
    await cache.del('k'); // remove do storage, mas lastKnown permanece

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

  it('rejeita quando o loader falha e não há valor anterior', async () => {
    const cache = new RedisCacheAdapter(fakeRedis());

    await expect(
      cache.getOrLoad(
        'k',
        1000,
        async () => {
          throw new Error('ERP fora do ar');
        },
        { staleOnError: true },
      ),
    ).rejects.toThrow('ERP fora do ar');
  });
});
