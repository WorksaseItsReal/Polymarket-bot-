/**
 * SpotPriceService — REST live price feed (fallback du WebSocket Polymarket).
 *
 * Contexte (2026-09-25) : le WebSocket `wss://ws-live-data.polymarket.com/`
 * (`crypto_prices` / `crypto_prices_chainlink`) ne renvoie plus AUCUN message
 * (erreur serveur interne `relation "__subscriptions" does not exist`). Le bot
 * restait donc bloqué sur `Last Price: $Waiting (Never)` à chaque tick.
 *
 * Correctif : le prix de l'underlying est désormais récupéré par POLLING REST
 * (Binance en primaire, data-api.binance.vision, Coinbase puis Kraken en
 * fallback), avec un cache court (~1 s) pour ne pas spammer les APIs. Le
 * WebSocket reste branché en optionnel non bloquant : s'il revient un jour,
 * `primeSpotPrice()` alimente le même cache et le REST devient un simple
 * filet de sécurité.
 *
 * Aucune clé API n'est requise : uniquement des endpoints publics.
 */

export type SpotCoin = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE';

export const SPOT_COINS: SpotCoin[] = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

interface PairMap {
  binance: string;
  binanceVision: string;
  coinbase: string;
  kraken: string;
}

const PAIRS: Record<SpotCoin, PairMap> = {
  BTC: { binance: 'BTCUSDT', binanceVision: 'BTCUSDT', coinbase: 'BTC-USD', kraken: 'XBTUSD' },
  ETH: { binance: 'ETHUSDT', binanceVision: 'ETHUSDT', coinbase: 'ETH-USD', kraken: 'ETHUSD' },
  SOL: { binance: 'SOLUSDT', binanceVision: 'SOLUSDT', coinbase: 'SOL-USD', kraken: 'SOLUSD' },
  XRP: { binance: 'XRPUSDT', binanceVision: 'XRPUSDT', coinbase: 'XRP-USD', kraken: 'XRPUSD' },
  DOGE: { binance: 'DOGEUSDT', binanceVision: 'DOGEUSDT', coinbase: 'DOGE-USD', kraken: 'XDGUSD' },
};

/** Durée de vie du cache : ~1 s (cf. contrainte « cache court ~1 s »). */
const DEFAULT_MAX_AGE_MS = 1000;
/** Timeout par requête REST (une source lente ne doit pas bloquer le tick). */
const FETCH_TIMEOUT_MS = 3500;

export interface SpotPrice {
  price: number;
  source: string;
  /** Âge de la valeur au moment du retour (ms). */
  ageMs: number;
}

interface CacheEntry {
  price: number;
  source: string;
  ts: number;
}

interface SpotStats {
  binance: number;
  binanceVision: number;
  coinbase: number;
  kraken: number;
  failures: number;
}

const cache = new Map<SpotCoin, CacheEntry>();
const inflight = new Map<SpotCoin, Promise<SpotPrice | null>>();

export const spotStats: SpotStats = {
  binance: 0,
  binanceVision: 0,
  coinbase: 0,
  kraken: 0,
  failures: 0,
};

export function isSpotCoin(value: string): value is SpotCoin {
  return (SPOT_COINS as string[]).includes(value.toUpperCase());
}

async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fromBinance(coin: SpotCoin): Promise<number | null> {
  const data = await fetchJson(
    `https://api.binance.com/api/v3/ticker/price?symbol=${PAIRS[coin].binance}`
  );
  const price = parseFloat(data?.price);
  if (Number.isFinite(price) && price > 0) {
    spotStats.binance++;
    return price;
  }
  return null;
}

async function fromBinanceVision(coin: SpotCoin): Promise<number | null> {
  const data = await fetchJson(
    `https://data-api.binance.vision/api/v3/ticker/price?symbol=${PAIRS[coin].binanceVision}`
  );
  const price = parseFloat(data?.price);
  if (Number.isFinite(price) && price > 0) {
    spotStats.binanceVision++;
    return price;
  }
  return null;
}

async function fromCoinbase(coin: SpotCoin): Promise<number | null> {
  const data = await fetchJson(
    `https://api.coinbase.com/v2/prices/${PAIRS[coin].coinbase}/spot`
  );
  const price = parseFloat(data?.data?.amount);
  if (Number.isFinite(price) && price > 0) {
    spotStats.coinbase++;
    return price;
  }
  return null;
}

async function fromKraken(coin: SpotCoin): Promise<number | null> {
  const pair = PAIRS[coin].kraken;
  const data = await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  const key = data?.result ? Object.keys(data.result)[0] : undefined;
  const price = key ? parseFloat(data.result[key]?.c?.[0]) : NaN;
  if (Number.isFinite(price) && price > 0) {
    spotStats.kraken++;
    return price;
  }
  return null;
}

/** Sources interrogées dans l'ordre (primaire → fallbacks). */
const SOURCES: Array<{ name: string; fn: (c: SpotCoin) => Promise<number | null> }> = [
  { name: 'binance', fn: fromBinance },
  { name: 'binance-vision', fn: fromBinanceVision },
  { name: 'coinbase', fn: fromCoinbase },
  { name: 'kraken', fn: fromKraken },
];

async function fetchFresh(coin: SpotCoin): Promise<SpotPrice | null> {
  for (const source of SOURCES) {
    const price = await source.fn(coin);
    if (price && price > 0) {
      const entry: CacheEntry = { price, source: source.name, ts: Date.now() };
      cache.set(coin, entry);
      return { price, source: source.name, ageMs: 0 };
    }
  }
  spotStats.failures++;
  return null;
}

/**
 * Prix spot courant pour une coin.
 *
 * Renvoie la valeur en cache si elle a moins de `maxAgeMs`, sinon relance une
 * requête REST (les appels concurrents sont dédupliqués). Renvoie `null` si
 * toutes les sources échouent — l'appelant ne doit JAMAIS bloquer pour autant
 * et doit se contenter d'un WARN throttlé.
 */
export async function getSpotPrice(
  coin: SpotCoin,
  options: { maxAgeMs?: number } = {}
): Promise<SpotPrice | null> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const cached = cache.get(coin);
  if (cached && Date.now() - cached.ts <= maxAgeMs) {
    return { price: cached.price, source: cached.source, ageMs: Date.now() - cached.ts };
  }

  const existing = inflight.get(coin);
  if (existing) {
    const res = await existing;
    if (res) return { price: res.price, source: res.source, ageMs: 0 };
    if (cached) return { price: cached.price, source: `${cached.source}(stale)`, ageMs: Date.now() - cached.ts };
    return null;
  }

  const promise = fetchFresh(coin).finally(() => inflight.delete(coin));
  inflight.set(coin, promise);

  const res = await promise;
  if (res) return res;
  // Dernier recours : renvoyer une valeur périmée plutôt que rien.
  if (cached) return { price: cached.price, source: `${cached.source}(stale)`, ageMs: Date.now() - cached.ts };
  return null;
}

/** Valeur en cache sans I/O (0 si inconnue). */
export function getCachedSpotPrice(coin: SpotCoin): number {
  return cache.get(coin)?.price ?? 0;
}

/** Âge (ms) de la valeur en cache, ou Infinity si aucune. */
export function getSpotAgeMs(coin: SpotCoin): number {
  const cached = cache.get(coin);
  return cached ? Date.now() - cached.ts : Infinity;
}

/** Alimente le cache depuis une autre source (ex. le WebSocket s'il revient). */
export function primeSpotPrice(coin: SpotCoin, price: number, source = 'websocket'): void {
  if (!Number.isFinite(price) || price <= 0) return;
  cache.set(coin, { price, source, ts: Date.now() });
}

/** Formatage compact d'un prix spot (BTC/ETH en $xx,xxx, altcoins en décimal). */
export function formatSpotPrice(coin: SpotCoin, price: number): string {
  if (!Number.isFinite(price) || price <= 0) return '$n/a';
  if (price >= 10) return `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${price.toFixed(4)}`;
}
