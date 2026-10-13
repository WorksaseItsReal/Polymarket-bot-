/**
 * llm-config.ts — réglages de la stratégie llm (PAPIER uniquement), lus depuis l'environnement.
 *
 * DÉSACTIVÉE par défaut (LLM_ENABLED absent ou faux) : aucun objet n'est créé, aucun processus
 * lancé, formule et récolte strictement inchangées. Même activée, elle démarre « off » : il faut
 * en plus `/llm on` (après une sonde réussie pour la version du CLI et des prompts).
 *
 * Toute valeur invalide garde son défaut et produit un avertissement (comme config.ts). Une
 * échéance qui tomberait dans la fenêtre de récolte (30 dernières secondes) rend la stratégie
 * INDISPONIBLE (refus au démarrage), sauf LLM_ALLOW_HARVEST_WINDOW=true.
 *
 * Module PUR : aucune I/O.
 */
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

export interface LlmConfig {
  /** Stratégie disponible (LLM_ENABLED). Faux : rien n'est construit. */
  enabled: boolean;
  /** Actifs décidés par les agents (LLM_COINS, défaut BTC). */
  coins: string[];
  /** Instant de la décision : secondes après le DÉBUT du round (LLM_DECISION_AT_S, 90). */
  decisionAtSec: number;
  /** Échéance : secondes après le début du round (LLM_DEADLINE_S, 150) ; au-delà → abstention. */
  deadlineSec: number;
  /** Autoriser une échéance dans les 30 dernières secondes (fenêtre de récolte). */
  allowHarvestWindow: boolean;
  /** Plafonds de décisions (LLM_MAX_PER_HOUR 12, LLM_MAX_PER_DAY 100), décomptés au lancement. */
  maxPerHour: number;
  maxPerDay: number;
  /** Mise maximale d'un pari llm, USD (LLM_MAX_STAKE_USD, 2). Le code a le dernier mot. */
  maxStakeUsd: number;
  /** Capital papier SÉPARÉ de llm (LLM_PAPER_CAPITAL, 250) : ses pertes ne touchent pas les
   *  limites de risque de formule et récolte, et inversement. */
  paperCapital: number;
  /** Garde de fraîcheur : baisse max de P(côté) de la formule entre instantané et exécution. */
  staleDrop: number;
  /** Délai maximal par agent (s), borné par le temps restant avant l'échéance. */
  agentTimeoutSec: number;
  /** Version FIGÉE du CLI (LLM_CLI_VERSION, ex. 2.1.296) : obligatoire pour lancer quoi que ce soit. */
  cliVersion: string | null;
  /** Binaire exact (LLM_CLI_PATH) ; défaut ~/.local/share/claude/versions/<version> (installateur natif). */
  cliPath: string | null;
  /** Passer aussi --json-schema (couche en plus ; défaut non, tant que la sonde ne l'a pas validé). */
  jsonSchemas: boolean;
  /** Outils internes tolérés par le fil-piège quand --json-schema est passé (relevés par la sonde). */
  schemaTools: string[];
  /** Pauses (llm-state.ts) : échecs consécutifs avant pause, durées (min), plafond (h). */
  failuresBeforePause: number;
  failurePauseMin: number;
  usagePauseMin: number;
  maxPauseHours: number;
  /** Rétention des sorties brutes des agents (jours). */
  rawRetentionDays: number;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  enabled: false,
  coins: ['BTC'],
  decisionAtSec: 90,
  deadlineSec: 150,
  allowHarvestWindow: false,
  maxPerHour: 12,
  maxPerDay: 100,
  maxStakeUsd: 2,
  paperCapital: 250,
  staleDrop: 0.05,
  agentTimeoutSec: 45,
  cliVersion: null,
  cliPath: null,
  jsonSchemas: false,
  schemaTools: [],
  failuresBeforePause: 3,
  failurePauseMin: 30,
  usagePauseMin: 60,
  maxPauseHours: 6,
  rawRetentionDays: 90,
};

/** Durée d'un round et début de la fenêtre de récolte (s après le début du round). */
export const ROUND_SEC = 300;
export const HARVEST_WINDOW_START_SEC = ROUND_SEC - 30;

const TRUE = ['true', '1', 'yes', 'on', 'oui'];
const FALSE = ['false', '0', 'no', 'off', 'non'];

function bool(env: Env, key: string, def: boolean, w: string[]): boolean {
  const r = (env[key] ?? '').trim().toLowerCase();
  if (!r) return def;
  if (TRUE.includes(r)) return true;
  if (FALSE.includes(r)) return false;
  w.push(`${key}=${r} ignoré (attendu : true ou false) — ${def}`);
  return def;
}

function num(env: Env, key: string, def: number, lo: number, hi: number, w: string[]): number {
  const r = (env[key] ?? '').trim();
  if (!r) return def;
  const v = Number(r);
  if (Number.isFinite(v) && v >= lo && v <= hi) return v;
  w.push(`${key}=${r} ignoré (attendu : nombre entre ${lo} et ${hi}) — ${def}`);
  return def;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

export function llmConfigFromEnv(env: Env, warnings: string[] = []): LlmConfig {
  const d = DEFAULT_LLM_CONFIG;
  const c: LlmConfig = { ...d, coins: [...d.coins], schemaTools: [] };
  c.enabled = bool(env, 'LLM_ENABLED', d.enabled, warnings);

  const coinsRaw = (env.LLM_COINS ?? '').trim();
  if (coinsRaw) {
    const asked = coinsRaw.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    const ok = asked.filter(x => COINS.includes(x));
    if (ok.length) c.coins = [...new Set(ok)];
    if (ok.length !== asked.length) warnings.push(`LLM_COINS=${coinsRaw} : actifs inconnus ignorés — ${c.coins.join(', ')}`);
  }

  c.decisionAtSec = num(env, 'LLM_DECISION_AT_S', d.decisionAtSec, 5, ROUND_SEC - 20, warnings);
  c.deadlineSec = num(env, 'LLM_DEADLINE_S', d.deadlineSec, 10, ROUND_SEC - 5, warnings);
  c.allowHarvestWindow = bool(env, 'LLM_ALLOW_HARVEST_WINDOW', d.allowHarvestWindow, warnings);
  c.maxPerHour = Math.floor(num(env, 'LLM_MAX_PER_HOUR', d.maxPerHour, 1, 12 * 5, warnings));
  c.maxPerDay = Math.floor(num(env, 'LLM_MAX_PER_DAY', d.maxPerDay, 1, 288 * 5, warnings));
  c.maxStakeUsd = num(env, 'LLM_MAX_STAKE_USD', d.maxStakeUsd, 1, 100, warnings);
  c.paperCapital = num(env, 'LLM_PAPER_CAPITAL', d.paperCapital, 10, 1_000_000, warnings);
  c.staleDrop = num(env, 'LLM_STALE_DROP', d.staleDrop, 0, 0.5, warnings);
  c.agentTimeoutSec = num(env, 'LLM_AGENT_TIMEOUT_S', d.agentTimeoutSec, 5, 120, warnings);
  c.jsonSchemas = bool(env, 'LLM_JSON_SCHEMA', d.jsonSchemas, warnings);
  c.schemaTools = (env.LLM_SCHEMA_TOOLS ?? '').split(',').map(x => x.trim()).filter(x => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(x));
  c.failuresBeforePause = Math.floor(num(env, 'LLM_FAILURES_BEFORE_PAUSE', d.failuresBeforePause, 1, 20, warnings));
  c.failurePauseMin = num(env, 'LLM_PAUSE_MIN', d.failurePauseMin, 1, 24 * 60, warnings);
  c.usagePauseMin = num(env, 'LLM_USAGE_PAUSE_MIN', d.usagePauseMin, 1, 24 * 60, warnings);
  c.maxPauseHours = num(env, 'LLM_MAX_PAUSE_H', d.maxPauseHours, 1, 72, warnings);
  c.rawRetentionDays = Math.floor(num(env, 'LLM_RAW_RETENTION_DAYS', d.rawRetentionDays, 1, 3650, warnings));

  const ver = (env.LLM_CLI_VERSION ?? '').trim();
  if (ver) {
    if (VERSION_RE.test(ver)) c.cliVersion = ver;
    else warnings.push(`LLM_CLI_VERSION=${ver} ignoré (attendu : x.y.z, ex. 2.1.296)`);
  }
  const path = (env.LLM_CLI_PATH ?? '').trim();
  if (path) {
    if (path.startsWith('/')) c.cliPath = path;
    else warnings.push(`LLM_CLI_PATH=${path} ignoré (chemin ABSOLU attendu)`);
  }

  if (c.enabled) {
    const reasons: string[] = [];
    if (c.deadlineSec < c.decisionAtSec + 10) reasons.push(`échéance ${c.deadlineSec} s < décision ${c.decisionAtSec} s + 10 s`);
    if (!c.allowHarvestWindow && c.deadlineSec > HARVEST_WINDOW_START_SEC) {
      reasons.push(`échéance ${c.deadlineSec} s dans la fenêtre de récolte (après ${HARVEST_WINDOW_START_SEC} s ; LLM_ALLOW_HARVEST_WINDOW=true pour l'autoriser)`);
    }
    if (!c.cliVersion) reasons.push('LLM_CLI_VERSION absent (version du CLI à figer, ex. 2.1.296)');
    if (reasons.length) {
      warnings.push(`stratégie llm INDISPONIBLE : ${reasons.join(' ; ')}`);
      c.enabled = false;
    }
  }
  return c;
}

/** Binaire du CLI à lancer : LLM_CLI_PATH, sinon la version figée de l'installateur natif. */
export function cliBinaryPath(c: Pick<LlmConfig, 'cliPath' | 'cliVersion'>, home: string): string | null {
  if (c.cliPath) return c.cliPath;
  if (!c.cliVersion) return null;
  return join(home, '.local', 'share', 'claude', 'versions', c.cliVersion);
}

/** Fichiers de la stratégie llm, tous sous `<dataDir>/llm` (hors du registre des trades). */
export function llmPaths(dataDir: string) {
  const dir = join(dataDir, 'llm');
  return {
    dir,
    /** Une ligne par tentative de décision (abstentions comprises). */
    decisions: join(dir, 'decisions.jsonl'),
    /** Instantanés, un fichier par empreinte. */
    snapshots: join(dir, 'snapshots'),
    /** Sorties brutes des agents : raw/<AAAA-MM-JJ>/<id>.json.gz. */
    raw: join(dir, 'raw'),
    budget: join(dir, 'budget.json'),
    state: join(dir, 'state.json'),
    /** Résultats de la sonde réelle : probe/<version CLI>_<version prompts>.json. */
    probe: join(dir, 'probe'),
    /** Arrêt de performance propre à llm. */
    guard: join(dir, 'guard.json'),
  };
}
