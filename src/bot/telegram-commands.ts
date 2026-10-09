/**
 * telegram-commands.ts — réponses aux commandes reçues sur Telegram (/status, /bilan,
 * /risque, /positions, /aide). Lecture seule : aucune commande ne change le bot.
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
  summary(): { stats: LedgerStats; capital: number; shadow?: ShadowStats };
  risk(): { verdict: RiskVerdict; limits: RiskLimits; capital: number };
  positions(): { positions: PositionLike[]; nowMs: number; timeZone?: string };
}

/** Nom de commande (« /status@MonBot 1 » → « status »), null si ce n'est pas une commande. */
export function parseCommand(text: string): string | null {
  const m = /^\/([A-Za-zÀ-ÿ_]+)(?:@\w+)?(?:\s|$)/.exec(text.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Réponse à un message du chat configuré. Texte libre : aide dans un chat privé, silence
 * dans un groupe (ne pas répondre à chaque conversation).
 */
export function answerCommand(text: string, p: CommandProviders, chatType: string | null = null): string | null {
  const cmd = parseCommand(text);
  if (cmd === null) return chatType === 'private' ? msgHelp() : null;
  switch (cmd) {
    case 'status': case 'etat': case 'état': case 'state':
      return msgStatus(p.status());
    case 'bilan': case 'summary': case 'resume': case 'résumé': {
      const s = p.summary();
      return msgSummary(s.stats, s.capital, s.shadow);
    }
    case 'risque': case 'risk': case 'risques': {
      const r = p.risk();
      return msgRisk(r.verdict, r.limits, r.capital);
    }
    case 'positions': case 'position': case 'paris': {
      const r = p.positions();
      return msgPositions(r.positions, r.nowMs, r.timeZone);
    }
    case 'aide': case 'help': case 'start': case 'menu':
      return msgHelp();
    default:
      return `Commande inconnue : /${cmd}\n${msgHelp()}`;
  }
}
