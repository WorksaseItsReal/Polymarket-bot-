/**
 * Simple in-memory cache with TTL support
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Au-delà, les entrées les plus anciennes sont abandonnées (borne mémoire). */
const MAX_ENTRIES = 10_000;
/** Balayage des entrées expirées toutes les N écritures. */
const SWEEP_EVERY = 500;

export class Cache {
  private store: Map<string, CacheEntry<unknown>> = new Map();
  private writes = 0;

  /**
   * ⚠️ FIX 2026-10-07 (fuite mémoire) : une entrée expirée n'était supprimée que si la
   * MÊME clé était relue. Les clés par round (`clob:market:<id>`, une nouvelle toutes
   * les 5 min et par coin) s'accumulaient donc indéfiniment sur un bot qui tourne des
   * semaines. On balaie les expirées régulièrement et on borne la taille.
   */
  private sweep(now: number): void {
    for (const [k, e] of this.store) if (now > e.expiresAt) this.store.delete(k);
    while (this.store.size > MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }


  /**
   * Get a cached value
   */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /**
   * Set a cached value with TTL
   */
  set<T>(key: string, value: T, ttlMs: number): void {
    const now = Date.now();
    this.store.delete(key); // réinsertion en fin : l'ordre d'insertion reste l'ordre d'âge
    this.store.set(key, {
      value,
      expiresAt: now + ttlMs,
    });
    if (++this.writes % SWEEP_EVERY === 0 || this.store.size > MAX_ENTRIES) this.sweep(now);
  }

  /**
   * Get a cached value or set it if not present
   */
  async getOrSet<T>(
    key: string,
    ttlMs: number,
    factory: () => Promise<T>
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    this.set(key, value, ttlMs);
    return value;
  }

  /**
   * Invalidate all keys matching a pattern
   */
  invalidate(pattern: string): void {
    for (const key of this.store.keys()) {
      if (key.includes(pattern)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Clear all cached values
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get the number of cached entries
   */
  size(): number {
    return this.store.size;
  }
}

/**
 * Cache TTL constants (in milliseconds)
 */
export const CACHE_TTL = {
  MARKET_INFO: 60 * 1000, // 1 minute
  WALLET_POSITIONS: 5 * 60 * 1000, // 5 minutes
  LEADERBOARD: 60 * 60 * 1000, // 1 hour
  TICK_SIZE: 24 * 60 * 60 * 1000, // 24 hours
  ACTIVITY: 2 * 60 * 1000, // 2 minutes (wallet activity data)
  // Binance K-line cache (historical data doesn't change)
  BINANCE_KLINE: 60 * 1000, // 1 minute
  // Binance current price cache (more volatile)
  BINANCE_PRICE: 5 * 1000, // 5 seconds
};
