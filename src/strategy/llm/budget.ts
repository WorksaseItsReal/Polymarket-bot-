/**
 * budget.ts — plafond d'appels de la stratégie llm, PERSISTÉ (papier uniquement).
 *
 * Unité : une DÉCISION (le pipeline en consomme une par round, quels que soient ses 1 à 3
 * appels au CLI). Plafonds glissants : 12 par heure, 100 par 24 h (configurables). Le
 * nombre d'appels CLI bruts est tenu à part, pour information (aucun plafond dessus).
 *
 * Décompté au LANCEMENT, pas au succès : un appel qui échoue a tout de même consommé du
 * quota côté abonnement. Le fichier fait foi (relu à chaque décision) : un redémarrage du
 * bot retrouve les mêmes compteurs.
 *
 * Fail-closed : fichier illisible ou impossible à écrire → refus ('budget_jour') avec un
 * détail pour l'alerte ; le fichier illisible n'est JAMAIS écrasé (diagnostic manuel).
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Écriture atomique : fichier temporaire + fsync + rename (+ fsync du dossier, au mieux).
 * Un arrêt brutal ne peut laisser que l'ancien fichier ou le nouveau, jamais un fichier
 * tronqué. Partagée par les fichiers d'état de la stratégie llm.
 */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* déjà renommé ou absent */ }
    throw e;
  }
  try {
    const dfd = openSync(dir, 'r');
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch { /* fsync de dossier non pris en charge : le rename reste atomique */ }
}

export interface BudgetConfig {
  /** Décisions maximum sur l'heure glissante. */
  maxPerHour: number;
  /** Décisions maximum sur les 24 h glissantes. */
  maxPerDay: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = { maxPerHour: 12, maxPerDay: 100 };

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; code: 'budget_heure' | 'budget_jour'; detail: string };

export interface BudgetSnapshot {
  decisionsLastHour: number;
  decisionsLastDay: number;
  cliCallsLastHour: number;
  cliCallsLastDay: number;
  maxPerHour: number;
  maxPerDay: number;
  /** Problème de fichier (illisible, écriture impossible), ou null. */
  error: string | null;
}

interface BudgetFile {
  version: 1;
  /** Horodatages (ms) des décisions lancées, dernières 24 h. */
  decisions: number[];
  /** Horodatages (ms) des lancements du CLI, dernières 24 h (information). */
  cliCalls: number[];
}

function isStampList(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(x => typeof x === 'number' && Number.isFinite(x));
}

export class CallBudget {
  private readonly cfg: BudgetConfig;
  private lastError: string | null = null;

  constructor(private readonly path: string, cfg: Partial<BudgetConfig> = {}) {
    const int = (v: number | undefined, def: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : def);
    this.cfg = {
      maxPerHour: int(cfg.maxPerHour, DEFAULT_BUDGET_CONFIG.maxPerHour),
      maxPerDay: int(cfg.maxPerDay, DEFAULT_BUDGET_CONFIG.maxPerDay),
    };
  }

  /** Dernier problème de fichier rencontré (pour l'alerte), ou null. */
  get error(): string | null {
    return this.lastError;
  }

  /**
   * Lecture du fichier. Absent → compteurs vides. Illisible → null (et `error` renseigné).
   * Les horodatages FUTURS (horloge reculée) restent comptés : prudence.
   */
  private load(nowMs: number): BudgetFile | null {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, decisions: [], cliCalls: [] };
      this.lastError = `fichier budget ${this.path} illisible (${(e as NodeJS.ErrnoException).code ?? 'erreur'}) — appels refusés`;
      return null;
    }
    try {
      const f = JSON.parse(text) as Partial<BudgetFile>;
      if (!f || typeof f !== 'object' || f.version !== 1 || !isStampList(f.decisions) || !isStampList(f.cliCalls)) throw new Error('format');
      const keep = (l: number[]) => l.filter(t => t > nowMs - DAY_MS);
      return { version: 1, decisions: keep(f.decisions), cliCalls: keep(f.cliCalls) };
    } catch {
      this.lastError = `fichier budget ${this.path} illisible (JSON invalide ou format inattendu) — appels refusés, fichier conservé`;
      return null;
    }
  }

  private save(f: BudgetFile): boolean {
    try {
      writeFileAtomic(this.path, JSON.stringify(f));
      return true;
    } catch (e) {
      this.lastError = `fichier budget ${this.path} impossible à écrire (${(e as NodeJS.ErrnoException).code ?? 'erreur'}) — appels refusés`;
      return false;
    }
  }

  /** Consomme une décision si les plafonds le permettent (décompte persisté AVANT le lancement). */
  tryConsume(nowMs: number): BudgetVerdict {
    const f = this.load(nowMs);
    if (!f) return { ok: false, code: 'budget_jour', detail: this.lastError ?? 'fichier budget illisible' };
    const lastDay = f.decisions.length;
    const lastHour = f.decisions.filter(t => t > nowMs - HOUR_MS).length;
    if (lastDay >= this.cfg.maxPerDay) {
      return { ok: false, code: 'budget_jour', detail: `${lastDay} décisions sur 24 h glissantes (plafond ${this.cfg.maxPerDay})` };
    }
    if (lastHour >= this.cfg.maxPerHour) {
      return { ok: false, code: 'budget_heure', detail: `${lastHour} décisions sur l'heure glissante (plafond ${this.cfg.maxPerHour})` };
    }
    f.decisions.push(nowMs);
    if (!this.save(f)) return { ok: false, code: 'budget_jour', detail: this.lastError ?? 'écriture du budget impossible' };
    this.lastError = null;
    return { ok: true };
  }

  /** Note un lancement du CLI (information). Fichier illisible → rien n'est écrit, false. */
  recordCliCall(nowMs: number): boolean {
    const f = this.load(nowMs);
    if (!f) return false;
    f.cliCalls.push(nowMs);
    return this.save(f);
  }

  snapshot(nowMs: number): BudgetSnapshot {
    const f = this.load(nowMs);
    const inHour = (l: number[]) => l.filter(t => t > nowMs - HOUR_MS).length;
    return {
      decisionsLastHour: f ? inHour(f.decisions) : 0,
      decisionsLastDay: f ? f.decisions.length : 0,
      cliCallsLastHour: f ? inHour(f.cliCalls) : 0,
      cliCallsLastDay: f ? f.cliCalls.length : 0,
      maxPerHour: this.cfg.maxPerHour,
      maxPerDay: this.cfg.maxPerDay,
      error: f ? null : this.lastError,
    };
  }
}
