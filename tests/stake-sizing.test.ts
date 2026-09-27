/**
 * ============================================================================
 * tests/stake-sizing.test.ts — couverture du dimensionnement adaptatif de mise
 * ============================================================================
 * Exécution : `npx tsx --test tests/stake-sizing.test.ts`
 *
 * On exerce la VRAIE fonction exportée par `src/services/stake-sizing.ts`
 * (aucune copie, aucun mock). Le module est PUR : aucun réseau, aucune horloge,
 * aucun accès à `.env`.
 *
 * 22 cas : bornes, cas dégénérés, plafonds durs, modérateurs, mise plancher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStake,
  DAILY_LOSS_PCT,
  MAX_EXPOSURE_PCT,
  MAX_STAKE_EUR,
  MAX_TRADE_PCT,
  MAX_VARIANCE_PCT,
  MIN_LOSSES_TO_DAILY_LIMIT,
  MIN_STAKE_EUR,
  MIN_TRADES_SIGNAL,
  type StakeSizingInput,
} from '../src/services/stake-sizing.ts';

// --- Jeu de référence « situation mesurée » (EDGE.md/RISK.md) --------------
// entrée 0,625 ; b observé 0,60 → BE = 0,625 ; WR récent 72 % sur 65 trades.
const BASE: StakeSizingInput = {
  capital: 50,
  entryPrice: 0.625,
  avgGainPerUnit: 0.6,
  avgLossPerUnit: 1.0,
  winRateRecent: 0.72,
  recentTrades: 65,
  bookProb: null,
  consecutiveLosses: 0,
  drawdownCurrent: 0,
  openExposureEur: 0,
  openPositions: 0,
};

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;
const cents = (x: number) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-9;

// ===========================================================================
// (1) CAS DÉGÉNÉRÉS — prix hors de ]0,1[
// ===========================================================================
test('1. prix hors de ]0,1[ → mise nulle, non contournable', () => {
  for (const bad of [0, 1, 1.5, -0.2, NaN]) {
    const r = computeStake({ ...BASE, entryPrice: bad });
    assert.equal(r.stake, 0, `entryPrice=${bad} doit donner stake 0`);
    assert.equal(r.skipped, true);
    assert.match(r.rationale, /hors de \]0,1\[/);
  }
});

test('2. capital invalide (0, négatif, NaN) → mise nulle', () => {
  for (const bad of [0, -10, NaN]) {
    const r = computeStake({ ...BASE, capital: bad });
    assert.equal(r.stake, 0);
    assert.equal(r.skipped, true);
  }
});

// ===========================================================================
// (2) HISTORIQUE VIDE / INSUFFISANT
// ===========================================================================
test('3. historique vide ET carnet indisponible → ne pas miser', () => {
  const r = computeStake({
    capital: 50,
    entryPrice: 0.625,
    winRateRecent: null,
    recentTrades: 0,
    bookProb: null,
  });
  assert.equal(r.stake, 0);
  assert.equal(r.skipped, true);
  assert.match(r.rationale, /Aucun signal de probabilité/);
  assert.equal(r.effectiveProb, null);
});

test(`4. n<${MIN_TRADES_SIGNAL} : le win rate empirique n'est PAS utilisé sans carnet`, () => {
  // 4 trades gagnants sur 4 (WR 100 %) ne doivent JAMAIS déclencher une grosse mise.
  const r = computeStake({
    capital: 50,
    entryPrice: 0.625,
    winRateRecent: 1.0,
    recentTrades: 4,
    bookProb: null,
    avgGainPerUnit: 0.6,
    avgLossPerUnit: 1.0,
  });
  assert.equal(r.stake, 0, 'WR sur 4 trades ⇒ ignoré (donc aucun signal)');
  assert.equal(r.skipped, true);
});

test('5. n<5 mais carnet fourni → signal carnet seulement, mise prudente', () => {
  const r = computeStake({
    capital: 500,
    entryPrice: 0.625,
    winRateRecent: 1.0,
    recentTrades: 3,
    bookProb: 0.75,
    avgGainPerUnit: 0.6,
    avgLossPerUnit: 1.0,
  });
  // λ = 20/(20+20) = 0,5 → p̂ = 0,625 + 0,5·(0,75−0,625) = 0,6875
  assert.equal(r.skipped, false);
  assert.ok(near(r.effectiveProb as number, 0.6875, 1e-12), `p̂=${r.effectiveProb}`);
  assert.ok(r.stake > 0);
  assert.ok(r.stake <= 500 * DAILY_LOSS_PCT / MIN_LOSSES_TO_DAILY_LIMIT + 1e-9);
  assert.match(r.rationale, /Confiance faible/);
});

// ===========================================================================
// (3) EDGE NUL ET EDGE NÉGATIF
// ===========================================================================
test('6. edge EXACTEMENT nul (WR = BE = prix) → mise nulle', () => {
  // b = 0,6/1,0 → BE = 1/1,6 = 0,625 ; WR = entrée = 0,625 ⇒ p̂ = BE.
  const r = computeStake({ ...BASE, winRateRecent: 0.625 });
  assert.equal(r.stake, 0);
  assert.equal(r.skipped, true);
  assert.ok(near(r.edgePp as number, 0, 1e-12), `edge=${r.edgePp}`);
  assert.match(r.rationale, /Edge nul ou négatif/);
});

test('7. edge négatif (WR 55 % < BE 62,5 %) → mise nulle', () => {
  const r = computeStake({ ...BASE, winRateRecent: 0.55 });
  assert.equal(r.stake, 0);
  assert.equal(r.skipped, true);
  assert.ok((r.edgePp as number) < 0);
});

test('8. le shrinkage ne peut pas INVENTER un edge : entrée = carnet ⇒ p̂ ≈ entrée', () => {
  // Carnet identique au prix marchés ⇒ edge ≈ 0 quelle que soit λ.
  const r = computeStake({ ...BASE, winRateRecent: null, recentTrades: 0, bookProb: 0.625 });
  assert.ok(Math.abs((r.edgePp as number) ?? 0) < 1e-9);
  assert.equal(r.stake, 0);
});

// ===========================================================================
// (4) PLAFONDS DURS
// ===========================================================================
test('9. plafond dur : borne de variance 1 % du capital (capital 50 €)', () => {
  const r = computeStake(BASE); // WR 72 %, gros edge
  assert.equal(r.skipped, false);
  assert.equal(r.capped, true, 'la mise Kelly brute doit avoir été écrêtée');
  assert.equal(r.maxStakeAllowed, 50 * MAX_VARIANCE_PCT); // 0,50 €
  assert.equal(r.stake, 0.5);
  assert.ok(r.stake <= 50 * MAX_TRADE_PCT + 1e-9);
  assert.match(r.bindingConstraint, /variance/);
  assert.match(r.rationale, /Plafond DUR/);
});

test('9b. la mise plafonnée reproduit la table de RISK.md §5.1 (1 % du capital)', () => {
  for (const [capital, expected] of [
    [20, 0.2],
    [50, 0.5],
    [100, 1.0],
    [200, 2.0],
    [500, 5.0],
  ] as const) {
    const r = computeStake({ ...BASE, capital });
    assert.equal(
      r.stake,
      expected,
      `capital ${capital} : RISK.md attend ${expected} € (1 %), obtenu ${r.stake} €`,
    );
  }
});

test('10. une SEULE perte ne peut pas consommer la limite quotidienne', () => {
  for (const capital of [20, 50, 100, 250, 500, 1000]) {
    const r = computeStake({ ...BASE, capital });
    assert.ok(
      r.stake * MIN_LOSSES_TO_DAILY_LIMIT <= capital * DAILY_LOSS_PCT + 1e-9,
      `capital=${capital} : ${MIN_LOSSES_TO_DAILY_LIMIT} pertes (${r.stake * 3}) ` +
        `doivent rester sous la limite quotidienne (${capital * DAILY_LOSS_PCT})`,
    );
  }
});

test('11. jamais plus de 2 % du capital par trade, quelle que soit la WR', () => {
  for (const capital of [10, 50, 137, 500, 5000]) {
    for (const wr of [0.66, 0.7, 0.8, 0.95, 1.0]) {
      const r = computeStake({ ...BASE, capital, winRateRecent: wr });
      assert.ok(
        r.stake <= capital * MAX_TRADE_PCT + 1e-9,
        `capital=${capital} wr=${wr} : stake ${r.stake} > 2 % (${capital * MAX_TRADE_PCT})`,
      );
    }
  }
});

test('12. plafond absolu de sécurité : MAX_STAKE_EUR même avec un capital énorme', () => {
  const r = computeStake({ ...BASE, capital: 100_000 });
  assert.equal(r.maxStakeAllowed, MAX_STAKE_EUR);
  assert.equal(r.stake, MAX_STAKE_EUR);
});

test('13. exposition simultanée : budget restant = 10 % − exposition engagée', () => {
  const capital = 100;
  const openExposureEur = capital * MAX_EXPOSURE_PCT - 0.5; // il ne reste que 0,50 € (sous la borne 1 %)
  const r = computeStake({ ...BASE, capital, openExposureEur });
  assert.equal(r.skipped, false);
  assert.equal(r.maxStakeAllowed, 0.5);
  assert.ok(r.stake <= 0.5 + 1e-9, `stake=${r.stake}`);
  assert.match(r.bindingConstraint, /exposition/);
});

test('14. exposition épuisée (10 % atteints) → refus par plafond dur', () => {
  const capital = 100;
  const r = computeStake({ ...BASE, capital, openExposureEur: capital * MAX_EXPOSURE_PCT });
  assert.equal(r.stake, 0);
  assert.equal(r.skipped, true);
  assert.equal(r.capped, true, 'un refus par plafond dur compte comme « capped »');
  assert.match(r.rationale, /budget d'exposition/);
});

test('15. 5 positions ouvertes simultanées → refus (5 coins max)', () => {
  const r = computeStake({ ...BASE, capital: 500, openPositions: 5 });
  assert.equal(r.stake, 0);
  assert.equal(r.skipped, true);
  assert.equal(r.capped, true);
  assert.match(r.bindingConstraint, /positions simultanées/);
});

// ===========================================================================
// (5) MODÉRATEURS — drawdown et série de pertes
// ===========================================================================
test('16. drawdown ≥ 20 % → STOP (mise nulle)', () => {
  const r = computeStake({ ...BASE, capital: 1000, drawdownCurrent: 0.25 });
  assert.equal(r.stake, 0);
  assert.equal(r.skipped, true);
  assert.match(r.rationale, /drawdown/);
});

test('17. drawdown ≥ 10 % → mise exactement RÉDUITE DE MOITIÉ', () => {
  const small: StakeSizingInput = {
    capital: 1000,
    entryPrice: 0.5,
    avgGainPerUnit: 1.0,
    avgLossPerUnit: 1.0,
    winRateRecent: 0.526, // edge faible ⇒ Kelly sous les plafonds ET au-dessus du plancher
    recentTrades: 65,
  };
  const r0 = computeStake({ ...small, drawdownCurrent: 0 });
  const r12 = computeStake({ ...small, drawdownCurrent: 0.12 });
  assert.ok(r0.stake > 0 && r12.stake > 0);
  assert.ok(r12.stake < r0.stake, 'le drawdown doit réduire la mise');
  assert.ok(near(r12.rawKellyStake, r0.rawKellyStake, 1e-9), 'le Kelly brut ne change pas');
  assert.ok(
    Math.abs(r12.stake / r0.stake - 0.5) < 0.01,
    `rapport attendu ≈ 0,5, obtenu ${r12.stake / r0.stake}`,
  );
});

test('18. 8 pertes consécutives → STOP ; 4 pertes → moitié', () => {
  const small: StakeSizingInput = {
    capital: 1000,
    entryPrice: 0.5,
    avgGainPerUnit: 1.0,
    avgLossPerUnit: 1.0,
    winRateRecent: 0.526,
    recentTrades: 65,
  };
  const r0 = computeStake({ ...small, consecutiveLosses: 0 });
  const r4 = computeStake({ ...small, consecutiveLosses: 4 });
  const r8 = computeStake({ ...small, consecutiveLosses: 8 });
  assert.equal(r8.stake, 0, '8 pertes = kill-switch RISK.md §5.2');
  assert.equal(r8.skipped, true);
  assert.ok(Math.abs(r4.stake / r0.stake - 0.5) < 0.01, `rapport attendu ≈ 0,5, obtenu ${r4.stake / r0.stake}`);
});

// ===========================================================================
// (6) MISE PLANCHER
// ===========================================================================
test('19. mise plancher : petite mise Kelly relevée au minimum (jamais au-dessus du plafond)', () => {
  const r = computeStake({
    capital: 10,
    entryPrice: 0.5,
    avgGainPerUnit: 1.0,
    avgLossPerUnit: 1.0,
    winRateRecent: 0.51,
    recentTrades: 65,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.bindingConstraint, 'mise plancher');
  assert.equal(r.stake, Math.max(MIN_STAKE_EUR, 10 * 0.002));
  assert.ok(r.stake <= r.maxStakeAllowed + 1e-9);
});

test('20. capital minuscule : plancher > plafond → on ne trade PAS (pas de violation)', () => {
  const r = computeStake({
    capital: 3, // plafond quotidien = 0,05 € < plancher 0,10 €
    entryPrice: 0.5,
    avgGainPerUnit: 1.0,
    avgLossPerUnit: 1.0,
    winRateRecent: 0.51,
    recentTrades: 65,
  });
  assert.equal(r.stake, 0);
  assert.equal(r.skipped, true);
  assert.equal(r.capped, true);
  assert.match(r.rationale, /mise plancher .* dépasse le plafond/);
});

// ===========================================================================
// (7) ADAPTATIVITÉ, PURETÉ, ODDS THÉORIQUES
// ===========================================================================
test('21. la mise croît avec la WR (avant plafond) et reste au centime', () => {
  const small: StakeSizingInput = {
    capital: 1000,
    entryPrice: 0.5,
    avgGainPerUnit: 1.0,
    avgLossPerUnit: 1.0,
    recentTrades: 65,
  };
  const wrs = [0.51, 0.53, 0.55, 0.6];
  const raws = wrs.map((w) => computeStake({ ...small, winRateRecent: w }).rawKellyStake);
  for (let i = 1; i < raws.length; i++) {
    assert.ok(raws[i] > raws[i - 1], `WR ${wrs[i]} doit donner une mise brute > WR ${wrs[i - 1]}`);
  }
  for (const w of wrs) {
    const r = computeStake({ ...small, winRateRecent: w });
    assert.ok(cents(r.stake), `stake ${r.stake} non aligné au centime`);
  }
});

test('22. fonction PURE : entrée non mutée, résultat déterministe, odds théoriques', () => {
  const input = Object.freeze({ ...BASE, capital: 137, winRateRecent: 0.71 });
  const a = computeStake(input);
  const b = computeStake(input);
  assert.deepEqual(a, b, 'mêmes entrées ⇒ mêmes sorties');
  assert.equal(input.capital, 137, "l'entrée ne doit pas être mutée");

  // Sans gain/perte moyens : b = (1−e)/e, BE = e (cas théorique de RISK.md).
  const r = computeStake({ capital: 500, entryPrice: 0.6, winRateRecent: 0.7, recentTrades: 65 });
  assert.ok(near(r.breakEvenProb as number, 0.6, 1e-12), `BE=${r.breakEvenProb} doit valoir le prix 0,6`);
  assert.ok(r.rationale.includes('théoriques'));
});
