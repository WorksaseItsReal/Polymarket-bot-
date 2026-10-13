/**
 * paper-ledger.ts — modèle du registre des trades paper (types, statistiques PURES) et
 * résolution des rounds « Up/Down 5 min » via l'API Gamma.
 *
 * Pourquoi un registre propre : le PnL réalisé était calculé par des scripts externes
 * (paperbot-pnl.py, hors dépôt) ; le bot ne pouvait donc ni connaître ses propres
 * résultats, ni annoncer clairement un gain/une perte sur Telegram. Ce registre est la
 * source de vérité de la stratégie : un trade y entre à l'ouverture, en sort résolu
 * (gagné / perdu / revendu), et toutes les statistiques en dérivent.
 *
 * Le FICHIER (journal append-only fv-ledger.jsonl, statistiques incrémentales, migration de
 * l'ancien fv-ledger.json) est dans ledger-store.ts ; ici, rien que du calcul sans I/O :
 * `computeStats` sur une liste complète reste la référence que le registre incrémental doit
 * reproduire (tests d'équivalence, vérification de la migration).
 *
 * Résolution (chemin vérifié, cf. docs/backtest/resolve.py) :
 *   GET https://gamma-api.polymarket.com/events?slug=<coin>-updown-5m-<slot>
 *   → la réponse doit porter EXACTEMENT le slug demandé (le filtre `markets?condition_id=`
 *     est ignoré par l'API et renvoyait un autre marché) ;
 *   → marché `closed` ET prix de sortie ≥ 0,99 d'un côté. Un marché ouvert affiche des
 *     `outcomePrices` provisoires (ex. 0,5/0,5) : ce n'est PAS un résultat.
 */

import { clusteredMeanT, slotKey } from '../analysis/stats.js';

export type LedgerSide = 'UP' | 'DOWN';
export type LedgerStatus = 'open' | 'won' | 'lost' | 'sold';
/** Stratégie d'un trade : 'fv' juste valeur (défaut, champ absent), 'late' récolte de fin de round. */
export type StrategyKey = 'fv' | 'late';

export interface LedgerTrade {
  /** conditionId du marché (un seul trade par round et par stratégie : `<conditionId>|late`
   *  pour la récolte de fin de round). */
  id: string;
  /** 'late' = récolte de fin de round (late-harvest.ts) ; absent = stratégie juste valeur. */
  strategy?: 'late';
  slug: string;
  coin: string;
  side: LedgerSide;
  /** Mise totale, frais inclus (€/$). */
  stake: number;
  /** Coût réel par part (VWAP + frais). */
  costPerShare: number;
  shares: number;
  /** Probabilité du modèle pour le côté acheté, à l'entrée. Récolte de fin de round : taux de
   *  gain historique de la règle (HARVEST_EXPECTED_WIN), que la calibration vérifie. */
  modelProb: number;
  /** modelProb − costPerShare. */
  edge: number;
  openedAt: string;
  /** Fin du round (ms epoch). */
  endMs: number;
  status: LedgerStatus;
  /** PnL réalisé (null tant que le trade est ouvert). */
  pnl: number | null;
  resolvedAt?: string;
  exitPrice?: number;
  /** Token acheté (sortie anticipée) et début du round (s epoch). */
  tokenId?: string;
  /** Token du côté opposé (prix du carnet pour le mélange modèle/carnet en sortie). */
  otherTokenId?: string;
  /** Alerte « round toujours non réglé » déjà envoyée (persistée : pas de répétition au
   *  redémarrage). */
  unresolvedAlertedAt?: string;
  slotSec?: number;
  /** Issue réelle du round (« Up » a gagné ?), connue même pour une position revendue :
   *  sert à la calibration, qui ne doit pas dépendre de la règle de vente. */
  outcomeUpWon?: boolean;
}

/** Ancien format (fv-ledger.json, un seul JSON réécrit à chaque modification) : migration,
 *  export pour revenir à une version antérieure du bot. */
export interface LedgerFile {
  version: 1;
  trades: LedgerTrade[];
}

export const strategyOf = (t: Pick<LedgerTrade, 'strategy'>): StrategyKey => (t.strategy === 'late' ? 'late' : 'fv');

// ---------------------------------------------------------------------------
// Logique pure
// ---------------------------------------------------------------------------

/** PnL d'un trade tenu jusqu'à la résolution. */
export function settlePnl(t: Pick<LedgerTrade, 'shares' | 'stake'>, won: boolean): number {
  return won ? t.shares - t.stake : -t.stake;
}

export interface LedgerStats {
  /** Trades résolus (gagnés + perdus + revendus). */
  n: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number | null;
  pnl: number;
  /** Calibration : trades dont l'issue du ROUND est connue (gagnés, perdus, et reventes
   *  dont le round a été réglé ensuite). « Réussite » = le côté choisi a gagné le round,
   *  indépendamment d'une éventuelle revente (sinon la règle de vente biaise la mesure). */
  calibN: number;
  calibWinRate: number | null;
  /** Probabilité modèle moyenne de ces trades = réussite attendue si le modèle est calibré. */
  avgModelProb: number | null;
  /** t-statistique du PnL par trade (null si n < 2 ou variance nulle). */
  tStat: number | null;
  /** Pertes consécutives sur les trades résolus les plus récents. */
  lossStreak: number;
  /** Exposition des positions ouvertes (somme des mises). */
  openExposure: number;
  /** Plus forte baisse du PnL cumulé depuis un sommet. */
  maxDrawdown: number;
  /** Baisse ACTUELLE du PnL cumulé sous son sommet (≥ 0). */
  drawdownNow: number;
  /** Sommet du PnL cumulé (≥ 0). */
  peakPnl: number;
}

/** Trade réglé avec un PnL utilisable : seul ce qui compte dans les statistiques. */
export const isSettled = (t: Pick<LedgerTrade, 'status' | 'pnl'>): boolean =>
  t.status !== 'open' && typeof t.pnl === 'number' && Number.isFinite(t.pnl);

/** Côté choisi gagnant au ROUND ? (won/lost : par définition ; reventes : si l'issue a été
 *  relevée ; sinon null = inconnu, hors calibration). */
export function sideWon(t: Pick<LedgerTrade, 'status' | 'side' | 'outcomeUpWon'>): boolean | null {
  if (t.status === 'won') return true;
  if (t.status === 'lost') return false;
  if (typeof t.outcomeUpWon === 'boolean') return t.outcomeUpWon === (t.side === 'UP');
  return null;
}

/** Groupe du t (créneau de 5 min) : les cryptos d'un même round sont corrélées. */
export const clusterKeyOf = (t: Pick<LedgerTrade, 'slotSec' | 'slug'>): string => String(t.slotSec ?? slotKey(t.slug));

/** Clé d'ordre des résolutions (date de règlement, sinon d'ouverture pour un registre ancien). */
export const settleOrderKey = (t: Pick<LedgerTrade, 'resolvedAt' | 'openedAt'>): string => t.resolvedAt ?? t.openedAt;

export function computeStats(trades: readonly LedgerTrade[]): LedgerStats {
  const resolved = trades
    .filter(isSettled)
    .sort((a, b) => settleOrderKey(a).localeCompare(settleOrderKey(b)));
  const open = trades.filter(t => t.status === 'open');
  const pnls = resolved.map(t => t.pnl as number);
  const n = resolved.length;
  const wins = pnls.filter(p => p > 0).length;
  const losses = pnls.filter(p => p < 0).length;
  const pnl = pnls.reduce((s, p) => s + p, 0);

  // t groupé par créneau : les paris sur plusieurs cryptos d'un même round de 5 min sont
  // corrélés ; les compter comme indépendants gonflerait le t (critère « Avant le réel »).
  const tStat = clusteredMeanT(resolved.map(t => ({ key: clusterKeyOf(t), x: t.pnl as number }))).t;

  let lossStreak = 0;
  for (let i = pnls.length - 1; i >= 0 && pnls[i] < 0; i--) lossStreak++;
  // Côté gagnant connu ? (won/lost : par définition ; reventes : si l'issue a été relevée)
  const calib = resolved.filter(t => sideWon(t) !== null);

  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    maxDrawdown = Math.max(maxDrawdown, peak - cum);
  }

  return {
    n,
    wins,
    losses,
    open: open.length,
    winRate: n ? wins / n : null,
    pnl,
    calibN: calib.length,
    calibWinRate: calib.length ? calib.filter(t => sideWon(t) === true).length / calib.length : null,
    avgModelProb: calib.length ? calib.reduce((s, t) => s + t.modelProb, 0) / calib.length : null,
    tStat,
    lossStreak,
    openExposure: open.reduce((s, t) => s + t.stake, 0),
    maxDrawdown,
    drawdownNow: peak - cum,
    peakPnl: peak,
  };
}

/**
 * Pertes consécutives parmi les trades réglés dans les `windowMs` dernières ms.
 * Une série de pertes met la mise à 0 ; sans fenêtre, elle ne pouvait plus jamais se
 * résorber (il faut trader pour la casser) → arrêt définitif silencieux. Avec une
 * fenêtre de 6 h, 8 pertes d'affilée valent une PAUSE de 6 h, puis reprise.
 */
export function recentLossStreak(trades: readonly LedgerTrade[], nowMs: number, windowMs: number): number {
  const recent = trades
    .filter(t => isSettled(t) && nowMs - Date.parse(settleOrderKey(t)) <= windowMs)
    .sort((a, b) => settleOrderKey(a).localeCompare(settleOrderKey(b)));
  let streak = 0;
  for (let i = recent.length - 1; i >= 0 && (recent[i].pnl as number) < 0; i--) streak++;
  return streak;
}

export interface CalendarPnl {
  today: number;
  month: number;
}

/** Début du jour et du mois CALENDAIRES (UTC) contenant `ms`. */
export function utcDayMonth(ms: number): { day: number; month: number } {
  const d = new Date(ms);
  return { day: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), month: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
}

/** PnL réalisé depuis le début du jour et du mois CALENDAIRES (UTC) — porte de risque. */
export function calendarPnl(trades: readonly LedgerTrade[], nowMs: number): CalendarPnl {
  const { day: dayStart, month: monthStart } = utcDayMonth(nowMs);
  let today = 0;
  let month = 0;
  for (const t of trades) {
    if (t.status === 'open' || typeof t.pnl !== 'number') continue;
    // Registre ancien ou édité à la main sans resolvedAt : même repli que computeStats
    // (date d'ouverture), sinon le trade compterait pour la baisse/total mais pas pour le jour/mois.
    const at = Date.parse(t.resolvedAt ?? t.openedAt ?? '');
    if (!Number.isFinite(at)) continue;
    if (at >= monthStart) month += t.pnl;
    if (at >= dayStart) today += t.pnl;
  }
  return { today, month };
}

// ---------------------------------------------------------------------------
// Résolution Gamma
// ---------------------------------------------------------------------------

export type RoundOutcome =
  | {
      resolved: true;
      upWon: boolean;
      /** Prix à battre et prix final publiés par Polymarket (`eventMetadata`), s'ils le sont.
       *  Servent à MESURER l'erreur de notre estimation du prix à battre (fv-report). */
      priceToBeat?: number;
      finalPrice?: number;
    }
  | { resolved: false; reason: string };

/** `eventMetadata` de Gamma (objet ou chaîne JSON) : prix à battre / final s'ils sont publiés. */
export function roundPrices(ev: { eventMetadata?: unknown }): { priceToBeat?: number; finalPrice?: number } {
  let meta: unknown = ev.eventMetadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { return {}; }
  }
  if (!meta || typeof meta !== 'object') return {};
  const num = (v: unknown) => {
    const x = typeof v === 'string' ? Number(v) : v;
    return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined;
  };
  const m = meta as { priceToBeat?: unknown; finalPrice?: unknown };
  const out: { priceToBeat?: number; finalPrice?: number } = {};
  const ptb = num(m.priceToBeat);
  const fin = num(m.finalPrice);
  if (ptb !== undefined) out.priceToBeat = ptb;
  if (fin !== undefined) out.finalPrice = fin;
  return out;
}

/** Interprète la réponse de `GET /events?slug=<slug>`. Pure. */
export function parseGammaEvent(data: unknown, slug: string): RoundOutcome {
  const events = Array.isArray(data) ? data : [];
  const ev = events.find(e => e && typeof e === 'object' && (e as { slug?: unknown }).slug === slug) as
    | { markets?: unknown; eventMetadata?: unknown }
    | undefined;
  if (!ev) return { resolved: false, reason: 'événement absent de la réponse (ou slug différent)' };
  const markets = Array.isArray(ev.markets) ? ev.markets : [];
  const m = markets[0] as { closed?: unknown; outcomes?: unknown; outcomePrices?: unknown } | undefined;
  if (!m) return { resolved: false, reason: 'aucun marché dans l\'événement' };
  if (m.closed !== true) return { resolved: false, reason: 'marché pas encore clôturé' };

  const parseArr = (v: unknown): unknown[] | null => {
    try {
      const a = typeof v === 'string' ? JSON.parse(v) : v;
      return Array.isArray(a) ? a : null;
    } catch {
      return null;
    }
  };
  // Libellés obligatoires : jamais de repli par position (« Up » = index 0) si illisibles.
  const outcomes = (parseArr(m.outcomes) ?? []).map(o => String(o).toLowerCase());
  const prices = (parseArr(m.outcomePrices) ?? []).map(Number);
  const upIdx = outcomes.indexOf('up');
  const downIdx = outcomes.indexOf('down');
  if (upIdx < 0 || downIdx < 0 || prices.length < 2) return { resolved: false, reason: 'outcomes/prix illisibles' };
  const up = prices[upIdx];
  const down = prices[downIdx];
  if (up >= 0.99 && down <= 0.01) return { resolved: true, upWon: true, ...roundPrices(ev) };
  if (down >= 0.99 && up <= 0.01) return { resolved: true, upWon: false, ...roundPrices(ev) };
  return { resolved: false, reason: `prix de sortie non définitifs (Up ${up}, Down ${down})` };
}

export async function fetchRoundOutcome(slug: string, timeoutMs = 5000): Promise<RoundOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { resolved: false, reason: `HTTP ${res.status}` };
    return parseGammaEvent(await res.json(), slug);
  } catch (err) {
    return { resolved: false, reason: `réseau : ${String((err as Error)?.message ?? err).slice(0, 80)}` };
  } finally {
    clearTimeout(timer);
  }
}
