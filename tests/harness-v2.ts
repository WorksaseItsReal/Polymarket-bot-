/**
 * Helpers PARTAGÉS — seconde génération (AJOUT, l'ancien harness.ts reste intact).
 *
 * Même principe que harness.ts : on teste le CODE RÉEL du projet.
 *  - TS monolithique (bot-with-dashboard.ts, bot-config.ts) : l'expression ou la
 *    fonction visée est EXTRAITE du fichier source au moment du test. Si elle
 *    disparaît ou change de forme, l'extraction casse → le test échoue.
 *  - Python (paperbot-recap.py, paperbot-pnl.py) : import par chemin via
 *    tests/harness_v2.py, exécuté en child_process avec ses effets de bord
 *    neutralisés.
 *
 * LIMITE HONNÊTE (voir docs/rebuild/tests/REPORT-v2.md) : ni bot-with-dashboard.ts
 * ni bot-config.ts ne sont IMPORTABLES — leur top-level démarre le bot (SDK,
 * WebSocket, écritures réseau). On ne peut donc pas appeler leurs fonctions
 * directement ; on extrait le texte source et on l'évalue dans un scope neuf via
 * `new Function`. Les `as any` (syntaxe TS) sont retirés avant évaluation.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = join(HERE, '..');
export const HARNESS_V2 = join(HERE, 'harness_v2.py');
export const SCRIPTS_DIR = process.env.PAPERBOT_SCRIPTS_DIR ?? '/root/.hermes/scripts';
export const BOT_SRC = join(REPO_ROOT, 'bot-with-dashboard.ts');
export const BOT_CONFIG_SRC = join(REPO_ROOT, 'bot-config.ts');

/** Les sources Python réelles sont-elles présentes ? Sinon : SKIP explicite. */
export const pySourcesAvailable =
  existsSync(join(SCRIPTS_DIR, 'paperbot-recap.py')) &&
  existsSync(join(SCRIPTS_DIR, 'paperbot-pnl.py'));

/** Lance tests/harness_v2.py et renvoie l'objet JSON qu'il imprime. */
export function runHarnessV2<T = unknown>(cmd: string, args: string[] = []): T {
  const out = execFileSync('python3', [HARNESS_V2, cmd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', PAPERBOT_SCRIPTS_DIR: SCRIPTS_DIR },
  });
  return JSON.parse(out) as T;
}

/** Extrait le texte source d'un fichier réel, ou échoue avec un message clair. */
export function extractFrom(filePath: string, re: RegExp, label: string): string {
  const src = readFileSync(filePath, 'utf8');
  const m = src.match(re);
  assert.ok(
    m,
    `NON-RÉGRESSION : « ${label} » introuvable dans ${filePath} ` +
      `(code modifié/retiré). Motif : ${re}`,
  );
  return m[0];
}

/** Extrait du monolithe bot-with-dashboard.ts (raccourci). */
export function extractFromBot(re: RegExp, label: string): string {
  return extractFrom(BOT_SRC, re, label);
}

/**
 * Extrait une fonction `function <nom>(...) { … }` complète d'un fichier réel.
 * La fin est détectée par une accolade fermante en colonne 0 (`\n}`).
 */
export function extractFunction(filePath: string, name: string): string {
  const re = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}`);
  return extractFrom(filePath, re, `fonction ${name}()`);
}

/** Extrait un littéral numérique identifié par un motif (valeur de CONFIG réelle). */
export function extractNumber(filePath: string, re: RegExp, label: string): number {
  const txt = extractFrom(filePath, re, label);
  const m = txt.match(/([-\d.]+)/);
  assert.ok(m, `valeur numérique illisible dans « ${label} » : ${txt}`);
  return Number(m[1]);
}

/** Évalue une expression extraite de TS en retirant les `as any` (non-JS). */
export function evalExtracted(
  expr: string,
  argNames: string[],
  argValues: unknown[],
  returnExpr: string,
): unknown {
  const js = stripTsAnnotations(expr);
  const fn = new Function(...argNames, `${js}\nreturn ${returnExpr};`);
  return (fn as (...a: unknown[]) => unknown)(...argValues);
}

/**
 * Retire les annotations de type TS d'un extrait de source réel pour pouvoir
 * l'évaluer en JavaScript : `x as any`, `: number|string|boolean|void|unknown`.
 * C'est la SEULE altération appliquée au code extrait, et elle est purement
 * syntaxique (les types TS n'existent pas à l'exécution) — voir REPORT-v2.md.
 */
export function stripTsAnnotations(ts: string): string {
  return ts
    .replace(/\sas any\b/g, '')
    .replace(/:\s*(number|string|boolean|void|unknown|any)\b/g, '');
}
