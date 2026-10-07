/**
 * paper-ledger.ts — registre des trades paper de la stratégie juste valeur, et
 * résolution des rounds « Up/Down 5 min » via l'API Gamma.
 *
 * Pourquoi un registre propre : le PnL réalisé était calculé par des scripts externes
 * (paperbot-pnl.py, hors dépôt) ; le bot ne pouvait donc ni connaître ses propres
 * résultats, ni annoncer clairement un gain/une perte sur Telegram. Ce registre est la
 * source de vérité de la stratégie : un trade y entre à l'ouverture, en sort résolu
 * (gagné / perdu / revendu), et toutes les statistiques en dérivent.
 *
 * Résolution (chemin vérifié, cf. docs/backtest/resolve.py) :
 *   GET https://gamma-api.polymarket.com/events?slug=<coin>-updown-5m-<slot>
 *   → la réponse doit porter EXACTEMENT le slug demandé (le filtre `markets?condition_id=`
 *     est ignoré par l'API et renvoyait un autre marché) ;
 *   → marché `closed` ET prix de sortie ≥ 0,99 d'un côté. Un marché ouvert affiche des
 *     `outcomePrices` provisoires (ex. 0,5/0,5) : ce n'est PAS un résultat.
 *
 * Écriture atomique (fichier temporaire + rename) ; fichier illisible → jamais écrasé.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type LedgerSide = 'UP' | 'DOWN';
export type LedgerStatus = 'open' | 'won' | 'lost' | 'sold';

export interface LedgerTrade {
  /** conditionId du marché (un seul trade par round). */
  id: string;
  slug: string;
  coin: string;
  side: LedgerSide;
  /** Mise totale, frais inclus (€/$). */
  stake: number;
  /** Coût réel par part (VWAP + frais). */
  costPerShare: number;
  shares: number;
  /** Probabilité du modèle pour le côté acheté, à l'entrée. */
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
  slotSec?: number;
}

export interface LedgerFile {
  version: 1;
  trades: LedgerTrade[];
}

// ---------------------------------------------------------------------------
// Fichier
// ---------------------------------------------------------------------------

/** [] si absent ; null si présent mais illisible (l'appelant ne doit alors rien écrire). */
export function loadLedger(path: string): LedgerTrade[] | null {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LedgerFile>;
    return Array.isArray(data?.trades) ? data.trades : null;
  } catch {
    return null;
  }
}

export function saveLedger(path: string, trades: LedgerTrade[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body: LedgerFile = { version: 1, trades };
  writeFileSync(tmp, JSON.stringify(body, null, 2));
  renameSync(tmp, path);
}

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
  /** Probabilité modèle moyenne des trades résolus = win rate attendu si calibré. */
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

export function computeStats(trades: LedgerTrade[]): LedgerStats {
  const resolved = trades
    .filter(t => t.status !== 'open' && typeof t.pnl === 'number' && Number.isFinite(t.pnl))
    .sort((a, b) => (a.resolvedAt ?? a.openedAt).localeCompare(b.resolvedAt ?? b.openedAt));
  const open = trades.filter(t => t.status === 'open');
  const pnls = resolved.map(t => t.pnl as number);
  const n = resolved.length;
  const wins = pnls.filter(p => p > 0).length;
  const losses = pnls.filter(p => p < 0).length;
  const pnl = pnls.reduce((s, p) => s + p, 0);

  let tStat: number | null = null;
  if (n >= 2) {
    const mean = pnl / n;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / (n - 1);
    if (variance > 0) tStat = mean / Math.sqrt(variance / n);
  }

  let lossStreak = 0;
  for (let i = pnls.length - 1; i >= 0 && pnls[i] < 0; i--) lossStreak++;

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
    avgModelProb: n ? resolved.reduce((s, t) => s + t.modelProb, 0) / n : null,
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
export function recentLossStreak(trades: LedgerTrade[], nowMs: number, windowMs: number): number {
  const recent = trades
    .filter(t => t.status !== 'open' && typeof t.pnl === 'number' && Number.isFinite(t.pnl)
      && nowMs - Date.parse(t.resolvedAt ?? t.openedAt) <= windowMs)
    .sort((a, b) => (a.resolvedAt ?? a.openedAt).localeCompare(b.resolvedAt ?? b.openedAt));
  let streak = 0;
  for (let i = recent.length - 1; i >= 0 && (recent[i].pnl as number) < 0; i--) streak++;
  return streak;
}

// ---------------------------------------------------------------------------
// Résolution Gamma
// ---------------------------------------------------------------------------

export type RoundOutcome = { resolved: true; upWon: boolean } | { resolved: false; reason: string };

/** Interprète la réponse de `GET /events?slug=<slug>`. Pure. */
export function parseGammaEvent(data: unknown, slug: string): RoundOutcome {
  const events = Array.isArray(data) ? data : [];
  const ev = events.find(e => e && typeof e === 'object' && (e as { slug?: unknown }).slug === slug) as
    | { markets?: unknown }
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
  const outcomes = (parseArr(m.outcomes) ?? ['Up', 'Down']).map(o => String(o).toLowerCase());
  const prices = (parseArr(m.outcomePrices) ?? []).map(Number);
  const upIdx = outcomes.indexOf('up');
  const downIdx = outcomes.indexOf('down');
  if (upIdx < 0 || downIdx < 0 || prices.length < 2) return { resolved: false, reason: 'outcomes/prix illisibles' };
  const up = prices[upIdx];
  const down = prices[downIdx];
  if (up >= 0.99 && down <= 0.01) return { resolved: true, upWon: true };
  if (down >= 0.99 && up <= 0.01) return { resolved: true, upWon: false };
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
