/**
 * ============================================================================
 * stake-sizing.ts — DIMENSIONNEMENT ADAPTATIF ET PLAFONNÉ DE LA MISE
 * ============================================================================
 *
 * Remplace la mise FIXE (`BET_STAKE=5` dans `.env`) par une mise calculée, fondée
 * sur la seule grandeur qui porte un edge sur un marché binaire réglé tout-ou-rien :
 *   l'écart entre une probabilité de gain ESTIMÉE (p̂) et la probabilité d'équilibre
 *   (BE) du marché — c'est-à-dire le prix d'entrée.
 *
 * Modèle (identique à docs/rebuild/strategy/EDGE.md et docs/rebuild/risk/RISK.md) :
 *   gain si victoire (par 1 € misé) : b = gain_moyen / |perte moyenne|
 *   probabilité d'équilibre          : BE = 1 / (1 + b)          [= prix d'entrée]
 *   espérance par unité misée        : E = p̂ · (1 + b) − 1        (> 0 ⟺ p̂ > BE)
 *   fraction de Kelly                : f* = p̂ − (1 − p̂) / b      (> 0 ⟺ p̂ > BE)
 *   identité utile                   : f* = ((1 + b)·p̂ − 1) / b
 *
 * La mise Kelly BRUTE est `capital · K · f*` avec K = KELLY_FRACTION (« Kelly
 * fractionnaire », ici quart de Kelly). Elle est ensuite :
 *   1. RÉDUITE par deux modérateurs (drawdown courant, série de pertes) ;
 *   2. PLAFONNÉE par quatre plafonds DURS non contournables (par trade, limite
 *      quotidienne, exposition simultanée, plafond absolu) ;
 *   3. ÉVENTUELLEMENT relevée à une mise PLANCHER (jamais au-dessus des plafonds).
 *
 * ⚠️ HONNÊTETÉ : le sizing ne CRÉE pas d'edge. Aucun dimensionnement ne rend
 * rentable une espérance négative. Ici l'edge n'est PAS prouvé (t ≈ +1,25 à +1,75
 * sur ~167 trades, seuil Bonferroni ≈ 2,81 — cf. EDGE.md / MONITORING.md). Le
 * shrinkage (étape de crédibilité ci-dessous) et les plafonds durs existent
 * précisément pour que la mise reste DÉFENDABLE sous l'hypothèse « edge = 0 ».
 *
 * --------------------------------------------------------------------------
 * SIGNATURE — `computeStake(input: StakeSizingInput): StakeSizingResult`
 * --------------------------------------------------------------------------
 * ENTREES (toutes optionnelles sauf `capital` et `entryPrice` ; champs absents ou
 * `null` = information indisponible, jamais « 0 par défaut ») :
 *
 *   capital                 €      Capital disponible courant (> 0). Obligatoire.
 *   entryPrice              ∈]0,1[ Prix d'entrée du côté acheté = probabilité
 *                                  implicite du marché. Obligatoire.
 *   bookProb                [0,1]  Probabilité de gain estimée par le carnet.
 *   winRateRecent           [0,1]  Win rate récent de la coin (trades résolus).
 *   recentTrades            ≥0     Nombre de trades résolus supportant winRateRecent.
 *   avgGainPerUnit          >0     Gain moyen observé par 1 € misé (trades gagnants).
 *   avgLossPerUnit          >0     Perte moyenne observée par 1 € misé (trades perdants).
 *   consecutiveLosses       ≥0     Pertes consécutives actuelles.
 *   drawdownCurrent         ≥0     Drawdown courant depuis le pic (fraction : 0.12 = 12 %).
 *   openExposureEur         ≥0     € déjà engagés sur positions ouvertes.
 *   openPositions           ≥0     Nombre de positions ouvertes.
 *   maxConcurrentPositions  ≥1     Plafond de positions simultanées (défaut 5).
 *
 * SORTIE `StakeSizingResult` :
 *   stake        €     Mise recommandée, arrondie au CENTIME INFÉRIEUR.
 *                      0 ⟺ ne pas trader.
 *   rationale    fr    Justification lisible (chiffres inclus).
 *   capped       bool  true si un plafond DUR a mordu (ou a refusé le trade).
 *   (+ champs d'information : skipped, effectiveProb, breakEvenProb, edgePp,
 *      kellyFraction, rawKellyStake, maxStakeAllowed, bindingConstraint.)
 *
 * Fonction PURE : aucune I/O, aucun accès à `process.env`, aucune horloge, aucun
 * effet de bord. Mêmes entrées ⇒ mêmes sorties.
 */

// ---------------------------------------------------------------------------
// CONSTANTES — toutes justifiées (aucune n'est un réglage « au doigt mouillé »)
// ---------------------------------------------------------------------------

/** A. Fraction de Kelly retenue. Kelly plein suppose p̂ CONNU ; ici p̂ est estimé
 *  sur un échantillon où l'edge n'est pas prouvé. Le quart de Kelly est la réponse
 *  standard à l'incertitude de paramètre (Thorp ; MacLean-Thorp-Ziemba) : il
 *  conserve ~3/4 de la croissance asymptotique pour une variance très inférieure. */
export const KELLY_FRACTION = 0.25;

/** B. Borne supérieure de f* (on ne risque jamais plus de 100 % du capital/théorie). */
export const KELLY_F_MAX = 1.0;

/** C. Nombre minimal de trades résolus pour TRUSTER le win rate empirique d'une coin.
 *  Aligné sur MONITORING.md (« n < 5 → non testé »). En dessous : on ne s'appuie
 *  QUE sur le carnet, jamais sur un win rate à 3 trades. */
export const MIN_TRADES_SIGNAL = 5;

/** D. Constante de crédibilité (Bühlmann) : λ = n / (n + N0).
 *  À n = 20 observations on ne croit le signal qu'à 50 % ; à n = 65 (échantillon
 *  actuel) λ = 0,76 ; à n = 200 (seuil de re-décision de RISK.md) λ = 0,91 ;
 *  à n = 500 λ = 0,96. Le signal est donc SHRINKÉ vers le prix marché (p̂ → e),
 *  ce qui rend la mise petite quand l'edge serait en réalité nul. */
export const CREDIBILITY_N0 = 20;

/** E. Plafonds DURS (non contournables) — hérités du cadre de risque existant
 *  (`bot-config.ts` / `bot-with-dashboard.ts`) et de RISK.md §5.1. */
export const MAX_VARIANCE_PCT = 0.01;   // ≤ 1 % du capital/trade — borne de variance RISK.md
export const MAX_TRADE_PCT = 0.02;      // ≤ 2 % du capital par trade (RISK.md §5.1)
export const MAX_EXPOSURE_PCT = 0.10;   // ≤ 10 % du capital exposé SIMULTANÉMENT
export const DAILY_LOSS_PCT = 0.05;     // perte quotidienne max du cadre existant (5 %)
export const MIN_LOSSES_TO_DAILY_LIMIT = 3; // la limite quotidienne doit exiger ≥ 3 pertes
export const MAX_STAKE_EUR = 25;        // plafond absolu de sécurité (anti-bug/décimale)

/** F. Mise PLANCHER. 0,2 % du capital, et au moins 0,10 € (plus petit montant
 *  exploitable en papier). Le plancher ne s'applique JAMAIS au-dessus d'un plafond. */
export const MIN_STAKE_PCT = 0.002;
export const MIN_STAKE_EUR = 0.10;

/** G. Modérateur de DRAWDOWN — repris tel quel de RISK.md §5.3. */
export const DD_WARN_PCT = 0.05;   // ≥ 5 %  : alerte, mise normale
export const DD_HALVE_PCT = 0.10;  // ≥ 10 % : mise RÉDUITE DE MOITIÉ (0,5)
export const DD_STOP_PCT = 0.20;   // ≥ 20 % : STOP (mise 0)

/** H. Modérateur de SÉRIE DE PERTES — RISK.md §5.2 (kill-switch à 8 pertes). */
export const STREAK_HALVE = 4;     // ≥ 4 pertes consécutives : mise RÉDUITE DE MOITIÉ
export const STREAK_STOP = 8;      // ≥ 8 pertes consécutives : STOP (mise 0)

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface StakeSizingInput {
  capital: number;
  entryPrice: number;
  bookProb?: number | null;
  winRateRecent?: number | null;
  recentTrades?: number | null;
  avgGainPerUnit?: number | null;
  avgLossPerUnit?: number | null;
  consecutiveLosses?: number | null;
  drawdownCurrent?: number | null;
  openExposureEur?: number | null;
  openPositions?: number | null;
  maxConcurrentPositions?: number | null;
}

export interface StakeSizingResult {
  /** Mise recommandée en €, arrondie au centime INFÉRIEUR. 0 = ne pas trader. */
  stake: number;
  /** Justification lisible en français. */
  rationale: string;
  /** true si un plafond DUR a mordu sur la mise, ou a refusé le trade. */
  capped: boolean;
  /** true si la fonction recommande de ne pas trader. */
  skipped: boolean;
  /** p̂ effectif après shrinkage (null si indéterminable). */
  effectiveProb: number | null;
  /** Probabilité d'équilibre BE = 1/(1+b) (null si indéterminable). */
  breakEvenProb: number | null;
  /** Edge effectif en points de probabilité : (p̂ − BE)·100. */
  edgePp: number | null;
  /** Fraction de Kelly brute f* (null si indéterminable). */
  kellyFraction: number | null;
  /** Mise Kelly brute avant modérateurs et plafonds : capital · K · f*. */
  rawKellyStake: number;
  /** Plafond dur effectif (le plus serré des quatre) en €. */
  maxStakeAllowed: number;
  /** Nom du facteur qui a fixé la mise finale. */
  bindingConstraint: string;
}

// ---------------------------------------------------------------------------
// HELPERS (purs)
// ---------------------------------------------------------------------------

function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Nombre fini, ou null. Ne transforme JAMAIS un « manquant » en 0. */
function opt(x: unknown): number | null {
  return isFiniteNum(x) ? x : null;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)} %`;
}

function eur(x: number): string {
  return `${x.toFixed(2)} €`;
}

/** Arrondi au centime INFÉRIEUR : ne peut jamais faire dépasser un plafond. */
function floorCents(x: number): number {
  return Math.floor((x + 1e-9) * 100) / 100;
}

// ---------------------------------------------------------------------------
// CŒUR
// ---------------------------------------------------------------------------

export function computeStake(input: StakeSizingInput): StakeSizingResult {
  const capital = opt(input?.capital);
  const e = opt(input?.entryPrice);

  const skippedResult = (
    rationale: string,
    extra: Partial<StakeSizingResult> = {},
  ): StakeSizingResult => ({
    stake: 0,
    rationale,
    capped: false,
    skipped: true,
    effectiveProb: null,
    breakEvenProb: null,
    edgePp: null,
    kellyFraction: null,
    rawKellyStake: 0,
    maxStakeAllowed: 0,
    bindingConstraint: 'aucune mise',
    ...extra,
  });

  // --- (c) CAS DÉGÉNÉRÉS : entrées invalides --------------------------------
  if (capital === null || capital <= 0) {
    return skippedResult(`Capital indisponible ou invalide (${String(input?.capital)}) : aucune mise possible.`);
  }
  if (e === null || e <= 0 || e >= 1) {
    return skippedResult(
      `Prix d'entrée ${String(input?.entryPrice)} hors de ]0,1[ : mise non déterminable, on ne trade pas.`,
    );
  }

  // --- 1. Odds nettes b et probabilité d'équilibre BE -----------------------
  const g = opt(input?.avgGainPerUnit);
  const l = opt(input?.avgLossPerUnit);
  const useEmpiricalOdds = g !== null && g > 0 && l !== null && l > 0;
  const b = useEmpiricalOdds ? (g as number) / (l as number) : (1 - e) / e;
  const oddsSource = useEmpiricalOdds ? 'gain/perte moyen observés de la coin' : 'théorique (1−e)/e';
  const BE = 1 / (1 + b);

  // --- 2. Signal de probabilité + shrinkage de crédibilité ------------------
  const n = Math.max(0, Math.floor(opt(input?.recentTrades) ?? 0));
  const wr = opt(input?.winRateRecent);
  const book = opt(input?.bookProb);

  let pSig: number | null = null;
  let evidence = 0;
  let sigSource = '';
  let lowConfidence = false;

  if (wr !== null && wr >= 0 && wr <= 1 && n >= MIN_TRADES_SIGNAL) {
    pSig = wr;
    evidence = n;
    sigSource = `win rate empirique ${pct(wr)} sur n=${n} trades résolus`;
  } else if (book !== null && book >= 0 && book <= 1) {
    pSig = book;
    evidence = CREDIBILITY_N0; // pseudo-comptage : le carnet « vaut » N0 observations
    sigSource = `probabilité carnet ${pct(book)}`;
    lowConfidence = n < MIN_TRADES_SIGNAL;
  }

  if (pSig === null) {
    return skippedResult(
      `Aucun signal de probabilité exploitable (win rate indisponible ou n=${n} < ${MIN_TRADES_SIGNAL}, ` +
        `et carnet indisponible) : mise nulle. Le prix d'entrée seul (= BE) n'est pas un edge.`,
      { breakEvenProb: BE },
    );
  }

  // Shrinkage vers le prix marché e (hypothèse « edge = 0 ») : λ = n/(n+N0).
  const lambda = evidence / (evidence + CREDIBILITY_N0);
  const pHat = clamp(e + lambda * (pSig - e), 0, 1);

  // --- 3. Edge et Kelly fractionnaire --------------------------------------
  const edge = pHat - BE;
  const edgePp = edge * 100;

  if (edge <= 0) {
    return skippedResult(
      `Edge nul ou négatif : p̂=${pct(pHat)} ≤ BE=${pct(BE)} (edge ${edgePp.toFixed(2)} pt). ` +
        `Espérance négative ou nulle ⇒ mise nulle (aucun sizing ne crée un edge).`,
      { effectiveProb: pHat, breakEvenProb: BE, edgePp },
    );
  }

  const fStarRaw = ((1 + b) * pHat - 1) / b; // = p̂ − (1−p̂)/b
  const fStar = clamp(fStarRaw, 0, KELLY_F_MAX);

  // --- 4. Mise Kelly brute -------------------------------------------------
  const rawKellyStake = capital * KELLY_FRACTION * fStar;

  // --- 5. Modérateurs (drawdown, série de pertes) --------------------------
  const dd = clamp(opt(input?.drawdownCurrent) ?? 0, 0, 1);
  let ddThrottle = 1;
  let ddLabel = `drawdown ${pct(dd)} < ${pct(DD_WARN_PCT)}`;
  if (dd >= DD_STOP_PCT) {
    ddThrottle = 0;
    ddLabel = `drawdown ${pct(dd)} ≥ ${pct(DD_STOP_PCT)} → STOP (RISK.md §5.3)`;
  } else if (dd >= DD_HALVE_PCT) {
    ddThrottle = 0.5;
    ddLabel = `drawdown ${pct(dd)} ≥ ${pct(DD_HALVE_PCT)} → mise réduite de moitié`;
  } else if (dd >= DD_WARN_PCT) {
    ddThrottle = 0.75;
    ddLabel = `drawdown ${pct(dd)} ≥ ${pct(DD_WARN_PCT)} → mise réduite à 75 %`;
  }

  const streak = Math.max(0, Math.floor(opt(input?.consecutiveLosses) ?? 0));
  let streakThrottle = 1;
  let streakLabel = `${streak} pertes consécutives (< ${STREAK_HALVE})`;
  if (streak >= STREAK_STOP) {
    streakThrottle = 0;
    streakLabel = `${streak} pertes consécutives ≥ ${STREAK_STOP} → STOP (RISK.md §5.2)`;
  } else if (streak >= STREAK_HALVE) {
    streakThrottle = 0.5;
    streakLabel = `${streak} pertes consécutives ≥ ${STREAK_HALVE} → mise réduite de moitié`;
  }

  const throttled = rawKellyStake * ddThrottle * streakThrottle;

  // --- 6. PLAFONDS DURS (non contournables) --------------------------------
  const positions = Math.max(0, Math.floor(opt(input?.openPositions) ?? 0));
  const maxPositions = Math.max(1, Math.floor(opt(input?.maxConcurrentPositions) ?? 5));
  const expo = Math.max(0, opt(input?.openExposureEur) ?? 0);

  const capVariance = capital * MAX_VARIANCE_PCT;
  const capTrade = capital * MAX_TRADE_PCT;
  const capDaily = (capital * DAILY_LOSS_PCT) / MIN_LOSSES_TO_DAILY_LIMIT;
  const capExposure = Math.max(0, capital * MAX_EXPOSURE_PCT - expo);
  const capAbsolute = MAX_STAKE_EUR;

  if (positions >= maxPositions) {
    return skippedResult(
      `Refus (plafond dur) : ${positions} positions ouvertes ≥ ${maxPositions} simultanées maximum.`,
      {
        capped: true,
        effectiveProb: pHat,
        breakEvenProb: BE,
        edgePp,
        kellyFraction: fStar,
        rawKellyStake,
        bindingConstraint: 'positions simultanées',
      },
    );
  }
  if (capExposure <= 0) {
    return skippedResult(
      `Refus (plafond dur) : exposition ${eur(expo)} ≥ ${pct(MAX_EXPOSURE_PCT)} du capital ` +
        `(${eur(capital * MAX_EXPOSURE_PCT)}). Aucun budget d'exposition disponible.`,
      {
        capped: true,
        effectiveProb: pHat,
        breakEvenProb: BE,
        edgePp,
        kellyFraction: fStar,
        rawKellyStake,
        maxStakeAllowed: 0,
        bindingConstraint: 'exposition simultanée',
      },
    );
  }

  const caps: Array<[string, number]> = [
    [`plafond ${pct(MAX_VARIANCE_PCT)} du capital par trade (borne de variance, RISK.md §5.1)`, capVariance],
    [`plafond par trade ${pct(MAX_TRADE_PCT)}`, capTrade],
    [`limite quotidienne ${pct(DAILY_LOSS_PCT)} / ${MIN_LOSSES_TO_DAILY_LIMIT} pertes`, capDaily],
    [`exposition simultanée ${pct(MAX_EXPOSURE_PCT)} restante`, capExposure],
    [`plafond absolu ${eur(MAX_STAKE_EUR)}`, capAbsolute],
  ];
  let maxStakeAllowed = caps[0][1];
  let bindingCapLabel = caps[0][0];
  for (const [label, val] of caps) {
    if (val < maxStakeAllowed - EPS) {
      maxStakeAllowed = val;
      bindingCapLabel = label;
    }
  }

  const cappedByHardLimit = throttled > maxStakeAllowed + EPS;

  // --- 7. Planche et plafond -----------------------------------------------
  // Le plancher ne s'applique QU'À une mise Kelly plus petite que lui ; il ne
  // peut jamais relever une mise au-dessus d'un plafond dur, et il ne s'applique
  // pas quand c'est le plafond lui-même qui a mordu (sinon un capital élevé
  // ferait refuser tous les trades alors que Kelly veut miser DAVANTAGE).
  const minStake = Math.max(MIN_STAKE_EUR, capital * MIN_STAKE_PCT);
  let stake: number;
  let binding: string;

  if (throttled <= EPS) {
    // modérateur à 0 (drawdown STOP / série STOP) : le plancher n'a pas le droit
    // de ressusciter un trade interdit.
    return skippedResult(
      `Mise nulle : ${ddThrottle === 0 ? ddLabel : streakThrottle === 0 ? streakLabel : 'mise Kelly brute nulle'}.`,
      {
        effectiveProb: pHat,
        breakEvenProb: BE,
        edgePp,
        kellyFraction: fStar,
        rawKellyStake,
        maxStakeAllowed,
        bindingConstraint: ddThrottle === 0 ? 'drawdown' : 'série de pertes',
      },
    );
  } else if (throttled > maxStakeAllowed + EPS) {
    stake = maxStakeAllowed;
    binding = bindingCapLabel;
  } else if (throttled >= minStake - EPS) {
    stake = throttled;
    binding = 'Kelly fractionnaire';
  } else if (minStake <= maxStakeAllowed + EPS) {
    stake = minStake;
    binding = 'mise plancher';
  } else {
    return skippedResult(
      `Refus (plafond dur) : la mise plancher ${eur(minStake)} dépasse le plafond autorisé ` +
        `${eur(maxStakeAllowed)} — on ne trade pas plutôt que de violer le cadre de risque.`,
      {
        capped: true,
        effectiveProb: pHat,
        breakEvenProb: BE,
        edgePp,
        kellyFraction: fStar,
        rawKellyStake,
        maxStakeAllowed,
        bindingConstraint: bindingCapLabel,
      },
    );
  }

  stake = floorCents(Math.min(stake, maxStakeAllowed));

  // --- 8. Rationale + résultat ---------------------------------------------
  const parts: string[] = [];
  parts.push(
    `Signal : ${sigSource}, shrink de crédibilité λ=${lambda.toFixed(3)} → p̂=${pct(pHat)} ` +
      `(prix marché/BE=${pct(BE)}, odds b=${b.toFixed(3)} ${useEmpiricalOdds ? '[observés]' : '[théoriques]'}).`,
  );
  parts.push(`Edge = ${edgePp.toFixed(2)} pt de probabilité > 0.`);
  parts.push(`Kelly plein f*=${fStar.toFixed(4)} → Kelly fractionnaire ×${KELLY_FRACTION} → ${eur(rawKellyStake)} bruts.`);
  if (ddThrottle !== 1 || streakThrottle !== 1) {
    parts.push(`Modérateurs : ${ddLabel} ; ${streakLabel}.`);
  }
  if (cappedByHardLimit) {
    parts.push(`Plafond DUR appliqué (${bindingCapLabel}) : ${eur(throttled)} ramenés à ${eur(maxStakeAllowed)}.`);
  }
  if (lowConfidence) {
    parts.push(`Confiance faible (n=${n} < ${MIN_TRADES_SIGNAL}) : signal carnet uniquement, mise prudente.`);
  }
  parts.push(`Mise finale : ${eur(stake)} = ${pct(stake / capital)} du capital (plafond ${eur(maxStakeAllowed)}).`);

  return {
    stake,
    rationale: parts.join(' '),
    capped: cappedByHardLimit,
    skipped: false,
    effectiveProb: pHat,
    breakEvenProb: BE,
    edgePp,
    kellyFraction: fStar,
    rawKellyStake,
    maxStakeAllowed,
    bindingConstraint: cappedByHardLimit ? bindingCapLabel : binding,
  };
}

export default computeStake;
