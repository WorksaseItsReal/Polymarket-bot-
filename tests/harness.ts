/**
 * Helpers partagés par la suite de tests du bot paper Polymarket.
 *
 * Principe : on teste le CODE RÉEL du projet, jamais une copie.
 *  - Pour le Python (paperbot-recap.py, paperbot-pnl.py) : import par chemin via
 *    tests/harness_recap.py, exécuté en child_process. Les effets de bord (réseau,
 *    Telegram, écriture du pnl.json émis) sont neutralisés DANS le harnais.
 *  - Pour le TypeScript monolithique (bot-with-dashboard.ts) : les expressions
 *    ciblées sont EXTRAITES du fichier source au moment du test et évaluées via
 *    `new Function`. Si la formule régresse, l'extraction ou l'assertion casse.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = join(HERE, '..');
export const HARNESS = join(HERE, 'harness_recap.py');
export const SCRIPTS_DIR = process.env.PAPERBOT_SCRIPTS_DIR ?? '/root/.hermes/scripts';
export const BOT_SRC = join(REPO_ROOT, 'bot-with-dashboard.ts');

/** Les sources Python réelles sont-elles présentes sur cette machine ?
 *  En CI (dépôt cloné ailleurs) elles ne le sont pas : les tests concernés
 *  sont alors SKIPPÉS explicitement, jamais remplacés par une simulation. */
export const pySourcesAvailable =
  existsSync(join(SCRIPTS_DIR, 'paperbot-recap.py')) &&
  existsSync(join(SCRIPTS_DIR, 'paperbot-pnl.py'));

/** Lance le harnais Python et renvoie l'objet JSON qu'il imprime. */
export function runHarness<T = unknown>(cmd: string, args: string[] = []): T {
  const out = execFileSync('python3', [HARNESS, cmd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', PAPERBOT_SCRIPTS_DIR: SCRIPTS_DIR },
  });
  return JSON.parse(out) as T;
}

/** Extrait du VRAI source TS l'expression correspondant au motif, ou échoue. */
export function extractFromBot(re: RegExp, label: string): string {
  const src = readFileSync(BOT_SRC, 'utf8');
  const m = src.match(re);
  assert.ok(
    m,
    `NON-RÉGRESSION : l'expression « ${label} » est introuvable dans bot-with-dashboard.ts ` +
      `(le code a été modifié/retiré). Motif : ${re}`,
  );
  return m[0];
}
