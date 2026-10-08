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

import {
  DEFAULT_FAIR_VALUE_CONFIG, blendWithMarket, bookMidUp, effectiveCostPerShare, normCdf, normInv, studentT4CdfStd, studentT4InvStd,
} from '../services/fair-value.js';
import type { DecisionRecord } from '../services/decision-journal.js';
import { clusteredMeanT, slotKey } from './stats.js';

export interface ResolvedRecord extends DecisionRecord {
  upWon: boolean;
}

/** Probabilité du modèle SEUL (avant mélange) ; les anciens journaux n'ont que pUp. */
export function rawModelProb(r: Pick<DecisionRecord, 'pUp' | 'pRaw'>): number | null {
  return r.pRaw ?? r.pUp;
}

/**
 * Ramène chaque évaluation au réglage FV_Z_SCALE ACTUEL : p' = Φ(zNow · Φ⁻¹(p) / zEnregistré).
 * Sans cela, un journal qui couvre un changement de réglage mélange deux modèles, et les
 * estimations (calibration, mélange, seuils) dérivent à chaque itération.
 */
export function normalizeZScale(rounds: ResolvedRecord[][], zNow: number, tails: 'normal' | 't4' = 'normal'): ResolvedRecord[][] {
  const { cdf } = link(tails);
  return rounds.map(list => list.map(r => {
    const raw = rawModelProb(r);
    const zRec = r.zs ?? 1; // journaux d'avant l'enregistrement du réglage : supposés à 1
    const recTails = r.tl ?? 'normal'; // loi utilisée lors de l'évaluation
    if (raw === null || (zRec === zNow && recTails === tails)) {
      // Rien à changer : même objet (un journal de 30 jours ≈ 1 million d'évaluations ;
      // une copie de chacune à chaque étape saturait la mémoire).
      return r.pRaw === raw && r.zs === zRec ? r : { ...r, pRaw: raw, zs: zRec };
    }
    // z du modèle de base avec la loi de l'évaluation, puis probabilité du modèle ACTUEL
    const z = link(recTails).inv(Math.min(0.999999, Math.max(0.000001, raw)));
    const p = z === null ? raw : cdf((zNow * z) / zRec);
    const { tl: _old, ...rest } = r;
    return { ...rest, pRaw: p, zs: zNow, ...(tails === 't4' ? { tl: 't4' as const } : {}) };
  }));
}

/** Loi du modèle (FV_TAILS) : fonction de répartition et son inverse. */
function link(tails: 'normal' | 't4'): { cdf: (z: number) => number; inv: (p: number) => number | null } {
  return tails === 't4' ? { cdf: studentT4CdfStd, inv: studentT4InvStd } : { cdf: normCdf, inv: normInv };
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
  /** FV_NOISE_EDGE_K : edge exigé = minEdge + noiseK · ns (bruit enregistré par évaluation). */
  noiseK?: number;
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
  const keys: string[] = [];
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
      const required = minEdge + (p.noiseK ?? 0) * (r.ns ?? 0);
      for (const c of cands) {
        if (!(c.ask >= p.minAsk && c.ask <= p.maxAsk) || c.prob < minProb) continue;
        const cost = effectiveCostPerShare(c.ask, p.feeRate);
        const edge = c.prob - cost;
        if (edge >= required && (!best || edge > best.edge)) best = { up: c.up, cost, edge };
      }
      if (!best) continue;
      const won = best.up === r.upWon;
      pnls.push(won ? 1 / best.cost - 1 : -1);
      keys.push(slotKey(r.slug));
      if (won) wins++;
      break; // un seul pari par round
    }
  }
  const n = pnls.length;
  const total = pnls.reduce((a, b) => a + b, 0);
  const mean = n ? total / n : null;
  // t groupé par créneau (les paris sur plusieurs cryptos d'un même round sont corrélés)
  const tStat = clusteredMeanT(pnls.map((x, i) => ({ key: keys[i], x }))).t;
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
  /** FV_Z_SCALE optimal (multiplicateur du z du modèle de base). */
  m: number;
  /** Intervalle de confiance 95 % (rapport de vraisemblance). */
  lo: number;
  hi: number;
}

/**
 * Calibration à un paramètre : trouve m maximisant la vraisemblance de P(Up) = Φ(m·z),
 * où z = Φ⁻¹(pUp enregistré). Une évaluation par round (la plus proche de τ = 150 s)
 * pour ne pas compter plusieurs fois le même résultat. m < 1 : modèle sur-confiant.
 * m est directement la valeur de FV_Z_SCALE à essayer (z ramené au modèle de base).
 */
export function fitZScale(rounds: ResolvedRecord[][], tauRef = 150, tails: 'normal' | 't4' = 'normal'): ZScaleFit | null {
  const { cdf, inv } = link(tails);
  const pts: Array<{ z: number; y: number }> = [];
  for (const list of rounds) {
    let best: ResolvedRecord | null = null;
    for (const r of list) {
      if (rawModelProb(r) === null) continue;
      if (!best || Math.abs(r.tau - tauRef) < Math.abs(best.tau - tauRef)) best = r;
    }
    // FV_Z_SCALE agit sur le modèle seul : on calibre la probabilité AVANT mélange, ramenée au
    // modèle de base (z divisé par le FV_Z_SCALE en vigueur lors de l'évaluation). Le
    // multiplicateur estimé est donc directement la valeur de FV_Z_SCALE à essayer.
    // inverse avec la loi de L'ÉVALUATION (normalement déjà ramenée à la loi actuelle)
    const zRaw = best ? link(best.tl ?? 'normal').inv(Math.min(0.999, Math.max(0.001, rawModelProb(best) as number))) : null;
    const z = zRaw === null || !best ? null : zRaw / (best.zs ?? 1);
    if (best && z !== null) pts.push({ z, y: best.upWon ? 1 : 0 });
  }
  if (pts.length < 30) return null;
  const ll = (m: number) => {
    let s = 0;
    for (const { z, y } of pts) {
      const p = Math.min(1 - 1e-9, Math.max(1e-9, cdf(m * z)));
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

const logit = (p: number) => Math.log(p / (1 - p));
const clampP = (p: number) => Math.min(0.99, Math.max(0.01, p));

export interface BlendPoint {
  slug: string;
  /** logit de la probabilité du modèle seul */
  lm: number;
  /** logit de la probabilité implicite du carnet */
  lk: number;
  y: 0 | 1;
  /** poids = 1 / nombre d'évaluations du round (chaque round compte pour 1) */
  w: number;
}

/** Points exploitables pour le mélange (modèle seul ET carnet connus, τ dans les bornes). */
export function blendPoints(rounds: ResolvedRecord[][], opts: { minTau?: number; maxTau?: number } = {}): BlendPoint[] {
  const out: BlendPoint[] = [];
  for (const list of rounds) {
    const pts: Array<Omit<BlendPoint, 'w'>> = [];
    for (const r of list) {
      if (opts.minTau !== undefined && r.tau < opts.minTau) continue;
      if (opts.maxTau !== undefined && r.tau > opts.maxTau) continue;
      const pm = rawModelProb(r);
      const pk = bookMidUp(r.upAsk, r.downAsk);
      if (pm === null || !Number.isFinite(pm) || pk === null) continue;
      pts.push({ slug: r.slug, lm: logit(clampP(pm)), lk: logit(pk), y: r.upWon ? 1 : 0 });
    }
    for (const p of pts) out.push({ ...p, w: 1 / pts.length });
  }
  return out;
}

const blendProb = (pt: Pick<BlendPoint, 'lm' | 'lk'>, a: number, b: number) => clampP(1 / (1 + Math.exp(-(a * pt.lm + b * pt.lk))));

/** Log-vraisemblance pondérée du mélange (a, b). */
export function blendLogLik(pts: BlendPoint[], a: number, b: number): number {
  // Log-vraisemblance logistique exacte (concave), calculée de façon stable :
  // log σ(x) = x − softplus(x), log(1 − σ(x)) = −softplus(x).
  let s = 0;
  for (const pt of pts) {
    const x = a * pt.lm + b * pt.lk;
    const softplus = x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x));
    s += pt.w * (pt.y * x - softplus);
  }
  return s;
}

/**
 * Maximum de vraisemblance de (a, b) sur [0, 3]² (régression logistique pondérée, sans
 * constante). La vraisemblance est concave : l'optimum contraint est soit l'optimum libre
 * (Newton à 2 paramètres) s'il est dans le domaine, soit sur un bord (Newton à 1 paramètre
 * sur chacun des 4 bords). Quelques passes sur les données au lieu de ~1 400 pour une grille.
 */
export function fitBlendParams(pts: BlendPoint[]): { a: number; b: number } {
  const LIM = 3;
  // Newton sur les paramètres libres ; `fixA`/`fixB` figent un paramètre.
  // Newton amorti : le pas est divisé par deux tant que la vraisemblance baisse (sans
  // cela, un modèle très confiant — logits à ±4,6 — fait diverger le premier pas).
  const newton = (a0: number, b0: number, freeA: boolean, freeB: boolean): { a: number; b: number } | null => {
    let a = a0;
    let b = b0;
    let ll = blendLogLik(pts, a, b);
    for (let it = 0; it < 100; it++) {
      let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
      for (const pt of pts) {
        const p = 1 / (1 + Math.exp(-(a * pt.lm + b * pt.lk)));
        const r = pt.w * (pt.y - p);
        const v = pt.w * p * (1 - p);
        ga += r * pt.lm;
        gb += r * pt.lk;
        haa += v * pt.lm * pt.lm;
        hab += v * pt.lm * pt.lk;
        hbb += v * pt.lk * pt.lk;
      }
      let da = 0;
      let db = 0;
      if (freeA && freeB) {
        const det = haa * hbb - hab * hab;
        if (!(det > 1e-12)) return null;
        da = (hbb * ga - hab * gb) / det;
        db = (haa * gb - hab * ga) / det;
      } else if (freeA) {
        if (!(haa > 1e-12)) return null;
        da = ga / haa;
      } else if (freeB) {
        if (!(hbb > 1e-12)) return null;
        db = gb / hbb;
      }
      let step = 1;
      let next = blendLogLik(pts, a + da, b + db);
      while (!(next >= ll - 1e-12) && step > 1e-8) {
        step /= 2;
        next = blendLogLik(pts, a + step * da, b + step * db);
      }
      if (!(next >= ll - 1e-12)) break; // plus de progrès possible
      a += step * da;
      b += step * db;
      ll = next;
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 50 || Math.abs(b) > 50) return null;
      if (step * (Math.abs(da) + Math.abs(db)) < 1e-10) break;
    }
    return { a, b };
  };
  const clamp = (x: number) => Math.min(LIM, Math.max(0, x));
  const cands: Array<{ a: number; b: number }> = [{ a: 1, b: 0 }];
  const free = newton(0, 0, true, true);
  if (free && free.a >= 0 && free.a <= LIM && free.b >= 0 && free.b <= LIM) {
    cands.push(free);
  } else {
    // Optimum libre hors du domaine (ou introuvable) : le maximum contraint est sur un bord.
    for (const a of [0, LIM]) {
      const e = newton(a, 0, false, true);
      cands.push({ a, b: e ? clamp(e.b) : 0 }, { a, b: LIM });
    }
    for (const b of [0, LIM]) {
      const e = newton(0, b, true, false);
      cands.push({ a: e ? clamp(e.a) : 0, b }, { a: LIM, b });
    }
  }
  let best = cands[0];
  let bestLL = -Infinity;
  for (const c of cands) {
    const ll = blendLogLik(pts, c.a, c.b);
    if (ll > bestLL) { bestLL = ll; best = c; }
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { a: r2(best.a), b: r2(best.b) };
}

export interface BlendScore {
  rounds: number;
  brierModel: number;
  brierMarket: number;
  brierBlend: number;
  /** t apparié PAR ROUND de (Brier mélange − Brier modèle) ; négatif = mélange meilleur. */
  tVsModel: number | null;
  /** idem contre le carnet seul. */
  tVsMarket: number | null;
}

/** Scores de Brier par round (chaque round compte pour 1) du modèle, du carnet et du mélange. */
export function scoreBlend(pts: BlendPoint[], a: number, b: number): BlendScore | null {
  const per = new Map<string, { m: number; k: number; x: number; w: number }>();
  for (const pt of pts) {
    const r = per.get(pt.slug) ?? { m: 0, k: 0, x: 0, w: 0 };
    r.m += pt.w * (blendProb(pt, 1, 0) - pt.y) ** 2;
    r.k += pt.w * (blendProb(pt, 0, 1) - pt.y) ** 2;
    r.x += pt.w * (blendProb(pt, a, b) - pt.y) ** 2;
    r.w += pt.w;
    per.set(pt.slug, r);
  }
  const rows = [...per.entries()].map(([slug, r]) => ({ key: slotKey(slug), m: r.m / r.w, k: r.k / r.w, x: r.x / r.w }));
  if (!rows.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  return {
    rounds: rows.length,
    brierModel: mean(rows.map(r => r.m)),
    brierMarket: mean(rows.map(r => r.k)),
    brierBlend: mean(rows.map(r => r.x)),
    // t groupé par créneau (les 5 cryptos d'un même round sont corrélées)
    tVsModel: clusteredMeanT(rows.map(r => ({ key: r.key, x: r.x - r.m }))).t,
    tVsMarket: clusteredMeanT(rows.map(r => ({ key: r.key, x: r.x - r.k }))).t,
  };
}

export interface BlendFit {
  /** rounds utilisés pour l'estimation sur tout l'échantillon */
  rounds: number;
  /** réglage estimé sur TOUT l'échantillon (celui à configurer si la validation passe) */
  a: number;
  b: number;
  /** estimé sur la 1re moitié chronologique, évalué sur la 2e (jamais vue). */
  oos: (BlendScore & { a: number; b: number }) | null;
}

/**
 * Mélange modèle/marché : logit(p) = a·logit(p_modèle) + b·logit(p_carnet).
 *   (1, 0) = modèle seul ; (0, 1) = carnet seul (aucun edge possible).
 * Le résultat n'a de valeur que si le mélange bat le modèle sur la moitié NON utilisée
 * pour l'estimer (oos.tVsModel nettement négatif).
 */
export function fitBlend(rounds: ResolvedRecord[][], opts: { minTau?: number; maxTau?: number } = {}): BlendFit | null {
  // Points construits l'un après l'autre (jamais les trois ensembles en mémoire à la fois :
  // ~1 million d'évaluations sur 30 jours de journal).
  const countRounds = (pts: BlendPoint[]) => new Set(pts.map(p => p.slug)).size;
  let nRounds = 0;
  const full = (() => {
    const all = blendPoints(rounds, opts);
    nRounds = countRounds(all);
    return nRounds < 60 ? null : fitBlendParams(all);
  })();
  if (!full) return null;
  const [h1, h2] = halves(rounds);
  let oos: BlendFit['oos'] = null;
  const fit1 = (() => {
    const p1 = blendPoints(h1, opts);
    return countRounds(p1) >= 30 ? fitBlendParams(p1) : null;
  })();
  if (fit1) {
    const p2 = blendPoints(h2, opts);
    const sc = countRounds(p2) >= 30 ? scoreBlend(p2, fit1.a, fit1.b) : null;
    if (sc) oos = { ...sc, ...fit1 };
  }
  return { rounds: nRounds, a: full.a, b: full.b, oos };
}

/** Rejoue avec un mélange donné : pUp devient la probabilité mélangée (pRaw conservé). */
export function applyBlend(rounds: ResolvedRecord[][], a: number, b: number): ResolvedRecord[][] {
  const cfg = { ...DEFAULT_FAIR_VALUE_CONFIG, blendModel: a, blendMarket: b };
  return rounds.map(list => list.map(r => {
    const raw = rawModelProb(r);
    const pUp = raw === null ? null : blendWithMarket(raw, bookMidUp(r.upAsk, r.downAsk), cfg);
    return r.pRaw === raw && r.pUp === pUp ? r : { ...r, pRaw: raw, pUp }; // pas de copie inutile
  }));
}

export type BlendVerdict = 'insufficient' | 'noEdge' | 'keep' | 'apply' | 'current';

/**
 * Verdict sur un mélange estimé, jugé HORS ÉCHANTILLON :
 *   - noEdge : même le meilleur mélange ne bat pas le carnet (t ≥ −2) → aucun edge démontré ;
 *   - apply / current : il bat le carnet ET le modèle seul → à essayer (ou déjà en place) ;
 *   - keep : il bat le carnet mais pas le modèle seul → garder le réglage actuel.
 * (Pas de seuil sur le poids `a` : il dépend de l'échelle de confiance du modèle.)
 */
export function blendVerdict(fit: BlendFit | null, current: { blendModel: number; blendMarket: number }): BlendVerdict {
  const o = fit?.oos;
  if (!fit || !o) return 'insufficient';
  if (o.tVsMarket === null || o.tVsMarket > -2) return 'noEdge';
  if (o.tVsModel !== null && o.tVsModel < -2) {
    return current.blendModel === fit.a && current.blendMarket === fit.b ? 'current' : 'apply';
  }
  return 'keep';
}

/**
 * FV_Z_SCALE et le mélange corrigent tous deux la confiance du modèle : ne jamais suggérer
 * l'un si l'autre est déjà actif ou proposé (les corrections s'additionneraient).
 */
export function zScaleConflictsWithBlend(verdict: BlendVerdict, current: { blendModel: number; blendMarket: number }): boolean {
  return verdict === 'apply' || verdict === 'current' || current.blendModel !== 1 || current.blendMarket !== 0;
}

/** Lignes de rapport (FR) pour un mélange estimé ; partagées par les deux scripts. */
export function describeBlend(fit: BlendFit | null, current: { blendModel: number; blendMarket: number }): string[] {
  const f4 = (x: number) => x.toFixed(4);
  const f1 = (x: number | null) => (x === null ? '—' : x.toFixed(1));
  if (!fit) return ['   échantillon insuffisant (< 60 rounds avec modèle et carnet) : rien à estimer.'];
  const out = [`   estimé sur ${fit.rounds} rounds : logit(p) = ${fit.a}·logit(p_modèle) + ${fit.b}·logit(p_carnet)`];
  const o = fit.oos;
  if (!o) {
    out.push('   validation impossible (< 30 rounds par moitié) : ne rien changer.');
    return out;
  }
  out.push(`   validation : estimé sur la 1re moitié (${o.a} / ${o.b}), mesuré sur la 2e (${o.rounds} rounds jamais vus)`);
  out.push(`     Brier  modèle ${f4(o.brierModel)} | carnet ${f4(o.brierMarket)} | mélange ${f4(o.brierBlend)}`
    + `   (t mélange−modèle ${f1(o.tVsModel)}, mélange−carnet ${f1(o.tVsMarket)})`);
  switch (blendVerdict(fit, current)) {
    case 'noEdge':
      out.push('   → hors échantillon, même le meilleur mélange ne bat pas le carnet (t ≥ −2) : AUCUN edge démontré.'
        + '\n     Ne pas régler le mélange pour « trouver » un edge, et ne pas passer en réel.');
      break;
    case 'current':
      out.push('   → mélange validé hors échantillon, et c\'est déjà le réglage actuel.');
      break;
    case 'apply':
      out.push(`   → mélange validé hors échantillon (bat le modèle seul ET le carnet) : essayer FV_BLEND_MODEL=${fit.a}`
        + ` FV_BLEND_MARKET=${fit.b} (actuel ${current.blendModel} / ${current.blendMarket}), puis re-mesurer.`
        + '\n     Il corrige déjà la confiance du modèle : ne PAS changer FV_Z_SCALE en même temps.');
      break;
    default:
      out.push('   → pas d\'amélioration significative sur le modèle seul hors échantillon : garder le réglage actuel'
        + ` (${current.blendModel} / ${current.blendMarket}).`);
  }
  return out;
}

export interface BookStats {
  coin: string;
  /** évaluations avec ask ET bid du token Up */
  n: number;
  /** écart achat/vente médian du token Up (en prix, 0,01 = 1 ct) */
  medianSpread: number;
  /** part des évaluations où bid Up = 1 − ask Down (carnets miroirs, à 0,5 ct près) */
  mirrorShare: number | null;
  /** taille médiane au meilleur ask Up (parts) */
  medianAskSize: number | null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Coût réel d'un aller-retour et profondeur, par coin (journaux avec bids seulement). */
export function bookStats(records: DecisionRecord[]): BookStats[] {
  const by = new Map<string, DecisionRecord[]>();
  for (const r of records) {
    if (r.upAsk == null || r.upBid == null) continue;
    (by.get(r.coin) ?? by.set(r.coin, []).get(r.coin)!).push(r);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([coin, rs]) => {
    const mirror = rs.filter(r => r.downAsk != null);
    return {
      coin,
      n: rs.length,
      medianSpread: median(rs.map(r => (r.upAsk as number) - (r.upBid as number))) as number,
      mirrorShare: mirror.length
        ? mirror.filter(r => Math.abs((r.upBid as number) - (1 - (r.downAsk as number))) < 0.005).length / mirror.length
        : null,
      medianAskSize: median(rs.filter(r => r.upAskSz != null).map(r => r.upAskSz as number)),
    };
  });
}

export interface ModelBookComparison {
  /** rounds où modèle ET carnet sont connus */
  rounds: number;
  brierModel: number | null;
  brierMarket: number | null;
  /** t groupé par créneau de (Brier modèle − Brier carnet) ; négatif = modèle meilleur */
  t: number | null;
}

/**
 * Le modèle prédit-il mieux que le carnet ? Comparaison APPARIÉE : pour chaque round,
 * moyenne des erreurs sur ses évaluations où les deux sont connus (chaque round compte
 * pour 1, les évaluations d'un même round étant corrélées), puis t groupé par créneau
 * (les cryptos d'un même round le sont aussi).
 */
export function compareModelBook(rounds: ResolvedRecord[][], opts: { minTau?: number; maxTau?: number } = {}): ModelBookComparison {
  const rows: Array<{ key: string; m: number; k: number }> = [];
  for (const list of rounds) {
    let m = 0;
    let k = 0;
    let n = 0;
    for (const r of list) {
      if (opts.minTau !== undefined && r.tau < opts.minTau) continue;
      if (opts.maxTau !== undefined && r.tau > opts.maxTau) continue;
      const pm = rawModelProb(r);
      const pk = marketProbUp(r);
      if (pm === null || pk === null) continue;
      const y = r.upWon ? 1 : 0;
      m += (pm - y) ** 2;
      k += (pk - y) ** 2;
      n++;
    }
    if (n) rows.push({ key: slotKey(list[0].slug), m: m / n, k: k / n });
  }
  if (!rows.length) return { rounds: 0, brierModel: null, brierMarket: null, t: null };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    rounds: rows.length,
    brierModel: mean(rows.map(r => r.m)),
    brierMarket: mean(rows.map(r => r.k)),
    t: clusteredMeanT(rows.map(r => ({ key: r.key, x: r.m - r.k }))).t,
  };
}

/** Bornes acceptées par la variable FV_Z_SCALE (fairValueConfigFromEnv). */
export const Z_SCALE_ENV_RANGE = [0.3, 2] as const;

/** Conseil (FR) tiré d'un ajustement de FV_Z_SCALE ; partagé par les deux rapports. */
export function zScaleAdvice(fit: ZScaleFit, current: number, blendConflict: boolean): string {
  const suggested = Math.round(fit.m * 100) / 100;
  if (fit.lo <= current && fit.hi >= current) return `→ compatible avec le réglage actuel (FV_Z_SCALE=${current}) : rien à changer.`;
  if (blendConflict) return '→ la confiance est déjà corrigée par le mélange (actif ou proposé) : ré-estimer le mélange, pas FV_Z_SCALE.';
  const [lo, hi] = Z_SCALE_ENV_RANGE;
  if (suggested < lo || suggested > hi) {
    return `→ valeur optimale ${suggested} hors des bornes de FV_Z_SCALE [${lo} ; ${hi}] (elle serait ignorée) : le modèle est trop`
      + ' mal calibré pour ce simple réglage — revoir la volatilité ou le bruit du strike.';
  }
  return `→ le modèle est ${fit.m < current ? 'SUR-confiant' : 'SOUS-confiant'} : essayer FV_Z_SCALE=${suggested} (actuel ${current}), puis re-mesurer.`;
}

export interface StrikeCheckRound {
  coin: string;
  slotSec: number;
  /** Notre prix à battre (estimé depuis les bougies). */
  est: number;
  /** σ par √s au moment de l'évaluation. */
  sig: number;
  /** Prix à battre / prix final publiés par Polymarket. */
  ptb: number;
  final?: number;
  upWon: boolean;
}

export interface StrikeCheckCoin {
  coin: string;
  n: number;
  /** Écart moyen ln(estimation / officiel), en points de base (décalage Binance/Chainlink). */
  meanBps: number;
  /** Dispersion de l'écart (bps). */
  sdBps: number;
  /** Dispersion après retrait d'un écart moyen glissant (12 rounds précédents ≈ 1 h), bps :
   *  ce qu'on gagnerait en lisant le prix officiel corrigé du décalage. null si < 5 points. */
  sdResidBps: number | null;
  /** Bruit de strike supposé par le modèle, en bps (σ·√strikeNoiseSec, médiane). */
  assumedBps: number;
}

/**
 * Notre prix à battre comparé à celui de Polymarket. Sert à décider sur preuve s'il faut
 * lire le prix officiel (et à vérifier que `strikeNoiseSec` / `basisBps` sont réalistes).
 * `consistency` : part des rounds où « prix final ≥ prix à battre » ⇔ Up — vérifie que les
 * champs publiés signifient bien ce qu'on croit (attendu : 100 %).
 */
export function strikeVsOfficial(rounds: StrikeCheckRound[], strikeNoiseSec: number): { coins: StrikeCheckCoin[]; consistency: { n: number; agree: number } } {
  const byCoin = new Map<string, StrikeCheckRound[]>();
  for (const r of rounds) {
    if (!(r.est > 0 && r.ptb > 0)) continue;
    (byCoin.get(r.coin) ?? byCoin.set(r.coin, []).get(r.coin)!).push(r);
  }
  const coins: StrikeCheckCoin[] = [];
  for (const [coin, list] of [...byCoin.entries()].sort()) {
    list.sort((a, b) => a.slotSec - b.slotSec);
    const d = list.map(r => 1e4 * Math.log(r.est / r.ptb));
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, d.length - 1));
    const resid: number[] = [];
    for (let i = 3; i < d.length; i++) {
      const prev = d.slice(Math.max(0, i - 12), i);
      resid.push(d[i] - prev.reduce((a, b) => a + b, 0) / prev.length);
    }
    const sdResid = resid.length >= 5 ? Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / resid.length) : null;
    const assumed = list.map(r => 1e4 * r.sig * Math.sqrt(Math.max(0, strikeNoiseSec))).sort((a, b) => a - b);
    coins.push({ coin, n: list.length, meanBps: mean, sdBps: sd, sdResidBps: sdResid, assumedBps: assumed[Math.floor(assumed.length / 2)] ?? 0 });
  }
  const withFinal = rounds.filter(r => r.ptb > 0 && (r.final ?? 0) > 0);
  const agree = withFinal.filter(r => ((r.final as number) >= r.ptb) === r.upWon).length;
  return { coins, consistency: { n: withFinal.length, agree } };
}
