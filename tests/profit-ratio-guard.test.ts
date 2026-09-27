/**
 * (1) GARDE DE RATIO DE PROFIT — NON-RÉGRESSION DU BUG RÉEL DU 2026-09-27.
 *
 * Bug observé en production : `estimatedProfitRate` n'était pas toujours calculé
 * (il valait alors `0`). Le code faisait `stake * (profitRate - 1)`, donc
 * `stake * (0 - 1) = -stake` : CHAQUE signal était enregistré comme une PERTE
 * TOTALE de la mise. Mesure : 2 514 signaux × mise négative → le PnL interne
 * s'effondrait, `currentCapital` avec lui, et le garde-fou de drawdown (25 % →
 * pause silencieuse de 7 JOURS, layer 3) se déclenchait : le bot arrêtait de
 * trader sans rien logger. Un ratio de profit VALIDE est > 1 (un ratio de 1.08
 * signifie +8 %).
 *
 * Le correctif vit DANS le monolithe bot-with-dashboard.ts (non importable : son
 * top-level démarre le SDK, le WebSocket et des écritures réseau). On EXTRAIT
 * donc le bloc de garde EXACT du source au moment du test, on retire les `as any`
 * (syntaxe TS) et on l'évalue dans `new Function`. Si la garde régresse (retour
 * à `stake * (profitRate - 1)` sans condition), ce fichier CASSE.
 *
 * LIMITE : on ne teste pas l'appel réel `onSignal(...)` de bout en bout (il faut
 * un SDK vivant) ; on teste la seule décision de PnL qui a produit le bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromBot, evalExtracted } from './harness-v2.ts';

// Bloc RÉEL : de `const profitRate = …` jusqu'à la fin du premier `else if`.
const GUARD_RE =
  /const profitRate = [\s\S]*?estProfit = stake \* \(\(1 \/ p\) - 1\);\n\s*\}/;

/** Exécute la VRAIE garde extraite du source. */
function estProfitFromGuard(s: unknown, stake: number): number {
  const block = extractFromBot(GUARD_RE, 'garde de ratio de profit (estProfit)');
  return evalExtracted(block, ['s', 'stake'], [s, stake], 'estProfit') as number;
}

/** Toutes les valeurs de ratio qui déclenchaient (ou frôlaient) le bug. */
const DEGENERES: unknown[] = [
  0,            // le bug : non calculé → 0
  undefined,    // absent
  null,         // absent explicite
  NaN,          // calcul raté
  Infinity,     // division par zéro en amont
  -Infinity,
  -1,           // négatif
  0.5,          // < 1 : un ratio sous 1 n'est PAS un gain exploitable
  1,            // exactement 1 : neutre, pas > 1
  '0.5',        // chaîne (type inattendu)
  {},           // objet
  [],           // tableau
];

test('NON-RÉGRESSION : la garde exige un ratio FINI ET > 1 (le bug : ratio 0)', () => {
  const block = extractFromBot(GUARD_RE, 'garde de ratio de profit (estProfit)');
  assert.match(block, /Number\.isFinite\(profitRate\)/, 'la garde doit tester la finitude');
  assert.match(block, /profitRate > 1/, 'la garde doit exiger un ratio STRICTEMENT > 1');
  assert.match(block, /typeof profitRate === 'number'/, 'la garde doit tester le type');
  // Le bug historique exact :
  assert.equal(1 * (0 - 1), -1, 'la formule buggée transformait bien un ratio 0 en perte totale');
});

test('un ratio dégénéré ne produit JAMAIS une perte de la totalité de la mise', () => {
  const stake = 1;
  for (const r of DEGENERES) {
    const p = estProfitFromGuard({ estimatedProfitRate: r, currentPrice: 0.6 }, stake);
    assert.ok(Number.isFinite(p), `estProfit doit rester fini pour ratio=${String(r)}, obtenu ${p}`);
    assert.notEqual(p, -stake, `ratio=${String(r)} ne doit PAS valoir -stake (le bug 2026-09-27)`);
    assert.ok(p >= 0, `estProfit doit être ≥ 0 pour ratio=${String(r)}, obtenu ${p}`);
  }
});

test('sans prix courant, un ratio dégénéré produit 0 (ni gain, ni perte), pas -stake', () => {
  const stake = 1;
  for (const r of DEGENERES) {
    const p = estProfitFromGuard({ estimatedProfitRate: r }, stake);
    assert.equal(p, 0, `ratio=${String(r)} sans currentPrice → 0, obtenu ${p}`);
  }
});

test('la mise (stake) n’est jamais multipliée par un facteur négatif dérivé du ratio', () => {
  // Ce qui a coûté : (profitRate - 1) avec profitRate ≤ 1 est ≤ 0 → mise négative.
  // La garde ne l'emprunte QUE si profitRate > 1, donc le facteur reste > 0.
  for (const stake of [1, 5, 25]) {
    const p = estProfitFromGuard({ estimatedProfitRate: 0, currentPrice: 0.6 }, stake);
    assert.ok(p > 0, `stake=${stake} : le repli sur le prix doit rester positif`);
    const pAbsent = estProfitFromGuard({ estimatedProfitRate: 0 }, stake);
    assert.equal(pAbsent, 0, `stake=${stake} sans prix → 0`);
    assert.notEqual(pAbsent, -stake, 'jamais -stake');
  }
});

test('un ratio VALIDE (> 1) est bien appliqué : stake × (ratio − 1)', () => {
  const r = estProfitFromGuard({ estimatedProfitRate: 1.08 }, 5);
  assert.ok(Math.abs(r - 0.4) < 1e-12, `1.08 → +8 % sur 5€ ≈ 0,40, obtenu ${r}`);
  assert.equal(estProfitFromGuard({ estimatedProfitRate: 2 }, 1), 1, '2 → +100 % sur 1€ = 1');
  assert.equal(estProfitFromGuard({ estimatedProfitRate: 1.5 }, 10), 5, '1.5 → +50 % sur 10€ = 5');
});

test('repli sur le prix : ratio inutilisable mais prix réel → rendement 1/prix − 1', () => {
  const p = estProfitFromGuard({ estimatedProfitRate: 0, currentPrice: 0.5, expectedProfitRate: undefined }, 2);
  // (1/0,5 − 1) × 2 = 2
  assert.ok(Math.abs(p - 2) < 1e-12, `repli attendu 2, obtenu ${p}`);
  // `expectedProfitRate` sert aussi de source (leg2) : un ratio valide y est lu.
  const q = estProfitFromGuard({ expectedProfitRate: 1.25, currentPrice: 0.5 }, 4);
  assert.ok(Math.abs(q - 1) < 1e-12, `expectedProfitRate 1.25 sur 4€ = 1, obtenu ${q}`);
});
