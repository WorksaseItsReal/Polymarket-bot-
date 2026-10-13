/**
 * ledger-store.ts — registre papier en JOURNAL APPEND-ONLY (`fv-ledger.jsonl`) et statistiques
 * INCRÉMENTALES.
 *
 * Pourquoi : l'ancien registre (`fv-ledger.json`, un seul JSON) était recopié, réécrit en
 * entier (+ fsync), relu puis retrié à CHAQUE modification : à 90 000 trades, ~1,2 s par
 * modification, boucle d'événements bloquée d'autant — et la récolte de fin de round en
 * produit ~1 000 par jour. Ici, une modification = UNE ligne ajoutée (+ fsync), et les
 * statistiques avancent d'un pas par événement : O(1), quelle que soit la longueur de
 * l'historique. SQLite écarté : node:sqlite est expérimental (et absent sous Node 20.6–22.12,
 * encore accepté par le doctor), better-sqlite3 est une dépendance native.
 *
 * Format : une ligne JSON par événement, dans l'ordre où ils se produisent :
 *   {"v":2,"op":"open","trade":{…LedgerTrade complet…}}   nouveau trade (état final pour la migration)
 *   {"v":2,"op":"set","id":"<id>","fields":{…}}            modification d'un trade encore « vivant »
 * Ordre du fichier = ordre des règlements = l'ordre dans lequel `computeStats` trie (par
 * resolvedAt) : PnL cumulé, plus haut, baisse et série de pertes sont donc les mêmes.
 *
 * Mémoire : positions ouvertes, reventes dont l'issue du round reste à relever (calibration),
 * agrégats par portée et tampons BORNÉS — jamais tout l'historique (PM2 : 400 Mo maximum).
 *
 * Sûreté (mêmes principes qu'avant : un registre douteux n'est jamais écrasé) :
 *  - ligne invalide AU MILIEU → registre illisible : aucune nouvelle position, alerte,
 *    fichier jamais modifié ;
 *  - dernière ligne coupée (arrêt brutal pendant un ajout) → ignorée ; l'écrivain la met de
 *    côté (`<registre>.ligne-coupee-<horodatage>`), tronque le registre à la dernière ligne
 *    complète et le signale (`loadIssues`, alerte Telegram au démarrage) ;
 *  - écriture en échec (disque plein…) → fichier ramené à la dernière ligne complète, sinon
 *    la ligne suivante se collerait à un morceau de ligne ;
 *  - UN seul écrivain (verrou `<registre>.lock` portant le pid) ; les autres processus
 *    (doctor, scripts) lisent, en ne relisant que la fin du fichier quand il grossit.
 */

import {
  closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { addToClusterSums, clusteredTFromSums, type ClusterSums } from '../analysis/stats.js';
import {
  calendarPnl, clusterKeyOf, computeStats, isSettled, settleOrderKey, sideWon, strategyOf, utcDayMonth,
  type CalendarPnl, type LedgerFile, type LedgerStats, type LedgerStatus, type LedgerTrade, type StrategyKey,
} from './paper-ledger.js';

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------

export type OpenEvent = { v: 2; op: 'open'; trade: LedgerTrade };
export type SetEvent = { v: 2; op: 'set'; id: string; fields: Partial<LedgerTrade> };
export type LedgerEvent = OpenEvent | SetEvent;

/** Début exact de toute ligne écrite (clés `v` puis `op`, dans cet ordre). Une fin de fichier
 *  qui ne le porte pas n'est PAS un ajout interrompu mais un contenu étranger → illisible. */
const LINE_PREFIX = '{"v":2,"op":"';

/** Événement bien formé ? (forme seulement : la cohérence avec l'état est vérifiée à l'application) */
function parseEvent(x: unknown): LedgerEvent | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const e = x as Record<string, unknown>;
  if (e.v !== 2) return null;
  if (e.op === 'open') {
    const t = e.trade as Record<string, unknown> | undefined;
    if (!t || typeof t !== 'object' || Array.isArray(t) || typeof t.id !== 'string' || t.id === '') return null;
    // Champs sans lesquels les statistiques ne se calculent pas (computeStats échouerait aussi) :
    // refusés AVANT l'écriture, et au rejeu de la même façon.
    if (typeof t.slug !== 'string' || typeof t.openedAt !== 'string' || typeof t.status !== 'string') return null;
    return e as unknown as OpenEvent;
  }
  if (e.op === 'set') {
    const f = e.fields as Record<string, unknown> | undefined;
    if (typeof e.id !== 'string' || e.id === '' || !f || typeof f !== 'object' || Array.isArray(f)) return null;
    for (const k of ['slug', 'openedAt', 'status'] as const) if (k in f && typeof f[k] !== 'string') return null;
    return e as unknown as SetEvent;
  }
  return null;
}

/** Fin de fichier laissée par un ajout interrompu : début d'une ligne à nous, ou zéros (bloc
 *  alloué mais jamais écrit après une coupure de courant). */
function looksTorn(text: string): boolean {
  if (/^\0+$/.test(text)) return true;
  return text.length < LINE_PREFIX.length ? LINE_PREFIX.startsWith(text) : text.startsWith(LINE_PREFIX);
}

// ---------------------------------------------------------------------------
// État en mémoire (pur, sans I/O) : rejoue les événements, tient les agrégats
// ---------------------------------------------------------------------------

/** Portée d'agrégats : une stratégie, ou le total (risque, capital). */
export type StatScope = 'total' | StrategyKey;

/**
 * Stratégies comptées dans chaque portée. Aujourd'hui le total = tout le registre ; une
 * stratégie expérimentale pourrait en être EXCLUE plus tard (son PnL ne toucherait alors ni
 * la porte de risque ni le capital) en changeant seulement le prédicat de `total`.
 */
export const STAT_SCOPES: Readonly<Record<StatScope, (k: StrategyKey) => boolean>> = {
  total: () => true,
  fv: k => k === 'fv',
  late: k => k === 'late',
};
const SCOPE_KEYS = Object.keys(STAT_SCOPES) as StatScope[];

const DAY_MS = 86_400_000;
/** Horizons d'oubli, en temps des ÉVÉNEMENTS (donc identiques chez l'écrivain et chez un lecteur
 *  qui rejoue le fichier) : au-delà, un créneau ne reçoit plus de trade, une revente sans issue
 *  relevée n'en recevra plus (le bot cesse de demander 2 h après la fin du round), et un
 *  identifiant ne peut plus être rejoué (un round ne se joue que pendant ses 5 minutes). */
const CLUSTER_HORIZON_MS = 30 * DAY_MS;
const PENDING_HORIZON_MS = 30 * DAY_MS;
const ID_HORIZON_MS = 7 * DAY_MS;
/** PnL calendaire : jours gardés (le jour courant suffit) et mois gardés. */
const DAY_KEEP_MS = 40 * DAY_MS;
const MONTH_KEEP_MS = 400 * DAY_MS;
/** Ménage tous les N événements (compte global du fichier : même moment chez tous les lecteurs). */
const PRUNE_EVERY = 4096;
/** Derniers règlements gardés (historique de session du dashboard : 500). */
const RECENT_MAX = 512;
/** Pertes de la série en cours gardées pour la série « récente » (le bot s'arrête à 8). */
const STREAK_MAX = 10_000;

type Cls = 'open' | 'settled' | 'none';
/** open : position en cours ; settled : réglée avec un PnL (compte dans les stats) ; none :
 *  ni l'un ni l'autre (registre édité à la main) — ignoré par computeStats, donc ici aussi. */
const classOf = (t: LedgerTrade): Cls => (t.status === 'open' ? 'open' : isSettled(t) ? 'settled' : 'none');
const timeOf = (t: LedgerTrade): number => Date.parse(settleOrderKey(t) ?? '');

const EMPTY_STATS: LedgerStats = Object.freeze(computeStats([]));

/** Agrégats d'UNE portée, mis à jour événement par événement (mêmes règles que computeStats). */
class ScopeAcc {
  n = 0;
  wins = 0;
  losses = 0;
  /** PnL cumulé, dans l'ordre des règlements (= `cum` de computeStats). */
  pnl = 0;
  peak = 0;
  maxDrawdown = 0;
  lossStreak = 0;
  calibN = 0;
  calibWins = 0;
  calibProb = 0;
  readonly sums: ClusterSums = { n: 0, sum: 0, clusters: 0, sumS2: 0, sumNS: 0, sumN2: 0 };
  /** État de chaque créneau (S, k) et dernier passage (temps des événements), pour l'oubli. */
  readonly groups = new Map<string, { S: number; k: number; at: number }>();
  /** Instants des pertes de la série en cours (série « récente » sur une fenêtre). */
  streakTimes: number[] = [];
  readonly dayPnl = new Map<number, number>();
  readonly monthPnl = new Map<number, number>();

  settle(t: LedgerTrade, clock: number): void {
    const p = t.pnl as number;
    this.n++;
    if (p > 0) this.wins++;
    if (p < 0) this.losses++;
    this.pnl += p;
    this.peak = Math.max(this.peak, this.pnl);
    this.maxDrawdown = Math.max(this.maxDrawdown, this.peak - this.pnl);
    if (p < 0) {
      this.lossStreak++;
      this.streakTimes.push(timeOf(t));
      if (this.streakTimes.length > 2 * STREAK_MAX) this.streakTimes = this.streakTimes.slice(-STREAK_MAX);
    } else {
      this.lossStreak = 0;
      this.streakTimes = [];
    }
    const key = clusterKeyOf(t);
    const g = this.groups.get(key) ?? { S: 0, k: 0, at: clock };
    const next = addToClusterSums(this.sums, g, p);
    this.groups.set(key, { ...next, at: clock });
    // Même règle que calendarPnl : date de règlement, sinon d'ouverture ; date illisible → ignoré.
    const at = Date.parse(t.resolvedAt ?? t.openedAt ?? '');
    if (Number.isFinite(at)) {
      const { day, month } = utcDayMonth(at);
      this.dayPnl.set(day, (this.dayPnl.get(day) ?? 0) + p);
      this.monthPnl.set(month, (this.monthPnl.get(month) ?? 0) + p);
    }
  }

  calib(t: LedgerTrade, sign: 1 | -1): void {
    const w = sideWon(t);
    if (w === null) return;
    this.calibN += sign;
    if (w) this.calibWins += sign;
    this.calibProb += sign * t.modelProb;
  }

  /** Oubli des créneaux sans trade vivant et des jours/mois anciens (voir les horizons). */
  prune(clock: number, liveKeys: ReadonlySet<string>): void {
    for (const [k, g] of this.groups) if (g.at < clock - CLUSTER_HORIZON_MS && !liveKeys.has(k)) this.groups.delete(k);
    for (const d of this.dayPnl.keys()) if (d < clock - DAY_KEEP_MS) this.dayPnl.delete(d);
    for (const m of this.monthPnl.keys()) if (m < clock - MONTH_KEEP_MS) this.monthPnl.delete(m);
  }
}

export interface LedgerStateOptions {
  /** Garde AUSSI tous les trades (relecture complète : tests, export). Jamais pour le bot. */
  keepAll?: boolean;
  /** Horloge réelle : borne l'horloge des événements (une date absurde dans le futur ne doit
   *  pas faire tout oublier). */
  now?: () => number;
}

/**
 * État dérivé du journal : rejoue les événements dans l'ordre, sans I/O. `apply` renvoie
 * l'anomalie éventuelle (événement ignoré) ; l'écrivain vérifie AVANT d'écrire (`check`), si
 * bien que le fichier ne contient que des événements applicables.
 */
export class LedgerState {
  /** Trades encore susceptibles de changer : ouverts, reventes sans issue, « ni l'un ni l'autre ».
   *  Ordre d'insertion = ordre d'ouverture (comme l'ancien tableau). */
  readonly live = new Map<string, LedgerTrade>();
  /** Identifiants récents (refus d'un second trade pour le même round et la même stratégie). */
  private readonly ids = new Map<string, number>();
  private readonly acc: Record<StatScope, ScopeAcc>;
  private recent: LedgerTrade[] = [];
  private since: { from: number; n: number; pnl: number } | null = null;
  /** Horloge des événements (ms) : la plus grande date vue, bornée par l'horloge réelle + 1 j. */
  clock = -Infinity;
  events = 0;
  version = 0;
  readonly anomalies: string[] = [];
  anomalyCount = 0;
  readonly all: Map<string, LedgerTrade> | null;
  private readonly now: () => number;
  private readonly cache = new Map<StatScope, { version: number; stats: LedgerStats }>();

  constructor(opts: LedgerStateOptions = {}) {
    this.acc = Object.fromEntries(SCOPE_KEYS.map(k => [k, new ScopeAcc()])) as Record<StatScope, ScopeAcc>;
    this.all = opts.keepAll ? new Map() : null;
    this.now = opts.now ?? Date.now;
  }

  /** Compte les règlements (date de règlement ≥ `fromMs`) : bilan de session du dashboard. */
  trackSince(fromMs: number): void {
    this.since = { from: fromMs, n: 0, pnl: 0 };
  }

  hasId(id: string): boolean {
    return this.ids.has(id) || this.live.has(id);
  }

  /** Raison de refuser l'événement (null = applicable). `open` d'un id déjà présent : 'doublon'. */
  check(ev: LedgerEvent): string | null {
    if (ev.op === 'open') return this.hasId(ev.trade.id) ? 'doublon' : null;
    const cur = this.live.get(ev.id);
    if (!cur) return `modification d'un trade inconnu ou déjà réglé (${ev.id})`;
    return this.checkTransition(cur, ev.fields);
  }

  private checkTransition(cur: LedgerTrade, fields: Partial<LedgerTrade>): string | null {
    if ('id' in fields && fields.id !== cur.id) return `changement d'identifiant refusé (${cur.id})`;
    const next = { ...cur, ...fields } as LedgerTrade;
    if (strategyOf(next) !== strategyOf(cur)) return `changement de stratégie refusé (${cur.id})`;
    if (classOf(cur) !== 'settled') return null;
    // Déjà compté dans les agrégats (ordre, PnL, créneau, jour) : seule la calibration peut
    // encore bouger (issue du round relevée après une revente).
    if (classOf(next) !== 'settled' || next.pnl !== cur.pnl || settleOrderKey(next) !== settleOrderKey(cur)
      || clusterKeyOf(next) !== clusterKeyOf(cur) || next.openedAt !== cur.openedAt) {
      return `modification d'un trade déjà réglé non prise en charge (${cur.id})`;
    }
    return null;
  }

  /** Applique un événement ; renvoie le trade concerné (nouvel état), ou null si ignoré (anomalie notée). */
  apply(ev: LedgerEvent): LedgerTrade | null {
    this.events++;
    const why = this.check(ev);
    if (why) {
      this.anomalyCount++;
      if (this.anomalies.length < 20) this.anomalies.push(ev.op === 'open' && why === 'doublon' ? `trade ${ev.trade.id} déjà présent (ignoré)` : why);
      this.maybePrune();
      return null;
    }
    const out = ev.op === 'open' ? this.applyOpen(ev.trade) : this.applySet(ev.id, ev.fields);
    this.version++;
    this.maybePrune();
    return out;
  }

  private tick(ms: number): void {
    if (Number.isFinite(ms) && ms > this.clock) this.clock = Math.min(ms, this.now() + DAY_MS);
  }

  private applyOpen(raw: LedgerTrade): LedgerTrade {
    const t = Object.freeze({ ...raw });
    this.tick(Date.parse(t.openedAt ?? ''));
    this.tick(Date.parse(t.resolvedAt ?? ''));
    this.ids.set(t.id, Number.isFinite(t.endMs) ? t.endMs : this.clock);
    if (classOf(t) === 'settled') this.settle(t);
    if (this.isLive(t)) this.live.set(t.id, t);
    this.all?.set(t.id, t);
    return t;
  }

  private applySet(id: string, fields: Partial<LedgerTrade>): LedgerTrade {
    const cur = this.live.get(id) as LedgerTrade;
    const next = Object.freeze({ ...cur, ...fields, id }) as LedgerTrade;
    this.tick(Date.parse(fields.resolvedAt ?? ''));
    if (classOf(cur) === 'settled') {
      // Seule la calibration change (transition vérifiée par checkTransition).
      for (const k of this.scopesOf(cur)) {
        this.acc[k].calib(cur, -1);
        this.acc[k].calib(next, 1);
      }
    } else if (classOf(next) === 'settled') {
      this.settle(next);
    }
    if (this.isLive(next)) this.live.set(id, next); // même clé : même place (ordre d'ouverture)
    else this.live.delete(id);
    this.all?.set(id, next);
    return next;
  }

  private scopesOf(t: LedgerTrade): StatScope[] {
    const s = strategyOf(t);
    return SCOPE_KEYS.filter(k => STAT_SCOPES[k](s));
  }

  private settle(t: LedgerTrade): void {
    for (const k of this.scopesOf(t)) {
      this.acc[k].settle(t, this.clock);
      this.acc[k].calib(t, 1);
    }
    this.recent.push(t);
    if (this.recent.length > 2 * RECENT_MAX) this.recent = this.recent.slice(-RECENT_MAX);
    if (this.since && Date.parse(t.resolvedAt ?? '') >= this.since.from) {
      this.since.n++;
      this.since.pnl += t.pnl as number;
    }
  }

  /** Vivant = peut encore changer les statistiques : ouvert, ou réglé dont l'issue du round
   *  (calibration) n'est pas encore connue, ou sans PnL. */
  private isLive(t: LedgerTrade): boolean {
    const c = classOf(t);
    return c !== 'settled' || sideWon(t) === null;
  }

  private maybePrune(): void {
    if (this.events % PRUNE_EVERY !== 0 || !Number.isFinite(this.clock)) return;
    const clock = this.clock;
    for (const [id, t] of this.live) {
      if (t.status === 'open') continue; // une position ouverte n'est jamais oubliée
      const ref = Number.isFinite(t.endMs) ? t.endMs : timeOf(t);
      if (!(ref >= clock - PENDING_HORIZON_MS)) this.live.delete(id);
    }
    for (const [id, ref] of this.ids) if (ref < clock - ID_HORIZON_MS && !this.live.has(id)) this.ids.delete(id);
    for (const k of SCOPE_KEYS) {
      const keys = new Set<string>();
      for (const t of this.live.values()) if (classOf(t) !== 'settled' && STAT_SCOPES[k](strategyOf(t))) keys.add(clusterKeyOf(t));
      this.acc[k].prune(clock, keys);
    }
  }

  // ------------------------------------------------------------ lectures

  stats(scope: StatScope = 'total'): LedgerStats {
    const hit = this.cache.get(scope);
    if (hit && hit.version === this.version) return hit.stats;
    const a = this.acc[scope];
    let open = 0;
    let openExposure = 0;
    for (const t of this.live.values()) {
      if (t.status === 'open' && STAT_SCOPES[scope](strategyOf(t))) {
        open++;
        openExposure += t.stake;
      }
    }
    const stats: LedgerStats = Object.freeze({
      n: a.n,
      wins: a.wins,
      losses: a.losses,
      open,
      winRate: a.n ? a.wins / a.n : null,
      pnl: a.pnl,
      calibN: a.calibN,
      calibWinRate: a.calibN ? a.calibWins / a.calibN : null,
      avgModelProb: a.calibN ? a.calibProb / a.calibN : null,
      tStat: clusteredTFromSums(a.sums),
      lossStreak: a.lossStreak,
      openExposure,
      maxDrawdown: a.maxDrawdown,
      drawdownNow: a.peak - a.pnl,
      peakPnl: a.peak,
    });
    this.cache.set(scope, { version: this.version, stats });
    return stats;
  }

  /** PnL du jour et du mois UTC (mêmes règles que `calendarPnl`). */
  calendarPnl(nowMs: number, scope: StatScope = 'total'): CalendarPnl {
    const { day, month } = utcDayMonth(nowMs);
    const a = this.acc[scope];
    let today = 0;
    let m = 0;
    for (const [d, p] of a.dayPnl) if (d >= day) today += p;
    for (const [k, p] of a.monthPnl) if (k >= month) m += p;
    return { today, month: m };
  }

  /** Pertes consécutives réglées dans les `windowMs` dernières ms (mêmes règles que `recentLossStreak`). */
  recentLossStreak(nowMs: number, windowMs: number, scope: StatScope = 'total'): number {
    const times = this.acc[scope].streakTimes;
    let n = 0;
    for (let i = times.length - 1; i >= 0 && nowMs - times[i] <= windowMs; i--) n++;
    return n;
  }

  openTrades(): LedgerTrade[] {
    return [...this.live.values()].filter(t => t.status === 'open');
  }

  liveTrades(): LedgerTrade[] {
    return [...this.live.values()];
  }

  /** Derniers trades réglés (au plus 512), dans l'ordre des règlements. */
  recentSettled(): LedgerTrade[] {
    return this.recent.slice(-RECENT_MAX);
  }

  /** Identifiants récents ou vivants (rounds déjà joués). */
  knownIds(): string[] {
    return [...new Set([...this.ids.keys(), ...this.live.keys()])];
  }

  sinceStats(): { n: number; pnl: number } {
    return this.since ? { n: this.since.n, pnl: this.since.pnl } : { n: 0, pnl: 0 };
  }
}

// ---------------------------------------------------------------------------
// Lecture du journal (par blocs, jamais tout le fichier en une chaîne)
// ---------------------------------------------------------------------------

const CHUNK = 1 << 20;

interface ScanResult {
  /** Fin de la dernière ligne appliquée. */
  offset: number;
  /** Registre illisible (ligne invalide au milieu, contenu étranger) : raison. */
  broken: string | null;
  /** Dernière ligne coupée (ajout interrompu) : début et taille du morceau ignoré. */
  torn: { start: number; length: number } | null;
}

/**
 * Lit [from, size) ligne par ligne et passe chaque événement valide à `onEvent`. Règles :
 * ligne invalide suivie d'autre chose → illisible ; DERNIÈRE ligne (avec ou sans fin de ligne)
 * invalide mais ressemblant à un ajout interrompu → ignorée (`torn`) ; sinon → illisible.
 */
function scanJournal(fd: number, from: number, size: number, onEvent: (ev: LedgerEvent) => void): ScanResult {
  let offset = from;
  let bad: { start: number; text: string } | null = null;
  let carry: Buffer | null = null;
  let carryStart = from;
  let pos = from;
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, size - from)));
  const line = (text: string, start: number, end: number): string | null => {
    if (bad) return `ligne invalide à l'octet ${bad.start}`;
    let ev: LedgerEvent | null = null;
    try { ev = parseEvent(JSON.parse(text)); } catch { ev = null; }
    if (!ev) {
      bad = { start, text };
      return null;
    }
    onEvent(ev);
    offset = end;
    return null;
  };
  while (pos < size) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
    if (n <= 0) break;
    const data: Buffer = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    const dataStart = carry ? carryStart : pos;
    let i = 0;
    for (let nl = data.indexOf(10, i); nl >= 0; nl = data.indexOf(10, i)) {
      const why = line(data.toString('utf8', i, nl), dataStart + i, dataStart + nl + 1);
      if (why) return { offset, broken: why, torn: null };
      i = nl + 1;
    }
    // Reste sans fin de ligne : copié (le tampon de lecture est réutilisé au tour suivant).
    carry = i < data.length ? Buffer.from(data.subarray(i)) : null;
    carryStart = dataStart + i;
    pos += n;
  }
  const b = bad as { start: number; text: string } | null;
  if (b && carry) return { offset, broken: `ligne invalide à l'octet ${b.start}`, torn: null };
  if (b) {
    return looksTorn(b.text)
      ? { offset, broken: null, torn: { start: b.start, length: Buffer.byteLength(b.text) + 1 } }
      : { offset, broken: `dernière ligne étrangère au registre (octet ${b.start})`, torn: null };
  }
  if (carry) {
    const text = carry.toString('utf8');
    let parsed: unknown;
    let json = true;
    try { parsed = JSON.parse(text); } catch { json = false; }
    // JSON complet mais pas un événement (ex. ancien fv-ledger.json copié ici) : jamais « coupé ».
    if (json && !parseEvent(parsed)) return { offset, broken: 'contenu étranger au registre (ancien format ?)', torn: null };
    if (!json && !looksTorn(text)) return { offset, broken: `fin de fichier étrangère au registre (octet ${carryStart})`, torn: null };
    return { offset, broken: null, torn: { start: carryStart, length: carry.length } };
  }
  return { offset, broken: null, torn: null };
}

// ---------------------------------------------------------------------------
// Verrou d'écrivain unique
// ---------------------------------------------------------------------------

interface LockInfo { pid: number; token: string; boot: string | null; at: string }

/** Verrous tenus par CE processus (chemin → jeton) : retirés à la sortie. */
const heldLocks = new Map<string, string>();
let exitHook = false;

function bootId(): string | null {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

function readLock(path: string): { raw: string; info: LockInfo | null; mtimeMs: number } | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const mtimeMs = statSync(path).mtimeMs;
    try {
      const x = JSON.parse(raw) as LockInfo;
      return { raw, mtimeMs, info: Number.isInteger(x?.pid) && typeof x?.token === 'string' ? x : null };
    } catch {
      return { raw, mtimeMs, info: null };
    }
  } catch {
    return null;
  }
}

function releaseLockFile(path: string, token: string): void {
  const cur = readLock(path);
  if (cur?.info?.token === token) {
    try { unlinkSync(path); } catch { /* déjà retiré */ }
  }
}

// ---------------------------------------------------------------------------
// Le registre (fichier + état)
// ---------------------------------------------------------------------------

export interface LedgerStoreOptions {
  /** Ancien registre JSON (migration ; tant qu'il n'est pas migré, le registre est illisible).
   *  Défaut : le chemin du journal sans son « l » final (`fv-ledger.jsonl` → `fv-ledger.json`). */
  legacyPath?: string | null;
  /** Identité de l'écrivain (tests : simuler un autre processus). */
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** Écriture injectable (tests : disque plein simulé) ; même contrat que fs.writeSync. */
  writeSync?: (fd: number, buf: Buffer, offset: number, length: number) => number;
}

export interface WriterOpenResult {
  ok: boolean;
  /** Raison du refus (verrou tenu par un autre processus, registre illisible). */
  reason?: string;
  migration: MigrationResult;
}

export class LedgerStore {
  readonly path: string;
  readonly lockPath: string;
  readonly legacyPath: string | null;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly writeImpl: (fd: number, buf: Buffer, offset: number, length: number) => number;

  private state: LedgerState;
  private loaded = false;
  private broken: string | null = null;
  /** Ce qui a été appliqué : identité du fichier, taille, et ses premiers/derniers octets
   *  (détection d'une réécriture, même si le système réutilise le numéro d'inode). */
  private file = { ino: -1, dev: -1, size: 0, mtimeMs: 0 };
  private offset = 0;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private legacySeen = false;
  private sessionFrom: number | null = null;
  /** Incidents du dernier chargement complet (ligne coupée réparée, événements ignorés). */
  private issues: string[] = [];

  private fd: number | null = null;
  private fdIno = -1;
  private goodOffset = 0;
  private needsRepair = false;
  private lock: LockInfo | null = null;
  private lockRefusal: string | null = null;

  constructor(path: string, opts: LedgerStoreOptions = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.legacyPath = opts.legacyPath !== undefined ? opts.legacyPath : path.endsWith('.jsonl') ? path.slice(0, -1) : null;
    this.pid = opts.pid ?? process.pid;
    this.isAlive = opts.isAlive ?? pidAlive;
    this.now = opts.now ?? Date.now;
    this.writeImpl = opts.writeSync ?? ((fd, buf, off, len) => writeSync(fd, buf, off, len));
    this.state = new LedgerState({ now: this.now });
  }

  // ------------------------------------------------------------ lectures (O(1) / O(ouverts))

  /** Registre lisible ? (false : aucune nouvelle position, fichier jamais modifié) */
  readable(): boolean {
    this.sync();
    return this.broken === null;
  }

  /** Raison de l'illisibilité, ou null. */
  brokenReason(): string | null {
    this.sync();
    return this.broken;
  }

  /** Incidents du dernier chargement complet (à signaler une fois). */
  get loadIssues(): readonly string[] {
    this.sync();
    return this.issues;
  }

  stats(scope: StatScope = 'total'): LedgerStats {
    this.sync();
    return this.broken ? EMPTY_STATS : this.state.stats(scope);
  }

  calendarPnl(nowMs: number, scope: StatScope = 'total'): CalendarPnl {
    this.sync();
    return this.broken ? { today: 0, month: 0 } : this.state.calendarPnl(nowMs, scope);
  }

  recentLossStreak(scope: StatScope, nowMs: number, windowMs: number): number {
    this.sync();
    return this.broken ? 0 : this.state.recentLossStreak(nowMs, windowMs, scope);
  }

  /** Positions ouvertes, dans l'ordre d'ouverture (objets gelés). */
  openTrades(): LedgerTrade[] {
    this.sync();
    return this.broken ? [] : this.state.openTrades();
  }

  /** Trades vivants (ouverts, reventes dont l'issue reste à relever) ; null si illisible. */
  liveTrades(): LedgerTrade[] | null {
    this.sync();
    return this.broken ? null : this.state.liveTrades();
  }

  /** Derniers trades réglés (≤ 512), ordre des règlements. */
  recentSettled(): LedgerTrade[] {
    this.sync();
    return this.broken ? [] : this.state.recentSettled();
  }

  /** Identifiants des rounds joués récemment (≤ 7 j) ou encore vivants. */
  recentIds(): string[] {
    this.sync();
    return this.broken ? [] : this.state.knownIds();
  }

  /** Règlements depuis `setSessionStart` (date de règlement ≥ début). */
  sessionSettled(): { n: number; pnl: number } {
    this.sync();
    return this.broken ? { n: 0, pnl: 0 } : this.state.sinceStats();
  }

  /** Début de session : les règlements postérieurs sont comptés (rejoue le registre si déjà chargé). */
  setSessionStart(ms: number): void {
    this.sessionFrom = ms;
    if (this.loaded) this.fullLoad();
  }

  // ------------------------------------------------------------ écriture

  /**
   * Prend le rôle d'écrivain : verrou, migration de l'ancien fv-ledger.json, relecture, réparation
   * d'une dernière ligne coupée. À appeler au démarrage du bot (sinon : au premier ajout, sans
   * migration).
   */
  openWriter(): WriterOpenResult {
    const refusal = this.acquireLock();
    if (refusal) return { ok: false, reason: refusal, migration: { status: 'absent' } };
    const migration = this.legacyPath ? migrateLegacyLedger(this.legacyPath, this.path, { now: this.now }) : { status: 'absent' as const };
    this.fullLoad();
    if (this.broken) return { ok: false, reason: this.broken, migration };
    return { ok: true, migration };
  }

  /** Ajoute un trade. false : identifiant déjà présent (un trade par round et par stratégie).
   *  Lève une erreur si le registre est illisible, verrouillé ailleurs, ou si l'écriture échoue. */
  open(trade: LedgerTrade): boolean {
    const { line, ev } = encode({ v: 2, op: 'open', trade });
    this.sync();
    this.assertWritable();
    const why = this.state.check(ev);
    if (why === 'doublon') return false;
    if (why) throw new Error(why);
    this.append(line);
    this.state.apply(ev);
    return true;
  }

  /**
   * Modifie un trade vivant (une ligne `set`). null : trade absent (ou réglé depuis), ou
   * `ifStatus` différent — rien n'est écrit. Renvoie le nouvel état du trade.
   */
  patch(id: string, fields: Partial<LedgerTrade>, opts: { ifStatus?: LedgerStatus } = {}): LedgerTrade | null {
    const { line, ev } = encode({ v: 2, op: 'set', id, fields });
    this.sync();
    this.assertWritable();
    const cur = this.state.live.get(id);
    if (!cur || (opts.ifStatus && cur.status !== opts.ifStatus)) return null;
    const why = this.state.check(ev);
    if (why) throw new Error(why);
    this.append(line);
    return this.state.apply(ev);
  }

  /** Ferme le descripteur et rend le verrou (arrêt propre). */
  close(): void {
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* déjà fermé */ }
      this.fd = null;
    }
    if (this.lock) {
      releaseLockFile(this.lockPath, this.lock.token);
      heldLocks.delete(this.lockPath);
      this.lock = null;
    }
  }

  private assertWritable(): void {
    if (this.broken) throw new Error(`registre illisible (${this.broken}) : écriture refusée`);
    if (!this.lock) {
      // Écrivain pris au premier ajout (tests, outils ; le bot passe par openWriter) : relecture
      // en écrivain, qui répare une éventuelle dernière ligne coupée.
      const refusal = this.acquireLock();
      if (refusal) throw new Error(refusal);
      this.fullLoad();
      if (this.broken) throw new Error(`registre illisible (${this.broken}) : écriture refusée`);
    }
  }

  private acquireLock(): string | null {
    if (this.lock) return null;
    mkdirSync(dirname(this.path), { recursive: true });
    const me: LockInfo = { pid: this.pid, token: randomBytes(8).toString('hex'), boot: bootId(), at: new Date(this.now()).toISOString() };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        try { writeFileSync(fd, JSON.stringify(me)); fsyncSync(fd); } finally { closeSync(fd); }
        this.lock = me;
        this.lockRefusal = null;
        heldLocks.set(this.lockPath, me.token);
        if (!exitHook) {
          exitHook = true;
          process.once('exit', () => { for (const [p, tok] of heldLocks) releaseLockFile(p, tok); });
        }
        return null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      }
      const cur = readLock(this.lockPath);
      if (!cur) continue; // retiré entre-temps : nouvel essai
      const o = cur.info;
      let stale: boolean;
      if (!o) stale = this.now() - cur.mtimeMs > 10_000; // illisible : en cours d'écriture, ou débris
      else if (o.boot && me.boot && o.boot !== me.boot) stale = true; // machine redémarrée depuis
      else if (o.pid === this.pid) stale = heldLocks.get(this.lockPath) !== o.token; // pid réattribué
      else stale = !this.isAlive(o.pid);
      if (!stale) {
        this.lockRefusal = o
          ? `registre verrouillé par le processus ${o.pid} (depuis ${o.at}) : écriture refusée — si aucun autre bot ne tourne, supprimer ${this.lockPath}`
          : `verrou ${this.lockPath} en cours de création par un autre processus : écriture refusée`;
        return this.lockRefusal;
      }
      // Verrou d'un processus mort : repris. Relu juste avant de le retirer, pour ne pas retirer
      // celui qu'un autre processus vient de reprendre.
      if (readLock(this.lockPath)?.raw === cur.raw) {
        try { unlinkSync(this.lockPath); } catch { /* retiré entre-temps */ }
      }
    }
    this.lockRefusal = `verrou ${this.lockPath} impossible à prendre`;
    return this.lockRefusal;
  }

  /** Le verrou est-il toujours à nous ? (repris par un autre processus après une erreur de pid…) */
  private checkLock(): void {
    const cur = readLock(this.lockPath);
    if (this.lock && cur?.info?.token === this.lock.token) return;
    heldLocks.delete(this.lockPath);
    this.lock = null;
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* ignoré */ } this.fd = null; }
    throw new Error(`verrou ${this.lockPath} perdu (${cur?.info ? `processus ${cur.info.pid}` : 'retiré'}) : écriture refusée`);
  }

  private writerFd(): number {
    if (this.fd !== null && this.fdIno === this.file.ino) return this.fd;
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* ignoré */ } this.fd = null; }
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'a');
    const st = fstatSync(fd);
    if (this.file.ino === -1) {
      // Fichier créé à l'instant : état vide, rien à relire.
      this.file = { ino: st.ino, dev: st.dev, size: st.size, mtimeMs: st.mtimeMs };
    }
    if (st.ino !== this.file.ino || st.size !== this.offset) {
      closeSync(fd);
      throw new Error('registre modifié pendant l\'ouverture en écriture : nouvel essai au prochain passage');
    }
    this.fd = fd;
    this.fdIno = st.ino;
    this.goodOffset = st.size;
    return fd;
  }

  /**
   * Ajoute une ligne : écriture complète en boucle (writeSync peut être partiel), puis fsync.
   * Échec (disque plein…) → fichier ramené à la dernière ligne complète avant de relever
   * l'erreur ; si même cela échoue, plus rien n'est écrit avant réparation.
   */
  private append(line: string): void {
    this.checkLock();
    const fd = this.writerFd();
    if (this.needsRepair) {
      ftruncateSync(fd, this.goodOffset); // lève tant que la réparation est impossible
      this.needsRepair = false;
    }
    const buf = Buffer.from(line, 'utf8');
    let done = 0;
    try {
      while (done < buf.length) {
        const n = this.writeImpl(fd, buf, done, buf.length - done);
        if (!(n > 0)) throw new Error(`écriture incomplète (${done}/${buf.length} octets)`);
        done += n;
      }
      fsyncSync(fd);
    } catch (err) {
      try { ftruncateSync(fd, this.goodOffset); } catch { this.needsRepair = true; }
      throw err;
    }
    this.goodOffset += buf.length;
    this.offset = this.goodOffset;
    const st = fstatSync(fd);
    this.file = { ino: st.ino, dev: st.dev, size: st.size, mtimeMs: st.mtimeMs };
    if (this.head.length < 64) this.head = Buffer.concat([this.head, buf]).subarray(0, 64);
    this.tail = Buffer.concat([this.tail, buf]).subarray(-64);
  }

  // ------------------------------------------------------------ synchronisation avec le fichier

  /**
   * Met l'état à jour avec le fichier : rien s'il n'a pas changé ; seulement la fin s'il a
   * grossi (même fichier) ; relecture complète s'il a été remplacé, tronqué ou réécrit.
   */
  private sync(): void {
    if (!this.loaded) { this.fullLoad(); return; }
    let st: { ino: number; dev: number; size: number; mtimeMs: number };
    try {
      st = statSync(this.path);
    } catch {
      // Absent : il l'était déjà (et l'ancien registre n'a pas bougé) → rien à faire.
      const legacy = !!this.legacyPath && existsSync(this.legacyPath);
      if (this.file.ino !== -1 || legacy !== this.legacySeen) this.fullLoad();
      return;
    }
    if (st.ino !== this.file.ino || st.dev !== this.file.dev || st.size < this.offset) { this.fullLoad(); return; }
    if (st.size === this.file.size && st.mtimeMs === this.file.mtimeMs) return;
    let fd: number;
    try { fd = openSync(this.path, 'r'); } catch { this.fullLoad(); return; }
    try {
      // Réécrit (début ou fin de la partie lue différents), ou illisible et modifié (réparé ?) :
      // relecture complète.
      if (this.broken || !this.edgesMatch(fd)) { closeSync(fd); fd = -1; this.fullLoad(); return; }
      this.consume(fd, this.offset, st.size, false);
      this.file = { ino: st.ino, dev: st.dev, size: st.size, mtimeMs: st.mtimeMs };
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  }

  private edgesMatch(fd: number): boolean {
    const same = (pos: number, ref: Buffer): boolean => {
      if (!ref.length) return true;
      const b = Buffer.alloc(ref.length);
      return readSync(fd, b, 0, ref.length, pos) === ref.length && b.equals(ref);
    };
    return same(0, this.head) && same(this.offset - this.tail.length, this.tail);
  }

  /** Relecture complète (démarrage, fichier remplacé). L'écrivain répare une ligne coupée. */
  private fullLoad(): void {
    this.loaded = true;
    this.state = new LedgerState({ now: this.now });
    if (this.sessionFrom !== null) this.state.trackSince(this.sessionFrom);
    this.broken = null;
    this.issues = [];
    this.offset = 0;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.file = { ino: -1, dev: -1, size: 0, mtimeMs: 0 };
    this.legacySeen = !!this.legacyPath && existsSync(this.legacyPath);
    if (this.fd !== null && this.fdIno !== -1) {
      // Le fichier a pu être remplacé : le descripteur d'écriture sera rouvert sur le nouveau.
      try { closeSync(this.fd); } catch { /* ignoré */ }
      this.fd = null;
      this.fdIno = -1;
    }
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      if (this.legacySeen) {
        // Ancien registre présent mais pas (encore) migré : surtout ne pas repartir d'un registre
        // vide (positions et pertes oubliées) — illisible jusqu'à la migration par le bot.
        this.broken = `ancien registre ${this.legacyPath} non migré (migration au démarrage du bot)`;
      }
      return;
    }
    try {
      const st = fstatSync(fd);
      this.file = { ino: st.ino, dev: st.dev, size: st.size, mtimeMs: st.mtimeMs };
      const r = this.consume(fd, 0, st.size, true);
      if (r.torn && this.lock) this.repairTorn(r.torn);
    } finally {
      closeSync(fd);
    }
    if (this.state.anomalyCount) {
      this.issues.push(`${this.state.anomalyCount} événement(s) du registre ignoré(s) : ${this.state.anomalies.slice(0, 3).join(' ; ')}`);
    }
  }

  private consume(fd: number, from: number, size: number, full: boolean): ScanResult {
    const r = scanJournal(fd, from, size, ev => this.state.apply(ev));
    this.offset = r.offset;
    if (r.broken) this.broken = r.broken;
    // Bords de la partie appliquée (détection d'une réécriture du fichier).
    if (full || this.head.length < 64) {
      const n = Math.min(64, this.offset);
      const h = Buffer.alloc(n);
      this.head = n ? h.subarray(0, readSync(fd, h, 0, n, 0)) : h;
    }
    const tn = Math.min(64, this.offset);
    const t = Buffer.alloc(tn);
    this.tail = tn ? t.subarray(0, readSync(fd, t, 0, tn, this.offset - tn)) : t;
    return r;
  }

  /** Dernière ligne coupée : mise de côté (jamais perdue), registre tronqué, incident noté. */
  private repairTorn(torn: { start: number; length: number }): void {
    const stamp = new Date(this.now()).toISOString().replace(/:/g, '');
    const aside = `${this.path}.ligne-coupee-${stamp}`;
    try {
      const fd = openSync(this.path, 'r+');
      try {
        const b = Buffer.alloc(torn.length);
        const n = readSync(fd, b, 0, torn.length, torn.start);
        writeFileSync(aside, b.subarray(0, n));
        ftruncateSync(fd, torn.start);
        fsyncSync(fd);
        const st = fstatSync(fd);
        this.file = { ino: st.ino, dev: st.dev, size: st.size, mtimeMs: st.mtimeMs };
      } finally {
        closeSync(fd);
      }
      this.issues.push(`dernière ligne du registre incomplète (arrêt brutal pendant une écriture ?) : ignorée, registre ramené à la dernière ligne complète (${torn.length} octets mis de côté dans ${aside})`);
    } catch (err) {
      // Réparation impossible : la ligne reste ignorée, mais on n'écrit pas derrière elle.
      this.broken = `dernière ligne incomplète non réparable (${(err as Error).message})`;
    }
  }
}

/** Sérialise l'événement et le relit : l'état en mémoire est construit sur la forme RELUE
 *  (undefined retiré, NaN → null…), exactement ce qu'un rejeu du fichier verra. */
function encode(ev: LedgerEvent): { line: string; ev: LedgerEvent } {
  const line = JSON.stringify(ev) + '\n';
  const back = parseEvent(JSON.parse(line));
  if (!back) throw new Error('événement de registre mal formé (identifiant manquant ?)');
  return { line, ev: back };
}

// ---------------------------------------------------------------------------
// Un registre par chemin et par processus
// ---------------------------------------------------------------------------

const stores = new Map<string, LedgerStore>();

/** Registre partagé du processus pour ce chemin (bot, runner, dashboard, Telegram, doctor). */
export function ledgerStore(path: string): LedgerStore {
  const key = resolve(path);
  let s = stores.get(key);
  if (!s) stores.set(key, (s = new LedgerStore(key)));
  return s;
}

/** Statistiques de tout le registre (porte de risque, capital) — O(1) entre deux événements. */
export function ledgerStatsShared(path: string): LedgerStats {
  return ledgerStore(path).stats('total');
}

/** Statistiques d'UNE stratégie (messages, séries de pertes, garde-fous). */
export function ledgerStatsSharedFor(path: string, key: StrategyKey): LedgerStats {
  return ledgerStore(path).stats(key);
}

// ---------------------------------------------------------------------------
// Fichier complet : tests, export, migration (jamais sur le chemin chaud du bot)
// ---------------------------------------------------------------------------

/** Rejoue tout le journal et garde TOUS les trades (O(n) en mémoire). null si illisible. */
function replayAll(path: string): LedgerState | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return new LedgerState({ keepAll: true }); }
  try {
    const state = new LedgerState({ keepAll: true });
    const r = scanJournal(fd, 0, fstatSync(fd).size, ev => state.apply(ev));
    return r.broken ? null : state;
  } finally {
    closeSync(fd);
  }
}

/** Tous les trades (état final, ordre d'ouverture), copie modifiable. [] si absent ; null si illisible. */
export function loadLedger(path: string): LedgerTrade[] | null {
  const s = replayAll(path);
  return s ? [...(s.all as Map<string, LedgerTrade>).values()].map(t => ({ ...t })) : null;
}

const sharedMemo = new Map<string, { ino: number; size: number; mtimeMs: number; trades: readonly LedgerTrade[] }>();

/** Version partagée (gelée, en cache tant que le fichier ne change pas) de `loadLedger`. */
export function readLedgerShared(path: string): readonly LedgerTrade[] | null {
  let st: { ino: number; size: number; mtimeMs: number };
  try {
    st = statSync(path);
  } catch {
    sharedMemo.delete(path);
    return existsSync(path) ? null : [];
  }
  const hit = sharedMemo.get(path);
  if (hit && hit.ino === st.ino && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.trades;
  const s = replayAll(path);
  if (!s) {
    sharedMemo.delete(path);
    return null;
  }
  const trades = Object.freeze([...(s.all as Map<string, LedgerTrade>).values()]) as readonly LedgerTrade[];
  sharedMemo.set(path, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, trades });
  return trades;
}

/** Ordre d'écriture d'un registre complet : celui de computeStats (règlement, sinon ouverture),
 *  pour que le rejeu incrémental retrouve exactement ses statistiques. Tri stable. */
function settleOrder(trades: readonly LedgerTrade[]): LedgerTrade[] {
  return [...trades].sort((a, b) => (settleOrderKey(a) ?? '').localeCompare(settleOrderKey(b) ?? ''));
}

/** Écrit un journal complet (un `open` par trade, état final), avec fsync. */
function writeJournalFile(path: string, trades: readonly LedgerTrade[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'w');
  try {
    let chunk = '';
    for (const t of settleOrder(trades)) {
      chunk += JSON.stringify({ v: 2, op: 'open', trade: t }) + '\n';
      // writeFileSync sur un descripteur boucle jusqu'à tout écrire (pas d'écriture partielle).
      if (chunk.length > 1 << 22) { writeFileSync(fd, chunk); chunk = ''; }
    }
    if (chunk) writeFileSync(fd, chunk);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* best effort */ }
}

/** Réécriture COMPLÈTE et atomique (fichier temporaire + rename) : tests, outils. Le bot ne
 *  l'utilise jamais ; un registre ouvert ailleurs détecte le remplacement et relit. */
export function saveLedger(path: string, trades: readonly LedgerTrade[]): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeJournalFile(tmp, trades);
  renameSync(tmp, path);
  sharedMemo.delete(path);
}

/** Ancien format (fv-ledger.json) : trades, [] si absent, null si illisible. */
export function readLegacyLedger(path: string): LedgerTrade[] | null {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LedgerFile>;
    if (!Array.isArray(data?.trades)) return null;
    if (!data.trades.every(t => t && typeof t === 'object' && typeof (t as LedgerTrade).id === 'string' && (t as LedgerTrade).id !== '')) return null;
    return data.trades;
  } catch {
    return null;
  }
}

/** Écrit l'ancien format, atomiquement (export pour revenir à une version antérieure du bot). */
export function writeLegacyLedger(path: string, trades: readonly LedgerTrade[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    const body: LedgerFile = { version: 1, trades: [...trades] };
    writeFileSync(fd, JSON.stringify(body));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Export du journal vers l'ancien format (`--export-json`). Lève si le journal est illisible. */
export function exportLegacyLedger(jsonlPath: string, outPath: string): number {
  const trades = loadLedger(jsonlPath);
  if (trades === null) throw new Error(`${jsonlPath} illisible : export impossible`);
  writeLegacyLedger(outPath, trades);
  return trades.length;
}

// ---------------------------------------------------------------------------
// Migration fv-ledger.json → fv-ledger.jsonl, vérifiée
// ---------------------------------------------------------------------------

export type MigrationResult =
  | { status: 'absent' }
  /** Migré : ancien fichier conservé sous `archivedAs`. */
  | { status: 'migre'; trades: number; archivedAs: string; ms: { write: number; verify: number } }
  /** Les deux fichiers existaient (arrêt entre les deux renommages) : le .jsonl fait foi. */
  | { status: 'deja-migre'; archivedAs: string }
  /** Ancien registre illisible : rien migré, rien modifié. */
  | { status: 'illisible'; detail: string }
  /** Statistiques rejouées ≠ ancien registre : migration annulée, ancien fichier intact. */
  | { status: 'ecart'; detail: string };

const TOL = 1e-9;
const near = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= TOL * Math.max(1, Math.abs(a), Math.abs(b));

/** Écarts entre deux jeux de statistiques (entiers exacts, réels à 1e-9 relatif). */
export function statsDiff(ref: LedgerStats, got: LedgerStats, label = ''): string[] {
  const out: string[] = [];
  for (const k of Object.keys(ref) as Array<keyof LedgerStats>) {
    const a = ref[k];
    const b = got[k];
    const ok = Number.isInteger(a) && ['n', 'wins', 'losses', 'open', 'calibN', 'lossStreak'].includes(k) ? a === b : near(a, b);
    if (!ok) out.push(`${label}${k} : ${a} attendu, ${b} rejoué`);
  }
  return out;
}

/** Ce qu'on compare à la référence : l'état rejoué, ou un registre (`LedgerStore`). */
export interface StatsSource {
  stats(scope: StatScope): LedgerStats;
  openTrades(): LedgerTrade[];
  calendarPnl(nowMs: number, scope?: StatScope): CalendarPnl;
}

/**
 * Compare un registre complet (référence : computeStats, calendarPnl) à un état rejoué : toutes
 * les statistiques (total et par stratégie), les positions ouvertes, le PnL du jour et du mois.
 */
export function compareToReference(trades: readonly LedgerTrade[], src: StatsSource, nowMs: number): string[] {
  const out: string[] = [];
  for (const k of SCOPE_KEYS) {
    out.push(...statsDiff(computeStats(trades.filter(t => STAT_SCOPES[k](strategyOf(t)))), src.stats(k), `${k}.`));
  }
  const key = (l: readonly LedgerTrade[]) => JSON.stringify([...l].sort((a, b) => a.id.localeCompare(b.id)));
  if (key(trades.filter(t => t.status === 'open')) !== key(src.openTrades())) out.push('positions ouvertes différentes');
  const c1 = calendarPnl(trades, nowMs);
  const c2 = src.calendarPnl(nowMs);
  if (!near(c1.today, c2.today) || !near(c1.month, c2.month)) {
    out.push(`PnL jour/mois : ${c1.today}/${c1.month} attendus, ${c2.today}/${c2.month} rejoués`);
  }
  return out;
}

/** Nom d'archive libre : `<ancien>.migre-<ISO sans ':'>` (jamais d'écrasement). */
function archiveLegacy(legacyPath: string, nowMs: number): string {
  const base = `${legacyPath}.migre-${new Date(nowMs).toISOString().replace(/:/g, '')}`;
  let name = base;
  for (let i = 2; existsSync(name); i++) name = `${base}-${i}`;
  renameSync(legacyPath, name);
  fsyncDir(dirname(legacyPath));
  return name;
}

/**
 * Migre l'ancien registre (idempotent) :
 *  - .json absent → rien ;
 *  - .json ET .jsonl présents (arrêt entre les deux renommages) → le .jsonl fait foi, l'ancien
 *    est renommé (CONSERVÉ) ;
 *  - .json illisible → rien n'est touché (registre illisible : comportement sûr) ;
 *  - sinon : `.jsonl.tmp` écrit (un `open` par trade, état final, ordre de computeStats) +
 *    fsync, REJOUÉ et comparé à l'ancien (toutes les statistiques) ; écart → tmp supprimé,
 *    ancien intact ; identique → rename en .jsonl, puis ancien renommé `.migre-<horodatage>`.
 */
export function migrateLegacyLedger(legacyPath: string, jsonlPath: string, opts: { now?: () => number } = {}): MigrationResult {
  const now = opts.now ?? Date.now;
  if (!existsSync(legacyPath)) return { status: 'absent' };
  if (existsSync(jsonlPath)) return { status: 'deja-migre', archivedAs: archiveLegacy(legacyPath, now()) };
  const trades = readLegacyLedger(legacyPath);
  if (trades === null) return { status: 'illisible', detail: `${legacyPath} illisible : rien n'a été migré (fichier préservé)` };
  const tmp = `${jsonlPath}.tmp`;
  const t0 = performance.now();
  writeJournalFile(tmp, trades);
  const t1 = performance.now();
  const replayed = new LedgerState({ now });
  let diffs: string[];
  const fd = openSync(tmp, 'r');
  try {
    const r = scanJournal(fd, 0, fstatSync(fd).size, ev => replayed.apply(ev));
    diffs = r.broken || r.torn ? [`relecture du fichier migré : ${r.broken ?? 'fin incomplète'}`] : compareToReference(trades, replayed, now());
    if (replayed.anomalyCount) diffs.push(`${replayed.anomalyCount} trade(s) ignoré(s) au rejeu : ${replayed.anomalies.slice(0, 3).join(' ; ')}`);
  } finally {
    closeSync(fd);
  }
  const t2 = performance.now();
  if (diffs.length) {
    try { unlinkSync(tmp); } catch { /* déjà retiré */ }
    return { status: 'ecart', detail: `migration annulée, ${legacyPath} intact — ${diffs.slice(0, 5).join(' ; ')}${diffs.length > 5 ? ` (+${diffs.length - 5})` : ''}` };
  }
  renameSync(tmp, jsonlPath);
  fsyncDir(dirname(jsonlPath));
  return { status: 'migre', trades: trades.length, archivedAs: archiveLegacy(legacyPath, now()), ms: { write: t1 - t0, verify: t2 - t1 } };
}
