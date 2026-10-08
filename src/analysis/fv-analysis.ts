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
  DEFAULT_FAIR_VALUE_CONFIG, blendWithMarket, bookMidUp, effectiveCostPerShare, normCdf, normInv,
} from '../services/fair-value.js';
import type { DecisionRecord } from '../services/decision-journal.js';

export interface ResolvedRecord extends DecisionRecord {
  upWon: boolean;
}

/** Probabilité du modèle SEUL (avant mélange) ; les anciens journaux n'ont que pUp. */
export function rawModelProb(r: Pick<DecisionRecord, 'pUp' | 'pRaw'>): number | null {
  return r.pRaw ?? r.pUp;
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
      if (rawModelProb(r) === null) continue;
      if (!best || Math.abs(r.tau - tauRef) < Math.abs(best.tau - tauRef)) best = r;
    }
    // FV_Z_SCALE agit sur le modèle seul : on calibre la probabilité AVANT mélange.
    const z = best ? normInv(Math.min(0.999, Math.max(0.001, rawModelProb(best) as number))) : null;
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
  let s = 0;
  for (const pt of pts) {
    const p = blendProb(pt, a, b);
    s += pt.w * (pt.y ? Math.log(p) : Math.log(1 - p));
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
  const newton = (a0: number, b0: number, freeA: boolean, freeB: boolean): { a: number; b: number } | null => {
    let a = a0;
    let b = b0;
    for (let it = 0; it < 60; it++) {
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
      a += da;
      b += db;
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 50 || Math.abs(b) > 50) return null;
      if (Math.abs(da) + Math.abs(db) < 1e-10) break;
    }
    return { a, b };
  };
  const clamp = (x: number) => Math.min(LIM, Math.max(0, x));
  const cands: Array<{ a: number; b: number }> = [{ a: 1, b: 0 }];
  const free = newton(1, 0, true, true);
  if (free && free.a >= 0 && free.a <= LIM && free.b >= 0 && free.b <= LIM) {
    cands.push(free);
  } else {
    for (const a of [0, LIM]) {
      const e = newton(a, 0, false, true);
      cands.push({ a, b: e ? clamp(e.b) : 0 }, { a, b: LIM });
    }
    for (const b of [0, LIM]) {
      const e = newton(1, b, true, false);
      cands.push({ a: e ? clamp(e.a) : 1, b }, { a: 0, b });
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
  const rows = [...per.values()].map(r => ({ m: r.m / r.w, k: r.k / r.w, x: r.x / r.w }));
  if (!rows.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const tStat = (ds: number[]) => {
    if (ds.length < 2) return null;
    const m = mean(ds);
    const v = ds.reduce((s, d) => s + (d - m) ** 2, 0) / (ds.length - 1);
    return v > 0 ? m / Math.sqrt(v / ds.length) : null;
  };
  return {
    rounds: rows.length,
    brierModel: mean(rows.map(r => r.m)),
    brierMarket: mean(rows.map(r => r.k)),
    brierBlend: mean(rows.map(r => r.x)),
    tVsModel: tStat(rows.map(r => r.x - r.m)),
    tVsMarket: tStat(rows.map(r => r.x - r.k)),
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
  const all = blendPoints(rounds, opts);
  const nRounds = new Set(all.map(p => p.slug)).size;
  if (nRounds < 60) return null;
  const full = fitBlendParams(all);
  const [h1, h2] = halves(rounds);
  const p1 = blendPoints(h1, opts);
  const p2 = blendPoints(h2, opts);
  let oos: BlendFit['oos'] = null;
  if (new Set(p1.map(p => p.slug)).size >= 30 && new Set(p2.map(p => p.slug)).size >= 30) {
    const fit1 = fitBlendParams(p1);
    const sc = scoreBlend(p2, fit1.a, fit1.b);
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
    return { ...r, pRaw: raw, pUp };
  }));
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
  const isCurrent = current.blendModel === fit.a && current.blendMarket === fit.b;
  if (o.tVsModel !== null && o.tVsModel < -2) {
    if (fit.a < 0.15) {
      out.push('   → le modèle n\'ajoute presque rien au carnet : AUCUN edge crédible. Ne pas trader cette stratégie.');
    } else {
      out.push(isCurrent
        ? '   → mélange validé hors échantillon, et c\'est déjà le réglage actuel.'
        : `   → mélange validé hors échantillon : essayer FV_BLEND_MODEL=${fit.a} FV_BLEND_MARKET=${fit.b}`
          + ` (actuel ${current.blendModel} / ${current.blendMarket}), puis re-mesurer.`
          + '\n     Un seul réglage à la fois : ce mélange corrige déjà la confiance du modèle (ne pas changer'
          + ' FV_Z_SCALE en même temps, les deux corrections s\'additionneraient).');
    }
  } else {
    out.push('   → pas d\'amélioration significative hors échantillon (t ≥ −2) : garder le réglage actuel'
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
