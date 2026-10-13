/**
 * tests/llm-guards.test.ts — garde-fous du code appliqués après la décision des agents (stratégie
 * papier « llm ») : chaque code d'abstention, plafonds de mise et de prix, exécution sur le carnet
 * relu, fraîcheur, et propriété « jamais au-delà d'une limite codée » sur des milliers de cas.
 * Exécution : `npx tsx --test tests/llm-guards.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGuards, edgeLimitPrice, llmStakeCapUsd,
  type GuardCode, type GuardContext, type LlmGuardDecision, type LlmAction,
} from '../src/strategy/llm/guards.ts';
import { effectiveCostPerShare, maxBuyPriceForEdge } from '../src/services/fair-value.ts';

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  riskAllowed: true,
  alreadyBetThisRound: false,
  stakeCapUsd: 5,
  minOrderUsd: 1,
  feeRate: 0.07,
  maxAsk: 0.92,
  minEdge: 0.04,
  asksNow: [[0.55, 100], [0.56, 100], [0.6, 200]],
  formulaPSideAtSnapshot: 0.65,
  formulaPSideNow: 0.64,
  ...over,
});
const dec = (over: Partial<LlmGuardDecision> = {}): LlmGuardDecision => ({
  action: 'acheter_up', probaUp: 0.7, prixLimite: 0.6, miseUsd: 3, ...over,
});
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('ok : achat au meilleur ask sous la limite, mise frais compris, parts = mise / coût par part', () => {
  const r = applyGuards(dec(), ctx());
  assert.equal(r.code, 'ok', r.reason);
  assert.equal(r.side, 'UP');
  assert.equal(r.stakeUsd, 3);
  assert.equal(r.limitPrice, 0.6, 'limite de l\'agent (0,6) sous maxAsk et sous la limite de marge (≈ 0,644)');
  const c = effectiveCostPerShare(0.55, 0.07); // 0,55 + 0,07·0,55·0,45 = 0,567325
  close(r.fill!.vwap, 0.55);
  close(r.fill!.costPerShare, c);
  close(r.fill!.shares, 3 / c);
  close(r.fill!.costUsd, 3);
});

test('carnet mince : remplissage partiel accepté au-dessus du minimum, niveaux au-delà de la limite ignorés', () => {
  const r = applyGuards(dec({ miseUsd: 5 }), ctx({ asksNow: [{ price: 0.58, size: 3 }, { price: 0.55, size: 2 }, { price: 0.62, size: 100 }] }));
  assert.equal(r.code, 'ok', r.reason);
  const spent = 0.55 * 2 + 0.58 * 3; // 2,84 $ ; 0,62 > limite 0,6
  const fees = 2 * 0.07 * 0.55 * 0.45 + 3 * 0.07 * 0.58 * 0.42;
  close(r.fill!.shares, 5);
  close(r.fill!.vwap, spent / 5);
  close(r.fill!.costUsd, spent + fees);
  assert.ok(r.fill!.costUsd < r.stakeUsd);
});

test('abstention de l\'agent : rien d\'autre n\'est évalué', () => {
  const r = applyGuards(dec({ action: 'abstention' }), ctx({ riskAllowed: false, feeRate: Number.NaN }));
  assert.deepEqual(
    { code: r.code, side: r.side, stakeUsd: r.stakeUsd, limitPrice: r.limitPrice, fill: r.fill },
    { code: 'abstention_agent', side: null, stakeUsd: 0, limitPrice: null, fill: null },
  );
});

test('risque refusé, puis déjà parié ce round (dans cet ordre)', () => {
  assert.equal(applyGuards(dec(), ctx({ riskAllowed: false, alreadyBetThisRound: true })).code, 'bloque_risque');
  const r = applyGuards(dec(), ctx({ alreadyBetThisRound: true }));
  assert.equal(r.code, 'deja_parie');
  assert.equal(r.stakeUsd, 0);
  assert.equal(r.fill, null);
});

test('paramètres non évaluables : NaN ou Infinity ne passent jamais', () => {
  const bad: Array<[Partial<GuardContext>, Partial<LlmGuardDecision>]> = [
    [{ feeRate: Number.NaN }, {}],
    [{ feeRate: 1 }, {}],
    [{ stakeCapUsd: Number.POSITIVE_INFINITY }, {}],
    [{ stakeCapUsd: Number.NaN }, {}],
    [{ maxAsk: 1.2 }, {}],
    [{ minEdge: -0.01 }, {}],
    [{ formulaPSideNow: Number.NaN }, {}],
    [{ staleDrop: Number.NaN }, {}],
    [{}, { probaUp: 1.2 }],
    [{}, { miseUsd: Number.NaN }],
    [{}, { prixLimite: 0 }],
  ];
  for (const [c, d] of bad) {
    const r = applyGuards(dec(d), ctx(c));
    assert.equal(r.code, 'parametres_invalides', JSON.stringify({ c, d }));
    assert.equal(r.stakeUsd, 0);
    assert.equal(r.fill, null);
  }
});

test('fraîcheur : P(côté) de la formule tombée de plus de 0,05 depuis l\'instantané → marché a bougé', () => {
  assert.equal(applyGuards(dec(), ctx({ formulaPSideAtSnapshot: 0.65, formulaPSideNow: 0.59 })).code, 'marche_a_bouge');
  assert.equal(applyGuards(dec(), ctx({ formulaPSideAtSnapshot: 0.65, formulaPSideNow: 0.61 })).code, 'ok', 'baisse 0,04 tolérée');
  assert.equal(applyGuards(dec(), ctx({ formulaPSideAtSnapshot: 0.65, formulaPSideNow: 0.8 })).code, 'ok', 'mouvement en faveur du côté');
  assert.equal(applyGuards(dec(), ctx({ formulaPSideAtSnapshot: 0.65, formulaPSideNow: 0.59, staleDrop: 0.1 })).code, 'ok', 'seuil réglable');
  assert.equal(applyGuards(dec(), ctx({ formulaPSideAtSnapshot: 0.65, formulaPSideNow: 0.62, staleDrop: 0.02 })).code, 'marche_a_bouge');
});

test('mise démesurée plafonnée par le code ; plafond sous le minimum → mise_sous_minimum', () => {
  const r = applyGuards(dec({ miseUsd: 10_000 }), ctx({ stakeCapUsd: 4.5 }));
  assert.equal(r.code, 'ok', r.reason);
  assert.equal(r.stakeUsd, 4.5);
  assert.ok(r.fill!.costUsd <= 4.5);
  assert.equal(applyGuards(dec({ miseUsd: 10_000 }), ctx({ stakeCapUsd: 0.8 })).code, 'mise_sous_minimum');
  assert.equal(applyGuards(dec({ miseUsd: 0.5 }), ctx()).code, 'mise_sous_minimum', 'mise de l\'agent elle-même trop petite');
  assert.equal(applyGuards(dec(), ctx({ stakeCapUsd: -3 })).code, 'mise_sous_minimum');
});

test('prix limite de l\'agent au-dessus de P − frais − marge : recalculé par le code', () => {
  const r = applyGuards(dec({ probaUp: 0.6, prixLimite: 0.99 }), ctx({ asksNow: [[0.5, 1], [0.53, 2], [0.55, 100]] }));
  assert.equal(r.code, 'ok', r.reason);
  const lim = r.limitPrice!;
  assert.ok(effectiveCostPerShare(lim, 0.07) <= 0.6 - 0.04, 'coût effectif à la limite ≤ P − marge');
  close(lim, maxBuyPriceForEdge(0.6, 0.04, 0.07)!, 1e-12);
  assert.ok(lim > 0.53 && lim < 0.55, `limite ${lim}`);
  // 0,55 coûte 0,567 > 0,56 : seuls les niveaux 0,50 et 0,53 sont pris.
  close(r.fill!.vwap, (0.5 * 1 + 0.53 * 2) / 3);
  assert.ok(r.fill!.costPerShare <= 0.56);
});

test('côté Down : P(côté) = 1 − P(Up) ; maxAsk plafonne le prix', () => {
  const r = applyGuards(dec({ action: 'acheter_down', probaUp: 0.3, prixLimite: 0.99 }), ctx({ asksNow: [[0.6, 50]] }));
  assert.equal(r.code, 'ok', r.reason);
  assert.equal(r.side, 'DOWN');
  close(r.limitPrice!, maxBuyPriceForEdge(0.7, 0.04, 0.07)!, 1e-12);
  const m = applyGuards(dec({ probaUp: 1, prixLimite: 0.99 }), ctx({ asksNow: [[0.9, 50], [0.93, 50]] }));
  assert.equal(m.code, 'ok', m.reason);
  assert.equal(m.limitPrice, 0.92, 'maxAsk 0,92');
  close(m.fill!.vwap, 0.9);
});

test('aucune marge possible : P(côté) − marge ≤ 0 → sans_marge', () => {
  const r = applyGuards(dec({ probaUp: 0.03 }), ctx());
  assert.equal(r.code, 'sans_marge');
  assert.equal(r.fill, null);
  assert.equal(applyGuards(dec({ action: 'acheter_down', probaUp: 0.97 }), ctx()).code, 'sans_marge');
});

test('prix parti : carnet vide, tout au-dessus de la limite, ou rempli sous le minimum', () => {
  for (const asksNow of [[], [[0.61, 100], [0.7, 100]], [[0.55, 1]], [[0, 50], [Number.NaN, 5], [0.5, -3]]] as GuardContext['asksNow'][]) {
    const r = applyGuards(dec(), ctx({ asksNow }));
    assert.equal(r.code, 'prix_parti', JSON.stringify(asksNow));
    assert.equal(r.stakeUsd, 0);
    assert.equal(r.fill, null);
    assert.equal(r.limitPrice, 0.6, 'limite rapportée pour le journal');
  }
});

test('limite par bissection = racine fermée de maxBuyPriceForEdge, sans jamais dépasser la marge', () => {
  for (const rate of [0, 0.02, 0.07, 0.25, 0.9]) {
    for (let p = 0.05; p <= 1; p += 0.0137) {
      for (const e of [0, 0.01, 0.04, 0.1]) {
        const b = edgeLimitPrice(p, e, rate);
        const f = maxBuyPriceForEdge(p, e, rate);
        if (f === null) { assert.equal(b, null); continue; }
        assert.ok(b !== null);
        assert.ok(Math.abs(b - f) < 1e-12, `p ${p} e ${e} r ${rate} : ${b} vs ${f}`);
        assert.ok(effectiveCostPerShare(b, rate) <= p - e, 'invariant exact');
      }
    }
  }
  assert.equal(edgeLimitPrice(1, 0, 0.07), 1);
  assert.equal(edgeLimitPrice(0.04, 0.04, 0.07), null);
  assert.equal(edgeLimitPrice(0.6, 0.04, Number.NaN), null);
});

test('plafond de mise : le plus petit des trois, 0 si l\'un est invalide', () => {
  assert.equal(llmStakeCapUsd({ maxStakeUsd: 10, strategyCapUsd: 3.5, riskRoomUsd: 7 }), 3.5);
  assert.equal(llmStakeCapUsd({ maxStakeUsd: 10, strategyCapUsd: 3.5, riskRoomUsd: 0 }), 0);
  assert.equal(llmStakeCapUsd({ maxStakeUsd: Number.POSITIVE_INFINITY, strategyCapUsd: 3.5, riskRoomUsd: 7 }), 0);
  assert.equal(llmStakeCapUsd({ maxStakeUsd: 10, strategyCapUsd: Number.NaN, riskRoomUsd: 7 }), 0);
  assert.equal(llmStakeCapUsd({ maxStakeUsd: 10, strategyCapUsd: 3.5, riskRoomUsd: -1 }), 0);
});

test('propriété (graine fixe, 20 000 cas) : jamais au-delà d\'une limite codée, aucun pari quand un garde-fou refuse', () => {
  // mulberry32 (même générateur que tests/stats.test.ts)
  let a = 20_261_013;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const seen = new Map<GuardCode, number>();
  for (let i = 0; i < 20_000; i++) {
    const action: LlmAction = pick(['acheter_up', 'acheter_up', 'acheter_down', 'acheter_down', 'abstention'] as const);
    const d: LlmGuardDecision = {
      action,
      probaUp: pick([0, 1, rnd(), rnd(), rnd()]),
      prixLimite: pick([0.99, 0.01 + 0.98 * rnd(), 0.01 + 0.98 * rnd()]),
      miseUsd: pick([10_000, 50 * rnd(), 5 * rnd()]),
    };
    const levels = Array.from({ length: Math.floor(rnd() * 7) }, () => [0.01 + 0.98 * rnd(), pick([1, 20, 200]) * rnd()] as [number, number]);
    const c: GuardContext = {
      riskAllowed: rnd() < 0.9,
      alreadyBetThisRound: rnd() < 0.1,
      stakeCapUsd: pick([0, 0.5, 20 * rnd(), 20 * rnd()]),
      minOrderUsd: pick([1, 1, 0]),
      feeRate: pick([0, 0.07, 0.07, 0.25, 0.9]),
      maxAsk: 0.5 + 0.5 * rnd(),
      minEdge: pick([0, 0.1 * rnd(), 0.04]),
      asksNow: rnd() < 0.5 ? levels : levels.map(([price, size]) => ({ price, size })),
      formulaPSideAtSnapshot: rnd(),
      formulaPSideNow: rnd(),
      staleDrop: pick([undefined, 0.05, 0.2, 1]),
    };
    if (rnd() < 0.01) c.feeRate = Number.NaN;
    const r = applyGuards(d, c);
    seen.set(r.code, (seen.get(r.code) ?? 0) + 1);
    const ctxt = JSON.stringify({ i, d, c, r });
    if (r.code !== 'ok') {
      assert.equal(r.stakeUsd, 0, ctxt);
      assert.equal(r.fill, null, ctxt);
      continue;
    }
    const pSide = action === 'acheter_up' ? d.probaUp : 1 - d.probaUp;
    const f = r.fill!;
    assert.notEqual(action, 'abstention', ctxt);
    assert.ok(c.riskAllowed && !c.alreadyBetThisRound, ctxt);
    assert.ok(c.formulaPSideAtSnapshot - c.formulaPSideNow <= (c.staleDrop ?? 0.05), ctxt);
    assert.equal(r.side, action === 'acheter_up' ? 'UP' : 'DOWN', ctxt);
    assert.ok(r.stakeUsd <= c.stakeCapUsd && r.stakeUsd <= d.miseUsd && r.stakeUsd >= c.minOrderUsd, ctxt);
    assert.ok(f.costUsd <= r.stakeUsd, ctxt);
    assert.ok(r.limitPrice! <= d.prixLimite && r.limitPrice! <= c.maxAsk, ctxt);
    assert.ok(effectiveCostPerShare(r.limitPrice!, c.feeRate) <= pSide - c.minEdge, ctxt);
    assert.ok(f.costPerShare <= pSide - c.minEdge, ctxt);
    assert.ok(f.vwap <= r.limitPrice! + 1e-12 && f.shares > 0, ctxt);
    assert.ok(f.shares * f.vwap >= c.minOrderUsd - 1e-9, ctxt);
  }
  // La propriété n'est pas vide : chaque issue est réellement exercée.
  for (const code of ['ok', 'abstention_agent', 'bloque_risque', 'deja_parie', 'parametres_invalides', 'marche_a_bouge', 'mise_sous_minimum', 'sans_marge', 'prix_parti'] as GuardCode[]) {
    assert.ok((seen.get(code) ?? 0) > 20, `${code} : ${seen.get(code) ?? 0} cas`);
  }
});
