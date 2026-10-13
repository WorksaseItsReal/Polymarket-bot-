/**
 * harvest-dataset.ts — la récolte de fin de round rejouée sur des CARNETS RÉELS à la seconde
 * (jeu de données public gensx-x1/polymarket-btc-eth-updown-data : table SQLite `ticks`, un
 * instantané du meilleur bid/ask des deux tokens par seconde et par round).
 *
 * C'est l'analyse qui a motivé la stratégie (late-harvest.ts) ; ce module la rend REPRODUCTIBLE
 * (scripts/analysis/harvest-dataset.ts) sur de nouveaux fichiers. Fonctions pures, sauf la
 * lecture SQLite faite par le script.
 *
 * Issue d'un round = carnet final (dernier instantané à ≤ 10 s de la fin, côté à ≥ 0,95 avec
 * l'autre ask ≤ 0,05) ; indécis à la fin → compté PERDU (prudence) ; collecteur arrêté plus tôt
 * → round écarté (sans lien avec l'issue).
 */
import { effectiveCostPerShare } from '../services/fair-value.js';
import { clusteredMeanT, slotKey } from './stats.js';

export interface Tick {
  /** Secondes restantes avant la fin du round. */
  tau: number;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
}

export interface DatasetRound {
  slug: string;
  asset: string;
  startSec: number;
  /** Instantanés triés par τ décroissant (temps croissant). */
  ticks: Tick[];
}

export type Outcome = 'UP' | 'DOWN' | 'undecided' | null;

/** Issue prudente depuis le carnet final (voir en-tête). */
export function datasetOutcome(r: DatasetRound): Outcome {
  const s = r.ticks[r.ticks.length - 1];
  if (!s || s.tau > 10) return null;
  if (s.upBid !== null && s.upBid >= 0.95 && (s.downAsk === null || s.downAsk <= 0.05)) return 'UP';
  if (s.downBid !== null && s.downBid >= 0.95 && (s.upAsk === null || s.upAsk <= 0.05)) return 'DOWN';
  return 'undecided';
}

export interface HarvestSimOpts {
  minAsk: number;
  maxAsk: number;
  minTau: number;
  maxTau: number;
  stableSec: number;
  /** Lecture du carnet toutes les `stepSec` secondes (comme le bot). */
  stepSec: number;
  /** Délai d'exécution (s) : achat à l'ask de l'instantané `delaySec` plus tard. */
  delaySec: number;
  feeRate: number;
  /** Décalage de la grille de lecture (0 ≤ phase < stepSec) : vérifier que le résultat n'en dépend pas. */
  phaseSec?: number;
}

export interface SimTrade {
  slug: string;
  startSec: number;
  side: 'UP' | 'DOWN';
  tau: number;
  ask: number;
  won: boolean;
  /** PnL par 1 $ misé, frais compris. */
  pnl: number;
}

/** Instantané le plus proche de τ (à `tol` s près), ou null. */
export function tickAt(ticks: Tick[], tau: number, tol = 0.6): Tick | null {
  let best: Tick | null = null;
  for (const t of ticks) {
    const d = Math.abs(t.tau - tau);
    if (d <= tol && (best === null || d < Math.abs(best.tau - tau))) best = t;
  }
  return best;
}

const pinned = (t: Tick, o: Pick<HarvestSimOpts, 'minAsk' | 'maxAsk'>): 'UP' | 'DOWN' | null => {
  const p = (a: number | null) => a !== null && a >= o.minAsk && a < o.maxAsk;
  const up = p(t.upAsk);
  const down = p(t.downAsk);
  return up === down ? null : up ? 'UP' : 'DOWN';
};

/**
 * Règle du bot rejouée sur un round : lectures toutes les `stepSec` s (dès τ = maxTau + stableSec
 * + stepSec), série du même côté bloqué sans interruption, entrée à la première lecture de la
 * fenêtre où la série dure ≥ stableSec, exécution `delaySec` plus tard si l'ask est encore sous
 * maxAsk. null si pas de pari (ou issue inconnue).
 */
export function simulateRound(r: DatasetRound, o: HarvestSimOpts): SimTrade | null {
  const outcome = datasetOutcome(r);
  if (outcome === null) return null;
  let tau = o.maxTau + o.stableSec + o.stepSec - (o.phaseSec ?? 0);
  let streak: { side: 'UP' | 'DOWN'; since: number } | null = null;
  while (tau >= o.minTau) {
    const t = tickAt(r.ticks, tau);
    const side = t ? pinned(t, o) : null;
    if (!side) streak = null;
    else if (!streak || streak.side !== side) streak = { side, since: tau };
    if (streak && side && tau <= o.maxTau && streak.since - tau >= o.stableSec) {
      const e = tickAt(r.ticks, tau - o.delaySec);
      const ask = e ? (side === 'UP' ? e.upAsk : e.downAsk) : null;
      if (ask === null || !(ask > 0 && ask < o.maxAsk)) return null; // prix parti pendant le trajet de l'ordre
      const won = outcome !== 'undecided' && outcome === side;
      const cost = effectiveCostPerShare(ask, o.feeRate);
      return { slug: r.slug, startSec: r.startSec, side, tau, ask, won, pnl: won ? 1 / cost - 1 : -1 };
    }
    tau -= o.stepSec;
  }
  return null;
}

export interface SimSummary {
  rounds: number;
  trades: number;
  winRate: number | null;
  ev: number | null;
  t: number | null;
}

export function summarize(trades: SimTrade[], rounds: number): SimSummary {
  const n = trades.length;
  return {
    rounds, trades: n,
    winRate: n ? trades.filter(x => x.won).length / n : null,
    ev: n ? trades.reduce((a, x) => a + x.pnl, 0) / n : null,
    t: clusteredMeanT(trades.map(x => ({ key: slotKey(x.slug), x: x.pnl }))).t,
  };
}

export function simulateAll(rounds: DatasetRound[], o: HarvestSimOpts): SimSummary {
  const usable = rounds.filter(r => datasetOutcome(r) !== null);
  const trades = usable.map(r => simulateRound(r, o)).filter((x): x is SimTrade => x !== null);
  return summarize(trades, usable.length);
}

/** Sous-ensemble de `node:sqlite` utilisé (types absents de @types/node du projet). */
export interface SqliteDb {
  prepare(sql: string): { iterate(...params: unknown[]): Iterable<Record<string, unknown>>; run(...params: unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
}
export type SqliteCtor = new (path: string, opts?: { readOnly?: boolean }) => SqliteDb;

/** `DatabaseSync` de node:sqlite (Node ≥ 22.5), ou null si indisponible. */
export async function loadSqlite(): Promise<SqliteCtor | null> {
  const name = 'node:sqlite'; // variable : pas de résolution de types à la compilation
  try {
    const mod = (await import(name)) as { DatabaseSync?: SqliteCtor };
    return mod.DatabaseSync ?? null;
  } catch {
    return null;
  }
}
