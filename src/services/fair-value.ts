/**
 * ============================================================================
 * fair-value.ts — JUSTE VALEUR d'un round « Up/Down 5 min » et décision d'entrée
 * ============================================================================
 *
 * Pourquoi ce module remplace la « fenêtre favori [0,58–0,65] » :
 *   docs/EDGE-VALIDATION.md §5 a mesuré sur 1 411 décisions que le marché est
 *   CALIBRÉ par niveau de prix (WR réel ≈ prix payé, ±3 pts). Acheter le favori
 *   parce qu'il coûte 0,62 est donc un pari à espérance nulle AVANT frais, négative
 *   après. Aucune règle fondée sur le seul prix d'entrée ne peut créer d'edge : il
 *   faut un prédicteur indépendant du carnet.
 *
 * Le prédicteur retenu est le seul qui découle de la règle de résolution :
 *   « Up » ⟺ prix final ≥ prix d'ouverture (strike) — tous deux des moyennes Chainlink
 *   sur 60 s depuis août 2026 (voir `twapWindowSec`). Avec le spot S, le strike K,
 *   le temps restant τ et la volatilité σ, P(Up) se calcule ; on n'achète un côté
 *   QUE si cette probabilité dépasse son coût réel (ask + frais taker) d'au moins
 *   `minEdge`. Le critère est l'ESPÉRANCE, jamais le win rate : un win rate élevé
 *   s'obtient trivialement en achetant des favoris à 0,95, sans aucun gain.
 *
 * ⚠️ Ce modèle n'est PAS validé sur données historiques (aucune donnée spot+carnet
 *   horodatée n'existe dans le dépôt). Il est prudent par construction
 *   (vol max(court, long), incertitude de strike et d'oracle, marge
 *   minimale, entrée interdite en toute fin de round) et chaque évaluation est journalisée
 *   (journal des décisions) pour mesurer sa calibration (`scripts/analysis/fv-report.ts`).
 *
 * Module PUR : aucune I/O, aucune horloge, aucun accès à process.env.
 */

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------

export interface FairValueConfig {
  /** Taux de frais taker Polymarket `crypto_fees_v2` : fee = parts · rate · p · (1−p).
   *  Barème officiel crypto : 0,07 (1,75 $ pour 100 parts à 0,50 $) ; makers jamais
   *  facturés (et 20 % de remise). */
  takerFeeRate: number;
  /** Fenêtre de moyenne (TWAP) du règlement, en s. Depuis le 7 août 2026, les marchés
   *  « Up or Down » 5 min se règlent sur le flux Chainlink TWAP (30 s, puis 60 s depuis
   *  mi-août 2026) : « Up » ⟺ TWAP à la fin ≥ prix à battre, et le prix à battre est LUI
   *  AUSSI lu sur ce flux (changelog Polymarket). 0 = ancien règlement ponctuel. ≤ 60. */
  twapWindowSec: number;
  /** Incertitude du strike, en « secondes de variance ». Avec TWAP, le strike est estimé
   *  par (O+H+L+C)/4 de la bougie 1 min précédant l'ouverture : erreur ≈ 0,19·σ√60, soit
   *  ≈ 2 s de variance (3 par prudence). Sans TWAP (open de la bougie du slot vs point
   *  Chainlink), 10 était la valeur retenue. */
  strikeNoiseSec: number;
  /** Incertitude du strike + écart de flux (Binance vs Chainlink), en points de base. */
  basisBps: number;
  /** Edge minimal exigé, en probabilité, APRÈS frais et prix d'exécution réel. */
  minEdge: number;
  /** Marge supplémentaire exigée, en écarts-types du bruit de NOTRE probabilité (prix à
   *  battre seulement estimé, écart de flux) : edge requis = minEdge + k·σ_p. Le carnet
   *  connaît le prix à battre exact (affiché par Polymarket) ; un désaccord de l'ordre de
   *  notre bruit n'est pas un edge mais de la sélection adverse. Simulation (10 graines ×
   *  3 000 rounds, règlement TWAP) : k = 0 → contre un carnet juste, 13 % des rounds joués
   *  à −5 %/$ (t = −3,9 : écart et frais payés sans edge) ; k = 1,5 → 0,1 %. Carnet en
   *  retard de 10 s : +17,5 % → +38 %/$ par pari, et gain total +17 %. */
  noiseEdgeK: number;
  /** Probabilité modèle minimale du côté acheté. Monte le win rate (on ne parie que
   *  sur le côté probable) et réduit la variance, au prix de quelques paris +EV sur
   *  l'outsider. Si le modèle est calibré, WR attendu ≥ minProb. */
  minProb: number;
  /** Pas d'entrée avec moins de τ secondes restantes : en toute fin de round, l'écart
   *  Binance/Chainlink et notre latence REST dominent le signal. Jamais moins que
   *  `twapWindowSec` (voir `entryMinTauSec`). */
  minTauSec: number;
  /** Pas d'entrée avant que le marché ait digéré l'ouverture. */
  maxTauSec: number;
  /** Bornes d'ask achetable : au-delà de maxAsk le gain est minuscule et l'erreur de
   *  modèle domine ; sous minAsk on parie contre un quasi-certain. */
  minAsk: number;
  maxAsk: number;
  /** Multiplicateur de calibration du score z (1 = modèle brut). < 1 rend le modèle moins
   *  confiant, > 1 plus confiant. À fixer d'après `scripts/analysis/fv-report.ts` (estimé
   *  par maximum de vraisemblance sur les rounds réglés), jamais au jugé. */
  zScale: number;
  /** Mélange avec le prix du marché : logit(p) = blendModel·logit(p_modèle) + blendMarket·logit(p_marché).
   *  (1, 0) = modèle seul (défaut). À fixer d'après les rapports (estimation + validation hors
   *  échantillon), jamais au jugé. Si le marché sait déjà tout, le mélange tend vers lui et
   *  les edges disparaissent : c'est voulu. */
  blendModel: number;
  blendMarket: number;
  /** Distribution des rendements : 'normal' (défaut) ou 't4'.
   *  ⚠️ À variance égale, la t4 est PLUS confiante que la normale pour |z| < 2
   *  (F(1) = 0,885 contre 0,841) — précisément la zone où le bot parie. Elle n'est donc
   *  pas « prudente » ; elle ne l'est qu'au-delà de |z| ≈ 2. */
  tails: 't4' | 'normal';
  /** Estimateur de volatilité : 'cc' clôture-à-clôture (défaut), 'parkinson' (plus haut /
   *  plus bas de chaque minute : ~5× plus efficace pour un mouvement brownien, mais biaisé
   *  vers le haut par le rebond bid/ask et vers le bas par l'échantillonnage), 'blend'
   *  (moyenne des deux variances). Les deux σ sont journalisés quel que soit ce réglage
   *  (sc, sp) : le rapport (section 1c) dit lequel prédit mieux AVANT de le changer. */
  volEstimator?: VolEstimator;
}

export type VolEstimator = 'cc' | 'parkinson' | 'blend';
export const VOL_ESTIMATORS: readonly VolEstimator[] = ['cc', 'parkinson', 'blend'];

export const DEFAULT_FAIR_VALUE_CONFIG: FairValueConfig = {
  takerFeeRate: 0.07,
  twapWindowSec: 60,
  strikeNoiseSec: 3,
  basisBps: 2,
  minEdge: 0.04,
  noiseEdgeK: 1.5,
  minProb: 0.6,
  minTauSec: 60,
  maxTauSec: 270,
  minAsk: 0.08,
  maxAsk: 0.92,
  tails: 'normal',
  zScale: 1,
  blendModel: 1,
  blendMarket: 0,
  volEstimator: 'cc',
};

/**
 * τ minimal pour entrer ou réévaluer une position. Pendant la fenêtre de moyenne finale
 * (τ < W), une partie du TWAP de règlement est déjà acquise : le modèle (centré sur le
 * spot) ne la connaît pas, sa probabilité y serait fausse → ni entrée ni sortie.
 */
export function entryMinTauSec(cfg: Pick<FairValueConfig, 'minTauSec' | 'twapWindowSec'>): number {
  return Math.max(cfg.minTauSec, cfg.twapWindowSec);
}

/** Probabilité modèle bornée : jamais 0 ni 1 (un modèle n'est jamais certain). */
export const PROB_FLOOR = 0.01;
export const PROB_CEIL = 0.99;

// ---------------------------------------------------------------------------
// Briques mathématiques
// ---------------------------------------------------------------------------

function isPos(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/** Fonction de répartition de la loi normale centrée réduite (Abramowitz-Stegun 7.1.26 via erf). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * Inverse de la loi normale (algorithme d'Acklam, erreur relative < 1,2e-9).
 * null hors de ]0, 1[.
 */
export function normInv(p: number): number | null {
  if (!(p > 0 && p < 1)) return null;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x: number;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
}

/**
 * Répartition d'une loi de Student à 4 degrés de liberté, RÉDUITE (variance 1).
 * La t4 brute a une variance ν/(ν−2) = 2 ; on évalue donc F_t4(x·√2).
 * Forme fermée pour ν = 4, avec u = t/√(4+t²) ∈ ]−1, 1[ :
 *   F(t) = ½ + ¾·u − ¼·u³   (vérifiée par intégration numérique dans les tests).
 */
export function studentT4CdfStd(x: number): number {
  const t = x * Math.SQRT2;
  const u = t / Math.sqrt(4 + t * t);
  return 0.5 + 0.75 * u - 0.25 * u * u * u;
}

/** Inverse de studentT4CdfStd (bissection sur u = t/√(4+t²), fonction monotone). */
export function studentT4InvStd(p: number): number | null {
  if (!(p > 0 && p < 1)) return null;
  let lo = -1;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const u = (lo + hi) / 2;
    if (0.5 + 0.75 * u - 0.25 * u * u * u < p) lo = u;
    else hi = u;
  }
  const u = (lo + hi) / 2;
  const t = (2 * u) / Math.sqrt(1 - u * u);
  return t / Math.SQRT2;
}

/** Frais taker par part pour un achat au prix p. */
export function takerFeePerShare(p: number, rate: number): number {
  return rate * p * (1 - p);
}

/** Coût réel d'une part : prix payé + frais taker. C'est le win rate d'équilibre. */
export function effectiveCostPerShare(p: number, rate: number): number {
  return p + takerFeePerShare(p, rate);
}

/**
 * Volatilité réalisée par √seconde à partir d'une série de clôtures espacées de
 * `intervalSec`. Estimateur à moyenne nulle (aucune dérive supposée sur 5 min) :
 * σ² = Σ r² / n. Renvoie null si moins de `minReturns` rendements valides.
 */
export function realizedVolPerSqrtSec(closes: number[], intervalSec: number, minReturns = 10): number | null {
  if (!Array.isArray(closes) || !isPos(intervalSec)) return null;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (!isPos(a) || !isPos(b)) continue;
    const r = Math.log(b / a);
    sum += r * r;
    n++;
  }
  if (n < minReturns) return null;
  return Math.sqrt(sum / n) / Math.sqrt(intervalSec);
}

/**
 * Volatilité par √seconde par l'estimateur de Parkinson : σ² = moyenne(ln(H/L)²) / (4 ln 2)
 * par bougie. Bougies sans plus haut/plus bas cohérents ignorées ; null sous `minCandles`.
 */
export function parkinsonVolPerSqrtSec(
  candles: ReadonlyArray<{ open: number; close: number; high?: number; low?: number }>,
  intervalSec: number,
  minCandles = 10,
): number | null {
  if (!isPos(intervalSec)) return null;
  let sum = 0;
  let n = 0;
  for (const c of candles) {
    const h = c.high;
    const l = c.low;
    if (typeof h !== 'number' || typeof l !== 'number' || !isPos(l) || !(h >= l)) continue;
    if (h < Math.max(c.open, c.close) || l > Math.min(c.open, c.close)) continue; // incohérente
    const r = Math.log(h / l);
    sum += r * r;
    n++;
  }
  if (n < minCandles) return null;
  return Math.sqrt(sum / n / (4 * Math.LN2)) / Math.sqrt(intervalSec);
}

/** σ retenue selon le réglage ; repli sur l'autre estimateur si l'un manque. */
export function selectSigma(cc: number | null, park: number | null, estimator: VolEstimator = 'cc'): number | null {
  const a = isPos(cc) ? cc : null;
  const b = isPos(park) ? park : null;
  if (estimator === 'parkinson') return b ?? a;
  if (estimator === 'blend') return a !== null && b !== null ? Math.sqrt((a * a + b * b) / 2) : a ?? b;
  return a ?? b;
}

/**
 * Variance restante (en « secondes de variance ») du TWAP final vu d'aujourd'hui.
 * Le prix final est la moyenne du prix sur les W dernières secondes du round. Pour
 * un mouvement brownien, depuis un instant situé τ ≥ W avant la fin :
 *   Var = σ²·[(τ − W) + W/3]
 * Pour τ < W, une partie de la moyenne est déjà acquise (et inconnue de nous) :
 *   Var(restant) = σ²·τ³/(3W²) — utilisé à titre indicatif, l'entrée y est interdite.
 */
export function twapVarianceSeconds(tauSec: number, twapWindowSec: number): number {
  if (!(tauSec > 0)) return 0;
  const W = Math.max(0, twapWindowSec);
  if (W === 0) return tauSec;
  if (tauSec >= W) return tauSec - W + W / 3;
  return (tauSec * tauSec * tauSec) / (3 * W * W);
}

export interface ProbUpInput {
  spot: number;
  strike: number;
  /** Volatilité par √seconde (log-rendements). */
  sigmaPerSqrtSec: number;
  tauSec: number;
}

/**
 * P(prix final ≥ strike). Dérive nulle. Renvoie null si une entrée est invalide
 * (jamais un 0,5 « par défaut » qui ferait passer une panne pour une donnée).
 */
export function probUp(input: ProbUpInput, cfg: FairValueConfig = DEFAULT_FAIR_VALUE_CONFIG): number | null {
  const { spot, strike, sigmaPerSqrtSec, tauSec } = input;
  if (!isPos(spot) || !isPos(strike) || !isPos(sigmaPerSqrtSec) || !isPos(tauSec)) return null;
  const x = Math.log(spot / strike);
  const basis = Math.max(0, cfg.basisBps) / 1e4;
  // Trois sources d'incertitude, indépendantes, qui s'additionnent en variance :
  //  1. le chemin restant jusqu'au prix de résolution (ponctuel, ou TWAP si configuré) ;
  //  2. le strike : estimé depuis les bougies 1 min (round-market-data.ts), pas lu chez Chainlink ;
  //  3. l'écart de flux (Binance/Coinbase vs Chainlink), `basisBps`.
  const pathVarSec = twapVarianceSeconds(tauSec, cfg.twapWindowSec) + Math.max(0, cfg.strikeNoiseSec);
  const variance = sigmaPerSqrtSec * sigmaPerSqrtSec * pathVarSec + basis * basis;
  if (!(variance > 0)) return null;
  const z = (x / Math.sqrt(variance)) * (cfg.zScale > 0 ? cfg.zScale : 1);
  const p = cfg.tails === 't4' ? studentT4CdfStd(z) : normCdf(z);
  return Math.min(PROB_CEIL, Math.max(PROB_FLOOR, p));
}

/**
 * Écart-type de P(Up) (modèle brut, après FV_Z_SCALE) dû à ce que nous ne connaissons
 * qu'approximativement : le prix à battre (`strikeNoiseSec`) et l'écart de flux
 * (`basisBps`). Linéarisation : σ_p = densité(z) · zScale · √(bruit / variance totale).
 */
export function probNoiseSd(input: ProbUpInput, cfg: FairValueConfig = DEFAULT_FAIR_VALUE_CONFIG): number {
  const { spot, strike, sigmaPerSqrtSec: s, tauSec } = input;
  if (!isPos(spot) || !isPos(strike) || !isPos(s) || !isPos(tauSec)) return 0;
  const basis = Math.max(0, cfg.basisBps) / 1e4;
  const noise = s * s * Math.max(0, cfg.strikeNoiseSec) + basis * basis;
  const V = s * s * (twapVarianceSeconds(tauSec, cfg.twapWindowSec) + Math.max(0, cfg.strikeNoiseSec)) + basis * basis;
  if (!(V > 0) || !(noise > 0)) return 0;
  const zs = cfg.zScale > 0 ? cfg.zScale : 1;
  const z = (Math.log(spot / strike) / Math.sqrt(V)) * zs;
  const h = 1e-4;
  const dens = cfg.tails === 't4'
    ? (studentT4CdfStd(z + h) - studentT4CdfStd(z - h)) / (2 * h)
    : Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  return dens * zs * Math.sqrt(noise / V);
}

/** Facteur du mélange modèle/carnet sur une petite variation de p_modèle (1 sans mélange). */
export function blendNoiseFactor(pRaw: number, pUsed: number, cfg: FairValueConfig): number {
  const a = cfg.blendModel ?? 1;
  const b = cfg.blendMarket ?? 0;
  if (a === 1 && b === 0) return 1;
  const pr = Math.min(PROB_CEIL, Math.max(PROB_FLOOR, pRaw));
  return (a * pUsed * (1 - pUsed)) / (pr * (1 - pr));
}

/**
 * Issue d'un achat binaire de `stake` (frais compris) au coût réel `costPerShare`.
 * Gain si le côté gagne : parts − mise ; perte sinon : la mise entière.
 * Linéaire en la mise ; mise nulle ou coût invalide → tout à 0 (jamais négatif).
 */
export function binaryPayoff(stake: number, costPerShare: number): { shares: number; winProfit: number; loss: number } {
  if (!isPos(stake) || !isPos(costPerShare) || costPerShare >= 1) return { shares: 0, winProfit: 0, loss: 0 };
  const shares = stake / costPerShare;
  return { shares, winProfit: shares - stake, loss: stake };
}

// ---------------------------------------------------------------------------
// Exécution : prix moyen réel sur le carnet
// ---------------------------------------------------------------------------

export interface BookLevel {
  price: number;
  size: number;
}

export interface FillEstimate {
  /** Parts obtenues. */
  shares: number;
  /** Montant dépensé (hors frais). */
  spent: number;
  /** Prix moyen pondéré (VWAP) ; null si rien d'exécutable. */
  avgPrice: number | null;
  /** Coût moyen EXACT par part, frais taker inclus niveau par niveau (si feeRate fourni). */
  avgCost: number | null;
  /** true si le carnet couvre entièrement le budget. */
  complete: boolean;
}

/**
 * Prix d'achat maximal tel que `prob − (p + frais(p)) ≥ minEdge`. C'est la LIMITE d'un
 * ordre envoyé au moment de la décision : en réel, l'ordre ne peut pas tenir compte d'un
 * mouvement du spot survenu pendant son trajet. f(p) = p + r·p(1−p) est croissante sur
 * [0,1] (r < 1) ; on résout r·p² − (1+r)·p + c = 0 (petite racine), c = prob − minEdge.
 * null si aucun prix ne convient.
 */
export function maxBuyPriceForEdge(prob: number, minEdge: number, rate: number): number | null {
  const c = prob - minEdge;
  if (!(c > 0)) return null;
  if (!(rate > 0)) return Math.min(c, 1);
  const disc = (1 + rate) ** 2 - 4 * rate * c;
  if (disc < 0) return null;
  // Forme stable de la petite racine (pas d'annulation quand rate → 0) :
  // ((1+r) − √disc) / (2r) = 2c / ((1+r) + √disc)
  const p = (2 * c) / ((1 + rate) + Math.sqrt(disc));
  return p > 0 ? Math.min(p, 1) : null;
}

/**
 * Simule un achat au marché de `budget` (USDC, hors frais) en consommant les asks
 * TRIÉS par prix croissant, sans dépasser `limitPrice`. Les niveaux invalides sont
 * ignorés. Le carnet est trié localement : l'API renvoie les asks du plus cher au
 * moins cher (COSTS.md §1.2).
 */
export function estimateFill(asks: BookLevel[], budget: number, limitPrice = 1, feeRate?: number): FillEstimate {
  const levels = (Array.isArray(asks) ? asks : [])
    .filter(l => isPos(l?.price) && isPos(l?.size) && l.price < 1 && l.price <= limitPrice)
    .slice()
    .sort((a, b) => a.price - b.price);
  let remaining = isPos(budget) ? budget : 0;
  let shares = 0;
  let spent = 0;
  let fees = 0;
  for (const l of levels) {
    if (remaining <= 1e-12) break;
    const cost = l.price * l.size;
    const q = cost <= remaining ? l.size : remaining / l.price;
    shares += q;
    spent += q * l.price;
    if (feeRate !== undefined) fees += q * takerFeePerShare(l.price, feeRate);
    remaining = cost <= remaining ? remaining - cost : 0;
  }
  return {
    shares,
    spent,
    avgPrice: shares > 0 ? spent / shares : null,
    avgCost: shares > 0 && feeRate !== undefined ? (spent + fees) / shares : null,
    complete: isPos(budget) && remaining <= 1e-9,
  };
}

export interface SellEstimate {
  /** Parts vendues. */
  shares: number;
  /** Produit NET de frais taker (chaque niveau payant ses propres frais). */
  netProceeds: number;
  /** Prix moyen brut ; null si rien de vendable. */
  avgPrice: number | null;
  /** true si les bids absorbent toutes les parts. */
  complete: boolean;
}

/**
 * Simule la vente au marché de `shares` parts en consommant les bids du plus haut au
 * plus bas. Les frais sont calculés niveau par niveau (exact, pas d'approximation au prix
 * moyen). Les niveaux invalides sont ignorés.
 */
export function estimateSell(bids: BookLevel[], shares: number, feeRate: number, minNetPerShare = 0): SellEstimate {
  // `minNetPerShare` = prix plancher NET de frais d'un ordre de vente limité, fixé à la
  // décision : les bids en dessous ne sont pas touchés.
  const levels = (Array.isArray(bids) ? bids : [])
    .filter(l => isPos(l?.price) && isPos(l?.size) && l.price < 1
      && l.price - takerFeePerShare(l.price, feeRate) >= minNetPerShare - 1e-12)
    .slice()
    .sort((a, b) => b.price - a.price);
  let remaining = isPos(shares) ? shares : 0;
  let sold = 0;
  let gross = 0;
  let net = 0;
  for (const l of levels) {
    if (remaining <= 1e-12) break;
    const q = Math.min(remaining, l.size);
    sold += q;
    gross += q * l.price;
    net += q * (l.price - takerFeePerShare(l.price, feeRate));
    remaining -= q;
  }
  return {
    shares: sold,
    netProceeds: net,
    avgPrice: sold > 0 ? gross / sold : null,
    complete: isPos(shares) && remaining <= 1e-9,
  };
}

// ---------------------------------------------------------------------------
// Décision
// ---------------------------------------------------------------------------

export type Side = 'UP' | 'DOWN';

export interface SideQuote {
  side: Side;
  /** Probabilité modèle que ce côté gagne. */
  prob: number;
  /** Meilleur ask du token. */
  ask: number;
  /** Coût réel par part au meilleur ask (ask + frais). */
  cost: number;
  /** prob − cost : espérance par part, en probabilité. */
  edge: number;
}

export interface FairValueDecision {
  /** Côté à acheter, ou null (ne pas trader). */
  side: Side | null;
  /** Raison lisible (FR), chiffres inclus. */
  reason: string;
  /** P(Up) utilisée pour décider (après mélange éventuel avec le marché). */
  pUp: number | null;
  /** P(Up) du modèle seul (avant mélange). */
  pRaw?: number | null;
  quotes: SideQuote[];
  best: SideQuote | null;
  /** Écart-type de bruit de la probabilité utilisée (voir `probNoiseSd`), mélange compris. */
  noiseSd?: number;
  /** Le même, modèle seul (avant mélange) : ce que garde le journal, le rejeu applique le mélange. */
  noiseSdRaw?: number;
  /** Edge exigé pour ce passage : minEdge + noiseEdgeK · noiseSd. */
  requiredEdge?: number;
}

export interface DecisionInput extends ProbUpInput {
  upAsk: number | null;
  downAsk: number | null;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Probabilité implicite du carnet pour « Up » : milieu entre ask Up et 1 − ask Down. */
export function bookMidUp(upAsk: number | null, downAsk: number | null): number | null {
  if (!(upAsk && upAsk > 0 && upAsk < 1 && downAsk && downAsk > 0 && downAsk < 1)) return null;
  return Math.min(PROB_CEIL, Math.max(PROB_FLOOR, (upAsk + (1 - downAsk)) / 2));
}

/**
 * Applique le mélange modèle/marché (même formule pour Up ou pour le côté détenu :
 * logit(1−p) = −logit(p)). Sans mélange configuré, renvoie pModel. null si le mélange
 * exige un prix de marché absent.
 */
export function blendWithMarket(pModel: number, pMarket: number | null, cfg: FairValueConfig): number | null {
  const a = cfg.blendModel ?? 1;
  const b = cfg.blendMarket ?? 0;
  if (a === 1 && b === 0) return pModel;
  if (b !== 0 && pMarket === null) return null;
  const clampP = (p: number) => Math.min(PROB_CEIL, Math.max(PROB_FLOOR, p));
  const x = a * logit(clampP(pModel)) + (b !== 0 ? b * logit(clampP(pMarket as number)) : 0);
  return clampP(sigmoid(x));
}

export function decide(input: DecisionInput, cfg: FairValueConfig = DEFAULT_FAIR_VALUE_CONFIG): FairValueDecision {
  const none = (reason: string, extra: Partial<FairValueDecision> = {}): FairValueDecision => ({
    side: null,
    reason,
    pUp: null,
    quotes: [],
    best: null,
    ...extra,
  });

  const minTau = entryMinTauSec(cfg);
  if (!(input.tauSec >= minTau)) {
    return none(cfg.twapWindowSec >= cfg.minTauSec
      ? `τ=${Math.round(input.tauSec)} s < ${minTau} s (fenêtre de moyenne du règlement : la part déjà moyennée n'est pas modélisée)`
      : `τ=${Math.round(input.tauSec)} s < ${minTau} s (fin de round : latence et écart d'oracle dominent)`);
  }
  if (!(input.tauSec <= cfg.maxTauSec)) {
    return none(`τ=${Math.round(input.tauSec)} s > ${cfg.maxTauSec} s (trop tôt dans le round)`);
  }

  const pRaw = probUp(input, cfg);
  if (pRaw === null) return none('entrées du modèle invalides (spot/strike/vol/τ)');
  const pUp = blendWithMarket(pRaw, bookMidUp(input.upAsk, input.downAsk), cfg);
  if (pUp === null) return none('mélange modèle/marché configuré mais carnet incomplet', { pRaw });

  const noiseSdRaw = probNoiseSd(input, cfg);
  const noiseSd = noiseSdRaw * blendNoiseFactor(pRaw, pUp, cfg);
  const requiredEdge = cfg.minEdge + Math.max(0, cfg.noiseEdgeK ?? 0) * noiseSd;
  const reqTxt = requiredEdge > cfg.minEdge + 5e-4
    ? `${(requiredEdge * 100).toFixed(1)}pt (${(cfg.minEdge * 100).toFixed(1)} + ${((requiredEdge - cfg.minEdge) * 100).toFixed(1)} bruit du prix à battre)`
    : `${(cfg.minEdge * 100).toFixed(1)}pt`;
  const quotes: SideQuote[] = [];
  const add = (side: Side, prob: number, ask: number | null) => {
    if (!isPos(ask) || ask >= 1) return;
    const cost = effectiveCostPerShare(ask, cfg.takerFeeRate);
    quotes.push({ side, prob, ask, cost, edge: prob - cost });
  };
  add('UP', pUp, input.upAsk);
  add('DOWN', 1 - pUp, input.downAsk);
  const ctx = { pUp, pRaw, noiseSd, noiseSdRaw, requiredEdge };
  if (quotes.length === 0) return none('aucun ask exploitable', ctx);

  const inBounds = quotes.filter(q => q.ask >= cfg.minAsk && q.ask <= cfg.maxAsk);
  const eligible = inBounds.filter(q => q.prob >= cfg.minProb);
  const pool = eligible.length ? eligible : inBounds.length ? inBounds : quotes;
  const best = pool.reduce((a, b) => (b.edge > a.edge ? b : a));
  const fmt = (q: SideQuote) =>
    `${q.side} p=${q.prob.toFixed(3)} ask=${q.ask.toFixed(2)} coût=${q.cost.toFixed(3)} edge=${(q.edge * 100).toFixed(1)}pt`;
  const summary = quotes.map(fmt).join(' | ');

  if (!inBounds.length) {
    return none(`asks hors bornes [${cfg.minAsk}, ${cfg.maxAsk}] (${summary})`, { ...ctx, quotes, best });
  }
  if (!eligible.length) {
    // Un côté peut avoir p ≥ minProb mais un ask hors bornes (ex. DOWN p=0.795, ask 0.93 > 0.92) :
    // le dire tel quel plutôt qu'un faux « aucun côté avec p_modèle ≥ … ».
    const capped = quotes.filter(q => q.prob >= cfg.minProb);
    if (capped.length) {
      const why = capped
        .map(q => `${q.side} p=${q.prob.toFixed(3)} mais ask ${q.ask.toFixed(2)} ${q.ask > cfg.maxAsk ? `> ${cfg.maxAsk}` : `< ${cfg.minAsk}`}`)
        .join(', ');
      return none(`${why} ; ${inBounds.map(q => q.side).join(' et ')} p_modèle < ${cfg.minProb} (${summary})`, { ...ctx, quotes, best });
    }
    return none(`aucun côté avec p_modèle ≥ ${cfg.minProb} (${summary})`, { ...ctx, quotes, best });
  }
  if (!(best.edge >= requiredEdge)) {
    return none(`edge ${(best.edge * 100).toFixed(1)}pt < ${reqTxt} requis (${summary})`, { ...ctx, quotes, best });
  }
  return { side: best.side, reason: `edge ${(best.edge * 100).toFixed(1)}pt ≥ ${reqTxt} (${summary})`, ...ctx, quotes, best };
}

/**
 * Lit la configuration depuis un dictionnaire de variables (process.env côté appelant).
 * Une valeur absente ou invalide garde le défaut — jamais 0 silencieux.
 */
export function fairValueConfigFromEnv(env: Record<string, string | undefined>): FairValueConfig {
  const num = (key: string, def: number, lo: number, hi: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return def;
    const v = Number(raw);
    return Number.isFinite(v) && v >= lo && v <= hi ? v : def;
  };
  const d = DEFAULT_FAIR_VALUE_CONFIG;
  const cfg: FairValueConfig = {
    takerFeeRate: num('FV_TAKER_FEE_RATE', d.takerFeeRate, 0, 0.5),
    twapWindowSec: num('FV_TWAP_WINDOW_SEC', d.twapWindowSec, 0, 60),
    strikeNoiseSec: num('FV_STRIKE_NOISE_SEC', d.strikeNoiseSec, 0, 120),
    basisBps: num('FV_BASIS_BPS', d.basisBps, 0, 100),
    minEdge: num('FV_MIN_EDGE', d.minEdge, 0, 0.5),
    noiseEdgeK: num('FV_NOISE_EDGE_K', d.noiseEdgeK, 0, 5),
    minProb: num('FV_MIN_PROB', d.minProb, 0, 0.99),
    minTauSec: num('FV_MIN_TAU_SEC', d.minTauSec, 0, 300),
    maxTauSec: num('FV_MAX_TAU_SEC', d.maxTauSec, 0, 300),
    minAsk: num('FV_MIN_ASK', d.minAsk, 0.01, 0.99),
    maxAsk: num('FV_MAX_ASK', d.maxAsk, 0.01, 0.99),
    tails: env.FV_TAILS === 't4' ? 't4' : 'normal',
    zScale: num('FV_Z_SCALE', d.zScale, 0.3, 2),
    blendModel: num('FV_BLEND_MODEL', d.blendModel, 0, 3),
    blendMarket: num('FV_BLEND_MARKET', d.blendMarket, 0, 3),
    volEstimator: VOL_ESTIMATORS.includes((env.FV_VOL_ESTIMATOR ?? '').trim() as VolEstimator) ? (env.FV_VOL_ESTIMATOR as string).trim() as VolEstimator : 'cc',
  };
  // Fenêtre vide (y compris à cause de la minute finale moyennée) : aucun pari possible → défauts.
  if (entryMinTauSec(cfg) > cfg.maxTauSec) { cfg.minTauSec = d.minTauSec; cfg.maxTauSec = d.maxTauSec; }
  if (cfg.minAsk > cfg.maxAsk) { cfg.minAsk = d.minAsk; cfg.maxAsk = d.maxAsk; }
  return cfg;
}
