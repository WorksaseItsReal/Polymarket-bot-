/**
 * token.ts — jeton OAuth du CLI Claude Code pour la stratégie llm (papier uniquement).
 *
 * Le jeton vient de `claude setup-token` (doc https://code.claude.com/docs/en/authentication :
 * « generate a one-year OAuth token », passé au CLI par CLAUDE_CODE_OAUTH_TOKEN, « It can
 * only make model requests »). Il est rangé dans un fichier en mode 0600 (exigé : un jeton
 * lisible par d'autres comptes est refusé), avec à côté un fichier méta JSON { createdAt }.
 *
 * HONNÊTETÉ sur l'expiration : la date est CALCULÉE (date d'enregistrement + durée d'un an
 * documentée). Elle n'est PAS lue dans le jeton, dont le format n'est pas documenté. Comme le
 * jeton est enregistré après sa génération, la date calculée est au plus tard la vraie.
 *
 * Le jeton n'apparaît dans AUCUN message produit ici (erreurs comprises) : ne jamais le logguer.
 */

import { chmodSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './budget.js';

const DAY_MS = 86_400_000;
/** Durée de vie documentée d'un jeton `claude setup-token`. */
export const TOKEN_LIFETIME_MS = 365 * DAY_MS;
/** Alerte « expire bientôt » à partir de 30 jours restants. */
export const TOKEN_WARNING_MS = 30 * DAY_MS;

export interface TokenPaths {
  tokenFile: string;
  metaFile: string;
}

export function tokenPaths(dir: string): TokenPaths {
  return { tokenFile: join(dir, 'claude-oauth-token'), metaFile: join(dir, 'claude-oauth-token.meta.json') };
}

/** Emplacement par défaut : ~/.polymarket/llm (à côté des autres fichiers d'état du bot). */
export function defaultTokenPaths(env: Record<string, string | undefined> = process.env): TokenPaths {
  return tokenPaths(join((env.HOME ?? '').trim() || homedir(), '.polymarket', 'llm'));
}

export type TokenState = 'absent' | 'permissions' | 'expire' | 'expire_bientot' | 'ok';

export interface TokenStatus {
  state: TokenState;
  /** Date d'enregistrement (ms), ou null si inconnue. */
  createdAt: number | null;
  /** Expiration CALCULÉE (createdAt + 365 j), ou null si inconnue. */
  expiresAt: number | null;
  /** Jours restants (arrondis vers le bas), ou null. */
  daysLeft: number | null;
  /** Explication lisible, sans le jeton. */
  detail: string;
}

/** Forme admise : une seule « ligne » de caractères ASCII imprimables, sans espace. */
function isPlausibleToken(t: string): boolean {
  return /^[\x21-\x7e]{16,4096}$/.test(t);
}

function readMetaCreatedAt(metaFile: string): number | null {
  try {
    const m = JSON.parse(readFileSync(metaFile, 'utf8')) as { createdAt?: unknown };
    const t = typeof m.createdAt === 'string' ? Date.parse(m.createdAt) : typeof m.createdAt === 'number' ? m.createdAt : NaN;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** Contenu du fichier jeton si présent, en 0600, et de forme plausible ; sinon le motif du refus. */
function inspect(paths: TokenPaths): { token: string } | { state: 'absent' | 'permissions'; detail: string } {
  let mode: number;
  try {
    const st = statSync(paths.tokenFile);
    if (!st.isFile()) return { state: 'absent', detail: `${paths.tokenFile} n'est pas un fichier` };
    mode = st.mode;
  } catch (e) {
    return { state: 'absent', detail: `aucun jeton (${paths.tokenFile} : ${(e as NodeJS.ErrnoException).code ?? 'illisible'}) — npm run llm:token` };
  }
  if ((mode & 0o077) !== 0) {
    return { state: 'permissions', detail: `permissions trop ouvertes sur ${paths.tokenFile} (${(mode & 0o777).toString(8)}, attendu 600) — chmod 600` };
  }
  let token: string;
  try {
    token = readFileSync(paths.tokenFile, 'utf8').trim();
  } catch (e) {
    return { state: 'absent', detail: `jeton illisible (${(e as NodeJS.ErrnoException).code ?? 'erreur'})` };
  }
  if (!isPlausibleToken(token)) return { state: 'absent', detail: `contenu de ${paths.tokenFile} invalide (vide ou mal formé)` };
  return { token };
}

export function tokenStatus(paths: TokenPaths, nowMs: number): TokenStatus {
  const r = inspect(paths);
  if (!('token' in r)) return { state: r.state, createdAt: null, expiresAt: null, daysLeft: null, detail: r.detail };
  const createdAt = readMetaCreatedAt(paths.metaFile);
  if (createdAt === null) {
    // Date d'enregistrement inconnue : on ne peut rien calculer → alerte, sans bloquer.
    return { state: 'expire_bientot', createdAt: null, expiresAt: null, daysLeft: null, detail: `méta ${paths.metaFile} absente ou illisible : expiration inconnue — réenregistre le jeton (npm run llm:token)` };
  }
  const expiresAt = createdAt + TOKEN_LIFETIME_MS;
  const left = expiresAt - nowMs;
  const daysLeft = Math.floor(left / DAY_MS);
  const when = new Date(expiresAt).toISOString().slice(0, 10);
  if (left <= 0) return { state: 'expire', createdAt, expiresAt, daysLeft, detail: `jeton expiré (calculé : ${when}) — claude setup-token puis npm run llm:token` };
  if (left <= TOKEN_WARNING_MS) return { state: 'expire_bientot', createdAt, expiresAt, daysLeft, detail: `jeton expire dans ${daysLeft} j (calculé : ${when})` };
  return { state: 'ok', createdAt, expiresAt, daysLeft, detail: `jeton valable jusqu'au ${when} (calculé), ${daysLeft} j restants` };
}

/**
 * Le jeton, ou null s'il est absent, mal formé, ou si ses permissions sont trop ouvertes.
 * Ne lève jamais d'exception ; la valeur ne doit être transmise qu'à l'environnement du CLI.
 */
export function readToken(paths: TokenPaths): string | null {
  const r = inspect(paths);
  return 'token' in r ? r.token : null;
}

/** Enregistre le jeton (0600) et sa méta { createdAt }. Erreurs sans le jeton. */
export function saveToken(paths: TokenPaths, rawToken: string, nowMs: number): { createdAt: number; expiresAt: number } {
  const token = rawToken.trim();
  if (!isPlausibleToken(token)) {
    throw new Error(`jeton refusé : attendu une seule ligne de 16 à 4096 caractères imprimables sans espace (reçu ${token.length} caractères)`);
  }
  writeFileAtomic(paths.tokenFile, `${token}\n`, 0o600);
  chmodSync(paths.tokenFile, 0o600);
  const createdAt = nowMs;
  const expiresAt = createdAt + TOKEN_LIFETIME_MS;
  writeFileAtomic(paths.metaFile, `${JSON.stringify({
    createdAt: new Date(createdAt).toISOString(),
    expiresAtCalcule: new Date(expiresAt).toISOString(),
    note: 'expiration calculée : date d\'enregistrement + 365 j (durée documentée), non lue dans le jeton',
  }, null, 2)}\n`, 0o600);
  return { createdAt, expiresAt };
}
