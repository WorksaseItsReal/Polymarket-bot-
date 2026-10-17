/**
 * llm-report.ts — section 5 du rapport d'analyse (scripts/analysis/fv-report.ts) : comparatif
 * « formule / récolte / llm », en PAPIER, et le résumé llm de /rapport (report-summary.ts).
 *
 * 5a. Registre (fv-ledger.jsonl) : trades RÉGLÉS de chaque stratégie (fv = formule, late =
 *     récolte, llm) dans la fenêtre du rapport — taux de gain, gain moyen par 1 $ misé
 *     (pnl / mise) avec son IC 95 % (erreur-type groupée par créneau de 5 min), PnL total.
 * 5b. Journal de la stratégie llm (~/.polymarket/llm/decisions.jsonl, `LlmDecisionRecord`), par
 *     campagne : tentatives, abstentions par motif, veto, échecs techniques, latence ; puis, sur
 *     les rounds réglés, Brier et gains APPARIÉS contre la formule évaluée au même instantané et
 *     exécutée par le même modèle (c'est déjà dans les données), calibration, désaccords.
 *
 * La règle d'arrêt (stop-rule.ts) est appliquée telle quelle, PAR CAMPAGNE et sur TOUTE la
 * campagne présente dans le journal : ses deux regards portent sur les 500 puis 1 000 PREMIÈRES
 * décisions appariées — la juger sur la fenêtre glissante du rapport créerait d'autres regards
 * (et /rapport 1 n'atteindrait pas 500 au plafond par défaut de 100 décisions par jour). Le reste
 * de 5b décrit la fenêtre (--days).
 *
 * Module PUR (aucune I/O) : le script lit les fichiers et règle les rounds.
 */
import { clusteredMeanT, slotKey } from './stats.js';
import type { LlmSummary } from './report-summary.js';
import { clusterKeyOf, isSettled, settleOrderKey, strategyOf, type LedgerTrade, type StrategyKey } from '../services/paper-ledger.js';
import { COUNTED_FAILURE_CODES } from '../strategy/llm/llm-state.js';
import type { LlmDecisionRecord } from '../strategy/llm/llm-journal.js';
import {
  executionUnitGain, pairedVerdict, STOP_RULE, type PairedDecision, type PairedVerdictResult, type StopLook, type StopVerdict,
} from '../strategy/llm/stop-rule.js';
import type { AbstentionCode } from '../strategy/llm/types.js';

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isProb = (x: unknown): x is number => isNum(x) && x >= 0 && x <= 1;
const mean = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);

/** IC 95 % : ± 1,96 erreur-type (approximation normale). */
export const Z95 = 1.96;

// ---------------------------------------------------------------- erreurs groupées

export interface ClusteredMean {
  n: number;
  mean: number | null;
  /** Erreur-type groupée (même estimateur que `clusteredMeanT`) ; null si moins de 2 créneaux. */
  se: number | null;
  /** mean / se ; null si l'erreur-type est nulle ou non calculable. */
  t: number | null;
}

/** Moyenne, erreur-type et t, erreurs groupées par `key` (créneau de 5 min). */
export function clusteredMean(obs: ReadonlyArray<{ key: string; x: number }>): ClusteredMean {
  const c = clusteredMeanT(obs);
  if (c.mean === null || c.clusters < 2) return { n: c.n, mean: c.mean, se: null, t: null };
  const m = c.mean;
  // Erreur-type tirée du t de `clusteredMeanT` : décaler toutes les valeurs ne change pas les
  // résidus (donc pas l'erreur-type) ; ramenées à une moyenne de 1, t' = 1 / erreur-type — même
  // quand la moyenne d'origine est nulle.
  const s = clusteredMeanT(obs.map(o => ({ key: o.key, x: o.x - m + 1 })));
  const se = s.t === null || s.mean === null ? 0 : s.mean / s.t;
  // Valeurs toutes égales : variance nulle, ou bruit d'arrondi (un t de 10^16) — pas de t.
  if (!(se > 1e-12 * Math.max(1, Math.abs(m)))) return { n: c.n, mean: m, se: 0, t: null };
  return { n: c.n, mean: m, se, t: m / se };
}

// ---------------------------------------------------------------- 5a. registre par stratégie

export const STRATEGY_LABELS: Readonly<Record<StrategyKey, string>> = { fv: 'formule', late: 'récolte', llm: 'llm' };

export interface StrategyRow {
  key: StrategyKey;
  /** Trades réglés dans la fenêtre. */
  n: number;
  /** Trades à PnL positif (même définition que `computeStats`). */
  wins: number;
  winRate: number | null;
  /** Gain moyen par 1 $ misé (pnl / mise, moyenne par trade). */
  ev: number | null;
  /** Demi-largeur de l'IC 95 % de `ev` (erreur-type groupée par créneau) ; null si non calculable. */
  ci95: number | null;
  t: number | null;
  /** PnL total ($). */
  pnl: number;
}

/** Trades RÉGLÉS de chaque stratégie (fv, late, llm) depuis `sinceMs` (date de règlement, sinon d'ouverture). */
export function ledgerByStrategy(trades: readonly LedgerTrade[], sinceMs: number): StrategyRow[] {
  const by = new Map<StrategyKey, LedgerTrade[]>([['fv', []], ['late', []], ['llm', []]]);
  for (const t of trades) {
    if (!isSettled(t) || !(Date.parse(settleOrderKey(t)) >= sinceMs)) continue;
    by.get(strategyOf(t))?.push(t);
  }
  return [...by].map(([key, ts]) => {
    const wins = ts.filter(t => (t.pnl as number) > 0).length;
    const per = clusteredMean(ts.filter(t => isNum(t.stake) && t.stake > 0).map(t => ({ key: clusterKeyOf(t), x: (t.pnl as number) / t.stake })));
    return {
      key, n: ts.length, wins, winRate: ts.length ? wins / ts.length : null,
      ev: per.mean, ci95: per.se === null ? null : Z95 * per.se, t: per.t,
      pnl: ts.reduce((a, t) => a + (t.pnl as number), 0),
    };
  });
}

// ---------------------------------------------------------------- 5b. décisions llm

/** Exécution simulée enregistrée (côté acheté, coût effectif par part frais compris). */
export interface LlmFill {
  side: string;
  costPerShare: number;
}

/**
 * Ligne de decisions.jsonl réduite aux champs du rapport : les étapes et réponses des agents
 * (plusieurs ko par ligne) ne sont pas gardées en mémoire.
 */
export interface LlmDecisionLite {
  t: number;
  /** Slug du round (`round_id`) : clé de règlement. */
  round: string;
  /** Créneau de 5 min (groupe des erreurs-types) : `slotSec`, sinon tiré du slug. */
  slot: string;
  campaign: string;
  /** 'ok' (pari pris) ou motif d'abstention. */
  code: string;
  /** Les agents ont abouti (décision finale assemblée) hors échec technique : base du taux de veto. */
  agentsDone: boolean;
  latencyMs: number | null;
  /** P(Up) des agents (non vérifiée : hors [0, 1] = échec technique pour la règle d'arrêt). */
  pLlm: number | null;
  /** P(Up) de la formule au même instantané (null : pas d'instantané ou formule muette). */
  pFormule: number | null;
  /** Exécutions simulées de llm (après garde-fous) et de la formule ; null = pas de pari. */
  llmFill: LlmFill | null;
  formulaFill: LlmFill | null;
}

/** Échec technique (couche processus ou schéma) au sens de llm-state.ts. */
export const isTechFailure = (code: string): boolean => COUNTED_FAILURE_CODES.has(code as AbstentionCode);

const objectOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Exécution présente mais illisible : gardée (c'est un pari), son gain sera non fini (anomalie). */
function fillOf(v: unknown): LlmFill | null {
  if (v === null || v === undefined) return null;
  const o = objectOf(v) ?? {};
  return { side: String(o.side), costPerShare: Number(o.costPerShare) };
}

/** Une ligne JSON de decisions.jsonl → champs utiles ; null si ce n'est pas une décision lisible. */
export function slimLlmDecision(x: unknown): LlmDecisionLite | null {
  const r = objectOf(x) as { [K in keyof LlmDecisionRecord]?: unknown } | null;
  if (!r || !isNum(r.t) || typeof r.round_id !== 'string' || r.round_id === '' || typeof r.code !== 'string' || r.code === '') return null;
  const exec = objectOf(r.exec);
  const formula = objectOf(r.formula);
  const pFormule = formula?.pUp;
  return {
    t: r.t,
    round: r.round_id,
    slot: isNum(r.slotSec) ? String(r.slotSec) : slotKey(r.round_id),
    campaign: typeof r.campaign === 'string' && r.campaign !== '' ? r.campaign : 'inconnue',
    code: r.code,
    agentsDone: objectOf(r.final) !== null && !isTechFailure(r.code),
    latencyMs: isNum(r.latencyMs) ? r.latencyMs : null,
    pLlm: isNum(r.pLlm) ? r.pLlm : null,
    pFormule: isNum(pFormule) ? pFormule : null,
    llmFill: fillOf(exec?.fill),
    formulaFill: fillOf(formula?.fill),
  };
}

/** Décision mesurée (une P(Up) au moins) : la seule dont l'issue du round sert. */
const measured = (d: LlmDecisionLite): boolean => d.pFormule !== null || isProb(d.pLlm);

/**
 * Rounds à régler pour la section : décisions mesurées des campagnes présentes dans la fenêtre,
 * sur TOUTE leur durée (la règle d'arrêt juge la campagne entière).
 */
export function llmRoundsToResolve(all: readonly LlmDecisionLite[], sinceMs: number): string[] {
  const campaigns = new Set(all.filter(d => d.t >= sinceMs).map(d => d.campaign));
  return [...new Set(all.filter(d => campaigns.has(d.campaign) && measured(d)).map(d => d.round))];
}

/** Issue du round (1 = Up a gagné) ; null tant qu'il n'est pas réglé. */
function outcomeOf(d: LlmDecisionLite, outcomes: ReadonlyMap<string, boolean>): 0 | 1 | null {
  const o = outcomes.get(d.round);
  return o === true ? 1 : o === false ? 0 : null;
}

/** G pour 1 $ (`executionUnitGain`) : 0 sans pari, NaN si l'exécution enregistrée est illisible. */
function gainOf(fill: LlmFill | null, y: 0 | 1): number {
  if (!fill) return 0;
  if (fill.side !== 'UP' && fill.side !== 'DOWN') return NaN;
  try {
    return executionUnitGain({ side: fill.side, costPerShare: fill.costPerShare }, y);
  } catch {
    return NaN; // coût effectif invalide
  }
}

export interface LatencyStats {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

/** Quantiles des latences non nulles (même convention que `LlmStrategy.latencyStats`, /llm). */
export function latencyStats(ms: ReadonlyArray<number | null>): LatencyStats {
  const a = ms.filter((x): x is number => isNum(x) && x > 0).sort((x, y) => x - y);
  const q = (p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
  return { n: a.length, p50: q(0.5), p95: q(0.95), max: a.length ? a[a.length - 1] : null };
}

export interface CalibrationRow {
  lo: number;
  hi: number;
  n: number;
  meanP: number | null;
  /** Fréquence observée de Up. */
  freqUp: number | null;
}

/** Calibration en `bins` tranches égales (toutes rendues, vides comprises). */
export function calibrationBins(obs: ReadonlyArray<{ p: number; y: 0 | 1 }>, bins = 10): CalibrationRow[] {
  const acc = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, sumP: 0, up: 0 }));
  for (const o of obs) {
    if (!isProb(o.p)) continue;
    const b = acc[Math.min(bins - 1, Math.max(0, Math.floor(o.p * bins)))];
    b.n++;
    b.sumP += o.p;
    b.up += o.y;
  }
  return acc.map(b => ({ lo: b.lo, hi: b.hi, n: b.n, meanP: b.n ? b.sumP / b.n : null, freqUp: b.n ? b.up / b.n : null }));
}

export interface PairedBrier {
  /** Paires réglées où les deux P(Up) sont valides. */
  n: number;
  llm: number | null;
  formula: number | null;
  /** Moyenne de (p_llm − y)² − (p_formule − y)² ; négatif = llm meilleur. */
  delta: number | null;
  t: number | null;
}

export interface PairedGains {
  /** Décisions appariées réglées (P(Up) formule valide), échecs techniques compris (gain llm 0). */
  n: number;
  /** Gain moyen pour 1 $ par décision (0 sans pari). */
  llm: number | null;
  formula: number | null;
  delta: number | null;
  t: number | null;
  llmBets: number;
  formulaBets: number;
  /** Gain moyen pour 1 $ par pari. */
  llmPerBet: number | null;
  formulaPerBet: number | null;
}

export interface Disagreements {
  /** Rounds en désaccord (au moins un critère ; un round peut en cumuler plusieurs). */
  n: number;
  /** P(Up) de part et d'autre de 0,5, et parmi eux ceux où llm était du bon côté. */
  acrossHalf: number;
  llmRightAcross: number;
  /** Un seul des deux parie. */
  oneBets: number;
  /** Les deux parient, côtés opposés. */
  opposite: number;
  brierLlm: number | null;
  brierFormula: number | null;
  /** Gain moyen pour 1 $ sur ces rounds (0 sans pari). */
  gainLlm: number | null;
  gainFormula: number | null;
}

export interface StopRuleReport {
  /** Décisions de TOUTE la campagne (journal entier, pas seulement la fenêtre). */
  decisions: number;
  /** Sans P(Up) formule : exclues de l'appariement. */
  noFormula: number;
  /** Appariables, round pas encore réglé : exclues. */
  unresolved: number;
  /** Échecs techniques sans ligne appariée (`nTechFailures` de `pairedVerdict`). */
  techWithoutPair: number;
  result: PairedVerdictResult;
}

export interface LlmCampaignReport {
  campaign: string;
  /** Campagne la plus récente (celle du résumé Telegram). */
  latest: boolean;
  // --- fenêtre du rapport
  attempts: number;
  /** Paris pris (code 'ok'). */
  bets: number;
  /** Abstentions par motif, de la plus fréquente à la moins fréquente (part des tentatives). */
  abstentions: Array<{ code: string; n: number; share: number }>;
  /** Décisions où les agents ont abouti (hors échec technique) et vetos parmi elles. */
  agentsDone: number;
  vetoes: number;
  vetoRate: number | null;
  /** Échecs techniques (COUNTED_FAILURE_CODES), part des tentatives. */
  techFailures: number;
  techFailureRate: number | null;
  latency: LatencyStats;
  /** Rounds non réglés (décisions mesurées) : exclus du Brier, de la calibration, des gains. */
  unresolvedRounds: number;
  brier: PairedBrier;
  /** P(Up) llm, rounds réglés, 10 tranches de 0,1. */
  calibration: CalibrationRow[];
  gains: PairedGains;
  disagreements: Disagreements;
  // --- toute la campagne
  stop: StopRuleReport;
}

export interface LlmReport {
  /** Décisions de la fenêtre, toutes campagnes. */
  decisions: number;
  /** Par campagne, dans l'ordre de leur première décision de la fenêtre. */
  campaigns: LlmCampaignReport[];
}

interface Paired {
  d: LlmDecisionLite;
  y: 0 | 1;
  gLlm: number;
  gFormule: number;
}

/** Règle d'arrêt sur les décisions d'UNE campagne, dans l'ordre chronologique. */
function stopRule(ds: readonly LlmDecisionLite[], outcomes: ReadonlyMap<string, boolean>): StopRuleReport {
  const pairs: PairedDecision[] = [];
  let noFormula = 0;
  let unresolved = 0;
  let techWithoutPair = 0;
  for (const d of ds) {
    if (d.pFormule === null) {
      noFormula++;
      // G_formule inconnu : compté dans le gain pour g = 0 (règle, cas b)
      if (isTechFailure(d.code)) techWithoutPair++;
      continue;
    }
    const y = outcomeOf(d, outcomes);
    if (y === null) {
      unresolved++;
      continue;
    }
    pairs.push({ slot: d.slot, pLlm: d.pLlm, pFormule: d.pFormule, y, gLlm: gainOf(d.llmFill, y), gFormule: gainOf(d.formulaFill, y) });
  }
  return { decisions: ds.length, noFormula, unresolved, techWithoutPair, result: pairedVerdict(pairs, techWithoutPair) };
}

function disagreementsOf(both: readonly Paired[]): Disagreements {
  let acrossHalf = 0;
  let llmRightAcross = 0;
  let oneBets = 0;
  let opposite = 0;
  const sel: Array<Paired & { pl: number; pf: number }> = [];
  for (const r of both) {
    const pl = r.d.pLlm as number;
    const pf = r.d.pFormule as number;
    const lf = r.d.llmFill;
    const ff = r.d.formulaFill;
    const across = (pl - 0.5) * (pf - 0.5) < 0;
    const one = (lf === null) !== (ff === null);
    const opp = lf !== null && ff !== null && lf.side !== ff.side;
    if (across) {
      acrossHalf++;
      if ((pl > 0.5) === (r.y === 1)) llmRightAcross++;
    }
    if (one) oneBets++;
    if (opp) opposite++;
    if (across || one || opp) sel.push({ ...r, pl, pf });
  }
  return {
    n: sel.length, acrossHalf, llmRightAcross, oneBets, opposite,
    brierLlm: mean(sel.map(r => (r.pl - r.y) ** 2)),
    brierFormula: mean(sel.map(r => (r.pf - r.y) ** 2)),
    gainLlm: mean(sel.map(r => r.gLlm).filter(isNum)),
    gainFormula: mean(sel.map(r => r.gFormule).filter(isNum)),
  };
}

function campaignReport(
  campaign: string, win: readonly LlmDecisionLite[], all: readonly LlmDecisionLite[], outcomes: ReadonlyMap<string, boolean>, latest: boolean,
): LlmCampaignReport {
  const attempts = win.length;
  const byCode = new Map<string, number>();
  for (const d of win) if (d.code !== 'ok') byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
  const abstentions = [...byCode]
    .map(([code, n]) => ({ code, n, share: n / attempts }))
    .sort((a, b) => b.n - a.n || a.code.localeCompare(b.code));
  const agentsDone = win.filter(d => d.agentsDone).length;
  const vetoes = win.filter(d => d.code === 'veto').length;
  const techFailures = win.filter(d => isTechFailure(d.code)).length;

  // Rounds réglés seulement ; les autres sont exclus et comptés.
  const unresolvedRounds = new Set(win.filter(d => measured(d) && outcomeOf(d, outcomes) === null).map(d => d.round)).size;
  const rows: Paired[] = [];
  for (const d of win) {
    if (d.pFormule === null) continue;
    const y = outcomeOf(d, outcomes);
    if (y !== null) rows.push({ d, y, gLlm: gainOf(d.llmFill, y), gFormule: gainOf(d.formulaFill, y) });
  }

  const both = rows.filter(r => isProb(r.d.pLlm) && isProb(r.d.pFormule));
  const bL = both.map(r => ((r.d.pLlm as number) - r.y) ** 2);
  const bF = both.map(r => ((r.d.pFormule as number) - r.y) ** 2);
  const db = clusteredMean(both.map((r, i) => ({ key: r.d.slot, x: bL[i] - bF[i] })));

  const calibration = calibrationBins(win.flatMap(d => {
    const y = isProb(d.pLlm) ? outcomeOf(d, outcomes) : null;
    return y === null ? [] : [{ p: d.pLlm as number, y }];
  }));

  // Gains comme la règle d'arrêt : P(Up) llm invalide = échec technique, gain llm 0.
  const g = rows
    .filter(r => isProb(r.d.pFormule))
    .map(r => ({ r, gl: isProb(r.d.pLlm) ? r.gLlm : 0, gf: r.gFormule, llmBet: isProb(r.d.pLlm) && r.d.llmFill !== null }))
    .filter(x => isNum(x.gl) && isNum(x.gf));
  const dg = clusteredMean(g.map(x => ({ key: x.r.d.slot, x: x.gl - x.gf })));
  const llmBets = g.filter(x => x.llmBet);
  const formulaBets = g.filter(x => x.r.d.formulaFill !== null);

  return {
    campaign,
    latest,
    attempts,
    bets: win.filter(d => d.code === 'ok').length,
    abstentions,
    agentsDone,
    vetoes,
    vetoRate: agentsDone ? vetoes / agentsDone : null,
    techFailures,
    techFailureRate: attempts ? techFailures / attempts : null,
    latency: latencyStats(win.map(d => d.latencyMs)),
    unresolvedRounds,
    brier: { n: both.length, llm: mean(bL), formula: mean(bF), delta: db.mean, t: db.t },
    calibration,
    gains: {
      n: g.length,
      llm: mean(g.map(x => x.gl)),
      formula: mean(g.map(x => x.gf)),
      delta: dg.mean,
      t: dg.t,
      llmBets: llmBets.length,
      formulaBets: formulaBets.length,
      llmPerBet: mean(llmBets.map(x => x.gl)),
      formulaPerBet: mean(formulaBets.map(x => x.gf)),
    },
    disagreements: disagreementsOf(both),
    stop: stopRule(all, outcomes),
  };
}

/**
 * Section llm : décisions de la fenêtre (`t ≥ sinceMs`) par campagne ; règle d'arrêt sur toute
 * la campagne (`all` = tout le journal). null s'il n'y a aucune décision dans la fenêtre.
 */
export function llmReport(all: readonly LlmDecisionLite[], sinceMs: number, outcomes: ReadonlyMap<string, boolean>): LlmReport | null {
  const sorted = [...all].sort((a, b) => a.t - b.t); // tri stable : ordre du fichier à égalité
  const win = sorted.filter(d => d.t >= sinceMs);
  if (!win.length) return null;
  // Campagne la plus récente : celle de la dernière décision MESURÉE (agents ou formule ont donné
  // une P(Up)) ; une abstention avant tout appel (CLI introuvable → « cli-inconnu_… ») n'en ouvre pas.
  const last = [...win].reverse().find(measured) ?? win[win.length - 1];
  const names = [...new Set(win.map(d => d.campaign))];
  return {
    decisions: win.length,
    campaigns: names.map(c => campaignReport(
      c, win.filter(d => d.campaign === c), sorted.filter(d => d.campaign === c), outcomes, c === last.campaign,
    )),
  };
}

/** Résumé Telegram : campagne la plus récente. */
export function llmSummaryOf(r: LlmReport): LlmSummary {
  const c = r.campaigns.find(x => x.latest) ?? r.campaigns[r.campaigns.length - 1];
  const v = c.stop.result;
  return {
    campaign: c.campaign,
    attempts: c.attempts,
    paired: c.gains.n,
    llmBets: c.gains.llmBets,
    formulaBets: c.gains.formulaBets,
    llmGainPerBet: c.gains.llmPerBet,
    formulaGainPerBet: c.gains.formulaPerBet,
    brier: { n: c.brier.n, llm: c.brier.llm, formula: c.brier.formula },
    stop: { n: v.n, look: v.look, verdict: v.verdict, deltaBrier: v.deltaBrier, zBrier: v.zBrier, deltaGain: v.deltaGain, zGain: v.zGain },
  };
}

// ---------------------------------------------------------------- rendu (rapport complet)

const pct = (x: number | null, d = 1) => (x === null ? '—' : `${(x * 100).toFixed(d)} %`);
const num = (x: number | null, d = 3) => (x === null ? '—' : x.toFixed(d));
const secs = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);

/** Ligne unique de la partie llm quand le journal est absent, vide ou muet sur la période. */
export const NO_LLM_DECISION = 'llm : aucune décision (stratégie désactivée ou pas encore lancée)';

const LOOK_LABEL: Readonly<Record<StopLook, string>> = { aucun: 'aucun', intermediaire: 'intermédiaire', final: 'final' };
const VERDICT_LABEL: Readonly<Record<StopVerdict, string>> = { insuffisant: 'insuffisant', non_concluant: 'non concluant', succes: 'succès', echec: 'échec' };
const VERDICT_HINT: Readonly<Record<StopVerdict, string>> = {
  insuffisant: ` (moins de ${STOP_RULE.nIntermediaire} décisions appariées : pas encore de regard)`,
  non_concluant: ` → prolonger jusqu'à ${STOP_RULE.nFinal} décisions appariées`,
  succes: ' → llm mieux calibré ET gagne plus que la formule (papier ; pas un passage au réel)',
  echec: ' → garder la formule (plus simple, gratuite)',
};

/** 5a : une ligne par stratégie ; `rows` null = registre illisible. */
export function ledgerSectionLines(rows: readonly StrategyRow[] | null, days: number): string[] {
  const L = [`5a) Registre papier : trades réglés sur ${days} j, par stratégie (gain par 1 $ misé = pnl / mise ; IC 95 % groupé par créneau de 5 min)`];
  if (!rows) return [...L, '   registre illisible (fichier préservé) : comparaison impossible.'];
  for (const r of rows) {
    L.push(`   ${STRATEGY_LABELS[r.key].padEnd(8)} n=${String(r.n).padStart(5)}  gagnés ${pct(r.winRate).padStart(7)}`
      + `  gain/1 $ ${num(r.ev, 4).padStart(7)} ± ${num(r.ci95, 4)}  t ${num(r.t, 1).padStart(5)}  PnL ${r.pnl.toFixed(2)} $`);
  }
  return L;
}

function campaignLines(c: LlmCampaignReport): string[] {
  const L: string[] = [];
  const abst = c.attempts - c.bets;
  L.push(`   campagne ${c.campaign}${c.latest ? ' — la plus récente' : ''}`);
  L.push(`     tentatives ${c.attempts} · paris pris ${c.bets} (${pct(c.bets / c.attempts)}) · abstentions ${abst} (${pct(abst / c.attempts)})`);
  if (c.abstentions.length) {
    L.push(`       ${'motif'.padEnd(24)} ${'n'.padStart(6)}  ${'%'.padStart(7)}`);
    for (const a of c.abstentions) L.push(`       ${a.code.slice(0, 24).padEnd(24)} ${String(a.n).padStart(6)}  ${pct(a.share).padStart(7)}`);
  }
  L.push(`     veto : ${c.vetoes} sur ${c.agentsDone} décisions abouties des agents (${pct(c.vetoRate)})`
    + ` · échecs techniques : ${c.techFailures} (${pct(c.techFailureRate)} des tentatives)`);
  L.push(`     latence des agents (n=${c.latency.n}) : p50 ${secs(c.latency.p50)} · p95 ${secs(c.latency.p95)} · max ${secs(c.latency.max)}`);
  if (c.unresolvedRounds) L.push(`     rounds non réglés (exclus de ce qui suit) : ${c.unresolvedRounds}`);
  if (!c.gains.n && !c.calibration.some(b => b.n)) {
    L.push('     aucune décision mesurée sur un round réglé dans la fenêtre : ni Brier, ni calibration, ni gains.');
  } else {
    const b = c.brier;
    L.push(`     Brier apparié (même instantané, n=${b.n}) : llm ${num(b.llm, 4)} | formule ${num(b.formula, 4)}`
      + ` | écart ${num(b.delta, 4)} (t ${num(b.t, 1)} ; négatif = llm meilleur)`);
    L.push('     calibration de P(Up) llm (rounds réglés)');
    L.push(`       tranche  ${'n'.padStart(6)}   ${'p moyen'.padStart(7)}   ${'Up réel'.padStart(7)}`);
    for (const k of c.calibration) {
      L.push(`       ${k.lo.toFixed(1)}-${k.hi.toFixed(1)}  ${String(k.n).padStart(6)}   ${pct(k.meanP).padStart(7)}   ${pct(k.freqUp).padStart(7)}`);
    }
    const g = c.gains;
    L.push(`     gains appariés pour 1 $ (même modèle d'exécution, frais compris ; 0 sans pari ; n=${g.n}) :`
      + ` llm ${num(g.llm, 4)} | formule ${num(g.formula, 4)} | écart ${num(g.delta, 4)} (t ${num(g.t, 1)})`);
    L.push(`       par pari : llm ${num(g.llmPerBet, 4)} (${g.llmBets} paris) | formule ${num(g.formulaPerBet, 4)} (${g.formulaBets} paris)`);
    const d = c.disagreements;
    L.push(`     désaccords llm / formule : ${d.n} rounds — P(Up) de part et d'autre de 0.5 : ${d.acrossHalf} (llm du bon côté : ${d.llmRightAcross})`
      + ` · un seul parie : ${d.oneBets} · côtés opposés : ${d.opposite}`);
    if (d.n) {
      const who = d.brierLlm === null || d.brierFormula === null ? ''
        : d.brierLlm < d.brierFormula ? ' → llm plus juste' : d.brierLlm > d.brierFormula ? ' → formule plus juste' : ' → égalité';
      L.push(`       sur ces rounds : Brier llm ${num(d.brierLlm, 4)} | formule ${num(d.brierFormula, 4)}${who}`
        + ` · gain moyen pour 1 $ llm ${num(d.gainLlm, 4)} | formule ${num(d.gainFormula, 4)}`);
    }
  }
  const s = c.stop;
  const v = s.result;
  L.push(`     règle d'arrêt pré-enregistrée — toute la campagne (${s.decisions} décisions), pas seulement la fenêtre :`);
  L.push(`       n=${v.n} décisions appariées (regard sur ${v.nUsed}) · ΔBrier ${num(v.deltaBrier, 4)} (z_B ${num(v.zBrier, 2)})`
    + ` · ΔGain ${num(v.deltaGain, 4)} (z_G ${num(v.zGain, 2)})`);
  L.push(`       regard : ${LOOK_LABEL[v.look]} · verdict : ${VERDICT_LABEL[v.verdict]}${VERDICT_HINT[v.verdict]}`);
  L.push(`       bornes (O'Brien-Fleming) : n=${v.bornes.nIntermediaire} → |z| ≥ ${v.bornes.zIntermediaire.toFixed(2)}`
    + ` ; n=${v.bornes.nFinal} → |z| ≥ ${v.bornes.zFinal.toFixed(2)}`);
  L.push(`       échecs techniques comptés dans le gain : ${v.nTechFailures} (${pct(v.techFailureRate)})`
    + ` · décisions exclues : sans P(Up) formule ${s.noFormula}, round non réglé ${s.unresolved}`
    + (v.nInvalid ? ` · ⚠️ ${v.nInvalid} lignes inutilisables (anomalie à corriger)` : ''));
  return L;
}

/** 5b : décisions llm par campagne ; une seule ligne (NO_LLM_DECISION) sans décision. */
export function llmSectionLines(r: LlmReport | null, days: number, source: string): string[] {
  if (!r) return [NO_LLM_DECISION];
  const L = [`5b) Stratégie llm (papier) : ${r.decisions} décisions sur ${days} j (${source}), par campagne`];
  for (const c of r.campaigns) L.push(...campaignLines(c));
  return L;
}
