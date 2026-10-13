/**
 * tests/late-harvest.test.ts — règle de la récolte de fin de round (favori bloqué à 0,99) :
 * côté bloqué, séries de stabilité, décision, réglages.
 * Exécution : `npx tsx --test tests/late-harvest.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HARVEST_CONFIG, FavoriteStreaks, harvestConfigFromEnv, harvestDecision, harvestSide } from '../src/strategy/late-harvest.ts';
import { loadBotConfig } from '../src/bot/config.ts';

const cfg = DEFAULT_HARVEST_CONFIG;

test('côté bloqué : ask dans [0,99 ; 0,995[ d\'un seul côté', () => {
  assert.equal(harvestSide(0.99, 0.02, cfg), 'UP');
  assert.equal(harvestSide(0.02, 0.993, cfg), 'DOWN');
  assert.equal(harvestSide(0.98, 0.03, cfg), null, '0,98 : prix libre, pas bloqué');
  assert.equal(harvestSide(0.995, 0.01, cfg), null, '0,995 et au-delà : hors plafond');
  assert.equal(harvestSide(0.99, 0.99, cfg), null, 'carnet incohérent');
  assert.equal(harvestSide(null, 0.99, cfg), 'DOWN');
  assert.equal(harvestSide(null, null, cfg), null);
  assert.equal(harvestSide(Number.NaN, 0.5, cfg), null);
});

test('séries : durée depuis le début, remise à zéro si le côté change, disparaît ou si trou d\'observation', () => {
  const s = new FavoriteStreaks(12_000);
  s.observe('m', 'UP', 0);
  s.observe('m', 'UP', 3000);
  assert.equal(s.stableSec('m', 'UP', 6000), 6);
  assert.equal(s.stableSec('m', 'DOWN', 6000), 0);
  s.observe('m', 'DOWN', 9000);
  assert.equal(s.stableSec('m', 'UP', 9000), 0, 'côté changé');
  assert.equal(s.stableSec('m', 'DOWN', 12_000), 3);
  s.observe('m', null, 15_000);
  assert.equal(s.stableSec('m', 'DOWN', 15_000), 0, 'plus bloqué');
  s.observe('m', 'UP', 20_000);
  s.observe('m', 'UP', 40_000); // 20 s sans observation : on ne sait pas ce qui s'est passé
  assert.equal(s.stableSec('m', 'UP', 40_000), 0);
  s.observe('n', 'UP', 0);
  s.prune(700_000);
  assert.equal(s.size, 0, 'marchés anciens oubliés');
});

test('décision : fenêtre de temps, stabilité, filtre de désaccord du modèle', () => {
  const ok = harvestDecision({ tauSec: 20, side: 'UP', stableSec: 7, pModelUp: 0.99 }, cfg);
  assert.equal(ok.side, 'UP');
  assert.match(ok.reason, /bloqué à ≥ 0\.99 depuis 7 s, τ 20 s/);
  assert.equal(harvestDecision({ tauSec: 31, side: 'UP', stableSec: 20, pModelUp: null }, cfg).side, null, 'trop tôt (τ > 30 s)');
  assert.equal(harvestDecision({ tauSec: 7, side: 'UP', stableSec: 20, pModelUp: null }, cfg).side, null, 'trop tard (τ < 8 s)');
  assert.match(harvestDecision({ tauSec: 20, side: 'UP', stableSec: 3, pModelUp: null }, cfg).reason, /depuis 3\.0 s < 6 s/);
  assert.equal(harvestDecision({ tauSec: 20, side: 'DOWN', stableSec: 9, pModelUp: null }, cfg).side, 'DOWN', 'sans flux : carnet seul');
  const dis = harvestDecision({ tauSec: 20, side: 'DOWN', stableSec: 9, pModelUp: 0.4 }, cfg);
  assert.equal(dis.side, null);
  assert.match(dis.reason, /modèle en désaccord : P\(DOWN\) 0\.600 < 0\.9/);
  assert.equal(harvestDecision({ tauSec: 20, side: null, stableSec: 0, pModelUp: 0.5 }, cfg).side, null);
  assert.equal(harvestDecision({ tauSec: 20, side: 'UP', stableSec: 9, pModelUp: 0.99 }, { ...cfg, enabled: false }).side, null);
});

test('réglages : défauts, FV_HARVEST=false, bornes, incohérence min > max', () => {
  assert.deepEqual(harvestConfigFromEnv({}), DEFAULT_HARVEST_CONFIG);
  assert.equal(harvestConfigFromEnv({ FV_HARVEST: 'false' }).enabled, false);
  const w: string[] = [];
  const c = harvestConfigFromEnv({ FV_HARVEST: 'peut-être', FV_HARVEST_MAX_TAU: '45', FV_HARVEST_MIN_TAU: '10', FV_HARVEST_STABLE_SEC: '8', FV_HARVEST_MIN_ASK: '2' }, w);
  assert.equal(c.enabled, true);
  assert.equal(c.maxTauSec, 45);
  assert.equal(c.minTauSec, 10);
  assert.equal(c.stableSec, 8);
  assert.equal(c.minAsk, 0.99, 'hors bornes → défaut');
  assert.equal(w.length, 2, w.join('\n'));
  const w2: string[] = [];
  const bad = harvestConfigFromEnv({ FV_HARVEST_MIN_TAU: '40', FV_HARVEST_MAX_TAU: '20' }, w2);
  assert.equal(bad.minTauSec, 8);
  assert.equal(bad.maxTauSec, 30);
  assert.match(w2[0], /FV_HARVEST_MIN_TAU=40 > FV_HARVEST_MAX_TAU=20/);
  // Câblé dans la config du bot
  assert.equal(loadBotConfig({}).config.harvest.enabled, true);
  assert.equal(loadBotConfig({ FV_HARVEST: 'off' }).config.harvest.enabled, false);
});
