/**
 * historical-backtest.ts — le modèle bat-il les prix Polymarket ? Mesuré sur l'HISTORIQUE.
 *
 * Le journal des décisions répond à cette question en quelques jours. Ce module y répond
 * en une heure, sur des milliers de rounds passés :
 *   - prix Polymarket : historique `prices-history` du token « Up » (un point par minute) ;
 *   - modèle : même calcul que le bot (strike = ouverture de la bougie Binance 1 min du
 *     slot, spot = clôture de la bougie qui se termine à l'instant évalué, vol réalisée) ;
 *   - issue réelle : résolution Gamma.
 * On compare aux mêmes instants (τ = 240, 180, 120, 60 s) les erreurs quadratiques (Brier)
 * du modèle et du marché, la calibration, plusieurs estimateurs de volatilité, et on
 * rejoue les seuils sur des asks RECONSTITUÉS (prix moyen + demi-écart) — indicatif
 * seulement : l'historique ne contient ni carnet ni profondeur.
 *
 * Fonctions PURES (aucune I/O).
 */

import { probUp, realizedVolPerSqrtSec, type FairValueConfig } from '../services/fair-value.js';
import type { Candle } from '../services/round-market-data.js';
import type { ResolvedRecord } from './fv-analysis.js';

export interface PricePoint {
  /** secondes epoch */
  t: number;
  p: number;
}

/** `{history: [{t, p}]}` ou tableau nu ; t et p en nombre ou en texte. Trié par t. */
export function parsePriceHistory(data: unknown): PricePoint[] {
  const raw = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { history?: unknown }).history)
      ? (data as { history: unknown[] }).history
      : [];
  const out: PricePoint[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    let t = Number((x as { t?: unknown }).t);
    const p = Number((x as { p?: unknown }).p);
    if (!Number.isFinite(t) || !Number.isFinite(p) || p < 0 || p > 1) continue;
    if (t > 1e12) t = Math.floor(t / 1000); // millisecondes → secondes
    out.push({ t, p });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Dernier prix connu à `tSec`, s'il date de moins de `maxStaleSec`. */
export function marketProbAt(history: PricePoint[], tSec: number, maxStaleSec = 90): number | null {
  let best: PricePoint | null = null;
  for (const pt of history) {
    if (pt.t > tSec) break;
    best = pt;
  }
  return best && tSec - best.t <= maxStaleSec ? best.p : null;
}

export interface HistoricalRound {
  slug: string;
  coin: string;
  slotSec: number;
  upWon: boolean;
}

/** Estimateurs de volatilité comparés (par √seconde, depuis des clôtures 1 min). */
export const VOL_VARIANTS: Record<string, (closes: number[]) => number | null> = {
  'max(60,15)': closes => {
    const a = realizedVolPerSqrtSec(closes, 60, 10);
    const b = realizedVolPerSqrtSec(closes.slice(-16), 60, 10);
    const m = Math.max(a ?? 0, b ?? 0);
    return m > 0 ? m : null;
  },
  '60 min': closes => realizedVolPerSqrtSec(closes, 60, 10),
  '15 min': closes => realizedVolPerSqrtSec(closes.slice(-16), 60, 10),
};
export const LIVE_VARIANT = 'max(60,15)';

export interface BacktestPoint {
  slug: string;
  coin: string;
  slotSec: number;
  tau: number;
  spot: number;
  strike: number;
  /** σ de la variante du bot (par √s). */
  sig: number;
  pMarket: number;
  /** P(Up) du modèle selon chaque estimateur de vol. */
  pModel: Record<string, number | null>;
  upWon: boolean;
}

export const DEFAULT_TAUS = [240, 180, 120, 60];

/**
 * Points d'évaluation d'un round. `candles` : bougies Binance 1 min (triées ou non) qui
 * couvrent au moins l'heure précédant le round et le round lui-même.
 */
export function evaluateRound(
  round: HistoricalRound,
  candles: Candle[],
  history: PricePoint[],
  cfg: FairValueConfig,
  taus: number[] = DEFAULT_TAUS,
): BacktestPoint[] {
  const byOpen = new Map(candles.map(c => [c.openTimeMs, c]));
  const strikeCandle = byOpen.get(round.slotSec * 1000);
  if (!strikeCandle) return [];
  const sorted = [...candles].sort((a, b) => a.openTimeMs - b.openTimeMs);
  const out: BacktestPoint[] = [];
  for (const tau of taus) {
    const tSec = round.slotSec + 300 - tau;
    const spotCandle = byOpen.get((tSec - 60) * 1000); // se termine à tSec
    if (!spotCandle) continue;
    const pMarket = marketProbAt(history, tSec);
    if (pMarket === null) continue;
    // Clôtures des bougies terminées à tSec (les 61 dernières → 60 rendements).
    const closes = sorted.filter(c => c.openTimeMs <= (tSec - 60) * 1000).slice(-61).map(c => c.close);
    const pModel: Record<string, number | null> = {};
    let sig = 0;
    for (const [name, f] of Object.entries(VOL_VARIANTS)) {
      const s = f(closes);
      if (name === LIVE_VARIANT && s) sig = s;
      pModel[name] = s ? probUp({ spot: spotCandle.close, strike: strikeCandle.open, sigmaPerSqrtSec: s, tauSec: tau }, cfg) : null;
    }
    if (pModel[LIVE_VARIANT] === null) continue;
    out.push({
      slug: round.slug, coin: round.coin, slotSec: round.slotSec, tau, spot: spotCandle.close, strike: strikeCandle.open,
      sig, pMarket, pModel, upWon: round.upWon,
    });
  }
  return out;
}

export interface BrierComparison {
  rounds: number;
  points: number;
  brierModel: number | null;
  brierMarket: number | null;
  /** t de la différence appariée PAR ROUND (négatif = modèle meilleur). */
  tDiff: number | null;
}

/** Brier modèle (variante) vs marché, différence moyennée par round (points corrélés). */
export function compareBrier(points: BacktestPoint[], variant = LIVE_VARIANT): BrierComparison {
  const perRound = new Map<string, { d: number; n: number; m: number; k: number }>();
  let sm = 0;
  let sk = 0;
  let n = 0;
  for (const pt of points) {
    const pm = pt.pModel[variant];
    if (pm === null || pm === undefined) continue;
    const y = pt.upWon ? 1 : 0;
    const bm = (pm - y) ** 2;
    const bk = (pt.pMarket - y) ** 2;
    sm += bm;
    sk += bk;
    n++;
    const r = perRound.get(pt.slug) ?? { d: 0, n: 0, m: 0, k: 0 };
    r.d += bm - bk;
    r.n++;
    perRound.set(pt.slug, r);
  }
  const ds = [...perRound.values()].map(r => r.d / r.n);
  let tDiff: number | null = null;
  if (ds.length >= 2) {
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const v = ds.reduce((a, b) => a + (b - mean) ** 2, 0) / (ds.length - 1);
    if (v > 0) tDiff = mean / Math.sqrt(v / ds.length);
  }
  return { rounds: perRound.size, points: n, brierModel: n ? sm / n : null, brierMarket: n ? sk / n : null, tDiff };
}

/**
 * Convertit en enregistrements « journal » pour réutiliser l'analyse (calibration,
 * seuils, FV_Z_SCALE). Les asks sont RECONSTITUÉS : prix + demi-écart, arrondis au tick
 * supérieur — approximation optimiste d'un carnet réel (profondeur ignorée).
 */
export function toResolvedRecords(points: BacktestPoint[], halfSpread = 0.005): ResolvedRecord[] {
  const tick = (x: number) => Math.min(0.99, Math.max(0.01, Math.ceil(x * 100 - 1e-9) / 100));
  return points.map(pt => ({
    t: (pt.slotSec + 300 - pt.tau) * 1000, slug: pt.slug, coin: pt.coin, tau: pt.tau, spot: pt.spot, strike: pt.strike,
    sig: pt.sig, pUp: pt.pModel[LIVE_VARIANT] ?? null,
    upAsk: tick(pt.pMarket + halfSpread), downAsk: tick(1 - pt.pMarket + halfSpread),
    upAskSz: null, downAskSz: null, src: 'historique', act: 'hold' as const, upWon: pt.upWon,
  }));
}
