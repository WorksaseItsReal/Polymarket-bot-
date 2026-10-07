import { describe, it, expect, vi, afterEach } from 'vitest';
import { Cache } from './cache.js';

describe('Cache — borne mémoire', () => {
  afterEach(() => vi.useRealTimers());

  it('balaie les entrées expirées jamais relues', () => {
    vi.useFakeTimers();
    const c = new Cache();
    for (let i = 0; i < 499; i++) c.set(`clob:market:${i}`, i, 1000);
    vi.advanceTimersByTime(2000);
    c.set('declencheur', 1, 1000); // 500e écriture → balayage
    expect(c.size()).toBe(1);
  });

  it('ne dépasse jamais la taille maximale, garde les plus récentes', () => {
    const c = new Cache();
    for (let i = 0; i < 10_050; i++) c.set(`k${i}`, i, 3_600_000);
    expect(c.size()).toBeLessThanOrEqual(10_000);
    expect(c.get('k10049')).toBe(10049);
    expect(c.get('k0')).toBeUndefined();
  });
});
