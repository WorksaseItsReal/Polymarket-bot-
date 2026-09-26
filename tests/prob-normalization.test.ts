/**
 * (4) NORMALISATION DES PROBABILITÉS UP/DOWN — code RÉEL de bot-with-dashboard.ts.
 *
 * Bug historique : on additionnait des `ask` bruts dont la somme vaut ≈ 1 + spread
 * (ex. 0,56 + 0,47 = 1,03) → le recap affichait « UP 56% / DOWN 47% » = 103 %.
 * Correctif : diviser chaque côté par `_totImp = (yes + no) || 1` pour sommer à 100 %.
 *
 * On EXTRAIT les deux expressions du source (elles apparaissent en 2 endroits) et
 * on les exécute — si la division disparaît, l'extraction échoue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromBot } from './harness.ts';

type Pct = [number, number];

function normalize(
  re: RegExp,
  label: string,
  totVar: string,
  v1: string,
  v2: string,
): (a: number, b: number) => Pct {
  const stmt = extractFromBot(re, label);
  const fn = new Function(
    v1,
    v2,
    `${stmt}\nreturn [100 * ${v1} / ${totVar}, 100 * ${v2} / ${totVar}];`,
  );
  return (a: number, b: number) => (fn as (a: number, b: number) => Pct)(a, b);
}

// Emplacement 1 : marché ~50/50 → « HOLD (pas de LLM) »
const TOT_1 = /const _totImp = \(_yesImp \+ _noImp\) \|\| 1;/;
// Emplacement 2 : « pas de favori net » → PAS de mise
const TOT_2 = /const _totImp2 = \(yesImp \+ noImp\) \|\| 1;/;

test('NON-RÉGRESSION : les deux points d’affichage normalisent bien leurs probas', () => {
  assert.match(extractFromBot(TOT_1, '_totImp'), /_totImp/, 'division par _totImp requise (1)');
  assert.match(extractFromBot(TOT_2, '_totImp2'), /_totImp2/, 'division par _totImp2 requise (2)');
});

test('UP + DOWN = 100 % dans les deux emplacements (asks bruts à 103 %)', () => {
  const n1 = normalize(TOT_1, '_totImp', '_totImp', '_yesImp', '_noImp');
  const n2 = normalize(TOT_2, '_totImp2', '_totImp2', 'yesImp', 'noImp');
  // Cas réels : ask_YES + ask_NO ≈ 1 + spread (101–103 %).
  const cases: [number, number][] = [
    [0.56, 0.47],
    [0.61, 0.42],
    [0.5, 0.53],
    [0.7, 0.33],
  ];
  for (const [yes, no] of cases) {
    const [u1, d1] = n1(yes, no);
    const [u2, d2] = n2(yes, no);
    assert.ok(Math.abs(u1 + d1 - 100) < 1e-9, `emplacement 1 : ${u1}+${d1} ≠ 100`);
    assert.ok(Math.abs(u2 + d2 - 100) < 1e-9, `emplacement 2 : ${u2}+${d2} ≠ 100`);
    // Et surtout : l'ANCIEN affichage (brut ×100) dépassait 100 % → le bug.
    assert.ok((yes + no) * 100 > 100, 'le cas de test reproduit bien la somme brute > 100 %');
  }
});

test('garde-fou : asks nuls/absents ne provoquent pas de division par zéro', () => {
  const n1 = normalize(TOT_1, '_totImp', '_totImp', '_yesImp', '_noImp');
  const [u, d] = n1(0, 0);
  assert.ok(Number.isFinite(u) && Number.isFinite(d), 'le `|| 1` protège le cas 0/0');
  assert.equal(u + d, 0, 'sans information : 0 % / 0 % (pas NaN)');
});

test('valeur affichée arrondie : le favori 0,56 vs 0,47 reste > 50 %', () => {
  const n1 = normalize(TOT_1, '_totImp', '_totImp', '_yesImp', '_noImp');
  const [u, d] = n1(0.56, 0.47);
  assert.equal(Math.round(u), 54, 'UP arrondi à 54 % (et non 56 % brut)');
  assert.equal(Math.round(d), 46, 'DOWN arrondi à 46 % (et non 47 % brut)');
  assert.equal(Math.round(u) + Math.round(d), 100, 'les arrondis somment à 100 %');
});
