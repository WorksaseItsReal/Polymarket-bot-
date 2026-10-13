/**
 * snapshot.ts — INSTANTANÉ d'un round « Up/Down 5 min » remis aux agents de la stratégie llm
 * (PAPIER uniquement).
 *
 * Principe : LISTE BLANCHE. Seuls des champs numériques ou énumérés, recopiés un par un,
 * entrent dans l'instantané. Aucune chaîne venant du marché (titre, description, règles…)
 * n'y passe, même si l'objet d'entrée en contient : un texte de marché est une DONNÉE, et
 * ici il n'est même pas transmis. Les agents ne voient donc que des nombres, des booléens
 * et des valeurs d'énumération fixées par ce module.
 *
 * Conventions de la sortie (version `snap-1`, clés en français) :
 *   - temps RELATIFS au début du round (debut_s = 0) : rien qui permette de dater le round
 *     hormis l'identifiant (remplacé par `anonymize` pour le backtest) ;
 *   - nombres arrondis raisonnablement, valeurs non finies → null ;
 *   - carnet : meilleur niveau en premier (asks croissants, bids décroissants), ≤ 5 niveaux.
 *
 * Module PUR (aucune I/O, aucune horloge) ; `node:crypto` sert au hachage seulement.
 */
import { createHash, createHmac } from 'node:crypto';

export const SNAPSHOT_VERSION = 'snap-1';

/** Actifs reconnus (énumération : toute autre valeur rend l'instantané impossible). */
export const ACTIFS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] as const;
export type Actif = typeof ACTIFS[number];

/** Stratégies connues des positions ouvertes ; toute autre chaîne devient 'autre'. */
export const STRATEGIES_CONNUES = ['fv', 'late', 'llm'] as const;
export type StrategieConnue = typeof STRATEGIES_CONNUES[number];

/** Slug d'un round 5 min : `<coin>-updown-5m-<slot>`. */
export const ROUND_ID_RE = /^[a-z]+-updown-5m-\d+$/;

/** Profondeur maximale du carnet transmise (niveaux d'ask). */
export const MAX_DEPTH = 5;
/** Nombre maximal de positions ouvertes transmises. */
export const MAX_POSITIONS = 20;

export const FEE_FORMULA_TEXT = 'taux × p × (1 − p) par part';

// ---------------------------------------------------------------------------
// Entrée (liste blanche) et sortie
// ---------------------------------------------------------------------------

/** Un niveau de carnet : [prix, parts]. */
export type Level = readonly [number, number];

export interface BookSideInput {
  /** Asks du moins cher au plus cher (re-triés par sécurité). */
  asks: ReadonlyArray<Level>;
  /** Bids du plus haut au plus bas (re-triés par sécurité). */
  bids: ReadonlyArray<Level>;
}

export interface SnapshotInput {
  roundId: string;
  coin: string;
  startMs: number;
  endMs: number;
  nowMs: number;
  /** Prix d'ouverture (prix à battre estimé). */
  open: number | null;
  spot: number | null;
  sigmaPerSqrtSec: number | null;
  /** P(Up) de la formule de juste valeur (après ajustements) et brute. */
  formulaPUp: number | null;
  formulaPUpRaw: number | null;
  book: { up: BookSideInput; down: BookSideInput };
  feeRate: number;
  minOrderUsd: number;
  risk: { capitalUsd: number; maxStakeUsd: number; pnlTodayUsd: number; dailyLimitUsd: number; blocked: boolean };
  openPositions: ReadonlyArray<{ coin: string; side: string; stakeUsd: number; strategy: string }>;
}

export interface SnapshotBookSide {
  ask: number | null;
  taille_ask: number | null;
  bid: number | null;
  taille_bid: number | null;
  profondeur_ask: Array<[number, number]>;
}

export interface SnapshotPosition {
  actif: Actif | 'autre';
  cote: 'up' | 'down' | 'inconnu';
  mise_usd: number | null;
  strategie: StrategieConnue | 'autre';
}

export interface Snapshot {
  version: typeof SNAPSHOT_VERSION;
  round_id: string;
  actif: Actif;
  temps: { debut_s: 0; fin_s: number | null; maintenant_s: number | null; restant_s: number | null };
  prix: { ouverture: number | null; actuel: number | null };
  volatilite: { sigma_par_racine_s: number | null };
  formule: { proba_up: number | null; proba_up_brute: number | null };
  carnet: { up: SnapshotBookSide; down: SnapshotBookSide };
  frais: { taux: number | null; formule: string };
  mise_minimum_usd: number | null;
  risque: {
    capital_usd: number | null;
    mise_max_usd: number | null;
    /** Perte réalisée du jour, ≥ 0 (0 si le jour est en gain). */
    perte_jour_usd: number | null;
    /** Perte du jour à ne pas dépasser, ≥ 0. */
    limite_perte_jour_usd: number | null;
    bloque: boolean;
  };
  positions_ouvertes: SnapshotPosition[];
}

// ---------------------------------------------------------------------------
// Arrondis
// ---------------------------------------------------------------------------

function fin(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** Arrondi à `d` décimales ; non fini → null ; jamais −0. */
function round(x: unknown, d: number): number | null {
  const v = fin(x);
  if (v === null) return null;
  const k = 10 ** d;
  const r = Math.round(v * k) / k;
  return r === 0 ? 0 : r;
}

/** Arrondi à `n` chiffres significatifs (prix d'actifs d'échelles très différentes, σ). */
function sig(x: unknown, n: number): number | null {
  const v = fin(x);
  if (v === null) return null;
  const r = Number(v.toPrecision(n));
  return r === 0 ? 0 : r;
}

/** Probabilité dans [0, 1], sinon null. */
function prob(x: unknown): number | null {
  const v = fin(x);
  return v !== null && v >= 0 && v <= 1 ? round(v, 4) : null;
}

const usd = (x: unknown) => round(x, 2);

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function levels(raw: unknown, order: 'asc' | 'desc'): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[number, number]> = [];
  for (const l of raw) {
    if (!Array.isArray(l)) continue;
    const p = fin(l[0]);
    const s = fin(l[1]);
    if (p === null || s === null || p <= 0 || p > 1 || s <= 0) continue;
    out.push([p, s]);
  }
  out.sort((a, b) => (order === 'asc' ? a[0] - b[0] : b[0] - a[0]));
  return out;
}

function bookSide(side: BookSideInput | undefined): SnapshotBookSide {
  const asks = levels(side?.asks, 'asc');
  const bids = levels(side?.bids, 'desc');
  return {
    ask: asks.length ? round(asks[0][0], 4) : null,
    taille_ask: asks.length ? round(asks[0][1], 2) : null,
    bid: bids.length ? round(bids[0][0], 4) : null,
    taille_bid: bids.length ? round(bids[0][1], 2) : null,
    profondeur_ask: asks.slice(0, MAX_DEPTH).map(([p, s]) => [round(p, 4) as number, round(s, 2) as number]),
  };
}

function actifOf(coin: unknown): Actif | null {
  const c = typeof coin === 'string' ? coin.trim().toUpperCase() : '';
  return (ACTIFS as readonly string[]).includes(c) ? (c as Actif) : null;
}

function position(p: SnapshotInput['openPositions'][number]): SnapshotPosition {
  const side = typeof p?.side === 'string' ? p.side.trim().toUpperCase() : '';
  const strat = typeof p?.strategy === 'string' ? p.strategy.trim().toLowerCase() : '';
  return {
    actif: actifOf(p?.coin) ?? 'autre',
    cote: side === 'UP' ? 'up' : side === 'DOWN' ? 'down' : 'inconnu',
    mise_usd: usd(p?.stakeUsd),
    strategie: (STRATEGIES_CONNUES as readonly string[]).includes(strat) ? (strat as StrategieConnue) : 'autre',
  };
}

/**
 * Instantané PUR d'un round. Seuls les champs listés ici sont lus ; toute autre propriété
 * de `input` (titre, description du marché…) est ignorée. Lève si l'identifiant du round
 * ou l'actif est invalide ou incohérent (l'appelant s'abstient alors).
 */
export function buildSnapshot(input: SnapshotInput): Snapshot {
  const roundId = typeof input?.roundId === 'string' ? input.roundId : '';
  if (!ROUND_ID_RE.test(roundId)) throw new Error(`identifiant de round invalide (attendu <coin>-updown-5m-<slot>)`);
  const actif = actifOf(input.coin);
  if (actif === null) throw new Error(`actif non reconnu (attendu : ${ACTIFS.join(', ')})`);
  if (roundId.slice(0, roundId.indexOf('-')) !== actif.toLowerCase()) throw new Error(`actif ${actif} incohérent avec l'identifiant du round`);

  const start = fin(input.startMs);
  const sec = (ms: unknown, from: number | null) => {
    const v = fin(ms);
    return v === null || from === null ? null : round((v - from) / 1000, 1);
  };
  const risk = input.risk ?? ({} as Partial<SnapshotInput['risk']>);
  const pnl = fin(risk.pnlTodayUsd);
  const limit = fin(risk.dailyLimitUsd);

  return {
    version: SNAPSHOT_VERSION,
    round_id: roundId,
    actif,
    temps: {
      debut_s: 0,
      fin_s: sec(input.endMs, start),
      maintenant_s: sec(input.nowMs, start),
      restant_s: sec(input.endMs, fin(input.nowMs)),
    },
    prix: { ouverture: sig(input.open, 10), actuel: sig(input.spot, 10) },
    volatilite: { sigma_par_racine_s: sig(input.sigmaPerSqrtSec, 4) },
    formule: { proba_up: prob(input.formulaPUp), proba_up_brute: prob(input.formulaPUpRaw) },
    carnet: { up: bookSide(input.book?.up), down: bookSide(input.book?.down) },
    frais: { taux: round(input.feeRate, 4), formule: FEE_FORMULA_TEXT },
    mise_minimum_usd: usd(input.minOrderUsd),
    risque: {
      capital_usd: usd(risk.capitalUsd),
      mise_max_usd: usd(risk.maxStakeUsd),
      perte_jour_usd: pnl === null ? null : usd(Math.max(0, -pnl)),
      limite_perte_jour_usd: limit === null ? null : usd(Math.abs(limit)),
      // Prudence : tout ce qui n'est pas exactement `false` compte comme bloqué.
      bloque: risk.blocked !== false,
    },
    positions_ouvertes: (Array.isArray(input.openPositions) ? input.openPositions : []).slice(0, MAX_POSITIONS).map(position),
  };
}

// ---------------------------------------------------------------------------
// Hachage canonique
// ---------------------------------------------------------------------------

/** JSON canonique : clés d'objet triées récursivement, tableaux dans l'ordre, undefined omis. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** sha256 (hex) du JSON canonique de l'instantané. */
export function snapshotHash(s: Snapshot): string {
  return createHash('sha256').update(canonicalJson(s)).digest('hex');
}

// ---------------------------------------------------------------------------
// Anonymisation (backtest)
// ---------------------------------------------------------------------------

/** Au-delà, un nombre peut être un horodatage (epoch en s ou ms) : il est retiré. */
export const ANON_MAX_ABS = 1e9;

function scrubNumbers(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) < ANON_MAX_ABS ? v : null;
  if (Array.isArray(v)) return v.map(scrubNumbers);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrubNumbers(x);
    return out;
  }
  return v;
}

/**
 * Identifiant opaque d'un round : « r- » + HMAC-SHA256(secret, round_id) tronqué à 64 bits,
 * écrit en lettres a–p (aucun chiffre : rien qui ressemble à un epoch).
 */
export function opaqueRoundId(roundId: string, secret: string): string {
  const hex = createHmac('sha256', secret).update(roundId).digest('hex').slice(0, 16);
  return `r-${hex.replace(/[0-9a-f]/g, c => 'abcdefghijklmnop'[parseInt(c, 16)])}`;
}

/**
 * Instantané anonymisé pour le backtest : rien ne permet de dater le round (ni slug, ni
 * epoch, ni niveau de prix absolu). L'identifiant devient opaque (même secret ⇒ même
 * identifiant), les prix sont normalisés (ouverture = 100, actuel = 100·spot/ouverture),
 * tout nombre ≥ 1e9 en valeur absolue est retiré (null). L'actif reste.
 */
export function anonymize(snapshot: Snapshot, secret: string): Snapshot {
  if (typeof secret !== 'string' || secret.length < 8) throw new Error('secret d\'anonymisation trop court (≥ 8 caractères)');
  const copy = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
  const o = snapshot.prix.ouverture;
  const a = snapshot.prix.actuel;
  const normalizable = o !== null && o > 0;
  copy.prix = {
    ouverture: normalizable ? 100 : null,
    actuel: normalizable && a !== null ? round((100 * a) / o, 6) : null,
  };
  copy.round_id = opaqueRoundId(snapshot.round_id, secret);
  return scrubNumbers(copy) as Snapshot;
}
