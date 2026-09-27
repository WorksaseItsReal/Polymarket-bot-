/**
 * (5) CONTRÔLE NÉGATIF — prouver que la suite MORD.
 *
 * « Un test qui ne mord pas ne vaut rien. » Ce fichier vérifie trois choses qui
 * doivent être vraies pour que les autres tests aient une valeur :
 *
 *  1. Le runner signale un échec : lancer une fixture dont l'assertion est
 *     FAUSSE doit produire un code de sortie non nul et un « fail » compté.
 *  2. Le runner reconnaît un succès : la fixture positive sort en code 0.
 *  3. Notre mécanisme d'EXTRACTION mord : `extractFromBot` avec un motif qui ne
 *     peut pas correspondre DOIT lever. C'est ce qui garantit que les tests de
 *     non-régression cassent si le code réel change (retrait de la garde, etc.).
 *
 * Le contrôle (1) est un méta-test : il exécute le runner sur des fixtures
 * réelles via child_process, jamais une simulation.
 */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { extractFromBot } from './harness-v2.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

/** Lance le runner sur UNE fixture et renvoie code de sortie + sortie brute. */
function runFixture(file: string): { code: number; out: string } {
  // ⚠️ node:test exporte `NODE_TEST_CONTEXT` vers ses sous-processus : si le
  // runner enfant l'hérite, il croit être un « child » du runner parent et ne
  // rapporte plus rien (sortie vide, code 0). On le retire.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const out = execFileSync('npx', ['tsx', '--test', join(FIXTURES, file)], {
      encoding: 'utf8',
      timeout: 120_000,
      env,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('CONTRÔLE NÉGATIF : une assertion fausse produit bien un échec signalé', () => {
  const r = runFixture('failing.test.ts');
  assert.notEqual(r.code, 0, `un test qui doit échouer DOIT sortir en code ≠ 0 (obtenu ${r.code})`);
  assert.match(r.out, /# fail 1\b/, 'le runner compte bien 1 échec');
  assert.match(r.out, /not ok 1\b/, 'la ligne « not ok » de l’échec est présente');
});

test('CONTRÔLE POSITIF : une assertion vraie sort en code 0', () => {
  const r = runFixture('passing.test.ts');
  assert.equal(r.code, 0, `un test qui doit passer DOIT sortir en code 0 (obtenu ${r.code})`);
  assert.match(r.out, /# pass 1\b/, 'le runner compte bien 1 succès');
  assert.match(r.out, /# fail 0\b/, 'aucun échec');
});

test('CONTRÔLE NÉGATIF : l’extraction du code réel LÈVE sur un motif impossible', () => {
  // Preuve que les tests de non-régression mordent : si l'expression ciblée
  // disparaissait du source, l'extraction lèverait au lieu de passer en silence.
  assert.throws(
    () => extractFromBot(/CETTE_EXPRESSION_EST_ABSENTE_DU_SOURCE_XYZ/, 'motif impossible'),
    /NON-RÉGRESSION/,
    'extractFromBot doit lever quand le motif est introuvable',
  );
});
