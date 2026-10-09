/**
 * Porte de risque du bot — quatre couches de perte, calculées à chaque passage depuis le
 * registre papier (source de vérité), jamais depuis un compteur en mémoire.
 *
 *   1. perte du jour (UTC)        → plus d'entrée jusqu'à minuit UTC ;
 *   2. perte du mois (UTC)        → plus d'entrée jusqu'au 1er du mois suivant ;
 *   3. baisse depuis le plus haut → plus d'entrée jusqu'à décision manuelle (le plus haut
 *      ne s'efface pas : arrêter le bot, archiver le registre réglé, redémarrer) ;
 *   4. perte totale               → arrêt définitif des entrées.
 *
 * Recalculé depuis le registre = insensible à un redémarrage et impossible à contourner par
 * un compteur mal alimenté (avant : des limites inertes parce que le PnL papier ne passait
 * jamais par le compteur qu'elles lisaient). Les positions ouvertes continuent d'être
 * suivies, réglées et revendues : la porte ne bloque que les NOUVELLES entrées.
 *
 * Module PUR : aucune I/O, aucune horloge implicite.
 */
import type { LedgerStats, LedgerTrade } from '../services/paper-ledger.js';
import type { RiskLimits } from './config.js';

export type RiskLayer = 'daily' | 'monthly' | 'drawdown' | 'total';

export interface RiskVerdict {
  allowed: boolean;
  layer: RiskLayer | null;
  /** Raison lisible (FR), chiffres inclus ; null si autorisé. */
  reason: string | null;
  /** Fin du blocage (ms), null si manuel ou définitif. */
  until: number | null;
  /** Capital courant, plus haut et baisse (fraction) — pour l'affichage. */
  currentCapital: number;
  peakCapital: number;
  drawdown: number;
  pnlToday: number;
  pnlMonth: number;
}

/** PnL réalisé depuis le début du jour et du mois CALENDAIRES (UTC). */
export function calendarPnl(trades: readonly LedgerTrade[], nowMs: number): { today: number; month: number } {
  const d = new Date(nowMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  let today = 0;
  let month = 0;
  for (const t of trades) {
    if (t.status === 'open' || typeof t.pnl !== 'number') continue;
    const at = Date.parse(t.resolvedAt ?? '');
    if (!Number.isFinite(at)) continue;
    if (at >= monthStart) month += t.pnl;
    if (at >= dayStart) today += t.pnl;
  }
  return { today, month };
}

export function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function nextUtcMonthStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const usd = (x: number) => `${x.toFixed(2)} $`;

/**
 * Verdict de la porte. `stats` : statistiques du registre (PnL cumulé, plus haut du PnL
 * cumulé) ; `trades` : pour les fenêtres calendaires. Couches testées de la plus durable
 * (perte totale) à la plus courte (jour), pour que la raison affichée soit la plus grave.
 */
export function evaluateRisk(
  capital: number,
  stats: Pick<LedgerStats, 'pnl' | 'peakPnl'>,
  trades: readonly LedgerTrade[],
  limits: RiskLimits,
  nowMs: number,
): RiskVerdict {
  const { today, month } = calendarPnl(trades, nowMs);
  const currentCapital = capital + stats.pnl;
  const peakCapital = capital + Math.max(0, stats.peakPnl, stats.pnl);
  const drawdown = peakCapital > 0 ? Math.max(0, (peakCapital - currentCapital) / peakCapital) : 0;
  const base = { currentCapital, peakCapital, drawdown, pnlToday: today, pnlMonth: month };
  const block = (layer: RiskLayer, reason: string, until: number | null): RiskVerdict =>
    ({ allowed: false, layer, reason, until, ...base });

  const totalLimit = capital * limits.totalMaxLossPct;
  if (stats.pnl <= -totalLimit) {
    return block('total', `perte totale ${usd(-stats.pnl)} ≥ limite ${usd(totalLimit)} (${(limits.totalMaxLossPct * 100).toFixed(0)} % du capital) : entrées ARRÊTÉES définitivement`, null);
  }
  if (drawdown >= limits.maxDrawdownFromPeak) {
    return block('drawdown', `baisse de ${(drawdown * 100).toFixed(1)} % depuis le plus haut (${usd(peakCapital)}) ≥ ${(limits.maxDrawdownFromPeak * 100).toFixed(0)} % : entrées bloquées jusqu'à décision manuelle`, null);
  }
  const monthLimit = capital * limits.monthlyMaxLossPct;
  if (month <= -monthLimit) {
    return block('monthly', `perte du mois ${usd(-month)} ≥ limite ${usd(monthLimit)} : plus d'entrée jusqu'au 1er du mois prochain (UTC)`, nextUtcMonthStart(nowMs));
  }
  const dayLimit = capital * limits.dailyMaxLossPct;
  if (today <= -dayLimit) {
    return block('daily', `perte du jour ${usd(-today)} ≥ limite ${usd(dayLimit)} : plus d'entrée jusqu'à minuit UTC`, nextUtcMidnight(nowMs));
  }
  return { allowed: true, layer: null, reason: null, until: null, ...base };
}
