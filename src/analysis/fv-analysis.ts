/**
 * fv-analysis.ts — analyse du journal des décisions une fois les rounds réglés.
 *
 * Trois questions, dans l'ordre où il faut se les poser :
 *   1. Le modèle prédit-il MIEUX que le marché ? (score de Brier modèle vs prix médian)
 *      Si non, aucun seuil ne rendra la stratégie rentable : le carnet sait déjà tout.
 *   2. Le modèle est-il CALIBRÉ ? (« 70 % » doit gagner ~70 % du temps)
 *   3. Quels seuils (edge min, probabilité min) auraient rapporté, et ce résultat
 *      tient-il sur les DEUX moitiés de l'échantillon ? Un seuil qui ne marche que sur
 *      une moitié est du sur-ajustement.
 *
 * Simplification assumée : un pari est rejoué au meilleur ask journalisé (la profondeur
 * n'est pas consommée) ; un seul pari par round, à la première évaluation qualifiante,
 * comme le bot.
 *
 * Fonctions PURES.
 */

import { effectiveCostPerShare, normCdf, normInv } from '../services/fair-value.js';
import type { DecisionRecord } from '../services/decision-journal.js';

export interface ResolvedRecord extends DecisionRecord {
  upWon: boolean;
}

/** Probabilité « Up » implicite du carnet : milieu entre l'ask Up et (1 − ask Down). */
export function marketProbUp(r: Pick<DecisionRecord, 'upAsk' | 'downAsk'>): number | null {
  if (!(r.upAsk && r.upAsk > 0 && r.upAsk < 1 && r.downAsk && r.downAsk > 0 && r.downAsk < 1)) return null;
  return Math.min(1, Math.max(0, (r.upAsk + (1 - r.downAsk)) / 2));
}

export function brier(records: ResolvedRecord[], p: (r: ResolvedRecord) => number | null): { n: number; score: number | null } {
  let n = 0;
  let sum = 0;
  for (const r of records) {
    const v = p(r);
    if (v === null || !Number.isFinite(v)) continue;
    sum += (v - (r.upWon ? 1 : 0)) ** 2;
    n++;
  }
  return { n, score: n ? sum / n : null };
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  freqUp: number;
}

export function calibration(records: ResolvedRecord[], p: (r: ResolvedRecord) => number | null, bins = 10): CalibrationBin[] {
  const acc = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, sumP: 0, up: 0 }));
  for (const r of records) {
    const v = p(r);
    if (v === null || !Number.isFinite(v)) continue;
    const b = acc[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))];
    b.n++;
    b.sumP += v;
    if (r.upWon) b.up++;
  }
  return acc.filter(b => b.n > 0).map(b => ({ lo: b.lo, hi: b.hi, n: b.n, meanP: b.sumP / b.n, freqUp: b.up / b.n }));
}

export interface ScanParams {
  feeRate: number;
  minAsk: number;
  maxAsk: number;
  minTau?: number;
  maxTau?: number;
}

export interface ScanResult {
  minEdge: number;
  minProb: number;
  n: number;
  wins: number;
  winRate: number | null;
  /** PnL moyen par 1 $ misé. */
  evPerDollar: number | null;
  /** PnL total pour 1 $ misé par pari. */
  total: number;
  tStat: number | null;
}

/** Évaluations regroupées par round, triées dans le temps. */
export function byRound(records: ResolvedRecord[]): ResolvedRecord[][] {
  const m = new Map<string, ResolvedRecord[]>();
  for (const r of records) (m.get(r.slug) ?? m.set(r.slug, []).get(r.slug)!).push(r);
  return [...m.values()].map(list => list.sort((a, b) => a.t - b.t));
}

/** Rejoue la règle du bot pour un couple de seuils : premier pari qualifiant par round. */
export function replay(rounds: ResolvedRecord[][], minEdge: number, minProb: number, p: ScanParams): ScanResult {
  const pnls: number[] = [];
  let wins = 0;
  for (const list of rounds) {
    for (const r of list) {
      if (r.pUp === null) continue;
      if (p.minTau !== undefined && r.tau < p.minTau) continue;
      if (p.maxTau !== undefined && r.tau > p.maxTau) continue;
      const cands: Array<{ up: boolean; prob: number; ask: number }> = [];
      if (r.upAsk !== null) cands.push({ up: true, prob: r.pUp, ask: r.upAsk });
      if (r.downAsk !== null) cands.push({ up: false, prob: 1 - r.pUp, ask: r.downAsk });
      let best: { up: boolean; cost: number; edge: number } | null = null;
      for (const c of cands) {
        if (!(c.ask >= p.minAsk && c.ask <= p.maxAsk) || c.prob < minProb) continue;
        const cost = effectiveCostPerShare(c.ask, p.feeRate);
        const edge = c.prob - cost;
        if (edge >= minEdge && (!best || edge > best.edge)) best = { up: c.up, cost, edge };
      }
      if (!best) continue;
      const won = best.up === r.upWon;
      pnls.push(won ? 1 / best.cost - 1 : -1);
      if (won) wins++;
      break; // un seul pari par round
    }
  }
  const n = pnls.length;
  const total = pnls.reduce((a, b) => a + b, 0);
  const mean = n ? total / n : null;
  let tStat: number | null = null;
  if (n >= 2 && mean !== null) {
    const v = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    if (v > 0) tStat = mean / Math.sqrt(v / n);
  }
  return { minEdge, minProb, n, wins, winRate: n ? wins / n : null, evPerDollar: mean, total, tStat };
}

export function thresholdGrid(
  rounds: ResolvedRecord[][],
  edges: number[],
  probs: number[],
  p: ScanParams,
): ScanResult[] {
  const out: ScanResult[] = [];
  for (const e of edges) for (const q of probs) out.push(replay(rounds, e, q, p));
  return out;
}

/** Sépare les rounds en deux moitiés chronologiques (pour tester la stabilité). */
export function halves(rounds: ResolvedRecord[][]): [ResolvedRecord[][], ResolvedRecord[][]] {
  const sorted = [...rounds].sort((a, b) => a[0].t - b[0].t);
  const mid = Math.floor(sorted.length / 2);
  return [sorted.slice(0, mid), sorted.slice(mid)];
}

export interface ZScaleFit {
  /** Nombre de rounds utilisés (une évaluation par round). */
  n: number;
  /** Multiplicateur optimal à appliquer au z ENREGISTRÉ. */
  m: number;
  /** Intervalle de confiance 95 % (rapport de vraisemblance). */
  lo: number;
  hi: number;
}

/**
 * Calibration à un paramètre : trouve m maximisant la vraisemblance de P(Up) = Φ(m·z),
 * où z = Φ⁻¹(pUp enregistré). Une évaluation par round (la plus proche de τ = 150 s)
 * pour ne pas compter plusieurs fois le même résultat. m < 1 : modèle sur-confiant.
 * Le réglage suggéré est FV_Z_SCALE(actuel) × m.
 */
export function fitZScale(rounds: ResolvedRecord[][], tauRef = 150): ZScaleFit | null {
  const pts: Array<{ z: number; y: number }> = [];
  for (const list of rounds) {
    let best: ResolvedRecord | null = null;
    for (const r of list) {
      if (r.pUp === null) continue;
      if (!best || Math.abs(r.tau - tauRef) < Math.abs(best.tau - tauRef)) best = r;
    }
    const z = best ? normInv(Math.min(0.999, Math.max(0.001, best.pUp as number))) : null;
    if (best && z !== null) pts.push({ z, y: best.upWon ? 1 : 0 });
  }
  if (pts.length < 30) return null;
  const ll = (m: number) => {
    let s = 0;
    for (const { z, y } of pts) {
      const p = Math.min(1 - 1e-9, Math.max(1e-9, normCdf(m * z)));
      s += y ? Math.log(p) : Math.log(1 - p);
    }
    return s;
  };
  // Recherche par grille fine sur [0,2 ; 3] (fonction concave en m : un seul maximum).
  let m = 1;
  let best = -Infinity;
  for (let k = 0.2; k <= 3.0001; k += 0.005) {
    const v = ll(k);
    if (v > best) { best = v; m = k; }
  }
  const inside = (k: number) => 2 * (best - ll(k)) <= 3.84;
  let lo = m;
  while (lo > 0.2 && inside(lo - 0.005)) lo -= 0.005;
  let hi = m;
  while (hi < 3 && inside(hi + 0.005)) hi += 0.005;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { n: pts.length, m: r3(m), lo: r3(lo), hi: r3(hi) };
}
