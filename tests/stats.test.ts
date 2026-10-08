/**
 * tests/stats.test.ts — t avec erreurs groupées par créneau.
 * Exécution : `npx tsx --test tests/stats.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addToClusterSums, clusteredMeanT, clusteredTFromSums, slotKey, type ClusterSums } from '../src/analysis/stats.ts';

test('un groupe par observation : t usuel exact', () => {
  const xs = [0.3, -0.1, 0.5, 0.2, -0.4, 0.6];
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  const r = clusteredMeanT(xs.map((x, i) => ({ key: i, x })));
  assert.ok(Math.abs(r.t! - m / (sd / Math.sqrt(xs.length))) < 1e-12);
});

test('observations corrélées dans un créneau : t ramené à sa vraie dispersion sous H0', () => {
  // mulberry32 : un LCG en flottants perd sa précision au-delà de 2^53 et corrèle les tirages
  let a = 9;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const tsNaive: number[] = [];
  const tsCl: number[] = [];
  for (let run = 0; run < 300; run++) {
    const obs: Array<{ key: number; x: number }> = [];
    for (let slot = 0; slot < 200; slot++) {
      const common = gauss();
      for (let c = 0; c < 5; c++) obs.push({ key: slot, x: 0.8 * common + 0.6 * gauss() }); // ρ ≈ 0,64
    }
    tsCl.push(clusteredMeanT(obs).t!);
    tsNaive.push(clusteredMeanT(obs.map((o, i) => ({ key: i, x: o.x }))).t!);
  }
  const sd = (a: number[]) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  assert.ok(sd(tsNaive) > 1.5, `naïf : sd ${sd(tsNaive)}`);
  assert.ok(Math.abs(sd(tsCl) - 1) < 0.15, `groupé : sd ${sd(tsCl)}`);
});

test('version incrémentale (sommes persistées) = version directe', () => {
  const obs = [{ key: 'a', x: 1 }, { key: 'b', x: -2 }, { key: 'a', x: 0.5 }, { key: 'c', x: 3 }, { key: 'b', x: 1.5 }];
  const sums: ClusterSums = { n: 0, sum: 0, clusters: 0, sumS2: 0, sumNS: 0, sumN2: 0 };
  const groups = new Map<string, { S: number; k: number }>();
  for (const o of obs) groups.set(o.key, addToClusterSums(sums, groups.get(o.key) ?? { S: 0, k: 0 }, o.x));
  assert.ok(Math.abs(clusteredTFromSums(sums)! - clusteredMeanT(obs).t!) < 1e-12);
  assert.equal(slotKey('btc-updown-5m-1790000100'), '1790000100');
  assert.equal(slotKey('s12'), 's12');
});
