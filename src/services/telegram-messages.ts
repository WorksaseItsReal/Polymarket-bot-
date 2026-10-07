/**
 * telegram-messages.ts — textes des notifications Telegram (HTML Telegram), en français.
 *
 * Principes : une information par ligne, des mots simples (HAUSSE / BAISSE, gagné /
 * perdu), les montants avec leur signe, l'heure du round lisible, et JAMAIS un PnL sans
 * son nombre de trades ni sa fiabilité statistique (un PnL positif sur 15 trades est du
 * bruit, le message le dit).
 *
 * Fonctions PURES (aucune I/O, l'heure et le fuseau sont passés en paramètre).
 */

import type { LedgerStats } from './paper-ledger.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** +0,42 $ / −1,00 $ (signe toujours affiché, virgule décimale). */
export function money(x: number, digits = 2): string {
  const sign = x > 0 ? '+' : x < 0 ? '−' : '';
  return `${sign}${Math.abs(x).toFixed(digits).replace('.', ',')} $`;
}

/** Montant sans signe forcé (mise, capital). */
export function amount(x: number, digits = 2): string {
  return `${x.toFixed(digits).replace('.', ',')} $`;
}

export function pct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits).replace('.', ',')} %`;
}

/** Prix d'un sous-jacent : plus de décimales pour les petits prix (DOGE, XRP). */
export function spotPrice(x: number): string {
  const digits = x >= 1000 ? 2 : x >= 10 ? 3 : x >= 1 ? 4 : 5;
  const [int, dec] = x.toFixed(digits).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${dec} $`;
}

/** Fuseau valide ? (un fuseau inconnu fait lever Intl.DateTimeFormat). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** « 14:05 → 14:10 » dans le fuseau demandé (défaut Europe/Paris ; UTC si fuseau invalide). */
export function roundWindow(slotSec: number, timeZone = 'Europe/Paris'): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const f = (ms: number) =>
    new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(ms));
  return `${f(slotSec * 1000)} → ${f(slotSec * 1000 + 300_000)}${tz === timeZone ? '' : ' UTC'}`;
}

export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}

const SIDE_LABEL: Record<'UP' | 'DOWN', string> = { UP: '⬆️ HAUSSE', DOWN: '⬇️ BAISSE' };

/** Verdict statistique honnête du PnL. */
export function reliability(stats: Pick<LedgerStats, 'n' | 'tStat'>): string {
  if (stats.n < 30 || stats.tStat === null) return `trop tôt pour conclure (${stats.n} trades, il en faut ≥ 200)`;
  const t = stats.tStat.toFixed(1).replace('.', ',');
  if (stats.tStat >= 2 && stats.n >= 200) return `t = ${t} → gain statistiquement significatif ✅`;
  if (stats.tStat <= -2) return `t = ${t} → perte statistiquement significative ⚠️`;
  return `t = ${t} → pas encore significatif (il faut t ≥ 2 sur ≥ 200 trades)`;
}

function balanceLine(stats: LedgerStats): string {
  const wr = stats.winRate === null ? '—' : pct(stats.winRate);
  return `${stats.n} trades · ${stats.wins} ✅ / ${stats.losses} ❌ (${wr}) · PnL ${money(stats.pnl)}`;
}

export interface StartupInfo {
  capital: number;
  minEdge: number;
  minProb: number;
  feeRate: number;
  pollSec: number;
  coins: string[];
  stats: LedgerStats;
}

export function msgStartup(i: StartupInfo): string {
  return [
    '🤖 <b>Bot Polymarket démarré</b> — mode PAPIER (aucun ordre réel)',
    `Marchés : « Up or Down » 5 min · ${escapeHtml(i.coins.join(', '))}`,
    `Règle : pari seulement si la probabilité calculée ≥ ${pct(i.minProb)} ET dépasse le prix payé (frais inclus) d'au moins ${(i.minEdge * 100).toFixed(0)} pts`,
    `Capital papier : ${amount(i.capital)} · vérification toutes les ${i.pollSec} s`,
    i.stats.n || i.stats.open ? `Historique : ${balanceLine(i.stats)}` : 'Historique : aucun trade pour l\'instant',
  ].join('\n');
}

export interface TradeOpenedInfo {
  coin: string;
  side: 'UP' | 'DOWN';
  slotSec: number;
  tauSec: number;
  strike: number;
  spot: number;
  modelProb: number;
  costPerShare: number;
  edge: number;
  stake: number;
  winProfit: number;
  timeZone?: string;
}

export function msgTradeOpened(i: TradeOpenedInfo): string {
  const move = (i.spot / i.strike - 1) * 100;
  return [
    `🎯 <b>NOUVEAU PARI — ${escapeHtml(i.coin)} ${SIDE_LABEL[i.side]}</b>`,
    `Round ${roundWindow(i.slotSec, i.timeZone)} · fin dans ${duration(i.tauSec)}`,
    `Prix à battre : ${spotPrice(i.strike)} · actuel : ${spotPrice(i.spot)} (${move >= 0 ? '+' : '−'}${Math.abs(move).toFixed(3).replace('.', ',')} %)`,
    `Chance de gagner (modèle) : <b>${pct(i.modelProb)}</b> · prix payé : ${i.costPerShare.toFixed(3).replace('.', ',')} $ par part (frais inclus)`,
    `Avantage : +${(i.edge * 100).toFixed(1).replace('.', ',')} pts · mise : ${amount(i.stake)}`,
    `Si gagné : <b>${money(i.winProfit)}</b> · si perdu : <b>${money(-i.stake)}</b>`,
  ].join('\n');
}

export interface TradeClosedInfo {
  coin: string;
  side: 'UP' | 'DOWN';
  slotSec: number;
  outcome: 'won' | 'lost' | 'sold';
  pnl: number;
  stats: LedgerStats;
  timeZone?: string;
}

export function msgTradeClosed(i: TradeClosedInfo): string {
  const head = i.outcome === 'won' ? '✅ <b>GAGNÉ</b>' : i.outcome === 'lost' ? '❌ <b>PERDU</b>' : '💱 <b>REVENDU avant la fin</b>';
  return [
    `${head} — ${escapeHtml(i.coin)} ${SIDE_LABEL[i.side]} · <b>${money(i.pnl)}</b>`,
    `Round ${roundWindow(i.slotSec, i.timeZone)}`,
    `Bilan : ${balanceLine(i.stats)}`,
  ].join('\n');
}

export function msgSummary(stats: LedgerStats, capital: number): string {
  const expected = stats.avgModelProb === null ? '' : ` (attendu par le modèle : ${pct(stats.avgModelProb)})`;
  return [
    '📊 <b>BILAN</b> — stratégie juste valeur (papier)',
    `Trades terminés : ${stats.n} (${stats.wins} ✅ / ${stats.losses} ❌) · en cours : ${stats.open}`,
    `Taux de réussite : ${stats.winRate === null ? '—' : pct(stats.winRate)}${expected}`,
    `PnL : <b>${money(stats.pnl)}</b> · capital : ${amount(capital + stats.pnl)} · pire baisse : ${money(-stats.maxDrawdown)}`,
    `Fiabilité : ${reliability(stats)}`,
  ].join('\n');
}

export function msgAlert(text: string): string {
  return `⚠️ <b>ALERTE</b> — ${escapeHtml(text)}`;
}
