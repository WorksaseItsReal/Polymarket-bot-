/**
 * llm-state.ts — état on/off/pause de la stratégie llm, PERSISTÉ (papier uniquement).
 *
 *   - /llm on, /llm off : `setEnabled`. « on » efface aussi la pause et les compteurs.
 *   - Limite d'usage ou authentification : pause IMMÉDIATE (60 min, doublée à chaque
 *     récidive sans succès entre-temps, plafond 6 h) — insister ne ferait que brûler du quota.
 *   - Fil-piège d'isolation (un outil est apparu) : pause immédiate de 6 h.
 *   - Autres échecs de la couche processus ou du schéma : compteur ; au 3e consécutif,
 *     pause de 30 min, doublée à chaque nouvelle pause, plafond 6 h.
 *   - Les abstentions « normales » (veto, abstention d'un agent, budget, fenêtre, etc.) ne
 *     sont PAS des échecs : elles ne touchent pas aux compteurs.
 *   - Un succès remet le compteur d'échecs et le niveau de doublement à zéro.
 *   - Reprise automatique dès que now ≥ pausedUntil : `canRun` le signale UNE fois
 *     (événement « reprise » pour l'alerte Telegram).
 *
 * Fail-closed : fichier d'état illisible → la stratégie ne tourne pas (code 'desactive' avec
 * le détail) ; seul un /llm on ou /llm off explicite le remplace (l'ancien est mis de côté).
 */

import { readFileSync, renameSync } from 'node:fs';
import { writeFileAtomic } from './budget.js';
import type { AbstentionCode } from './types.js';

const MIN_MS = 60_000;

export interface LlmStateConfig {
  /** Échecs consécutifs avant la pause. */
  failureThreshold: number;
  /** Première pause après `failureThreshold` échecs (doublée ensuite). */
  failurePauseMs: number;
  /** Première pause sur limite d'usage ou authentification (doublée ensuite). */
  quotaPauseMs: number;
  /** Pause sur fil-piège d'isolation. */
  isolationPauseMs: number;
  /** Plafond de toute pause. */
  maxPauseMs: number;
  /** État si aucun fichier n'existe encore (défaut : désactivé, activation explicite). */
  initialEnabled: boolean;
}

export const DEFAULT_LLM_STATE_CONFIG: LlmStateConfig = {
  failureThreshold: 3,
  failurePauseMs: 30 * MIN_MS,
  quotaPauseMs: 60 * MIN_MS,
  isolationPauseMs: 6 * 60 * MIN_MS,
  maxPauseMs: 6 * 60 * MIN_MS,
  initialEnabled: false,
};

/** Pause immédiate : il faut une action humaine ou du temps (quota, jeton). */
const QUOTA_CODES: ReadonlySet<AbstentionCode> = new Set<AbstentionCode>(['limite_usage', 'authentification']);

/** Échecs techniques comptés (couche processus + schéma). */
export const COUNTED_FAILURE_CODES: ReadonlySet<AbstentionCode> = new Set<AbstentionCode>([
  'timeout', 'apres_echeance', 'code_sortie', 'signal', 'sortie_trop_grande', 'flux_invalide',
  'resultat_absent', 'resultat_erreur', 'lancement_impossible',
  'json_invalide', 'champ_manquant', 'champ_inattendu', 'valeur_invalide', 'incoherence',
]);

export interface PauseEvent {
  pausedUntil: number;
  reason: string;
  code: AbstentionCode;
  durationMs: number;
}

export type CanRunVerdict =
  | { ok: true; resumed?: { pausedUntil: number; reason: string | null } }
  | { ok: false; code: 'desactive' | 'pause'; until?: number; detail: string };

interface StateFile {
  version: 1;
  enabled: boolean;
  pausedUntil: number | null;
  pauseReason: string | null;
  consecutiveFailures: number;
  backoffLevel: number;
}

export interface LlmStateSnapshot extends Omit<StateFile, 'version'> {
  /** Fichier illisible au chargement, ou dernière écriture ratée ; null sinon. */
  error: string | null;
}

function fmtDuration(ms: number): string {
  const min = Math.round(ms / MIN_MS);
  return min >= 60 && min % 60 === 0 ? `${min / 60} h` : `${min} min`;
}

export class LlmState {
  private readonly cfg: LlmStateConfig;
  private s: StateFile;
  /** Fichier illisible au démarrage : on refuse de tourner tant qu'un humain n'a pas tranché. */
  private loadError: string | null = null;
  private writeError: string | null = null;

  constructor(private readonly path: string, cfg: Partial<LlmStateConfig> = {}) {
    this.cfg = { ...DEFAULT_LLM_STATE_CONFIG, ...cfg };
    this.s = this.fresh(this.cfg.initialEnabled);
    let text: string | null = null;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.loadError = `fichier d'état ${path} illisible (${(e as NodeJS.ErrnoException).code ?? 'erreur'})`;
      }
    }
    if (text !== null) {
      try {
        const f = JSON.parse(text) as Partial<StateFile>;
        const okNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
        if (!f || f.version !== 1 || typeof f.enabled !== 'boolean'
          || !(f.pausedUntil === null || okNum(f.pausedUntil))
          || !(f.pauseReason === null || typeof f.pauseReason === 'string')
          || !okNum(f.consecutiveFailures) || !okNum(f.backoffLevel)) throw new Error('format');
        this.s = {
          version: 1, enabled: f.enabled, pausedUntil: f.pausedUntil ?? null, pauseReason: f.pauseReason ?? null,
          consecutiveFailures: f.consecutiveFailures as number, backoffLevel: f.backoffLevel as number,
        };
      } catch {
        this.loadError = `fichier d'état ${path} illisible (JSON invalide ou format inattendu)`;
      }
    }
  }

  private fresh(enabled: boolean): StateFile {
    return { version: 1, enabled, pausedUntil: null, pauseReason: null, consecutiveFailures: 0, backoffLevel: 0 };
  }

  private persist(): void {
    if (this.loadError) return; // ne jamais écraser un fichier illisible sans décision humaine
    try {
      writeFileAtomic(this.path, JSON.stringify(this.s));
      this.writeError = null;
    } catch (e) {
      this.writeError = `écriture de ${this.path} impossible (${(e as NodeJS.ErrnoException).code ?? 'erreur'})`;
    }
  }

  /** Peut-on lancer une décision maintenant ? Reprise automatique à l'échéance de la pause. */
  canRun(nowMs: number): CanRunVerdict {
    if (this.loadError) return { ok: false, code: 'desactive', detail: `${this.loadError} — /llm on ou /llm off pour repartir d'un état propre` };
    if (!this.s.enabled) return { ok: false, code: 'desactive', detail: 'stratégie llm désactivée (/llm on pour l\'activer)' };
    if (this.s.pausedUntil !== null) {
      if (nowMs < this.s.pausedUntil) {
        return { ok: false, code: 'pause', until: this.s.pausedUntil, detail: `en pause jusqu'à ${new Date(this.s.pausedUntil).toISOString()} : ${this.s.pauseReason ?? '?'}` };
      }
      const resumed = { pausedUntil: this.s.pausedUntil, reason: this.s.pauseReason };
      this.s.pausedUntil = null;
      this.s.pauseReason = null;
      this.persist();
      return { ok: true, resumed };
    }
    return { ok: true };
  }

  /** Décision menée à bien (quelle qu'en soit l'issue : pari ou abstention « normale »). */
  recordSuccess(): void {
    if (this.s.consecutiveFailures === 0 && this.s.backoffLevel === 0) return;
    this.s.consecutiveFailures = 0;
    this.s.backoffLevel = 0;
    this.persist();
  }

  /**
   * Note une issue en échec. Renvoie l'événement de pause (pour l'alerte) si une pause
   * commence, sinon null (échec compté sous le seuil, ou abstention « normale »).
   */
  recordFailure(code: AbstentionCode, nowMs: number): PauseEvent | null {
    if (code === 'isolation') {
      return this.pause(code, nowMs, this.cfg.isolationPauseMs, 'fil-piège d\'isolation déclenché (outil ou serveur MCP inattendu)');
    }
    if (QUOTA_CODES.has(code)) {
      const what = code === 'limite_usage' ? 'limite d\'usage du compte atteinte' : 'échec d\'authentification du CLI (jeton ?)';
      return this.pause(code, nowMs, this.backoff(this.cfg.quotaPauseMs), what);
    }
    if (!COUNTED_FAILURE_CODES.has(code)) return null;
    this.s.consecutiveFailures += 1;
    if (this.s.consecutiveFailures < this.cfg.failureThreshold) {
      this.persist();
      return null;
    }
    return this.pause(code, nowMs, this.backoff(this.cfg.failurePauseMs), `${this.s.consecutiveFailures} échecs consécutifs (dernier : ${code})`);
  }

  private backoff(baseMs: number): number {
    return Math.min(baseMs * 2 ** Math.min(this.s.backoffLevel, 30), this.cfg.maxPauseMs);
  }

  private pause(code: AbstentionCode, nowMs: number, durationMs: number, why: string): PauseEvent {
    const d = Math.min(durationMs, this.cfg.maxPauseMs);
    const until = Math.max(nowMs + d, this.s.pausedUntil ?? 0);
    const reason = `${why} — pause ${fmtDuration(d)}`;
    this.s.pausedUntil = until;
    this.s.pauseReason = reason;
    this.s.consecutiveFailures = 0;
    this.s.backoffLevel = Math.min(this.s.backoffLevel + 1, 30);
    this.persist();
    return { pausedUntil: until, reason, code, durationMs: d };
  }

  /** /llm on (efface pause et compteurs) ou /llm off. Remplace un fichier illisible (mis de côté). */
  setEnabled(enabled: boolean, nowMs = Date.now()): void {
    if (this.loadError) {
      try { renameSync(this.path, `${this.path}.illisible-${nowMs}`); } catch { /* absent ou non renommable */ }
      this.loadError = null;
      this.s = this.fresh(enabled);
    } else if (enabled) {
      this.s = this.fresh(true);
    } else {
      this.s.enabled = false;
    }
    this.persist();
  }

  snapshot(): LlmStateSnapshot {
    const { version: _v, ...rest } = this.s;
    return { ...rest, error: this.loadError ?? this.writeError };
  }
}
