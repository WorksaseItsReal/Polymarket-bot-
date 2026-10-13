/**
 * guards.ts — garde-fous du CODE appliqués APRÈS la décision des agents (stratégie papier « llm »).
 *
 * Principe : le code a le dernier mot. Les agents proposent un côté, P(Up), un prix limite et
 * une mise ; ici on ne peut que RÉDUIRE ou ANNULER le pari, jamais dépasser une limite codée :
 *   - mise      = min(mise de l'agent, plafond calculé par le code) ;
 *   - prix      ≤ min(prix limite de l'agent, maxAsk, plus grand p tel que
 *                 coût effectif(p) = p + frais(p) ≤ P(côté) − minEdge) ;
 *   - exécution simulée sur le carnet RELU au moment de l'exécution (la réponse des agents
 *     arrive des dizaines de secondes après l'instantané), jamais au-dessus de la limite.
 *
 * Modèle d'exécution COMMUN (`simulateExecution`), le même pour llm et pour la formule dans la
 * campagne de mesure (stop-rule.ts) : décision, puis latence d'exécution de 1 s
 * (`EXECUTION_LATENCY_MS`), carnet RELU à ce moment, remplissage simulé sur ce carnet jusqu'au
 * prix limite, frais inclus (coût effectif). llm décide à la réception de la réponse des agents ;
 * la formule au même instantané que llm.
 *
 * Ordre des contrôles (le premier qui refuse donne le code ; aucun pari si code ≠ 'ok') :
 *   1. abstention de l'agent                                   → 'abstention_agent'
 *   2. limites de risque du capital llm refusées               → 'bloque_risque'
 *   3. déjà parié sur ce round                                 → 'deja_parie'
 *   4. contexte ou décision non numériques / hors bornes       → 'parametres_invalides'
 *      (un garde-fou qu'on ne peut pas évaluer refuse : NaN ou Infinity ne passent jamais)
 *   5. fraîcheur : P(côté) de la formule a baissé de plus de `staleDrop` entre l'instantané
 *      et maintenant (acheter quand le marché vient de bouger CONTRE le côté choisi =
 *      sélection adverse)                                     → 'marche_a_bouge'
 *   6. mise plafonnée < minimum d'ordre                        → 'mise_sous_minimum'
 *   7. aucun prix > 0 ne laisse la marge (P(côté) − minEdge ≤ 0) → 'sans_marge'
 *   8. exécution simulée : montant rempli < minimum d'ordre   → 'prix_parti'
 *   sinon 'ok' avec VWAP, parts et coût.
 *
 * `simulateExecution` réutilise `effectiveCostPerShare` (coût réel d'une part, frais taker compris)
 * et `estimateFill` (parcours du carnet sous un prix limite) de services/fair-value.ts, avec la
 * même convention que le registre papier (`binaryPayoff`) : la mise est la dépense FRAIS
 * COMPRIS, parts = mise / coût moyen par part.
 *
 * Module PUR (aucune I/O, aucune horloge, aucun accès à process.env).
 */

import { effectiveCostPerShare, estimateFill, type BookLevel, type Side } from '../../services/fair-value.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LlmAction = 'acheter_up' | 'acheter_down' | 'abstention';

/** Décision des agents (déjà validée en amont par le schéma ; revérifiée ici quand même). */
export interface LlmGuardDecision {
  action: LlmAction;
  /** P(Up gagne) estimée par l'agent, dans [0, 1]. */
  probaUp: number;
  /** Prix limite proposé par l'agent (prix d'une part, hors frais). */
  prixLimite: number;
  /** Mise proposée par l'agent (USD, frais compris). */
  miseUsd: number;
}

/** Niveau d'ask : `{ price, size }` (convention du dépôt) ou `[prix, parts]`. */
export type AskLevel = BookLevel | readonly [number, number];

export interface GuardContext {
  /** Les limites de risque du capital llm autorisent-elles une entrée ? */
  riskAllowed: boolean;
  /** Un pari llm existe déjà sur ce round. */
  alreadyBetThisRound: boolean;
  /** Plafond de mise calculé par le code (voir `llmStakeCapUsd`), USD. */
  stakeCapUsd: number;
  /** Minimum d'ordre (USD, 1 sur Polymarket). */
  minOrderUsd: number;
  /** Taux de frais taker (`crypto_fees_v2` : frais = parts · r · p · (1 − p)), dans [0, 1[. */
  feeRate: number;
  /** Prix plafond absolu d'une part, dans ]0, 1]. */
  maxAsk: number;
  /** Marge exigée : coût effectif ≤ P(côté) − minEdge. ≥ 0. */
  minEdge: number;
  /** Carnet RELU au moment de l'exécution (EXECUTION_LATENCY_MS après la réception de la réponse
   *  des agents), côté choisi (asks ; triés ou non : retriés). */
  asksNow: ReadonlyArray<AskLevel>;
  /** P(côté choisi) de la formule à l'instantané montré aux agents. */
  formulaPSideAtSnapshot: number;
  /** P(côté choisi) de la formule maintenant (au moment de l'exécution). */
  formulaPSideNow: number;
  /** Baisse maximale tolérée de P(côté) de la formule entre les deux (défaut 0,05). */
  staleDrop?: number;
}

export type GuardCode =
  | 'ok'
  | 'abstention_agent'
  | 'bloque_risque'
  | 'deja_parie'
  | 'parametres_invalides'
  | 'marche_a_bouge'
  | 'mise_sous_minimum'
  | 'sans_marge'
  | 'prix_parti';

export interface GuardFill {
  /** Prix moyen pondéré (hors frais) du parcours du carnet. */
  vwap: number;
  /** Parts achetées. */
  shares: number;
  /** Dépense totale, frais compris (≤ stakeUsd). */
  costUsd: number;
  /** Coût effectif moyen par part, frais compris (= costUsd / shares) : c'est le prix « réellement
   *  simulé » de la règle d'arrêt (gain gagné = 1 / costPerShare − 1). */
  costPerShare: number;
}

export interface GuardResult {
  code: GuardCode;
  /** Côté choisi par l'agent (null si abstention). Indicatif quand code ≠ 'ok'. */
  side: Side | null;
  /** Mise retenue (USD) ; 0 dès qu'un garde-fou refuse. */
  stakeUsd: number;
  /** Prix limite recalculé par le code ; null s'il n'a pas été calculé. */
  limitPrice: number | null;
  /** Exécution simulée ; null dès qu'un garde-fou refuse. */
  fill: GuardFill | null;
  /** Explication lisible (journal). */
  reason: string;
}

export const DEFAULT_STALE_DROP = 0.05;

/** Latence d'exécution du modèle commun : le carnet est relu 1 s après la décision. */
export const EXECUTION_LATENCY_MS = 1000;

// ---------------------------------------------------------------------------
// Briques
// ---------------------------------------------------------------------------

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Plafond de mise de la stratégie llm, calculé par le CODE : le plus petit de
 *   - LLM_MAX_STAKE_USD (plafond absolu),
 *   - le plafond de mise de la stratégie (p. ex. `computeStake(...).stake`, services/stake-sizing.ts),
 *   - ce qui reste sous les limites de risque du capital llm.
 * Toute valeur non finie (NaN, Infinity : un plafond absent n'est pas un plafond) ou négative
 * vaut 0 : dans le doute, pas de pari.
 */
export function llmStakeCapUsd(caps: { maxStakeUsd: number; strategyCapUsd: number; riskRoomUsd: number }): number {
  const vals = [caps?.maxStakeUsd, caps?.strategyCapUsd, caps?.riskRoomUsd];
  if (!vals.every(v => isNum(v) && v >= 0)) return 0;
  return Math.min(...(vals as number[]));
}

/**
 * Plus grand prix p ∈ ]0, 1] tel que coût effectif(p) = p + r·p·(1 − p) ≤ cible, avec
 * cible = P(côté) − minEdge ; null si aucun prix > 0 ne convient (cible ≤ 0).
 *
 * Résolu par BISSECTION sur `effectiveCostPerShare` (le même calcul de frais que partout
 * ailleurs). Le coût est strictement croissant sur [0, 1] pour r ∈ [0, 1[
 * (dérivée 1 + r·(1 − 2p) ≥ 1 − r > 0), avec coût(0) = 0 et coût(1) = 1 : la solution est
 * unique. Invariant à chaque pas : coût(lo) ≤ cible < coût(hi). On renvoie `lo`, donc la
 * limite respecte la marge EXACTEMENT (pas d'arrondi d'une formule fermée qui la ferait
 * dépasser de 1e-17) ; la racine fermée de `maxBuyPriceForEdge` donne le même prix à 1e-12
 * près (vérifié par les tests). On s'arrête quand le milieu ne se distingue plus des bornes
 * (précision du double, ~55 itérations), au plus 200 itérations.
 */
export function edgeLimitPrice(pSide: number, minEdge: number, feeRate: number): number | null {
  const target = pSide - minEdge;
  if (!isNum(target) || !isNum(feeRate) || feeRate < 0 || feeRate >= 1) return null;
  if (target <= 0) return null;
  if (effectiveCostPerShare(1, feeRate) <= target) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (mid <= lo || mid >= hi) break;
    if (effectiveCostPerShare(mid, feeRate) <= target) lo = mid;
    else hi = mid;
  }
  return lo > 0 ? lo : null;
}

function normalizeAsks(asks: ReadonlyArray<AskLevel> | null | undefined): BookLevel[] {
  if (!Array.isArray(asks)) return [];
  const out: BookLevel[] = [];
  for (const l of asks as ReadonlyArray<AskLevel>) {
    if (Array.isArray(l)) out.push({ price: Number(l[0]), size: Number(l[1]) });
    else if (l && typeof l === 'object') out.push({ price: Number((l as BookLevel).price), size: Number((l as BookLevel).size) });
  }
  return out; // niveaux invalides écartés (et tri) par estimateFill
}

/** Le premier défaut trouvé dans le contexte ou la décision, ou null. */
function invalidInput(d: LlmGuardDecision, ctx: GuardContext, staleDrop: number): string | null {
  if (!isNum(d.probaUp) || d.probaUp < 0 || d.probaUp > 1) return `probaUp ${d.probaUp} hors [0, 1]`;
  if (!isNum(d.prixLimite) || d.prixLimite <= 0) return `prix limite de l'agent ${d.prixLimite} invalide`;
  if (!isNum(d.miseUsd) || d.miseUsd < 0) return `mise de l'agent ${d.miseUsd} invalide`;
  if (!isNum(ctx.stakeCapUsd)) return `plafond de mise ${ctx.stakeCapUsd} non fini`;
  if (!isNum(ctx.minOrderUsd) || ctx.minOrderUsd < 0) return `minimum d'ordre ${ctx.minOrderUsd} invalide`;
  if (!isNum(ctx.feeRate) || ctx.feeRate < 0 || ctx.feeRate >= 1) return `taux de frais ${ctx.feeRate} hors [0, 1[`;
  if (!isNum(ctx.maxAsk) || ctx.maxAsk <= 0 || ctx.maxAsk > 1) return `maxAsk ${ctx.maxAsk} hors ]0, 1]`;
  if (!isNum(ctx.minEdge) || ctx.minEdge < 0) return `marge exigée ${ctx.minEdge} invalide`;
  if (!isNum(staleDrop) || staleDrop < 0) return `staleDrop ${staleDrop} invalide`;
  const p01 = (x: number) => isNum(x) && x >= 0 && x <= 1;
  if (!p01(ctx.formulaPSideAtSnapshot) || !p01(ctx.formulaPSideNow)) {
    return `P(côté) de la formule indisponible (instantané ${ctx.formulaPSideAtSnapshot}, maintenant ${ctx.formulaPSideNow})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exécution simulée (modèle commun llm / formule)
// ---------------------------------------------------------------------------

export interface SimulatedExecution {
  side: Side;
  /** Prix moyen pondéré (hors frais) du parcours du carnet. */
  vwap: number;
  /** Parts achetées. */
  shares: number;
  /** Dépense totale, frais compris (≤ stakeUsd). */
  costUsd: number;
  /** Coût effectif moyen par part, frais compris : gain pour 1 $ si gagné = 1 / costPerShare − 1. */
  costPerShare: number;
  /** Montant de l'ordre hors frais (parts · VWAP), comparé au minimum d'ordre. */
  notionalUsd: number;
}

/**
 * Exécution simulée d'un achat de `stakeUsd` (frais compris) sur `asksAfterLatency` — le carnet
 * du côté acheté RELU `EXECUTION_LATENCY_MS` après la décision —, sans dépasser `limitPrice`.
 * Parcours du carnet (`estimateFill`) avec la mise comme budget, puis parts = mise / coût moyen
 * frais compris (convention du registre, `binaryPayoff`) : le coût moyen vient d'un parcours un
 * peu plus profond que les parts retenues → prudent. Carnet trop mince : on prend ce qui est
 * rempli. null si rien n'est exécutable, si le montant rempli (hors frais) est sous
 * `minOrderUsd`, ou si une entrée est invalide.
 */
export function simulateExecution(
  side: Side, stakeUsd: number, limitPrice: number, asksAfterLatency: ReadonlyArray<AskLevel>, feeRate: number, minOrderUsd = 0,
): SimulatedExecution | null {
  if (side !== 'UP' && side !== 'DOWN') return null;
  if (!isNum(stakeUsd) || stakeUsd <= 0 || !isNum(limitPrice) || limitPrice <= 0) return null;
  if (!isNum(feeRate) || feeRate < 0 || feeRate >= 1 || !isNum(minOrderUsd) || minOrderUsd < 0) return null;
  const f = estimateFill(normalizeAsks(asksAfterLatency), stakeUsd, limitPrice, feeRate);
  if (f.avgPrice === null || f.avgCost === null || !(f.shares > 0)) return null;
  const shares = Math.min(f.shares, stakeUsd / f.avgCost);
  const costUsd = Math.min(stakeUsd, shares * f.avgCost);
  const notionalUsd = shares * f.avgPrice;
  if (!(notionalUsd >= minOrderUsd)) return null;
  return { side, vwap: f.avgPrice, shares, costUsd, costPerShare: f.avgCost, notionalUsd };
}

// ---------------------------------------------------------------------------
// Garde-fous
// ---------------------------------------------------------------------------

/**
 * Applique les garde-fous du code à une décision des agents. PURE : mêmes entrées ⇒ même sortie.
 * Garanties (testées sur des milliers de cas aléatoires) : si code = 'ok', stakeUsd ≤ stakeCapUsd,
 * fill.costUsd ≤ stakeUsd, limitPrice ≤ min(prixLimite, maxAsk), coût effectif(limitPrice) et
 * fill.costPerShare ≤ P(côté) − minEdge ; sinon stakeUsd = 0 et fill = null (aucun pari).
 */
export function applyGuards(decision: LlmGuardDecision, ctx: GuardContext): GuardResult {
  const refuse = (code: GuardCode, side: Side | null, reason: string, limitPrice: number | null = null): GuardResult =>
    ({ code, side, stakeUsd: 0, limitPrice, fill: null, reason });

  if (!decision || (decision.action !== 'acheter_up' && decision.action !== 'acheter_down')) {
    return refuse('abstention_agent', null, 'abstention des agents');
  }
  const side: Side = decision.action === 'acheter_up' ? 'UP' : 'DOWN';
  if (ctx.riskAllowed !== true) return refuse('bloque_risque', side, 'limites de risque du capital llm : entrée refusée');
  if (ctx.alreadyBetThisRound !== false) return refuse('deja_parie', side, 'déjà un pari llm sur ce round');

  const staleDrop = ctx.staleDrop ?? DEFAULT_STALE_DROP;
  const bad = invalidInput(decision, ctx, staleDrop);
  if (bad) return refuse('parametres_invalides', side, `garde-fou non évaluable : ${bad}`);

  // Fraîcheur : la décision porte sur l'instantané ; si la formule a depuis baissé P(côté) de
  // plus de staleDrop, le marché a bougé contre le côté choisi → ne pas acheter en retard.
  const drop = ctx.formulaPSideAtSnapshot - ctx.formulaPSideNow;
  if (drop > staleDrop) {
    return refuse('marche_a_bouge', side,
      `P(${side}) formule ${ctx.formulaPSideAtSnapshot.toFixed(3)} → ${ctx.formulaPSideNow.toFixed(3)} (baisse ${drop.toFixed(3)} > ${staleDrop})`);
  }

  const stakeUsd = Math.min(decision.miseUsd, ctx.stakeCapUsd);
  if (!(stakeUsd >= ctx.minOrderUsd) || !(stakeUsd > 0)) {
    return refuse('mise_sous_minimum', side,
      `mise ${stakeUsd.toFixed(2)} $ (agent ${decision.miseUsd.toFixed(2)} $, plafond ${ctx.stakeCapUsd.toFixed(2)} $) < minimum ${ctx.minOrderUsd} $`);
  }

  const pSide = side === 'UP' ? decision.probaUp : 1 - decision.probaUp;
  const target = pSide - ctx.minEdge;
  const edgeLimit = edgeLimitPrice(pSide, ctx.minEdge, ctx.feeRate);
  if (edgeLimit === null) {
    return refuse('sans_marge', side, `P(${side}) ${pSide.toFixed(3)} − marge ${ctx.minEdge} ≤ 0 : aucun prix ne laisse la marge`);
  }
  const limitPrice = Math.min(decision.prixLimite, ctx.maxAsk, edgeLimit);

  const x = simulateExecution(side, stakeUsd, limitPrice, ctx.asksNow, ctx.feeRate, ctx.minOrderUsd);
  const gone = (why: string) => refuse('prix_parti', side, `${why} (limite ${limitPrice.toFixed(4)})`, limitPrice);
  if (x === null) return gone(`rien d'exécutable, ou rempli < minimum ${ctx.minOrderUsd} $, sur le carnet relu`);
  // Dernier mot, à l'arrondi flottant près de la moyenne pondérée : jamais au-dessus de la marge.
  if (!(x.costPerShare <= target)) return gone(`coût moyen ${x.costPerShare.toFixed(4)} > P(${side}) − marge ${target.toFixed(4)}`);

  return {
    code: 'ok',
    side,
    stakeUsd,
    limitPrice,
    fill: { vwap: x.vwap, shares: x.shares, costUsd: x.costUsd, costPerShare: x.costPerShare },
    reason: `achat ${side} @ VWAP ${x.vwap.toFixed(4)} (frais compris ${x.costPerShare.toFixed(4)}/part ≤ P ${pSide.toFixed(3)} − ${ctx.minEdge}), `
      + `${x.shares.toFixed(2)} parts, ${x.costUsd.toFixed(2)} $ (mise ${stakeUsd.toFixed(2)} $, limite ${limitPrice.toFixed(4)})`,
  };
}
