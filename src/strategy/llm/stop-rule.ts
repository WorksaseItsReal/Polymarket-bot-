/**
 * stop-rule.ts — règle d'arrêt PRÉ-ENREGISTRÉE de la campagne de mesure de la stratégie papier
 * « llm » contre la formule (juste valeur). Fixée AVANT la collecte ; ne se modifie pas en cours
 * de campagne.
 *
 * ---------------------------------------------------------------------------------------------
 * RÈGLE (texte pré-enregistré, mot pour mot)
 * ---------------------------------------------------------------------------------------------
 * Unité : une décision appariée = un round où l'agent a produit une P(Up) valide ET où la formule
 * avait une P(Up) au même instantané, round réglé (issue y ∈ {0,1}). Les décisions en échec
 * technique sont exclues du Brier mais comptées dans le gain (gain 0) et leur taux est rapporté.
 * - Brier apparié : b_i = (p_llm − y)² − (p_formule − y)² ; ΔB = moyenne (négatif = llm meilleur).
 * - Gain apparié pour 1 $ de mise unitaire : g_i = G_llm − G_formule, où G = 0 sans pari ; pari
 *   gagné → 1/coût effectif − 1 ; perdu → −1. La formule et llm passent par le MÊME modèle
 *   d'exécution : décision, puis latence d'exécution de 1 s, carnet RELU à ce moment, remplissage
 *   simulé sur ce carnet jusqu'au prix limite, frais inclus (coût effectif). Formule : décision au
 *   même instantané que llm, exécutée par ce modèle ; llm : décision (APRÈS garde-fous) à la
 *   réception de la réponse des agents (sa latence de réflexion est un coût réel), exécutée par ce
 *   même modèle. Pas de prix « à l'instantané » pour la formule.
 * - z = moyenne / erreur-type, erreurs groupées par créneau de 5 min (réutilise `clusteredMeanT`
 *   de src/analysis/stats.ts).
 * - Deux regards seulement, bornes d'O'Brien-Fleming (α global ≈ 5 % par critère) : n = 500 →
 *   |z| ≥ 2,80 ; n = 1 000 → |z| ≥ 1,98.
 * - À 500 : ÉCHEC (arrêt) si z_B ≥ +2,80 (llm moins bien calibré) OU z_G ≤ −2,80 (llm gagne
 *   moins) ; SUCCÈS si z_B ≤ −2,80 ET z_G ≥ +2,80 ; sinon NON CONCLUANT → prolonger jusqu'à 1 000.
 * - À 1 000 : SUCCÈS si z_B ≤ −1,98 ET z_G ≥ +1,98 ; sinon ÉCHEC (la charge de la preuve est sur
 *   llm : par défaut on garde la formule, plus simple et gratuite).
 * - n < 500 → 'insuffisant'. Le compte est PAR CAMPAGNE = (version du CLI, version des prompts) :
 *   changer l'un ou l'autre ouvre une nouvelle campagne qui repart de zéro (pas d'ajustement en
 *   cours de route). « Succès » ne veut pas dire passage au réel (hors périmètre).
 * ---------------------------------------------------------------------------------------------
 *
 * Notes d'implémentation (n'ajoutent aucun degré de liberté à la règle) :
 * - `pairs` = les décisions d'UNE campagne, dans l'ordre CHRONOLOGIQUE. Chaque regard porte sur
 *   exactement les 500 (puis 1 000) premières décisions appariées : appeler la fonction à n = 700
 *   ne crée pas un regard de plus (on rejuge les 500 premières). L'arrêt à 500 est CONTRAIGNANT :
 *   si le regard intermédiaire a tranché (succès ou échec), des données collectées ensuite ne
 *   changent rien (verdict et statistiques restent ceux de 500, `look` = 'intermediaire').
 * - Bornes 2,80 / 1,98 : O'Brien-Fleming bilatéral à deux regards (fractions d'information 1/2
 *   et 1), α = 5 % : 2,797 et 1,977, arrondies au centième supérieur — un cheveu plus strictes.
 * - Échecs techniques : (a) une ligne de `pairs` dont pLlm est null, non finie ou hors [0, 1]
 *   est un échec technique : exclue du Brier, comptée dans le gain avec G_llm = 0 (pas de pari),
 *   g = −G_formule, dans son créneau ; (b) `nTechFailures` compte les échecs sans ligne appariée
 *   (G_formule inconnu) : chacun compte dans le gain pour g = 0, comme son propre groupe, au
 *   prorata de la fenêtre du regard (ils ne sont pas datés). Les deux réduisent |z_G| quand
 *   l'écart est en faveur de llm : la charge de la preuve reste sur llm.
 * - Lignes inutilisables (pFormule hors [0, 1], y ∉ {0, 1}, gains non finis, créneau vide) :
 *   écartées et comptées dans `nInvalid` — un nInvalid > 0 est une anomalie à corriger, pas un
 *   réglage.
 * - z non calculable (moins de 2 créneaux, variance nulle) : ne franchit aucune borne.
 * - Modèle d'exécution commun : `simulateExecution` (guards.ts, utilisée aussi par `applyGuards`),
 *   avec le carnet relu `EXECUTION_LATENCY_MS` après la décision ; `executionUnitGain` en tire G.
 *
 * Module PUR (aucune I/O).
 */

import { clusteredMeanT } from '../../analysis/stats.js';
import type { SimulatedExecution } from './guards.js';

export const STOP_RULE = {
  nIntermediaire: 500,
  zIntermediaire: 2.8,
  nFinal: 1000,
  zFinal: 1.98,
} as const;

export type StopLook = 'aucun' | 'intermediaire' | 'final';
export type StopVerdict = 'insuffisant' | 'non_concluant' | 'succes' | 'echec';

export interface PairedDecision {
  /** Créneau de 5 min (groupe des erreurs-types), p. ex. le slot en secondes. */
  slot: string;
  /** P(Up) des agents ; null (ou invalide) = échec technique. */
  pLlm: number | null;
  /** P(Up) de la formule au même instantané. */
  pFormule: number;
  /** Issue : 1 si Up a gagné. */
  y: 0 | 1;
  /** Gain pour 1 $ de llm (décision après garde-fous à la réception de la réponse, exécutée par
   *  le modèle commun : `executionUnitGain`) ; 0 sans pari. */
  gLlm: number;
  /** Gain pour 1 $ de la formule (décision au même instantané que llm, exécutée par le même
   *  modèle : `executionUnitGain`) ; 0 sans pari. */
  gFormule: number;
}

export interface PairedVerdictResult {
  /** Décisions appariées valides fournies (pLlm valide). */
  n: number;
  /** Décisions appariées utilisées par le regard retenu (500, 1 000, ou n si n < 500). */
  nUsed: number;
  /** ΔB = moyenne de (p_llm − y)² − (p_formule − y)² ; négatif = llm mieux calibré. */
  deltaBrier: number | null;
  zBrier: number | null;
  /** ΔG = moyenne de G_llm − G_formule (gain pour 1 $) ; positif = llm gagne plus. */
  deltaGain: number | null;
  zGain: number | null;
  look: StopLook;
  verdict: StopVerdict;
  bornes: typeof STOP_RULE;
  /** Échecs techniques dans la fenêtre du regard (lignes à pLlm invalide + compte au prorata). */
  nTechFailures: number;
  /** nTechFailures / (nUsed + nTechFailures) ; null si aucune décision. */
  techFailureRate: number | null;
  /** Lignes écartées car inutilisables (anomalie). */
  nInvalid: number;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isProb = (x: unknown): x is number => isNum(x) && x >= 0 && x <= 1;

/**
 * Gain d'un pari pour 1 $ misé au coût effectif `costPerShare` (prix + frais, par part) :
 * gagné → 1 / coût − 1 ; perdu → −1. (Sans pari, G = 0 : ne pas appeler cette fonction.)
 */
export function unitGain(won: boolean, costPerShare: number): number {
  if (!isNum(costPerShare) || costPerShare <= 0) throw new RangeError(`coût effectif par part invalide : ${costPerShare}`);
  return won ? 1 / costPerShare - 1 : -1;
}

/**
 * G pour 1 $ d'une décision exécutée par le modèle commun (`simulateExecution`, guards.ts) :
 * 0 sans pari (abstention, garde-fou, rien d'exécutable : exécution null) ; sinon `unitGain`
 * au coût effectif réellement simulé, le côté gagnant étant Up si y = 1.
 */
export function executionUnitGain(exec: Pick<SimulatedExecution, 'side' | 'costPerShare'> | null, y: 0 | 1): number {
  if (!exec) return 0;
  return unitGain(exec.side === 'UP' ? y === 1 : y === 0, exec.costPerShare);
}

interface Window {
  nUsed: number;
  deltaBrier: number | null;
  zBrier: number | null;
  deltaGain: number | null;
  zGain: number | null;
  nTech: number;
}

/**
 * Verdict de la règle d'arrêt pour une campagne. `pairs` dans l'ordre chronologique ;
 * `nTechFailures` = échecs techniques sans ligne appariée (voir l'en-tête).
 */
export function pairedVerdict(pairs: ReadonlyArray<PairedDecision>, nTechFailures = 0): PairedVerdictResult {
  // Lignes utilisables, dans l'ordre : valides (Brier + gain) ou échecs techniques (gain seul).
  type Row = { key: string; b: number | null; g: number };
  const rows: Row[] = [];
  let nInvalid = 0;
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const usable = p && typeof p.slot === 'string' && p.slot !== '' && isProb(p.pFormule)
      && (p.y === 0 || p.y === 1) && isNum(p.gFormule);
    if (!usable) { nInvalid++; continue; }
    if (isProb(p.pLlm)) {
      if (!isNum(p.gLlm)) { nInvalid++; continue; }
      rows.push({ key: p.slot, b: (p.pLlm - p.y) ** 2 - (p.pFormule - p.y) ** 2, g: p.gLlm - p.gFormule });
    } else {
      rows.push({ key: p.slot, b: null, g: 0 - p.gFormule }); // échec technique : G_llm = 0
    }
  }
  const n = rows.reduce((a, r) => a + (r.b !== null ? 1 : 0), 0);
  const extraTech = isNum(nTechFailures) && nTechFailures > 0 ? Math.floor(nTechFailures) : 0;

  /**
   * Statistiques sur les `m` premières décisions appariées valides et les échecs intercalés
   * (un échec postérieur à la m-ième décision est hors fenêtre) ; `m` = null : tout (n < 500,
   * statistiques indicatives sans verdict).
   */
  const windowStats = (m: number | null): Window => {
    const brier: Array<{ key: string; x: number }> = [];
    const gain: Array<{ key: string; x: number }> = [];
    let inPairsTech = 0;
    for (const r of rows) {
      if (m !== null && brier.length >= m) break;
      if (r.b !== null) brier.push({ key: r.key, x: r.b });
      else inPairsTech++;
      gain.push({ key: r.key, x: r.g });
    }
    const counted = m === null || n === 0 || m >= n ? extraTech : Math.round((extraTech * m) / n);
    for (let k = 0; k < counted; k++) gain.push({ key: `echec-technique-${k}`, x: 0 });
    const B = clusteredMeanT(brier);
    const G = clusteredMeanT(gain);
    return { nUsed: brier.length, deltaBrier: B.mean, zBrier: B.t, deltaGain: G.mean, zGain: G.t, nTech: inPairsTech + counted };
  };

  const result = (w: Window, look: StopLook, verdict: StopVerdict): PairedVerdictResult => ({
    n,
    nUsed: w.nUsed,
    deltaBrier: w.deltaBrier,
    zBrier: w.zBrier,
    deltaGain: w.deltaGain,
    zGain: w.zGain,
    look,
    verdict,
    bornes: STOP_RULE,
    nTechFailures: w.nTech,
    techFailureRate: w.nUsed + w.nTech > 0 ? w.nTech / (w.nUsed + w.nTech) : null,
    nInvalid,
  });

  if (n < STOP_RULE.nIntermediaire) return result(windowStats(null), 'aucun', 'insuffisant');

  // z non calculable (null) : ne franchit aucune borne.
  const atOrAbove = (z: number | null, c: number) => z !== null && z >= c;
  const atOrBelow = (z: number | null, c: number) => z !== null && z <= c;

  // Regard intermédiaire : les 500 premières décisions appariées, arrêt contraignant.
  const wi = windowStats(STOP_RULE.nIntermediaire);
  const ci = STOP_RULE.zIntermediaire;
  if (atOrAbove(wi.zBrier, ci) || atOrBelow(wi.zGain, -ci)) return result(wi, 'intermediaire', 'echec');
  if (atOrBelow(wi.zBrier, -ci) && atOrAbove(wi.zGain, ci)) return result(wi, 'intermediaire', 'succes');
  if (n < STOP_RULE.nFinal) return result(wi, 'intermediaire', 'non_concluant');

  // Regard final : les 1 000 premières ; par défaut, échec (on garde la formule).
  const wf = windowStats(STOP_RULE.nFinal);
  const cf = STOP_RULE.zFinal;
  const success = atOrBelow(wf.zBrier, -cf) && atOrAbove(wf.zGain, cf);
  return result(wf, 'final', success ? 'succes' : 'echec');
}
