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
 *   - strike : voir `strikeFromCandles` (moyenne de la minute précédant l'ouverture depuis
 *     le règlement TWAP d'août 2026 ; auparavant OPEN de la bougie du slot, même méthode que
 *     dip-arb-service / paperbot-recap.py) ;
 *   - spot   = CLOSE de la bougie en cours (dernier prix échangé) ;
 *   - σ      = vol réalisée des clôtures 1 min (max de la dernière heure et des
 *              15 dernières minutes : on suit un pic de vol, on n'en sort pas trop tôt).
 *
 * Aucune valeur par défaut : toute donnée absente, périmée ou incohérente → null.
 */

import { DEFAULT_FAIR_VALUE_CONFIG, parkinsonVolPerSqrtSec, realizedVolPerSqrtSec, selectSigma, type VolEstimator } from './fair-value.js';
import type { SpotCoin } from './spot-price-service.js';
import type { LivePrice } from './spot-stream.js';

export interface Candle {
  openTimeMs: number;
  open: number;
  close: number;
  /** Plus haut / plus bas de la minute (absents ou incohérents : estimation (O+C)/2). */
  high?: number;
  low?: number;
}

export interface RoundMarketData {
  spot: number;
  strike: number;
  sigmaPerSqrtSec: number;
  source: string;
  /** Âge de la bougie courante (ms) au moment de la lecture. */
  candleAgeMs: number;
  /** σ clôture-à-clôture et σ Parkinson (plus haut/plus bas), toujours calculés (null si les
   *  bougies ne le permettent pas) : journalisés pour comparer les estimateurs (rapport 1c). */
  sigmaCcPerSqrtSec?: number | null;
  sigmaParkPerSqrtSec?: number | null;
  /** Dernière minute du round, flux temps réel Binance : moyenne du prix déjà acquise sur la
   *  fenêtre de règlement et secondes couvertes (mesure « fin de round », jamais d'entrée). */
  twapPartial?: { mean: number; knownSec: number } | null;
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
/** Une bougie « courante » plus vieille que ça signifie un flux figé (bougies = strike/vol). */
const MAX_CANDLE_AGE_MS = 120_000;
/** Sans flux temps réel, le spot EST la clôture de la dernière bougie : elle doit être celle
 *  de la minute en cours (sinon le spot peut avoir 1 à 2 min de retard sur le carnet et
 *  fabriquer de faux edges juste après un mouvement). */
const MAX_CANDLE_AGE_SPOT_MS = 65_000;

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

export function parseBinance(data: unknown): Candle[] | null {
  if (!Array.isArray(data)) return null;
  const out: Candle[] = [];
  for (const k of data) {
    if (!Array.isArray(k)) continue;
    const c = { openTimeMs: Number(k[0]), open: parseFloat(k[1] as string), close: parseFloat(k[4] as string),
      high: parseFloat(k[2] as string), low: parseFloat(k[3] as string) };
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
    const c = { openTimeMs: Number(k[0]) * 1000, open: Number(k[3]), close: Number(k[4]), high: Number(k[2]), low: Number(k[1]) };
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
 * Strike (« prix à battre ») estimé depuis les bougies 1 min.
 *  - `twapWindowSec` = 0 (ancien règlement ponctuel) : open de la bougie du slot.
 *  - W > 0 (règlement TWAP Chainlink depuis août 2026) : le prix à battre est la moyenne
 *    des W secondes qui PRÉCÈDENT l'ouverture. Estimée par (O+H+L+C)/4 de la bougie
 *    [T0 − 60 s, T0) — erreur ≈ 0,19·σ√60 contre 0,58·σ√60 pour l'open du slot (mouvement
 *    brownien, simulation) — et ramenée vers la clôture pour W < 60. Sans plus haut/plus
 *    bas cohérents : (O+C)/2 (erreur 0,29·σ√60).
 * null si la bougie nécessaire manque (jamais d'approximation silencieuse).
 */
export function strikeFromCandles(
  candleAt: (openTimeMs: number) => Candle | undefined,
  slotSec: number,
  twapWindowSec: number,
): number | null {
  const W = Math.min(60, Math.max(0, twapWindowSec));
  if (W === 0) {
    const c = candleAt(slotSec * 1000);
    return c && c.open > 0 ? c.open : null;
  }
  const prev = candleAt(slotSec * 1000 - 60_000);
  if (!prev || !(prev.open > 0) || !(prev.close > 0)) return null;
  const { open: o, close: c, high: h, low: l } = prev;
  const hlOk = typeof h === 'number' && typeof l === 'number' && h >= Math.max(o, c) && l <= Math.min(o, c) && l > 0;
  const mean60 = hlOk ? (o + (h as number) + (l as number) + c) / 4 : (o + c) / 2;
  return c + (mean60 - c) * (W / 60);
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
  maxCandleAgeMs = MAX_CANDLE_AGE_SPOT_MS,
  twapWindowSec = DEFAULT_FAIR_VALUE_CONFIG.twapWindowSec,
  estimator: VolEstimator = 'cc',
): RoundMarketData | null {
  if (!candles.length || !(slotSec > 0)) return null;
  const last = candles[candles.length - 1];
  const candleAgeMs = nowMs - last.openTimeMs;
  // Bougie courante = minute en cours (0–60 s), petite tolérance pour une source lente.
  if (!(candleAgeMs >= 0 && candleAgeMs <= maxCandleAgeMs)) return null;
  // La bougie du slot doit exister même avec TWAP : elle prouve que les données ont été
  // lues APRÈS l'ouverture (bougie précédente close, donc définitive).
  if (!candles.some(c => c.openTimeMs === slotSec * 1000)) return null;
  const strike = strikeFromCandles(ms => candles.find(c => c.openTimeMs === ms), slotSec, twapWindowSec);
  if (strike === null) return null;
  // Vol sur bougies CLOSES uniquement (la courante est partielle). Deux estimateurs, chacun
  // = max(longue fenêtre, 16 dernières minutes) pour réagir à une hausse de volatilité.
  const closedCandles = candles.slice(0, -1);
  const closed = closedCandles.map(c => c.close);
  const cc = Math.max(realizedVolPerSqrtSec(closed, 60, 10) ?? 0, realizedVolPerSqrtSec(closed.slice(-16), 60, 10) ?? 0) || null;
  const park = Math.max(parkinsonVolPerSqrtSec(closedCandles, 60, 10) ?? 0, parkinsonVolPerSqrtSec(closedCandles.slice(-16), 60, 10) ?? 0) || null;
  const sigma = selectSigma(cc, park, estimator);
  if (!(sigma && sigma > 0)) return null;
  return { spot: last.close, strike, sigmaPerSqrtSec: sigma, source, candleAgeMs, sigmaCcPerSqrtSec: cc, sigmaParkPerSqrtSec: park };
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
  liveInput: LivePrice | null | (() => LivePrice | null) = null,
  twapWindowSec = DEFAULT_FAIR_VALUE_CONFIG.twapWindowSec,
  estimator: VolEstimator = 'cc',
  twapMean: ((fromMs: number, toMs: number) => number | null) | null = null,
): Promise<RoundMarketData | null> {
  if (slotSec * 1000 > nowMs) return null; // round pas encore ouvert : strike inconnu
  // Un getter est relu APRÈS le chargement des bougies (qui peut prendre plusieurs
  // secondes) : sinon le spot temps réel pouvait être plus vieux que le carnet lu ensuite.
  const readLive = () => (typeof liveInput === 'function' ? liveInput() : liveInput);
  const liveOk0 = (l: LivePrice | null) => !!l && l.price > 0 && l.ageMs >= 0 && l.ageMs <= LIVE_MAX_AGE_MS;
  let live = readLive();
  let liveOk = liveOk0(live);
  const hit = cache.get(coin);
  const maxAge = liveOk && hit?.value?.source.startsWith('binance') ? CACHE_MS_WITH_LIVE : CACHE_MS;
  let loaded = hit && nowMs - hit.ts < maxAge ? hit.value : undefined;
  const fromCache = loaded !== undefined;
  let loadedAt = fromCache ? (hit as { ts: number }).ts : nowMs;
  if (loaded === undefined) {
    loaded = await fetchCandles(coin);
    cache.set(coin, { ts: nowMs, value: loaded });
  }
  if (!loaded) return null;
  // Avec un spot temps réel, la bougie ne sert qu'au strike et à la vol : âge toléré plus long.
  const useLive = () => liveOk && !!loaded && loaded.source.startsWith('binance');
  const maxCandleAge = () => (useLive() ? MAX_CANDLE_AGE_MS : MAX_CANDLE_AGE_SPOT_MS);
  let base = deriveRoundData(loaded.candles, slotSec, nowMs, loaded.source, maxCandleAge(), twapWindowSec, estimator);
  if (!base && fromCache) {
    // Cache antérieur au début du round (bougie du strike absente) ou trop vieux : on relit.
    loaded = await fetchCandles(coin);
    cache.set(coin, { ts: nowMs, value: loaded });
    loadedAt = nowMs;
    if (!loaded) return null;
    base = deriveRoundData(loaded.candles, slotSec, nowMs, loaded.source, maxCandleAge(), twapWindowSec, estimator);
  }
  if (!base) return null;
  live = readLive();
  const assumedLive = useLive();
  liveOk = liveOk0(live);
  if (assumedLive && !useLive()) {
    // Le flux temps réel a décroché pendant le chargement : le spot sera la clôture de
    // bougie → mêmes exigences qu'en mode REST (bougie de la minute en cours, cache court).
    if (nowMs - loadedAt >= CACHE_MS) {
      const fresh = await fetchCandles(coin);
      if (!fresh) return null; // ne pas écraser un cache valide par un échec
      cache.set(coin, { ts: nowMs, value: fresh });
      loaded = fresh;
    }
    return deriveRoundData(loaded.candles, slotSec, nowMs, loaded.source, MAX_CANDLE_AGE_SPOT_MS, twapWindowSec, estimator);
  }
  if (liveOk && loaded.source.startsWith('binance')) {
    // Dernière minute : part déjà acquise du TWAP de règlement, sur le même flux que le spot.
    const endMs = slotSec * 1000 + 300_000;
    const W = Math.min(60, Math.max(0, twapWindowSec));
    let twapPartial: { mean: number; knownSec: number } | null = null;
    if (twapMean && W > 0 && nowMs < endMs && nowMs > endMs - W * 1000) {
      const from = endMs - W * 1000;
      const mean = twapMean(from, nowMs);
      if (mean !== null && mean > 0) twapPartial = { mean, knownSec: (nowMs - from) / 1000 };
    }
    return { ...base, spot: (live as LivePrice).price, source: `${loaded.source}+ws`, twapPartial };
  }
  return base;
}

/** Vide le cache (tests). */
export function clearRoundDataCache(): void {
  cache.clear();
}
