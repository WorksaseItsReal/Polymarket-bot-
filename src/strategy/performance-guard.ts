/**
 * performance-guard.ts — arrêt automatique sur performance RÉELLE mauvaise.
 *
 * Les garde-fous existants protègent contre une mauvaise série (série de pertes,
 * drawdown, limites jour/mois). Ils ne disent pas si la stratégie est STRUCTURELLEMENT
 * perdante. Ce module le fait, avec les seuils de docs/rebuild/monitoring/MONITORING.md :
 *
 *   STOP  : n ≥ 50 trades réglés ET t-stat du PnL ≤ −2 → la perte n'est plus du hasard.
 *           Les entrées sont bloquées (l'observation et le journal continuent) jusqu'à
 *           une remise à zéro MANUELLE (suppression du fichier d'état).
 *   ALERTE: n ≥ 30 ET win rate réel < probabilité annoncée − 2 erreurs-types → le modèle
 *           est sur-confiant (il surestime ses chances) : à corriger avant de miser plus.
 *
 * Logique pure + persistance minimale du STOP (survit à un redémarrage).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { LedgerStats } from '../services/paper-ledger.js';

export interface GuardVerdict {
  stop: string | null;
  warn: string | null;
}

export interface GuardOptions {
  minTradesStop?: number;
  tStop?: number;
  minTradesCalibration?: number;
}

export function evaluateGuard(stats: LedgerStats, o: GuardOptions = {}): GuardVerdict {
  const minStop = o.minTradesStop ?? 50;
  const tStop = o.tStop ?? -2;
  const minCal = o.minTradesCalibration ?? 30;
  let stop: string | null = null;
  let warn: string | null = null;
  if (stats.n >= minStop && stats.tStat !== null && stats.tStat <= tStop) {
    stop = `perte statistiquement significative : t = ${stats.tStat.toFixed(2)} sur ${stats.n} trades (PnL ${stats.pnl.toFixed(2)} $)`;
  }
  // Calibration : le côté choisi a-t-il gagné le ROUND (revente ou non) aussi souvent
  // que le modèle l'annonçait ?
  if (stats.calibN >= minCal && stats.calibWinRate !== null && stats.avgModelProb !== null) {
    const p = stats.avgModelProb;
    const se = Math.sqrt((p * (1 - p)) / stats.calibN);
    if (stats.calibWinRate < p - 2 * se) {
      warn = `modèle sur-confiant : le côté choisi gagne ${(stats.calibWinRate * 100).toFixed(1)} % des rounds pour ${(p * 100).toFixed(1)} % annoncés (${stats.calibN} rounds)`;
    }
  }
  return { stop, warn };
}

interface GuardFile {
  stoppedAt: string;
  reason: string;
}

/** STOP persistant : lu au démarrage, écrit au déclenchement, levé en supprimant le fichier. */
export class PersistentGuard {
  constructor(private readonly path: string) {}

  /** Raison du STOP en vigueur, ou null. Un fichier illisible compte comme un STOP (prudence). */
  current(): string | null {
    if (!existsSync(this.path)) return null;
    try {
      const f = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<GuardFile>;
      return `${f.reason ?? 'arrêt de sécurité'} (depuis ${f.stoppedAt ?? '?'})`;
    } catch {
      return `fichier ${this.path} illisible — arrêt de sécurité maintenu`;
    }
  }

  trip(reason: string, nowMs: number): void {
    const body: GuardFile = { stoppedAt: new Date(nowMs).toISOString(), reason };
    writeFileSync(this.path, JSON.stringify(body, null, 2));
  }
}
