/**
 * tests/fair-value.test.ts — modèle de juste valeur Up/Down 5 min.
 * Exécution : `npx tsx --test tests/fair-value.test.ts`
 *
 * On exerce les VRAIES fonctions exportées (aucune copie, aucun mock réseau).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FAIR_VALUE_CONFIG as CFG,
  decide,
  effectiveCostPerShare,
  estimateFill,
  fairValueConfigFromEnv,
  normCdf,
  probUp,
  realizedVolPerSqrtSec,
  studentT4CdfStd,
  takerFeePerShare,
  twapVarianceSeconds,
} from '../src/services/fair-value.ts';
import { deriveRoundData } from '../src/services/round-market-data.ts';

const close = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);

// σ réaliste BTC : ~0,05 % par minute → par √s
const SIGMA = 0.0005 / Math.sqrt(60);

test('normCdf : valeurs de référence', () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.96), 0.975, 1e-4);
  close(normCdf(-1.96), 0.025, 1e-4);
});

test('t4 réduite : symétrique, centrée, intègre sa densité, queues plus épaisses que la normale', () => {
  close(studentT4CdfStd(0), 0.5, 1e-12);
  for (const x of [0.3, 1, 2.5]) close(studentT4CdfStd(x) + studentT4CdfStd(-x), 1, 1e-12);
  // Densité de la t4 réduite : f(x) = √2 · (3/8) · (1 + 2x²/4)^(−5/2)
  const pdf = (x: number) => Math.SQRT2 * 0.375 * Math.pow(1 + (2 * x * x) / 4, -2.5);
  let acc = 0;
  const steps = 15_000;
  const h = 1.5 / steps;
  for (let i = 0; i < steps; i++) acc += pdf((i + 0.5) * h) * h;
  close(0.5 + acc, studentT4CdfStd(1.5), 1e-6);
  assert.ok(studentT4CdfStd(3) < normCdf(3), 'queue droite plus lourde');
});

test('frais taker crypto_fees_v2 et coût réel', () => {
  close(takerFeePerShare(0.5, 0.07), 0.0175, 1e-12);
  close(effectiveCostPerShare(0.6, 0.07), 0.6 + 0.07 * 0.6 * 0.4, 1e-12);
});

test('vol réalisée : null sans assez de points, valeur exacte sinon', () => {
  assert.equal(realizedVolPerSqrtSec([100, 101], 60), null);
  const r = 0.001;
  const closes = [100];
  for (let i = 0; i < 20; i++) closes.push(closes[closes.length - 1] * Math.exp(i % 2 ? -r : r));
  close(realizedVolPerSqrtSec(closes, 60)!, r / Math.sqrt(60), 1e-12);
  // un point invalide est ignoré, pas transformé en rendement
  assert.ok(realizedVolPerSqrtSec([...closes, 0, NaN], 60)! > 0);
});

test('variance TWAP : continue en τ = W, plein chemin au-delà', () => {
  close(twapVarianceSeconds(300, 60), 260, 1e-12);
  close(twapVarianceSeconds(60, 60), 20, 1e-12);
  close(twapVarianceSeconds(60 - 1e-9, 60), 20, 1e-6);
  assert.equal(twapVarianceSeconds(0, 60), 0);
});

test('probUp : 0,5 au strike, monotone en spot, se rapproche de 0,5 quand τ augmente', () => {
  close(probUp({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!, 0.5, 1e-6); // précision de normCdf ≈ 1,5e-7
  const up = probUp({ spot: 100.05, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!;
  const upMore = probUp({ spot: 100.1, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!;
  const upLong = probUp({ spot: 100.05, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 240 })!;
  assert.ok(up > 0.5 && upMore > up && upLong < up && upLong > 0.5);
  // symétrie : spot sous le strike du même écart log
  close(probUp({ spot: 100 * 100 / 100.05, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!, 1 - up, 1e-6);
  // jamais 0 ni 1
  assert.ok(probUp({ spot: 200, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })! <= 0.99);
});

test('probUp : entrées invalides → null (jamais 0,5 par défaut)', () => {
  assert.equal(probUp({ spot: 0, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 }), null);
  assert.equal(probUp({ spot: 100, strike: NaN, sigmaPerSqrtSec: SIGMA, tauSec: 120 }), null);
  assert.equal(probUp({ spot: 100, strike: 100, sigmaPerSqrtSec: 0, tauSec: 120 }), null);
  assert.equal(probUp({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 0 }), null);
});

test('decide : un carnet calibré sur le modèle ne déclenche AUCUN trade (les frais mangent tout)', () => {
  const base = { spot: 100.04, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 150 };
  const p = probUp(base)!;
  const upAsk = Math.round(p * 100) / 100 + 0.01; // ask = juste valeur + 1 tick (demi-spread)
  const downAsk = Math.round((1 - p) * 100) / 100 + 0.01;
  const d = decide({ ...base, upAsk, downAsk });
  assert.equal(d.side, null, d.reason);
});

test('decide : un carnet en retard sur le spot déclenche l\'achat du bon côté', () => {
  const base = { spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 };
  const p = probUp(base)!;
  assert.ok(p > 0.75, `p=${p}`);
  const d = decide({ ...base, upAsk: 0.6, downAsk: 0.41 });
  assert.equal(d.side, 'UP', d.reason);
  close(d.best!.edge, p - effectiveCostPerShare(0.6, CFG.takerFeeRate), 1e-12);
  // même situation vue côté DOWN
  const dn = decide({ ...base, spot: 100 * 100 / 100.12, upAsk: 0.41, downAsk: 0.6 });
  assert.equal(dn.side, 'DOWN', dn.reason);
});

test('decide : bornes de τ et d\'ask respectées', () => {
  const base = { spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, upAsk: 0.6, downAsk: 0.41 };
  assert.equal(decide({ ...base, tauSec: 30 }).side, null);
  assert.equal(decide({ ...base, tauSec: 290 }).side, null);
  // favori à 0,95 : hors borne même si le modèle dit 0,99
  const big = decide({ ...base, spot: 101, tauSec: 120, upAsk: 0.95, downAsk: 0.06 });
  assert.equal(big.side, null, big.reason);
  // ask absent ou aberrant
  assert.equal(decide({ ...base, tauSec: 120, upAsk: null, downAsk: null }).side, null);
  assert.equal(decide({ ...base, tauSec: 120, upAsk: 1, downAsk: 0 }).side, null);
});

test('estimateFill : trie les asks, consomme la profondeur, respecte le prix limite', () => {
  const asks = [
    { price: 0.99, size: 1000 },
    { price: 0.62, size: 10 },
    { price: 0.61, size: 5 },
  ];
  const f = estimateFill(asks, 5);
  // 5 parts × 0,61 = 3,05 ; reste 1,95 à 0,62 → 3,1452 parts
  close(f.shares, 5 + 1.95 / 0.62, 1e-9);
  close(f.avgPrice!, 5 / f.shares, 1e-12);
  assert.equal(f.complete, true);
  const lim = estimateFill(asks, 50, 0.62);
  assert.equal(lim.complete, false);
  close(lim.spent, 3.05 + 6.2, 1e-9);
  const empty = estimateFill([], 5);
  assert.equal(empty.avgPrice, null);
  assert.equal(empty.complete, false);
});

test('config depuis env : valeurs invalides ignorées, bornes incohérentes rejetées', () => {
  const c = fairValueConfigFromEnv({ FV_MIN_EDGE: 'abc', FV_BASIS_BPS: '-3', FV_MIN_TAU_SEC: '200', FV_MAX_TAU_SEC: '100', FV_TAILS: 't4' });
  assert.equal(c.minEdge, CFG.minEdge);
  assert.equal(c.basisBps, CFG.basisBps);
  assert.equal(c.minTauSec, CFG.minTauSec);
  assert.equal(c.maxTauSec, CFG.maxTauSec);
  assert.equal(c.tails, 't4');
  assert.equal(fairValueConfigFromEnv({}).tails, 'normal', 'normale par défaut');
  assert.equal(fairValueConfigFromEnv({ FV_MIN_EDGE: '0.06' }).minEdge, 0.06);
});

test('deriveRoundData : strike = moyenne de la minute précédant l\'ouverture (TWAP), spot = close courant, flux périmé → null', () => {
  const slot = 1_790_000_100;
  const candles = [] as Array<{ openTimeMs: number; open: number; close: number }>;
  let px = 100;
  for (let i = -40; i <= 2; i++) {
    const open = px;
    px = px * Math.exp((i % 2 ? 1 : -1) * 0.0004);
    candles.push({ openTimeMs: (slot + i * 60) * 1000, open, close: px });
  }
  const now = (slot + 2 * 60 + 30) * 1000;
  const d = deriveRoundData(candles, slot, now, 'test')!;
  const prev = candles.find(c => c.openTimeMs === slot * 1000 - 60_000)!;
  close(d.strike, (prev.open + prev.close) / 2, 1e-12); // sans plus haut/plus bas : (O+C)/2
  // Ancien règlement ponctuel (FV_TWAP_WINDOW_SEC=0) : open de la bougie du slot.
  assert.equal(deriveRoundData(candles, slot, now, 'test', undefined, 0)!.strike, candles.find(c => c.openTimeMs === slot * 1000)!.open);
  assert.equal(d.spot, candles[candles.length - 1].close);
  close(d.sigmaPerSqrtSec, 0.0004 / Math.sqrt(60), 1e-9);
  assert.equal(deriveRoundData(candles, slot, now + 10 * 60_000, 'test'), null, 'flux figé');
  assert.equal(deriveRoundData(candles, slot + 3600, now, 'test'), null, 'slot absent');
});

test('deriveRoundData : sans flux temps réel, une bougie de plus de 65 s n\'est pas un spot', () => {
  const slot = 1_790_000_100;
  const candles = Array.from({ length: 30 }, (_, i) => ({ openTimeMs: (slot - 25 * 60 + i * 60) * 1000, open: 100, close: 100 * Math.exp((i % 2 ? 1 : -1) * 0.0004) }));
  const lastOpen = candles[candles.length - 1].openTimeMs;
  assert.ok(deriveRoundData(candles, slot, lastOpen + 30_000, 't'), 'minute en cours : OK');
  assert.equal(deriveRoundData(candles, slot, lastOpen + 90_000, 't'), null, 'bougie précédente : spot périmé');
  assert.ok(deriveRoundData(candles, slot, lastOpen + 90_000, 't', 120_000), 'avec flux temps réel : bougie = strike/vol seulement');
});

test('normInv : inverse de normCdf ; FV_Z_SCALE agit sur la confiance du modèle', async () => {
  const { normInv } = await import('../src/services/fair-value.ts');
  for (const p of [0.001, 0.02, 0.3, 0.5, 0.77, 0.99]) close(normCdf(normInv(p)!), p, 1e-6);
  assert.equal(normInv(0), null);
  assert.equal(normInv(1), null);
  const base = { spot: 100.05, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 };
  const p1 = probUp(base)!;
  const pLess = probUp(base, { ...CFG, zScale: 0.5 })!;
  const pMore = probUp(base, { ...CFG, zScale: 1.5 })!;
  assert.ok(pLess < p1 && p1 < pMore && pLess > 0.5);
  assert.equal(fairValueConfigFromEnv({ FV_Z_SCALE: '0.8' }).zScale, 0.8);
  assert.equal(fairValueConfigFromEnv({ FV_Z_SCALE: '9' }).zScale, 1, 'hors bornes → défaut');
});

test('fitZScale : retrouve la sur-confiance d\'un modèle simulé', async () => {
  const { fitZScale, byRound } = await import('../src/analysis/fv-analysis.ts');
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const recs = [];
  for (let i = 0; i < 3000; i++) {
    const z = 1.2 * gauss();
    const upWon = rnd() < normCdf(0.7 * z); // la vérité est moins tranchée que le modèle
    recs.push({ t: i, slug: `s${i}`, coin: 'BTC', tau: 150, spot: 1, strike: 1, sig: 1, pUp: normCdf(z), upAsk: null, downAsk: null, upAskSz: null, downAskSz: null, src: 't', act: 'hold' as const, upWon });
  }
  const fit = fitZScale(byRound(recs))!;
  assert.equal(fit.n, 3000);
  assert.ok(fit.lo <= 0.7 && fit.hi >= 0.7, `IC ${fit.lo}–${fit.hi} contient 0,7`);
  assert.ok(fit.hi < 1, 'sur-confiance détectée');
  assert.equal(fitZScale(byRound(recs.slice(0, 10))), null, 'trop peu de rounds');
});

test('estimateSell : bids du plus haut au plus bas, frais exacts par niveau, vente partielle signalée', async () => {
  const { estimateSell, takerFeePerShare } = await import('../src/services/fair-value.ts');
  const bids = [{ price: 0.5, size: 10 }, { price: 0.8, size: 1 }, { price: 0.7, size: 2 }];
  const r = estimateSell(bids, 2.5, 0.07);
  assert.equal(r.complete, true);
  close(r.shares, 2.5, 1e-12);
  const expected = 1 * (0.8 - takerFeePerShare(0.8, 0.07)) + 1.5 * (0.7 - takerFeePerShare(0.7, 0.07));
  close(r.netProceeds, expected, 1e-12);
  close(r.avgPrice!, (0.8 + 1.5 * 0.7) / 2.5, 1e-12);
  const partial = estimateSell([{ price: 0.6, size: 1 }], 3, 0.07);
  assert.equal(partial.complete, false);
  assert.equal(estimateSell([], 1, 0.07).avgPrice, null);
});

test('prix limite d\'achat : l\'edge minimal est exactement garanti, frais inclus', async () => {
  const { maxBuyPriceForEdge, estimateFill, estimateSell, takerFeePerShare } = await import('../src/services/fair-value.ts');
  const lim = maxBuyPriceForEdge(0.8, 0.04, 0.07)!;
  close(0.8 - effectiveCostPerShare(lim, 0.07), 0.04, 1e-12);
  assert.equal(maxBuyPriceForEdge(0.03, 0.04, 0.07), null, 'aucun prix possible');
  close(maxBuyPriceForEdge(0.8, 0.04, 0)!, 0.76, 1e-12);
  // coût exact niveau par niveau
  const f = estimateFill([{ price: 0.6, size: 1 }, { price: 0.7, size: 10 }], 1.3, 1, 0.07);
  const exact = (0.6 + takerFeePerShare(0.6, 0.07) + 1 * (0.7 + takerFeePerShare(0.7, 0.07))) / 2;
  close(f.avgCost!, exact, 1e-12);
  assert.equal(estimateFill([{ price: 0.6, size: 1 }], 0.6).avgCost, null, 'sans taux : pas de coût frais inclus');
  // vente : plancher net
  const s = estimateSell([{ price: 0.8, size: 1 }, { price: 0.5, size: 10 }], 2, 0.07, 0.7);
  assert.equal(s.complete, false, 'le bid à 0,50 est sous le plancher');
});

test('prix limite : stable numériquement même avec un taux de frais minuscule', async () => {
  const { maxBuyPriceForEdge } = await import('../src/services/fair-value.ts');
  for (const r of [1e-12, 1e-9, 1e-6, 0.07]) {
    const lim = maxBuyPriceForEdge(0.8, 0.04, r)!;
    close(0.8 - effectiveCostPerShare(lim, r), 0.04, 1e-12);
  }
});

test('mélange modèle/carnet : identité par défaut, carnet seul, symétrie, carnet manquant', async () => {
  const { blendWithMarket, bookMidUp } = await import('../src/services/fair-value.ts');
  close(bookMidUp(0.61, 0.41)!, 0.6, 1e-12);
  assert.equal(bookMidUp(null, 0.41), null);
  assert.equal(bookMidUp(0.61, 1), null);
  assert.equal(blendWithMarket(0.8, null, CFG), 0.8, '(1, 0) : modèle seul, carnet inutile');
  const market = { ...CFG, blendModel: 0, blendMarket: 1 };
  close(blendWithMarket(0.8, 0.6, market)!, 0.6, 1e-12);
  assert.equal(blendWithMarket(0.8, null, market), null, 'mélange configuré sans carnet → pas de probabilité');
  const mix = { ...CFG, blendModel: 0.7, blendMarket: 0.5 };
  const up = blendWithMarket(0.8, 0.6, mix)!;
  close(blendWithMarket(0.2, 0.4, mix)!, 1 - up, 1e-12); // même formule pour le côté Down
  assert.ok(up > 0.6 && up < 0.8 + 1e-9, `${up}`);
  assert.equal(fairValueConfigFromEnv({ FV_BLEND_MODEL: '0.7', FV_BLEND_MARKET: '0.4' }).blendMarket, 0.4);
  assert.equal(fairValueConfigFromEnv({ FV_BLEND_MARKET: '-1' }).blendMarket, 0, 'hors bornes → défaut');
});

test('decide avec mélange : un carnet jugé informé efface l\'edge ; pRaw garde le modèle seul', () => {
  const base = { spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120, upAsk: 0.6, downAsk: 0.41 };
  const raw = decide(base);
  assert.equal(raw.side, 'UP');
  assert.equal(raw.pRaw, raw.pUp);
  const trusting = decide(base, { ...CFG, blendModel: 0.05, blendMarket: 1 });
  assert.equal(trusting.side, null, trusting.reason);
  assert.equal(trusting.pRaw, raw.pUp);
  assert.ok(trusting.pUp! < raw.pUp!);
  const noBook = decide({ ...base, downAsk: null }, { ...CFG, blendMarket: 0.5 });
  assert.equal(noBook.side, null);
  assert.match(noBook.reason, /carnet incomplet/);
});

test('fitBlend : retrouve le poids du carnet, et ne le valide que hors échantillon', async () => {
  const { applyBlend, byRound, describeBlend, fitBlend } = await import('../src/analysis/fv-analysis.ts');
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  const world = (a: number, b: number) => {
    const recs = [];
    for (let i = 0; i < 4000; i++) {
      const lm = Math.max(-3, Math.min(3, 1.2 * gauss()));
      const lk = Math.max(-3, Math.min(3, 1.2 * gauss()));
      const pk = sig(lk);
      const upWon = rnd() < sig(a * lm + b * lk);
      recs.push({
        t: i, slug: `s${i}`, coin: 'BTC', tau: 150, spot: 1, strike: 1, sig: 1, pUp: sig(lm),
        upAsk: pk + 0.01, downAsk: 1 - pk + 0.01, upAskSz: null, downAskSz: null, src: 't', act: 'hold' as const, upWon,
      });
    }
    return byRound(recs);
  };
  const both = fitBlend(world(0.6, 0.8))!;
  assert.ok(Math.abs(both.a - 0.6) < 0.2 && Math.abs(both.b - 0.8) < 0.2, `${both.a} / ${both.b}`);
  assert.ok(both.oos!.tVsModel! < -2, 'le mélange bat le modèle seul sur la moitié jamais vue');
  assert.match(describeBlend(both, CFG).join('\n'), /essayer FV_BLEND_MODEL=/);

  const modelOnly = fitBlend(world(1, 0))!;
  assert.ok(modelOnly.b < 0.2, `${modelOnly.b}`);
  assert.match(describeBlend(modelOnly, CFG).join('\n'), /garder le réglage actuel/);

  const marketKnows = fitBlend(world(0, 1))!;
  assert.match(describeBlend(marketKnows, CFG).join('\n'), /AUCUN edge démontré/);

  assert.equal(fitBlend(world(1, 0).slice(0, 40)), null, 'trop peu de rounds');

  const r = world(1, 0).slice(0, 3);
  assert.deepEqual(applyBlend(r, 1, 0).map(l => l[0].pUp), r.map(l => l[0].pUp));
  for (const [l] of applyBlend(r, 0, 1)) close(l.pUp!, (l.upAsk! + 1 - l.downAsk!) / 2, 1e-9);
});

test('fitBlendParams : optimum exact, y compris contraint sur un bord (poids négatif interdit)', async () => {
  const { blendLogLik, fitBlendParams } = await import('../src/analysis/fv-analysis.ts');
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  const pts = (a: number, b: number) => Array.from({ length: 3000 }, (_, i) => {
    const lm = 1.2 * gauss();
    const lk = 1.2 * gauss();
    return { slug: `s${i}`, lm, lk, y: (rnd() < sig(a * lm + b * lk) ? 1 : 0) as 0 | 1, w: 1 };
  });
  const isLocalMax = (p: ReturnType<typeof pts>, a: number, b: number) => {
    const ll = blendLogLik(p, a, b);
    for (const [da, db] of [[0.03, 0], [-0.03, 0], [0, 0.03], [0, -0.03]]) {
      const na = a + da;
      const nb = b + db;
      if (na < 0 || nb < 0 || na > 3 || nb > 3) continue;
      assert.ok(blendLogLik(p, na, nb) <= ll + 1e-9, `(${na}, ${nb}) meilleur que (${a}, ${b})`);
    }
  };
  const inner = pts(0.7, 0.5);
  const f1 = fitBlendParams(inner);
  isLocalMax(inner, f1.a, f1.b);
  const edge = pts(1, -0.6); // vrai poids du carnet négatif → borne b = 0
  const f2 = fitBlendParams(edge);
  assert.equal(f2.b, 0);
  isLocalMax(edge, f2.a, f2.b);
  assert.deepEqual(fitBlendParams([]), { a: 1, b: 0 }, 'aucune donnée : modèle seul');
});

test('verdict du mélange : carnet = vérité, modèle = copie bruitée et peu confiante → jamais « essayer »', async () => {
  const { blendVerdict, byRound, describeBlend, fitBlend } = await import('../src/analysis/fv-analysis.ts');
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  for (const seed0 of [1, 2, 3, 4, 5]) {
    let seed = seed0 * 7919;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const recs = [];
    for (let i = 0; i < 400; i++) {
      const lk = Math.max(-3, Math.min(3, 1.2 * gauss())); // le carnet connaît la vraie probabilité
      const lm = 0.4 * (lk + 0.8 * gauss()); // le modèle n'en sait pas plus (bruit, sous-confiance)
      const pk = sig(lk);
      recs.push({
        t: i, slug: `s${i}`, coin: 'BTC', tau: 150, spot: 1, strike: 1, sig: 1, pUp: sig(lm),
        upAsk: pk + 0.01, downAsk: 1 - pk + 0.01, upAskSz: null, downAskSz: null, src: 't', act: 'hold' as const, upWon: rnd() < pk,
      });
    }
    const fit = fitBlend(byRound(recs));
    assert.notEqual(blendVerdict(fit, { blendModel: 1, blendMarket: 0 }), 'apply', describeBlend(fit, { blendModel: 1, blendMarket: 0 }).join('\n'));
  }
});

test('fitBlendParams : modèle très confiant (logits saturés à ±4,6) → même optimum qu\'une recherche exhaustive', async () => {
  const { blendLogLik, fitBlendParams } = await import('../src/analysis/fv-analysis.ts');
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  const L = Math.log(0.99 / 0.01);
  for (const [ta, tb] of [[0.3, 0.7], [0.2, -0.5], [0.1, 1]]) {
    for (const seed0 of [1, 2, 3]) {
      let seed = seed0 * 104_729;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
      const pts = Array.from({ length: 2000 }, (_, i) => {
        const lm = Math.max(-L, Math.min(L, 3 * gauss()));
        const lk = Math.max(-L, Math.min(L, 1.2 * gauss()));
        return { slug: `s${i}`, lm, lk, y: (rnd() < sig(ta * lm + tb * lk) ? 1 : 0) as 0 | 1, w: 1 };
      });
      let gridBest = -Infinity;
      for (let a = 0; a <= 3 + 1e-9; a += 0.05) for (let b = 0; b <= 3 + 1e-9; b += 0.05) gridBest = Math.max(gridBest, blendLogLik(pts, a, b));
      const f = fitBlendParams(pts);
      // l'arrondi à 0,01 coûte au plus une fraction de point de log-vraisemblance
      assert.ok(blendLogLik(pts, f.a, f.b) >= gridBest - 0.5, `(${ta}, ${tb}) graine ${seed0} : (${f.a}, ${f.b}) sous la grille`);
      if (tb < 0) assert.equal(f.b, 0, 'poids négatif interdit → bord b = 0');
    }
  }
});

test('FV_Z_SCALE jamais suggéré en plus d\'un mélange actif ou proposé', async () => {
  const { zScaleConflictsWithBlend } = await import('../src/analysis/fv-analysis.ts');
  const raw = { blendModel: 1, blendMarket: 0 };
  assert.equal(zScaleConflictsWithBlend('keep', raw), false);
  assert.equal(zScaleConflictsWithBlend('noEdge', raw), false);
  assert.equal(zScaleConflictsWithBlend('apply', raw), true);
  assert.equal(zScaleConflictsWithBlend('current', { blendModel: 0.6, blendMarket: 0.4 }), true);
  assert.equal(zScaleConflictsWithBlend('keep', { blendModel: 0.6, blendMarket: 0.4 }), true, 'mélange déjà actif');
});

test('loi t4 : inverse exacte ; remise à l\'échelle de FV_Z_SCALE cohérente avec probUp (normale ET t4)', async () => {
  const { studentT4CdfStd, studentT4InvStd } = await import('../src/services/fair-value.ts');
  const { normalizeZScale, zScaleAdvice } = await import('../src/analysis/fv-analysis.ts');
  for (const x of [-3, -1, -0.2, 0, 0.5, 2.5]) close(studentT4InvStd(studentT4CdfStd(x))!, x, 1e-9);
  const base = { spot: 100.08, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 150 };
  for (const tails of ['normal', 't4'] as const) {
    const at = (z: number) => probUp(base, { ...CFG, tails, zScale: z })!;
    const rec = { t: 0, slug: 's', coin: 'BTC', tau: 150, spot: 1, strike: 1, sig: 1, pUp: at(0.6), pRaw: at(0.6), zs: 0.6,
      ...(tails === 't4' ? { tl: 't4' as const } : {}),
      upAsk: null, downAsk: null, upAskSz: null, downAskSz: null, src: 't', act: 'hold' as const, upWon: true };
    const [[r]] = normalizeZScale([[rec]], 1, tails);
    close(r.pRaw!, at(1), 1e-6); // même probabilité que si le bot avait tourné à FV_Z_SCALE=1
  }
  assert.match(zScaleAdvice({ n: 100, m: 2.6, lo: 2.3, hi: 2.9 }, 1, false), /hors des bornes/);
  assert.match(zScaleAdvice({ n: 100, m: 0.8, lo: 0.7, hi: 0.9 }, 1, false), /SUR-confiant : essayer FV_Z_SCALE=0.8/);
  assert.match(zScaleAdvice({ n: 100, m: 0.95, lo: 0.8, hi: 1.1 }, 1, false), /rien à changer/);
});

test('journal couvrant un changement de FV_TAILS : chaque évaluation est convertie depuis SA loi', async () => {
  const { normalizeZScale } = await import('../src/analysis/fv-analysis.ts');
  const base = { spot: 100.08, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 150 };
  const pT4 = probUp(base, { ...CFG, tails: 't4', zScale: 0.7 })!;
  const rec = { t: 0, slug: 's', coin: 'BTC', tau: 150, spot: 1, strike: 1, sig: 1, pUp: pT4, pRaw: pT4, zs: 0.7, tl: 't4' as const,
    upAsk: null, downAsk: null, upAskSz: null, downAskSz: null, src: 't', act: 'hold' as const, upWon: true };
  const [[r]] = normalizeZScale([[rec]], 1, 'normal');
  close(r.pRaw!, probUp(base, { ...CFG, tails: 'normal', zScale: 1 })!, 1e-6);
  assert.equal(r.tl, undefined, 'converti en loi normale');
});

test('strikeFromCandles : (O+H+L+C)/4 de la bougie précédant l\'ouverture ; repli (O+C)/2 ; W < 60 ; bougie absente → null', async () => {
  const { strikeFromCandles } = await import('../src/services/round-market-data.ts');
  const slot = 1_790_000_100;
  const prev = { openTimeMs: slot * 1000 - 60_000, open: 100, close: 102, high: 103, low: 99 };
  const at = (ms: number) => (ms === prev.openTimeMs ? prev : ms === slot * 1000 ? { openTimeMs: ms, open: 102.5, close: 101 } : undefined);
  close(strikeFromCandles(at, slot, 60)!, (100 + 103 + 99 + 102) / 4, 1e-12);
  close(strikeFromCandles(at, slot, 30)!, 102 + ((100 + 103 + 99 + 102) / 4 - 102) / 2, 1e-12); // W = 30 s : ramené vers la clôture
  assert.equal(strikeFromCandles(at, slot, 0), 102.5, 'règlement ponctuel : open du slot');
  const incoherent = { ...prev, high: 101 }; // plus haut sous la clôture : donnée fausse
  close(strikeFromCandles(ms => (ms === prev.openTimeMs ? incoherent : undefined), slot, 60)!, 101, 1e-12);
  assert.equal(strikeFromCandles(() => undefined, slot, 60), null);
});

test('edge exigé : minEdge + k·σ_p (bruit du prix à battre), plus grand près de 50/50 et à faible vol', async () => {
  const { probNoiseSd } = await import('../src/services/fair-value.ts');
  const sig = 0.0006 / Math.sqrt(60);
  const atMoney = probNoiseSd({ spot: 100, strike: 100, sigmaPerSqrtSec: sig, tauSec: 120 });
  const far = probNoiseSd({ spot: 100.15, strike: 100, sigmaPerSqrtSec: sig, tauSec: 120 });
  const highVol = probNoiseSd({ spot: 100, strike: 100, sigmaPerSqrtSec: 3 * sig, tauSec: 120 });
  assert.ok(atMoney > far && far > 0, `${atMoney} > ${far}`);
  assert.ok(highVol < atMoney, 'à vol plus forte, l\'écart de flux pèse moins');
  assert.equal(probNoiseSd({ spot: 100, strike: 100, sigmaPerSqrtSec: sig, tauSec: 120 }, { ...CFG, strikeNoiseSec: 0, basisBps: 0 }), 0);
  const input = { spot: 100.05, strike: 100, sigmaPerSqrtSec: sig, tauSec: 120, upAsk: 0.5, downAsk: 0.52 };
  const d = decide(input);
  close(d.requiredEdge!, CFG.minEdge + CFG.noiseEdgeK * d.noiseSd!, 1e-12);
  assert.equal(decide(input, { ...CFG, noiseEdgeK: 0 }).requiredEdge, CFG.minEdge);
  if (!d.side) assert.match(d.reason, /bruit du prix à battre/);
});

test('règlement TWAP : ni entrée ni réévaluation dans la dernière minute (part déjà moyennée inconnue)', () => {
  const sig = 0.0006 / Math.sqrt(60);
  const d = decide({ spot: 100.3, strike: 100, sigmaPerSqrtSec: sig, tauSec: 55, upAsk: 0.5, downAsk: 0.5 }, { ...CFG, minTauSec: 30 });
  assert.equal(d.side, null);
  assert.match(d.reason, /fenêtre de moyenne du règlement/);
});
