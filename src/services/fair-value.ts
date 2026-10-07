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
 *   « Up » ⟺ prix final ≥ prix d'ouverture (strike). Avec le spot S, le strike K,
 *   le temps restant τ et la volatilité σ, P(Up) se calcule ; on n'achète un côté
 *   QUE si cette probabilité dépasse son coût réel (ask + frais taker) d'au moins
 *   `minEdge`. Le critère est l'ESPÉRANCE, jamais le win rate : un win rate élevé
 *   s'obtient trivialement en achetant des favoris à 0,95, sans aucun gain.
 *
 * ⚠️ Ce modèle n'est PAS validé sur données historiques (aucune donnée spot+carnet
 *   horodatée n'existe dans le dépôt). Il est prudent par construction
 *   (vol max(court, long), incertitude de strike et d'oracle, marge
 *   minimale, entrée interdite en toute fin de round) et chaque décision journalise
 *   p_modèle dans history.json pour mesurer sa calibration
 *   (`npx tsx scripts/fv-calibration.ts`).
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
  /** Fenêtre de moyenne du prix de résolution (s). Les règles des marchés « Up or Down »
   *  disent : prix Chainlink BTC/USD à la FIN vs au DÉBUT de la plage → résolution
   *  ponctuelle, 0. (> 0 seulement si un marché résout sur un TWAP.) */
  twapWindowSec: number;
  /** Incertitude du strike, en « secondes de variance » : notre strike est l'open de la
   *  bougie 1 min Binance/Coinbase du slot, pas le point Chainlink exact. */
  strikeNoiseSec: number;
  /** Incertitude du strike + écart de flux (Binance vs Chainlink), en points de base. */
  basisBps: number;
  /** Edge minimal exigé, en probabilité, APRÈS frais et prix d'exécution réel. */
  minEdge: number;
  /** Probabilité modèle minimale du côté acheté. Monte le win rate (on ne parie que
   *  sur le côté probable) et réduit la variance, au prix de quelques paris +EV sur
   *  l'outsider. Si le modèle est calibré, WR attendu ≥ minProb. */
  minProb: number;
  /** Pas d'entrée avec moins de τ secondes restantes : en toute fin de round, l'écart
   *  Binance/Chainlink et notre latence REST dominent le signal. */
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
  /** Distribution des rendements : 'normal' (défaut) ou 't4'.
   *  ⚠️ À variance égale, la t4 est PLUS confiante que la normale pour |z| < 2
   *  (F(1) = 0,885 contre 0,841) — précisément la zone où le bot parie. Elle n'est donc
   *  pas « prudente » ; elle ne l'est qu'au-delà de |z| ≈ 2. */
  tails: 't4' | 'normal';
}

export const DEFAULT_FAIR_VALUE_CONFIG: FairValueConfig = {
  takerFeeRate: 0.07,
  twapWindowSec: 0,
  strikeNoiseSec: 10,
  basisBps: 2,
  minEdge: 0.04,
  minProb: 0.6,
  minTauSec: 45,
  maxTauSec: 270,
  minAsk: 0.08,
  maxAsk: 0.92,
  tails: 'normal',
  zScale: 1,
};

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
  //  2. le strike : approché par l'OPEN de la bougie 1 min du slot, pas le point Chainlink ;
  //  3. l'écart de flux (Binance/Coinbase vs Chainlink), `basisBps`.
  const pathVarSec = twapVarianceSeconds(tauSec, cfg.twapWindowSec) + Math.max(0, cfg.strikeNoiseSec);
  const variance = sigmaPerSqrtSec * sigmaPerSqrtSec * pathVarSec + basis * basis;
  if (!(variance > 0)) return null;
  const z = (x / Math.sqrt(variance)) * (cfg.zScale > 0 ? cfg.zScale : 1);
  const p = cfg.tails === 't4' ? studentT4CdfStd(z) : normCdf(z);
  return Math.min(PROB_CEIL, Math.max(PROB_FLOOR, p));
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
  /** true si le carnet couvre entièrement le budget. */
  complete: boolean;
}

/**
 * Simule un achat au marché de `budget` (USDC, hors frais) en consommant les asks
 * TRIÉS par prix croissant, sans dépasser `limitPrice`. Les niveaux invalides sont
 * ignorés. Le carnet est trié localement : l'API renvoie les asks du plus cher au
 * moins cher (COSTS.md §1.2).
 */
export function estimateFill(asks: BookLevel[], budget: number, limitPrice = 1): FillEstimate {
  const levels = (Array.isArray(asks) ? asks : [])
    .filter(l => isPos(l?.price) && isPos(l?.size) && l.price < 1 && l.price <= limitPrice)
    .slice()
    .sort((a, b) => a.price - b.price);
  let remaining = isPos(budget) ? budget : 0;
  let shares = 0;
  let spent = 0;
  for (const l of levels) {
    if (remaining <= 1e-12) break;
    const cost = l.price * l.size;
    if (cost <= remaining) {
      shares += l.size;
      spent += cost;
      remaining -= cost;
    } else {
      const s = remaining / l.price;
      shares += s;
      spent += remaining;
      remaining = 0;
    }
  }
  return {
    shares,
    spent,
    avgPrice: shares > 0 ? spent / shares : null,
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
export function estimateSell(bids: BookLevel[], shares: number, feeRate: number): SellEstimate {
  const levels = (Array.isArray(bids) ? bids : [])
    .filter(l => isPos(l?.price) && isPos(l?.size) && l.price < 1)
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
  pUp: number | null;
  quotes: SideQuote[];
  best: SideQuote | null;
}

export interface DecisionInput extends ProbUpInput {
  upAsk: number | null;
  downAsk: number | null;
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

  if (!(input.tauSec >= cfg.minTauSec)) {
    return none(`τ=${Math.round(input.tauSec)} s < ${cfg.minTauSec} s (fin de round : latence et écart d'oracle dominent)`);
  }
  if (!(input.tauSec <= cfg.maxTauSec)) {
    return none(`τ=${Math.round(input.tauSec)} s > ${cfg.maxTauSec} s (trop tôt dans le round)`);
  }

  const pUp = probUp(input, cfg);
  if (pUp === null) return none('entrées du modèle invalides (spot/strike/vol/τ)');

  const quotes: SideQuote[] = [];
  const add = (side: Side, prob: number, ask: number | null) => {
    if (!isPos(ask) || ask >= 1) return;
    const cost = effectiveCostPerShare(ask, cfg.takerFeeRate);
    quotes.push({ side, prob, ask, cost, edge: prob - cost });
  };
  add('UP', pUp, input.upAsk);
  add('DOWN', 1 - pUp, input.downAsk);
  if (quotes.length === 0) return none('aucun ask exploitable', { pUp });

  const inBounds = quotes.filter(q => q.ask >= cfg.minAsk && q.ask <= cfg.maxAsk);
  const eligible = inBounds.filter(q => q.prob >= cfg.minProb);
  const pool = eligible.length ? eligible : inBounds.length ? inBounds : quotes;
  const best = pool.reduce((a, b) => (b.edge > a.edge ? b : a));
  const fmt = (q: SideQuote) =>
    `${q.side} p=${q.prob.toFixed(3)} ask=${q.ask.toFixed(2)} coût=${q.cost.toFixed(3)} edge=${(q.edge * 100).toFixed(1)}pt`;
  const summary = quotes.map(fmt).join(' | ');

  if (!inBounds.length) {
    return none(`asks hors bornes [${cfg.minAsk}, ${cfg.maxAsk}] (${summary})`, { pUp, quotes, best });
  }
  if (!eligible.length) {
    return none(`aucun côté avec p_modèle ≥ ${cfg.minProb} (${summary})`, { pUp, quotes, best });
  }
  if (!(best.edge >= cfg.minEdge)) {
    return none(`edge ${(best.edge * 100).toFixed(1)}pt < ${(cfg.minEdge * 100).toFixed(1)}pt requis (${summary})`, { pUp, quotes, best });
  }
  return { side: best.side, reason: `edge ${(best.edge * 100).toFixed(1)}pt ≥ ${(cfg.minEdge * 100).toFixed(1)}pt (${summary})`, pUp, quotes, best };
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
    twapWindowSec: num('FV_TWAP_WINDOW_SEC', d.twapWindowSec, 0, 300),
    strikeNoiseSec: num('FV_STRIKE_NOISE_SEC', d.strikeNoiseSec, 0, 120),
    basisBps: num('FV_BASIS_BPS', d.basisBps, 0, 100),
    minEdge: num('FV_MIN_EDGE', d.minEdge, 0, 0.5),
    minProb: num('FV_MIN_PROB', d.minProb, 0, 0.99),
    minTauSec: num('FV_MIN_TAU_SEC', d.minTauSec, 0, 300),
    maxTauSec: num('FV_MAX_TAU_SEC', d.maxTauSec, 0, 300),
    minAsk: num('FV_MIN_ASK', d.minAsk, 0.01, 0.99),
    maxAsk: num('FV_MAX_ASK', d.maxAsk, 0.01, 0.99),
    tails: env.FV_TAILS === 't4' ? 't4' : 'normal',
    zScale: num('FV_Z_SCALE', d.zScale, 0.3, 2),
  };
  if (cfg.minTauSec > cfg.maxTauSec) { cfg.minTauSec = d.minTauSec; cfg.maxTauSec = d.maxTauSec; }
  if (cfg.minAsk > cfg.maxAsk) { cfg.minAsk = d.minAsk; cfg.maxAsk = d.maxAsk; }
  return cfg;
}
