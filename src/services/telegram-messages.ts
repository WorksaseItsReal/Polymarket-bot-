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
import type { ShadowStats } from '../strategy/shadow-tracker.js';

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
/** « 0 trade », « 1 trade », « 2 trades » (règle française : pluriel à partir de 2). */
export function plural(n: number, word: string): string {
  return `${n} ${word}${Math.abs(n) >= 2 ? 's' : ''}`;
}

export function reliability(stats: Pick<LedgerStats, 'n' | 'tStat'>): string {
  if (stats.n < 30 || stats.tStat === null) return `trop tôt pour conclure (${plural(stats.n, 'trade')}, il en faut ≥ 200)`;
  const t = stats.tStat.toFixed(1).replace('.', ',');
  if (stats.tStat >= 2 && stats.n >= 200) return `t = ${t} → gain statistiquement significatif ✅`;
  if (stats.tStat <= -2) return `t = ${t} → perte statistiquement significative ⚠️`;
  return `t = ${t} → pas encore significatif (il faut t ≥ 2 sur ≥ 200 trades)`;
}

function balanceLine(stats: LedgerStats): string {
  const wr = stats.winRate === null ? '—' : pct(stats.winRate);
  return `${plural(stats.n, 'trade')} · ${stats.wins} ✅ / ${stats.losses} ❌ (${wr}) · PnL ${money(stats.pnl)}`;
}

export interface StartupInfo {
  capital: number;
  minEdge: number;
  minProb: number;
  feeRate: number;
  pollSec: number;
  coins: string[];
  stats: LedgerStats;
  /** Avertissement de configuration à afficher en tête (ex. capital trop petit). */
  warning?: string;
  /** Réglages de calibration (affichés seulement s'ils diffèrent du modèle brut). */
  zScale?: number;
  blendModel?: number;
  blendMarket?: number;
  /** FV_NOISE_EDGE_K : marge en plus de minEdge selon l'incertitude du prix à battre. */
  noiseK?: number;
  /** Relance après un arrêt anormal (sur erreur, ou brutal : kill -9, mémoire saturée). */
  restart?: { brutal: boolean; recentCrashes: number };
}

function restartLine(r: NonNullable<StartupInfo['restart']>): string {
  const n = r.recentCrashes > 1 ? ` — ${r.recentCrashes} arrêts anormaux dans la dernière heure` : '';
  return r.brutal
    ? `↻ Relancé après un arrêt brutal non journalisé (mémoire saturée, kill -9 ou coupure ?)${n}`
    : `↻ Relancé après un arrêt sur erreur${n}`;
}

function tuningLine(i: StartupInfo): string | null {
  const parts: string[] = [];
  const f = (x: number) => String(x).replace('.', ',');
  if (i.zScale !== undefined && i.zScale !== 1) parts.push(`confiance du modèle ×${f(i.zScale)}`);
  if ((i.blendModel ?? 1) !== 1 || (i.blendMarket ?? 0) !== 0) {
    parts.push(`mélange modèle ${f(i.blendModel ?? 1)} / carnet ${f(i.blendMarket ?? 0)}`);
  }
  return parts.length ? `Calibration : ${parts.join(' · ')}` : null;
}

export function msgStartup(i: StartupInfo): string {
  return [
    // Le bot est papier uniquement (DRY_RUN=false est refusé au démarrage) : pas de variante RÉEL.
    '🤖 <b>Bot Polymarket démarré</b> — mode PAPIER (aucun ordre réel)',
    ...(i.restart ? [restartLine(i.restart)] : []),
    `Marchés : « Up or Down » 5 min · ${escapeHtml(i.coins.join(', '))}`,
    `Règle : pari seulement si la probabilité calculée ≥ ${pct(i.minProb)} ET dépasse le prix payé (frais inclus) d'au moins ${(i.minEdge * 100).toFixed(0)} pts`
      + (i.noiseK ? ', plus une marge quand le prix à battre (estimé) laisse un doute' : ''),
    `Capital papier : ${amount(i.capital)} · vérification toutes les ${i.pollSec} s`,
    ...(tuningLine(i) ? [tuningLine(i) as string] : []),
    i.stats.n || i.stats.open ? `Historique : ${balanceLine(i.stats)}` : 'Historique : aucun trade pour l\'instant',
    ...(i.warning ? [`⚠️ ${escapeHtml(i.warning)}`] : []),
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

/** « Le modèle bat-il le carnet ? » en une ligne honnête. */
export function shadowLine(sh: ShadowStats): string {
  if (sh.n < 50 || sh.brierModel === null || sh.brierMarket === null) {
    return `Modèle vs carnet : trop tôt (${sh.n} rounds observés, il en faut ≥ 50)`;
  }
  const b = (x: number) => x.toFixed(4).replace('.', ',');
  const t = sh.tDiff === null ? '' : `, t = ${sh.tDiff.toFixed(1).replace('.', ',')}`;
  const verdict = sh.tDiff !== null && sh.tDiff <= -2
    ? 'le modèle prédit MIEUX que le carnet ✅'
    : sh.tDiff !== null && sh.tDiff >= 2
      ? 'le carnet prédit mieux que le modèle ❌ (pas d\'edge)'
      : 'pas de différence significative';
  return `Modèle vs carnet (${sh.n} rounds) : erreur ${b(sh.brierModel)} vs ${b(sh.brierMarket)}${t} → ${verdict}`;
}

/**
 * Les critères (README) à remplir AVANT d'envisager de l'argent réel, en une ligne :
 * ⏳ = pas assez de données, ✅ = rempli, ❌ = mesuré et non rempli.
 */
export function goLiveLine(stats: LedgerStats, shadow?: ShadowStats): string {
  const crit: Array<{ label: string; state: '✅' | '❌' | '⏳'; detail: string }> = [];
  const sh = shadow?.n ?? 0;
  crit.push(sh < 500 || shadow?.tDiff == null
    ? { label: 'modèle > carnet', state: '⏳', detail: `${sh}/500 rounds` }
    : { label: 'modèle > carnet', state: shadow.tDiff <= -2 ? '✅' : '❌', detail: `t ${shadow.tDiff.toFixed(2).replace('.', ',')}` });
  crit.push(stats.n < 200 || stats.tStat === null
    ? { label: 'gain significatif', state: '⏳', detail: `${stats.n}/200 trades` }
    : { label: 'gain significatif', state: stats.tStat >= 2 ? '✅' : '❌', detail: `t ${stats.tStat.toFixed(2).replace('.', ',')}` });
  if (stats.calibN < 100 || stats.calibWinRate === null || stats.avgModelProb === null) {
    crit.push({ label: 'calibration', state: '⏳', detail: `${stats.calibN}/100 trades` });
  } else {
    // Réussite réelle pas significativement sous la probabilité annoncée (2 écarts-types).
    const p = stats.avgModelProb;
    const ok = stats.calibWinRate >= p - 2 * Math.sqrt((p * (1 - p)) / stats.calibN);
    crit.push({ label: 'calibration', state: ok ? '✅' : '❌', detail: `${pct(stats.calibWinRate)} pour ${pct(p)} annoncés` });
  }
  const all = crit.every(c => c.state === '✅');
  const failed = crit.some(c => c.state === '❌');
  return `Avant le réel : ${crit.map(c => `${c.label} ${c.state} (${c.detail})`).join(' · ')} → `
    + (all ? 'critères remplis : décision à prendre (vérifier le rapport sur les deux moitiés, et un capital réel permettant des mises ≥ 5 $)'
      : failed ? 'rester en papier ❌' : 'rester en papier, mesure en cours');
}

export function msgSummary(stats: LedgerStats, capital: number, shadow?: ShadowStats): string {
  const expected = stats.avgModelProb === null || stats.calibWinRate === null
    ? ''
    : ` · côté choisi gagnant à l'issue du round : ${pct(stats.calibWinRate)} pour ${pct(stats.avgModelProb)} annoncés par le modèle`;
  return [
    '📊 <b>BILAN</b> — stratégie juste valeur (papier)',
    `Trades terminés : ${stats.n} (${stats.wins} ✅ / ${stats.losses} ❌) · en cours : ${stats.open}`,
    `Taux de réussite : ${stats.winRate === null ? '—' : pct(stats.winRate)}${expected}`,
    `PnL : <b>${money(stats.pnl)}</b> · capital : ${amount(capital + stats.pnl)} · pire baisse : ${money(-stats.maxDrawdown)}`,
    `Fiabilité : ${reliability(stats)}`,
    ...(shadow ? [shadowLine(shadow)] : []),
    goLiveLine(stats, shadow),
  ].join('\n');
}

export function msgAlert(text: string): string {
  return `⚠️ <b>ALERTE</b> — ${escapeHtml(text)}`;
}
