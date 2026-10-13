/**
 * telegram-commands.ts — réponses aux commandes reçues sur Telegram (/status, /bilan,
 * /risque, /positions, /rapport, /backtest, /aide). Lecture seule : aucune commande ne
 * change le bot ni ses réglages.
 *
 * Fonction PURE : les données viennent de `providers` (app.ts), le texte des fonctions
 * de telegram-messages.ts — donc testable sans bot ni réseau.
 */
import type { LedgerStats } from '../services/paper-ledger.js';
import type { ShadowStats } from '../strategy/shadow-tracker.js';
import { msgHelp, msgPositions, msgRisk, msgStatus, msgSummary, type PositionLike, type StatusInfo } from '../services/telegram-messages.js';
import type { RiskLimits } from './config.js';
import type { RiskVerdict } from './risk-gate.js';

export interface CommandProviders {
  status(): StatusInfo;
  /** `stats` : juste valeur ; `late` : récolte de fin de round ; `total` : tout le registre (capital). */
  summary(): { stats: LedgerStats; capital: number; shadow?: ShadowStats; late?: LedgerStats; total?: LedgerStats };
  risk(): { verdict: RiskVerdict; limits: RiskLimits; capital: number };
  positions(): { positions: PositionLike[]; nowMs: number; timeZone?: string };
  /** Lance un calcul long (rapport du journal, backtest) en arrière-plan ; renvoie l'accusé
   *  de réception immédiat (le résultat part dans un second message). Absent = indisponible. */
  analysis?(kind: 'rapport' | 'backtest', days: number): string;
}

/** Commande (« /Status@MonBot 1 » → status, bot « MonBot », args « 1 »), null si ce n'est pas une commande. */
export function parseCommand(text: string): { cmd: string; bot: string | null; args: string } | null {
  const m = /^\/([A-Za-zÀ-ÿ_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { cmd: m[1].toLowerCase(), bot: m[2] ?? null, args: (m[3] ?? '').trim() } : null;
}

/** Jours demandés (« 7 », « 1,5 ») bornés à [min, max] ; défaut si absent ou illisible. */
export function parseDays(args: string, def: number, min: number, max: number): number {
  const x = Number(args.split(/\s+/)[0]?.replace(',', '.'));
  return Number.isFinite(x) && x > 0 ? Math.min(max, Math.max(min, x)) : def;
}

/**
 * Réponse à un message du chat configuré. Texte libre : aide dans un chat privé, silence
 * dans un groupe (ne pas répondre à chaque conversation). Une commande adressée à un AUTRE
 * bot du groupe (« /status@AutreBot ») est ignorée.
 */
export function answerCommand(text: string, p: CommandProviders, chatType: string | null = null, botUsername: string | null = null): string | null {
  const parsed = parseCommand(text);
  if (parsed === null) return chatType === 'private' ? msgHelp() : null;
  if (parsed.bot && botUsername && parsed.bot.toLowerCase() !== botUsername.toLowerCase()) return null;
  const cmd = parsed.cmd;
  switch (cmd) {
    case 'status': case 'etat': case 'état': case 'state':
      return msgStatus(p.status());
    case 'bilan': case 'summary': case 'resume': case 'résumé': {
      const s = p.summary();
      return msgSummary(s.stats, s.capital, s.shadow, s.late, s.total);
    }
    case 'risque': case 'risk': case 'risques': {
      const r = p.risk();
      return msgRisk(r.verdict, r.limits, r.capital);
    }
    case 'positions': case 'position': case 'paris': {
      const r = p.positions();
      return msgPositions(r.positions, r.nowMs, r.timeZone);
    }
    case 'rapport': case 'report': case 'edge': case 'verdict':
      return p.analysis ? p.analysis('rapport', parseDays(parsed.args, 3, 0.25, 30)) : 'Rapport indisponible sur ce bot.';
    case 'backtest': case 'historique':
      return p.analysis ? p.analysis('backtest', parseDays(parsed.args, 2, 0.25, 14)) : 'Backtest indisponible sur ce bot.';
    case 'aide': case 'help': case 'start': case 'menu':
      return msgHelp();
    default:
      return `Commande inconnue : /${cmd}\n${msgHelp()}`;
  }
}
