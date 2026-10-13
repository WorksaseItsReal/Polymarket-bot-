/**
 * tests/llm-stop-rule.test.ts — règle d'arrêt pré-enregistrée de la campagne « llm » contre la
 * formule : Brier et gain appariés, z groupés par créneau, deux regards (500 / 1 000) aux bornes
 * d'O'Brien-Fleming. Données synthétiques à graine fixe.
 * Exécution : `npx tsx --test tests/llm-stop-rule.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairedVerdict, STOP_RULE, unitGain, type PairedDecision } from '../src/strategy/llm/stop-rule.ts';
import { effectiveCostPerShare } from '../src/services/fair-value.ts';

// mulberry32 (même générateur que tests/stats.test.ts)
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scenario {
  /** Bruit de P(Up) de llm, de la formule et du prix du marché autour de la vraie probabilité. */
  sdL: number;
  sdF: number;
  sdM: number;
  /** Glissement de prix subi par llm (latence) : achète plus cher que l'instantané. */
  slipL?: number;
}

/**
 * Rounds synthétiques : vraie P(Up) q, issue y ~ Bernoulli(q), deux rounds par créneau de 5 min.
 * Chaque stratégie achète le côté dont sa P dépasse le coût effectif (+ 0,04), sinon ne parie pas ;
 * son gain pour 1 $ est `unitGain` au coût effectif payé.
 */
function campaign(seed: number, n: number, sc: Scenario, slotOffset = 0): PairedDecision[] {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const clamp = (x: number) => Math.min(0.97, Math.max(0.03, x));
  const gain = (p: number, m: number, y: 0 | 1, slip: number) => {
    const cu = effectiveCostPerShare(Math.min(0.99, m + slip), 0.07);
    const cd = effectiveCostPerShare(Math.min(0.99, 1 - m + slip), 0.07);
    if (p - cu > 0.04) return unitGain(y === 1, cu);
    if (1 - p - cd > 0.04) return unitGain(y === 0, cd);
    return 0;
  };
  const out: PairedDecision[] = [];
  for (let i = 0; i < n; i++) {
    const slot = String(1_790_000_000 + 300 * (slotOffset + Math.floor(i / 2)));
    const q = 0.2 + 0.6 * r();
    const y: 0 | 1 = r() < q ? 1 : 0;
    const m = clamp(q + sc.sdM * gauss());
    const pLlm = clamp(q + sc.sdL * gauss());
    const pFormule = clamp(q + sc.sdF * gauss());
    out.push({ slot, pLlm, pFormule, y, gLlm: gain(pLlm, m, y, sc.slipL ?? 0), gFormule: gain(pFormule, m, y, 0) });
  }
  return out;
}

const NETTEMENT_MEILLEUR: Scenario = { sdL: 0, sdF: 0.3, sdM: 0.3 };
const MODERE: Scenario = { sdL: 0, sdF: 0.2, sdM: 0.15 };
const PIRE_BRIER: Scenario = { sdL: 0.2, sdF: 0.02, sdM: 0.1 };
const PIRE_GAIN: Scenario = { sdL: 0.03, sdF: 0.03, sdM: 0.1, slipL: 0.08 };
const LEGEREMENT_MEILLEUR: Scenario = { sdL: 0.05, sdF: 0.07, sdM: 0.1 };

test('bornes pré-enregistrées : 500 → 2,80 ; 1 000 → 1,98', () => {
  assert.deepEqual(STOP_RULE, { nIntermediaire: 500, zIntermediaire: 2.8, nFinal: 1000, zFinal: 1.98 });
});

test('O\'Brien-Fleming : α global ≈ 5 % par critère sous H0 (Monte-Carlo, graine fixe)', () => {
  // Z_500 = W(1/2)/√(1/2), Z_1000 = W(1) : corrélation √(1/2). Rejet si |Z_500| ≥ 2,80 ou |Z_1000| ≥ 1,98.
  const r = rng(5);
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const N = 400_000;
  let rejections = 0;
  for (let i = 0; i < N; i++) {
    const w1 = gauss() * Math.SQRT1_2;
    const w2 = w1 + gauss() * Math.SQRT1_2;
    if (Math.abs(w1 / Math.SQRT1_2) >= STOP_RULE.zIntermediaire || Math.abs(w2) >= STOP_RULE.zFinal) rejections++;
  }
  const alpha = rejections / N;
  assert.ok(Math.abs(alpha - 0.05) < 0.003, `α = ${alpha}`);
});

test('gain pour 1 $ : gagné → 1/coût − 1, perdu → −1', () => {
  assert.equal(unitGain(true, 0.5), 1);
  assert.equal(unitGain(false, 0.5), -1);
  assert.ok(Math.abs(unitGain(true, 0.8) - 0.25) < 1e-12);
  assert.throws(() => unitGain(true, 0), RangeError);
  assert.throws(() => unitGain(false, Number.NaN), RangeError);
});

test('petit cas calculé à la main : ΔB, ΔG et z groupés par créneau', () => {
  const pairs: PairedDecision[] = [
    // b = (p_llm − y)² − (p_formule − y)² ; g = G_llm − G_formule
    { slot: 's1', pLlm: 0.8, pFormule: 0.6, y: 1, gLlm: unitGain(true, 0.5), gFormule: 0 }, // b = 0,04 − 0,16 = −0,12 ; g = 1
    { slot: 's1', pLlm: 0.3, pFormule: 0.5, y: 0, gLlm: 0, gFormule: unitGain(false, 0.5) }, // b = 0,09 − 0,25 = −0,16 ; g = 1
    { slot: 's2', pLlm: 0.6, pFormule: 0.7, y: 0, gLlm: -1, gFormule: -1 }, // b = 0,36 − 0,49 = −0,13 ; g = 0
    { slot: 's2', pLlm: 0.9, pFormule: 0.4, y: 1, gLlm: unitGain(true, 0.8), gFormule: 0 }, // b = 0,01 − 0,36 = −0,35 ; g = 0,25
  ];
  const v = pairedVerdict(pairs);
  assert.equal(v.n, 4);
  assert.equal(v.look, 'aucun');
  assert.equal(v.verdict, 'insuffisant');
  assert.ok(Math.abs(v.deltaBrier! - -0.19) < 1e-12, `ΔB ${v.deltaBrier}`);
  assert.ok(Math.abs(v.deltaGain! - 0.5625) < 1e-12, `ΔG ${v.deltaGain}`);
  // Brier : résidus groupés s1 = 0,07 + 0,03 = 0,10 ; s2 = 0,06 − 0,16 = −0,10 ;
  // var = (0,01 + 0,01)/4² · 2/1 = 0,0025 → erreur-type 0,05 → z = −0,19/0,05 = −3,8.
  assert.ok(Math.abs(v.zBrier! - -3.8) < 1e-9, `z_B ${v.zBrier}`);
  // Gain : s1 = 2·0,4375 = 0,875 ; s2 = −0,5625 − 0,3125 = −0,875 ; var = 2·0,765625/16 · 2 = 0,19140625
  // → erreur-type 0,4375 → z = 0,5625/0,4375 = 9/7.
  assert.ok(Math.abs(v.zGain! - 9 / 7) < 1e-9, `z_G ${v.zGain}`);
  assert.equal(v.nTechFailures, 0);
  assert.equal(v.techFailureRate, 0);
  assert.equal(v.nInvalid, 0);

  // Échec technique : hors Brier, dans le gain avec G_llm = 0 (g = −G_formule = −1), taux rapporté.
  const withFail = [...pairs, { slot: 's2', pLlm: null, pFormule: 0.5, y: 1 as const, gLlm: 0, gFormule: unitGain(true, 0.5) }];
  const f = pairedVerdict(withFail);
  assert.equal(f.n, 4);
  assert.ok(Math.abs(f.deltaBrier! - -0.19) < 1e-12);
  assert.ok(Math.abs(f.deltaGain! - 1.25 / 5) < 1e-12);
  assert.equal(f.nTechFailures, 1);
  assert.ok(Math.abs(f.techFailureRate! - 0.2) < 1e-12);
  // Échecs sans ligne appariée : g = 0 chacun.
  const g = pairedVerdict(withFail, 3);
  assert.ok(Math.abs(g.deltaGain! - 1.25 / 8) < 1e-12);
  assert.equal(g.nTechFailures, 4);
  assert.ok(Math.abs(g.techFailureRate! - 0.5) < 1e-12);
  // Ligne inutilisable (issue hors {0, 1}) : écartée et comptée.
  const bad = pairedVerdict([...pairs, { ...pairs[0], y: 2 as unknown as 0 }]);
  assert.equal(bad.n, 4);
  assert.equal(bad.nInvalid, 1);
  assert.ok(Math.abs(bad.deltaBrier! - -0.19) < 1e-12);
});

test('n < 500 → insuffisant, même avec un llm nettement meilleur', () => {
  const v = pairedVerdict(campaign(42, 499, NETTEMENT_MEILLEUR));
  assert.equal(v.n, 499);
  assert.equal(v.look, 'aucun');
  assert.equal(v.verdict, 'insuffisant');
  assert.ok(v.deltaBrier! < 0 && v.deltaGain! > 0, 'statistiques indicatives quand même calculées');
});

test('llm nettement meilleur → succès dès 500 (et l\'arrêt est contraignant)', () => {
  const d = campaign(42, 1000, NETTEMENT_MEILLEUR);
  const v = pairedVerdict(d.slice(0, 500));
  assert.equal(v.look, 'intermediaire');
  assert.equal(v.verdict, 'succes', JSON.stringify(v));
  assert.ok(v.zBrier! <= -2.8 && v.zGain! >= 2.8);
  const later = pairedVerdict(d);
  assert.deepEqual(later, { ...v, n: 1000 }, 'données collectées après l\'arrêt : verdict et statistiques de 500 inchangés');
});

test('llm nettement moins bien calibré → échec à 500', () => {
  const v = pairedVerdict(campaign(1, 500, PIRE_BRIER));
  assert.equal(v.look, 'intermediaire');
  assert.equal(v.verdict, 'echec');
  assert.ok(v.zBrier! >= 2.8, `z_B ${v.zBrier}`);
});

test('llm pire en gain seulement (latence : prix plus cher) → échec à 500', () => {
  const v = pairedVerdict(campaign(1, 500, PIRE_GAIN));
  assert.equal(v.verdict, 'echec');
  assert.ok(Math.abs(v.zBrier!) < 2.8, `Brier non tranché : z_B ${v.zBrier}`);
  assert.ok(v.zGain! <= -2.8, `z_G ${v.zGain}`);
});

test('légèrement meilleur → non concluant à 500, puis échec à 1 000 (sous la borne : on garde la formule)', () => {
  const d = campaign(1, 1000, LEGEREMENT_MEILLEUR);
  const mid = pairedVerdict(d.slice(0, 500));
  assert.equal(mid.verdict, 'non_concluant', JSON.stringify(mid));
  assert.ok(mid.deltaBrier! < 0, 'llm un peu mieux calibré');
  const fin = pairedVerdict(d);
  assert.equal(fin.look, 'final');
  assert.equal(fin.nUsed, 1000);
  assert.equal(fin.verdict, 'echec', JSON.stringify(fin));
  assert.ok(fin.deltaBrier! < 0 && fin.zBrier! > -1.98, `toujours sous la borne : z_B ${fin.zBrier}`);
});

test('avantage modéré → non concluant à 500, succès à 1 000', () => {
  const d = campaign(2, 1000, MODERE);
  assert.equal(pairedVerdict(d.slice(0, 500)).verdict, 'non_concluant');
  const fin = pairedVerdict(d);
  assert.equal(fin.look, 'final');
  assert.equal(fin.verdict, 'succes', JSON.stringify(fin));
  assert.ok(fin.zBrier! <= -1.98 && fin.zGain! >= 1.98);
});

test('deux regards seulement : à n = 700, on rejuge les 500 premières ; un échec à 500 tient à 1 000', () => {
  const d = campaign(1, 1000, LEGEREMENT_MEILLEUR);
  const at500 = pairedVerdict(d.slice(0, 500));
  const at700 = pairedVerdict(d.slice(0, 700));
  assert.deepEqual(at700, { ...at500, n: 700 });
  // Échec à 500, puis 500 décisions excellentes : le verdict reste l'échec du regard intermédiaire.
  const mixed = [...campaign(1, 500, PIRE_BRIER), ...campaign(42, 500, NETTEMENT_MEILLEUR, 10_000)];
  const v = pairedVerdict(mixed);
  assert.equal(v.n, 1000);
  assert.equal(v.look, 'intermediaire');
  assert.equal(v.nUsed, 500);
  assert.equal(v.verdict, 'echec');
});

test('z non calculable (llm identique à la formule) → échec au regard final', () => {
  const d = campaign(3, 1000, LEGEREMENT_MEILLEUR).map(p => ({ ...p, pLlm: p.pFormule, gLlm: p.gFormule }));
  const v = pairedVerdict(d);
  assert.equal(v.deltaBrier, 0);
  assert.equal(v.zBrier, null);
  assert.equal(v.verdict, 'echec');
  assert.equal(pairedVerdict(d.slice(0, 500)).verdict, 'non_concluant');
});
