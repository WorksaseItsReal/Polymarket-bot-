/**
 * round-market-data.ts — spot, strike et volatilité d'un round Up/Down 5 min,
 * lus sur UNE SEULE source de bougies 1 min.
 *
 * Pourquoi une seule source : spot et strike doivent venir du même carnet. Mélanger
 * un strike Binance (USDT) et un spot Coinbase (USD) injecterait l'écart USDT/USD
 * (plusieurs bps) directement dans ln(S/K) — du même ordre que les mouvements que
 * le modèle cherche à mesurer.
 *
 * Une requête `klines?interval=1m&limit=61` suffit :
 *   - strike = OPEN de la bougie qui commence au slot du round (même méthode que
 *     dip-arb-service / paperbot-recap.py) ;
 *   - spot   = CLOSE de la bougie en cours (dernier prix échangé) ;
 *   - σ      = vol réalisée des clôtures 1 min (max de la dernière heure et des
 *              15 dernières minutes : on suit un pic de vol, on n'en sort pas trop tôt).
 *
 * Aucune valeur par défaut : toute donnée absente, périmée ou incohérente → null.
 */

import { realizedVolPerSqrtSec } from './fair-value.js';
import type { SpotCoin } from './spot-price-service.js';
import type { LivePrice } from './spot-stream.js';

interface Candle {
  openTimeMs: number;
  open: number;
  close: number;
}

export interface RoundMarketData {
  spot: number;
  strike: number;
  sigmaPerSqrtSec: number;
  source: string;
  /** Âge de la bougie courante (ms) au moment de la lecture. */
  candleAgeMs: number;
}

const PAIRS: Record<SpotCoin, { binance: string; coinbase: string }> = {
  BTC: { binance: 'BTCUSDT', coinbase: 'BTC-USD' },
  ETH: { binance: 'ETHUSDT', coinbase: 'ETH-USD' },
  SOL: { binance: 'SOLUSDT', coinbase: 'SOL-USD' },
  XRP: { binance: 'XRPUSDT', coinbase: 'XRP-USD' },
  DOGE: { binance: 'DOGEUSDT', coinbase: 'DOGE-USD' },
};

const FETCH_TIMEOUT_MS = 3500;
/** Sans flux temps réel, le spot vient de la bougie courante : cache court. */
const CACHE_MS = 3000;
/** Avec flux temps réel, les bougies ne servent qu'au strike et à la vol : cache long. */
const CACHE_MS_WITH_LIVE = 30_000;
/** Un prix temps réel plus vieux que ça est ignoré (repli sur la bougie). */
const LIVE_MAX_AGE_MS = 3000;
/** Une bougie « courante » plus vieille que ça signifie un flux figé. */
const MAX_CANDLE_AGE_MS = 120_000;

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseBinance(data: unknown): Candle[] | null {
  if (!Array.isArray(data)) return null;
  const out: Candle[] = [];
  for (const k of data) {
    if (!Array.isArray(k)) continue;
    const c = { openTimeMs: Number(k[0]), open: parseFloat(k[1] as string), close: parseFloat(k[4] as string) };
    if (Number.isFinite(c.openTimeMs) && c.open > 0 && c.close > 0) out.push(c);
  }
  return out.length ? out.sort((a, b) => a.openTimeMs - b.openTimeMs) : null;
}

/** Coinbase : [time(s), low, high, open, close, volume], du plus récent au plus ancien. */
function parseCoinbase(data: unknown): Candle[] | null {
  if (!Array.isArray(data)) return null;
  const out: Candle[] = [];
  for (const k of data) {
    if (!Array.isArray(k)) continue;
    const c = { openTimeMs: Number(k[0]) * 1000, open: Number(k[3]), close: Number(k[4]) };
    if (Number.isFinite(c.openTimeMs) && c.open > 0 && c.close > 0) out.push(c);
  }
  return out.length ? out.sort((a, b) => a.openTimeMs - b.openTimeMs) : null;
}

async function fetchCandles(coin: SpotCoin): Promise<{ candles: Candle[]; source: string } | null> {
  const p = PAIRS[coin];
  const sources: Array<{ name: string; url: string; parse: (d: unknown) => Candle[] | null }> = [
    { name: 'binance', url: `https://api.binance.com/api/v3/klines?symbol=${p.binance}&interval=1m&limit=61`, parse: parseBinance },
    { name: 'binance-vision', url: `https://data-api.binance.vision/api/v3/klines?symbol=${p.binance}&interval=1m&limit=61`, parse: parseBinance },
    { name: 'coinbase', url: `https://api.exchange.coinbase.com/products/${p.coinbase}/candles?granularity=60`, parse: parseCoinbase },
  ];
  for (const s of sources) {
    const candles = s.parse(await fetchJson(s.url));
    if (candles && candles.length >= 16) return { candles: candles.slice(-61), source: s.name };
  }
  return null;
}

/**
 * Calcul pur à partir de bougies déjà chargées (exporté pour les tests).
 * `nowMs` et `slotSec` sont explicites : aucune horloge implicite.
 */
export function deriveRoundData(
  candles: Candle[],
  slotSec: number,
  nowMs: number,
  source: string,
): RoundMarketData | null {
  if (!candles.length || !(slotSec > 0)) return null;
  const last = candles[candles.length - 1];
  const candleAgeMs = nowMs - last.openTimeMs;
  // Bougie courante = minute en cours (0–60 s), tolérance pour une source un peu lente.
  if (!(candleAgeMs >= 0 && candleAgeMs <= MAX_CANDLE_AGE_MS)) return null;
  const startCandle = candles.find(c => c.openTimeMs === slotSec * 1000);
  if (!startCandle) return null;
  // Vol sur bougies CLOSES uniquement (la courante est partielle).
  const closed = candles.slice(0, -1).map(c => c.close);
  const volLong = realizedVolPerSqrtSec(closed, 60, 10);
  const volShort = realizedVolPerSqrtSec(closed.slice(-16), 60, 10);
  const sigma = Math.max(volLong ?? 0, volShort ?? 0);
  if (!(sigma > 0)) return null;
  return { spot: last.close, strike: startCandle.open, sigmaPerSqrtSec: sigma, source, candleAgeMs };
}

const cache = new Map<SpotCoin, { ts: number; value: { candles: Candle[]; source: string } | null }>();

/**
 * Données du round commencé à `slotSec` pour `coin`. null si le round n'a pas
 * commencé, si les sources sont indisponibles ou si le flux est périmé.
 *
 * `live` : prix temps réel (flux WebSocket Binance). Utilisé comme spot UNIQUEMENT si
 * les bougies viennent aussi de Binance (même marché que le strike) et s'il a moins de
 * 3 s ; sinon le spot reste la clôture de la bougie courante.
 */
export async function getRoundMarketData(
  coin: SpotCoin,
  slotSec: number,
  nowMs = Date.now(),
  live: LivePrice | null = null,
): Promise<RoundMarketData | null> {
  if (slotSec * 1000 > nowMs) return null; // round pas encore ouvert : strike inconnu
  const liveOk = !!live && live.price > 0 && live.ageMs >= 0 && live.ageMs <= LIVE_MAX_AGE_MS;
  const hit = cache.get(coin);
  const maxAge = liveOk && hit?.value?.source.startsWith('binance') ? CACHE_MS_WITH_LIVE : CACHE_MS;
  let loaded = hit && nowMs - hit.ts < maxAge ? hit.value : undefined;
  const fromCache = loaded !== undefined;
  if (loaded === undefined) {
    loaded = await fetchCandles(coin);
    cache.set(coin, { ts: nowMs, value: loaded });
  }
  if (!loaded) return null;
  let base = deriveRoundData(loaded.candles, slotSec, nowMs, loaded.source);
  if (!base && fromCache) {
    // Cache antérieur au début du round (bougie du strike absente) : on relit une fois.
    loaded = await fetchCandles(coin);
    cache.set(coin, { ts: nowMs, value: loaded });
    if (!loaded) return null;
    base = deriveRoundData(loaded.candles, slotSec, nowMs, loaded.source);
  }
  if (!base) return null;
  if (liveOk && loaded.source.startsWith('binance')) {
    return { ...base, spot: (live as LivePrice).price, source: `${loaded.source}+ws` };
  }
  return base;
}

/** Vide le cache (tests). */
export function clearRoundDataCache(): void {
  cache.clear();
}
