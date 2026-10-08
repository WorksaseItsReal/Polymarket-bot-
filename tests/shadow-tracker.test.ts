/**
 * tests/shadow-tracker.test.ts — mesure continue « modèle vs carnet ».
 * Exécution : `npx tsx --test tests/shadow-tracker.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowTracker, shadowStats } from '../src/strategy/shadow-tracker.ts';
import { shadowLine } from '../src/services/telegram-messages.ts';
import type { DecisionRecord } from '../src/services/decision-journal.ts';

const SLOT = 1_790_000_100;
const rec = (slug: string, pUp: number, upAsk: number, downAsk: number): DecisionRecord => ({
  t: 0, slug, coin: 'BTC', tau: 200, spot: 1, strike: 1, sig: 1e-4, pUp, upAsk, downAsk, upAskSz: 1, downAskSz: 1, src: 't', act: 'hold',
});

test('évaluations d\'un round (≥ 10 s d\'écart), résolution après la fin, Brier apparié, persistance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
  let now = (SLOT + 100) * 1000;
  const outcomes: Record<string, boolean> = {};
  const fetched: string[] = [];
  const t = new ShadowTracker({
    path: join(dir, 'fv-shadow.json'), now: () => now,
    fetchOutcome: async slug => { fetched.push(slug); return slug in outcomes ? { resolved: true, upWon: outcomes[slug] } : { resolved: false, reason: 'pas encore' }; },
  });
  const slug = `btc-updown-5m-${SLOT}`;
  t.observe(rec(slug, 0.9, 0.61, 0.41)); // carnet : (0,61 + 0,59)/2 = 0,60
  t.observe(rec(slug, 0.1, 0.5, 0.5)); // ignorée : moins de 10 s après la précédente
  await t.resolveDue();
  assert.equal(fetched.length, 0, 'pas avant la fin du round + 60 s');
  now = (SLOT + 400) * 1000;
  await t.resolveDue();
  assert.equal(fetched.length, 1);
  assert.equal(t.stats().n, 0, 'pas encore réglé : on retentera');
  outcomes[slug] = true;
  await t.resolveDue();
  const st = t.stats();
  assert.equal(st.n, 1);
  assert.ok(Math.abs(st.brierModel! - 0.01) < 1e-12);
  assert.ok(Math.abs(st.brierMarket! - 0.16) < 1e-12);
  // redémarrage : agrégats relus
  const t2 = new ShadowTracker({ path: join(dir, 'fv-shadow.json'), fetchOutcome: async () => ({ resolved: false, reason: '' }) });
  assert.equal(t2.stats().n, 1);
  writeFileSync(join(dir, 'fv-shadow.json'), '{corrompu');
  assert.equal(new ShadowTracker({ path: join(dir, 'fv-shadow.json'), fetchOutcome: async () => ({ resolved: false, reason: '' }) }).stats().n, 0);
});

test('verdict honnête : trop tôt, meilleur, pire, indistinct', () => {
  assert.match(shadowLine(shadowStats({ n: 10, sumModel: 1, sumMarket: 2, sumD: -1, sumD2: 1 })), /trop tôt/);
  // modèle nettement meilleur : d = −0,05 ± petit bruit sur 200 rounds
  const better = { n: 200, sumModel: 40, sumMarket: 50, sumD: -10, sumD2: 200 * (0.05 ** 2 + 0.01 ** 2) };
  assert.match(shadowLine(shadowStats(better)), /prédit MIEUX/);
  const worse = { ...better, sumModel: 50, sumMarket: 40, sumD: 10 };
  assert.match(shadowLine(shadowStats(worse)), /pas d'edge/);
  const same = { n: 200, sumModel: 45, sumMarket: 45, sumD: 0.1, sumD2: 200 * 0.01 };
  assert.match(shadowLine(shadowStats(same)), /pas de différence significative/);
});

test('round jamais réglé abandonné après 1 h ; nombre de rounds en attente borné', async () => {
  let now = SLOT * 1000;
  const t = new ShadowTracker({ path: join(mkdtempSync(join(tmpdir(), 'shadow-')), 's.json'), now: () => now, maxPending: 3, fetchOutcome: async () => ({ resolved: false, reason: '' }) });
  for (let i = 0; i < 5; i++) t.observe(rec(`eth-updown-5m-${SLOT + i * 300}`, 0.5, 0.5, 0.5));
  assert.equal(t.pendingCount(), 3);
  now = (SLOT + 5 * 3600) * 1000;
  await t.resolveDue();
  assert.equal(t.pendingCount(), 0);
});

test('mélange actif : la comparaison porte sur le modèle SEUL (pRaw), pas sur la probabilité mélangée', async () => {
  const now = (SLOT + 400) * 1000;
  const t = new ShadowTracker({
    path: join(mkdtempSync(join(tmpdir(), 'shadow-')), 'fv-shadow.json'), now: () => now,
    fetchOutcome: async () => ({ resolved: true, upWon: true }),
  });
  // pUp mélangée = 0,6 (≈ carnet), modèle seul = 0,9
  t.observe({ ...rec(`btc-updown-5m-${SLOT}`, 0.6, 0.61, 0.41), pRaw: 0.9 });
  await t.resolveDue();
  assert.ok(Math.abs(t.stats().brierModel! - 0.01) < 1e-12, 'Brier de 0,9, pas de 0,6');
});

test('t groupé par créneau ; réglages du modèle changés → nouvelle mesure (jamais deux modèles mélangés)', async () => {
  const outcome = async (slug: string) => ({ resolved: true as const, upWon: Number(slug.split('-').pop()) % 600 === 0 });
  const run = async (path: string, coins: string[], modelKey?: string) => {
    let now = 0;
    const t = new ShadowTracker({ path, now: () => now, perCall: 1000, modelKey, fetchOutcome: outcome });
    for (let k = 0; k < 40; k++) {
      for (const c of coins) t.observe(rec(`${c}-updown-5m-${SLOT + k * 300}`, 0.7, 0.61, 0.41));
      now = (SLOT + k * 300 + 361) * 1000;
      await t.resolveDue();
    }
    return t.stats();
  };
  const path = join(mkdtempSync(join(tmpdir(), 'shadow-')), 'fv-shadow.json');
  // 5 cryptos aux mêmes probabilités : 5 copies du même résultat par créneau
  const grouped = await run(path, ['btc', 'eth', 'sol', 'xrp', 'doge'], 'z=1');
  assert.equal(grouped.n, 200);
  const single = await run(join(mkdtempSync(join(tmpdir(), 'shadow-')), 'fv-shadow.json'), ['btc']);
  assert.ok(Math.abs(grouped.tDiff! - single.tDiff!) / Math.abs(single.tDiff!) < 0.05,
    `5 copies corrélées ≠ 5× plus de preuve : ${grouped.tDiff} vs ${single.tDiff}`);
  // réglages changés : la mesure repart de zéro, avec un signalement
  let resetN = -1;
  const changed = new ShadowTracker({ path, modelKey: 'z=0.8', onReset: n => { resetN = n; }, fetchOutcome: outcome });
  assert.equal(changed.stats().n, 0);
  assert.equal(resetN, 200);
  assert.equal(new ShadowTracker({ path, modelKey: 'z=1', fetchOutcome: outcome }).stats().n, 200, 'même réglage : mesure conservée');
});

test('ancien fichier sans empreinte : gardé si le modèle est resté par défaut, écarté sinon', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'shadow-')), 'fv-shadow.json');
  writeFileSync(path, JSON.stringify({ n: 10, sumModel: 1, sumMarket: 1.2, sumD: -0.2, sumD2: 0.05 }));
  const outcome = async () => ({ resolved: false as const, reason: '' });
  assert.equal(new ShadowTracker({ path, fetchOutcome: outcome, modelKey: 'defaut', legacyModelKey: 'defaut' }).stats().n, 10);
  let reset = -1;
  const t = new ShadowTracker({ path, fetchOutcome: outcome, modelKey: 'z=0.8', legacyModelKey: 'defaut', onReset: n => { reset = n; } });
  assert.equal(t.stats().n, 0);
  assert.equal(reset, 10);
});

test('toutes les évaluations du round comptent (moyenne), chaque round pesant 1', async () => {
  let now = (SLOT + 100) * 1000;
  const t = new ShadowTracker({
    path: join(mkdtempSync(join(tmpdir(), 'shadow-')), 'fv-shadow.json'), now: () => now,
    fetchOutcome: async () => ({ resolved: true, upWon: true }),
  });
  const slug = `btc-updown-5m-${SLOT}`;
  t.observe({ ...rec(slug, 0.6, 0.51, 0.51), t: 0 }); // carnet 0,50
  t.observe({ ...rec(slug, 0.9, 0.71, 0.31), t: 20_000 }); // carnet 0,70
  now = (SLOT + 400) * 1000;
  await t.resolveDue();
  const st = t.stats();
  assert.equal(st.n, 1, 'un round');
  assert.ok(Math.abs(st.brierModel! - (0.16 + 0.01) / 2) < 1e-12, `${st.brierModel}`);
  assert.ok(Math.abs(st.brierMarket! - (0.25 + 0.09) / 2) < 1e-12, `${st.brierMarket}`);
});

test('écart minimal de 8 s : gigue tolérée, évaluations déclenchées par un saut du spot exclues', async () => {
  let now = (SLOT + 100) * 1000;
  const t = new ShadowTracker({
    path: join(mkdtempSync(join(tmpdir(), 'shadow-')), 'fv-shadow.json'), now: () => now,
    fetchOutcome: async () => ({ resolved: true, upWon: true }),
  });
  const slug = `btc-updown-5m-${SLOT}`;
  // passages réguliers avec gigue (9,95 s d'écart) : tous gardés
  for (let k = 0; k < 5; k++) t.observe({ ...rec(slug, 0.6, 0.51, 0.51), t: (SLOT + 40 + k * 9.95 + 0.5) * 1000 });
  // saut du spot : exclu (sinon il sur-pondère les instants favorables au modèle)
  t.observe({ ...rec(slug, 0.99, 0.51, 0.51), t: (SLOT + 95) * 1000, mv: true });
  now = (SLOT + 400) * 1000;
  await t.resolveDue();
  assert.ok(Math.abs(t.stats().brierModel! - 0.16) < 1e-12, 'moyenne des 5 évaluations régulières à 0,6 seulement');
});
