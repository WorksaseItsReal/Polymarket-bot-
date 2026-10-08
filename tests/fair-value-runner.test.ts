/**
 * tests/fair-value-runner.test.ts — la boucle de stratégie de bout en bout, sans réseau.
 * Exécution : `npx tsx --test tests/fair-value-runner.test.ts`
 *
 * Faux scan Polymarket, faux carnets, fausses données spot, fausse résolution Gamma,
 * horloge pilotée ; registre réel dans un dossier temporaire ; on capture les
 * messages Telegram produits. On vérifie le cycle complet :
 *   marché → pari (registre + message) → pas de second pari sur le même round →
 *   fin du round → résolution → message GAGNÉ/PERDU → bilan à jour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FAIR_VALUE_CONFIG, blendWithMarket, probUp } from '../src/services/fair-value.ts';
import { loadLedger, type RoundOutcome } from '../src/services/paper-ledger.ts';
import type { RoundMarketData } from '../src/services/round-market-data.ts';
import { FairValueRunner, slotOf, type Book, type RunnerDeps, type ScannedMarket } from '../src/strategy/fair-value-runner.ts';

const SLOT = 1_790_000_100;
const SIGMA = 0.0006 / Math.sqrt(60);
const MARKET: ScannedMarket = {
  conditionId: '0xabc', name: 'Bitcoin Up or Down', slug: `btc-updown-5m-${SLOT}`, underlying: 'BTC',
  durationMinutes: 5, upTokenId: 'UP', downTokenId: 'DOWN',
};

function setup(over: Partial<RunnerDeps> & { spot?: number; upAsk?: number; downAsk?: number; outcome?: RoundOutcome } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  const ledgerPath = join(dir, 'fv-ledger.json');
  let now = (SLOT + 180) * 1000; // τ = 120 s
  const messages: string[] = [];
  const logs: string[] = [];
  let outcome: RoundOutcome = over.outcome ?? { resolved: false, reason: 'pas encore' };
  const data = (): RoundMarketData => ({ spot: over.spot ?? 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 1000 });
  const book = (ask: number): Book => ({
    asks: [{ price: 0.99, size: 1000 }, { price: ask + 0.01, size: 50 }, { price: ask, size: 5 }], // ordre API : du plus cher au moins cher
    bids: [{ price: ask - 0.01, size: 100 }],
  });
  let scans = 0;
  const deps: RunnerDeps = {
    cfg: DEFAULT_FAIR_VALUE_CONFIG,
    exitEdge: 0.04,
    ledgerPath,
    capital: () => 50,
    now: () => now,
    canTrade: () => true,
    scanMarkets: async () => { scans++; return [MARKET]; },
    getBook: async id => book(id === 'UP' ? (over.upAsk ?? 0.6) : (over.downAsk ?? 0.41)),
    getRoundData: async () => data(),
    fetchOutcome: async () => outcome,
    notify: m => messages.push(m),
    log: (_l, m) => logs.push(m),
    timeZone: 'Europe/Paris',
    ...over,
  };
  return {
    deps, ledgerPath, messages, logs,
    runner: () => new FairValueRunner(deps),
    setNow: (ms: number) => { now = ms; },
    setOutcome: (o: RoundOutcome) => { outcome = o; },
    scans: () => scans,
  };
}

test('slotOf : slug exact du bon coin uniquement', () => {
  assert.equal(slotOf(MARKET), SLOT);
  assert.equal(slotOf({ ...MARKET, underlying: 'ETH' }), null, 'slug BTC annoncé comme ETH');
  assert.equal(slotOf({ ...MARKET, slug: 'xi-jinping-out-before-2027' }), null);
  assert.equal(slotOf({ ...MARKET, slug: `btc-updown-15m-${SLOT}` }), null);
});

test('cycle complet : pari → un seul par round → résolution GAGNÉ → messages clairs', async () => {
  const env = setup();
  const r = env.runner();
  await r.tick();

  let ledger = loadLedger(env.ledgerPath)!;
  assert.equal(ledger.length, 1, 'un pari ouvert');
  const t = ledger[0];
  assert.equal(t.side, 'UP');
  assert.equal(t.status, 'open');
  assert.ok(t.stake > 0 && t.stake <= 50 * 0.01 + 1e-9, `mise plafonnée à 1 % du capital (${t.stake})`);
  assert.ok(t.costPerShare > 0.6, 'coût = VWAP + frais, jamais l\'ask brut');
  assert.ok(Math.abs(t.modelProb - probUp({ spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!) < 1e-12);
  assert.equal(env.messages.length, 1);
  assert.match(env.messages[0], /NOUVEAU PARI — BTC ⬆️ HAUSSE/);

  // Ticks suivants dans le même round : aucun second pari, aucun nouveau message.
  env.setNow((SLOT + 200) * 1000);
  await r.tick();
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 1);
  assert.equal(env.messages.length, 1);

  // Fin du round, pas encore réglé par Polymarket : rien ne bouge.
  env.setNow((SLOT + 330) * 1000);
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'open');

  // Réglé : UP a gagné. (Gamma n'est réinterrogé qu'après 10 s pour un même trade.)
  env.setOutcome({ resolved: true, upWon: true });
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'open', 'pas de nouvelle requête Gamma avant 10 s');
  env.setNow((SLOT + 341) * 1000);
  await r.tick();
  ledger = loadLedger(env.ledgerPath)!;
  assert.equal(ledger[0].status, 'won');
  assert.ok(Math.abs(ledger[0].pnl! - (t.shares - t.stake)) < 1e-12);
  assert.equal(env.messages.length, 2);
  assert.match(env.messages[1], /✅ <b>GAGNÉ<\/b> — BTC ⬆️ HAUSSE/);
  assert.match(env.messages[1], /Bilan : 1 trades · 1 ✅ \/ 0 ❌ \(100 %\)/);

  // Un redémarrage ne rejoue pas le round (registre relu).
  env.setNow((SLOT + 180) * 1000);
  const r2 = env.runner();
  await r2.tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 1);
});

test('PERDU : la mise entière est perdue et annoncée', async () => {
  const env = setup();
  const r = env.runner();
  await r.tick();
  env.setNow((SLOT + 330) * 1000);
  env.setOutcome({ resolved: true, upWon: false });
  await r.tick();
  const t = loadLedger(env.ledgerPath)![0];
  assert.equal(t.status, 'lost');
  assert.equal(t.pnl, -t.stake);
  assert.match(env.messages[1], /❌ <b>PERDU<\/b>/);
});

test('carnet juste (pas d\'edge) : aucun pari, aucun message', async () => {
  const p = probUp({ spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!;
  const env = setup({ upAsk: Math.ceil(p * 100) / 100, downAsk: Math.ceil((1 - p) * 100) / 100 + 0.01 });
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 0);
  assert.equal(env.messages.length, 0);
  assert.ok(env.logs.some(l => /HOLD/.test(l)), 'la raison du HOLD est journalisée');
});

test('porte de risque fermée : aucun nouveau pari, MAIS les rounds terminés sont réglés', async () => {
  let open = true;
  const env = setup({ canTrade: () => open });
  const r = env.runner();
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 1);
  open = false;
  env.setNow((SLOT + 330) * 1000);
  env.setOutcome({ resolved: true, upWon: true });
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'won', 'résolution même en pause');
});

test('hors fenêtre de temps, données absentes ou erreurs réseau : pas de pari, pas de crash', async () => {
  const early = setup();
  early.setNow((SLOT + 10) * 1000); // τ = 290 s > 270
  await early.runner().tick();
  assert.equal(loadLedger(early.ledgerPath)!.length, 0);

  const late = setup();
  late.setNow((SLOT + 280) * 1000); // τ = 20 s < 45
  await late.runner().tick();
  assert.equal(loadLedger(late.ledgerPath)!.length, 0);

  const noData = setup({ getRoundData: async () => null });
  await noData.runner().tick();
  assert.equal(loadLedger(noData.ledgerPath)!.length, 0);

  const broken = setup({ getBook: async () => { throw new Error('CLOB 503'); } });
  await broken.runner().tick();
  assert.equal(loadLedger(broken.ledgerPath)!.length, 0);
  assert.ok(broken.logs.some(l => /erreur d'analyse/.test(l)));

  const scanFail = setup({ scanMarkets: async () => { throw new Error('gamma down'); } });
  await scanFail.runner().tick();
  assert.ok(scanFail.logs.some(l => /tick en échec/.test(l)));
});

test('profondeur insuffisante : pas de pari sur un carnet vide au bon prix', async () => {
  const env = setup({ getBook: async id => (id === 'UP' ? { asks: [{ price: 0.6, size: 0.1 }], bids: [] } : { asks: [{ price: 0.41, size: 100 }], bids: [] }) });
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 0);
  assert.ok(env.logs.some(l => /profondeur insuffisante/.test(l)));
});

test('registre illisible : aucun pari, une seule alerte, fichier préservé', async () => {
  const env = setup();
  writeFileSync(env.ledgerPath, '{"trades":[');
  const r = env.runner();
  await r.tick();
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath), null, 'fichier non écrasé');
  assert.equal(env.messages.filter(m => /registre des trades illisible/.test(m)).length, 1);
});

test('revente anticipée quand le marché paie plus que la position ne vaut', async () => {
  const env = setup();
  const r = env.runner();
  await r.tick();
  const t = loadLedger(env.ledgerPath)![0];
  // Le spot retombe au strike (p_UP ≈ 0,5) mais un acheteur paie 0,80 pour UP.
  env.deps.getRoundData = async () => ({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 0 });
  env.deps.getBook = async () => ({ asks: [], bids: [{ price: 0.8, size: 1000 }] });
  env.setNow((SLOT + 200) * 1000);
  await r.tick();
  const after = loadLedger(env.ledgerPath)![0];
  assert.equal(after.status, 'sold');
  assert.ok(after.pnl! > 0 && Math.abs(after.pnl! - (t.shares * (0.8 - DEFAULT_FAIR_VALUE_CONFIG.takerFeeRate * 0.8 * 0.2) - t.stake)) < 1e-9);
  assert.match(env.messages[env.messages.length - 1], /REVENDU avant la fin/);
});

test('le scan des marchés est mis en cache 60 s (pas de spam de l\'API)', async () => {
  const env = setup({ getRoundData: async () => null });
  const r = env.runner();
  for (let i = 0; i < 5; i++) {
    env.setNow((SLOT + 180 + i * 10) * 1000);
    await r.tick();
  }
  assert.equal(env.scans(), 1);
  env.setNow((SLOT + 300) * 1000);
  await r.tick();
  assert.equal(env.scans(), 2);
});

test('journal : chaque évaluation est transmise (abstention puis pari), avec asks et tailles', async () => {
  const evals: Array<Record<string, unknown>> = [];
  const p = probUp({ spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!;
  let fair = true;
  const env = setup({
    onEvaluation: r => evals.push({ ...r }),
    getBook: async id => {
      const ask = id === 'UP' ? (fair ? Math.ceil(p * 100) / 100 : 0.6) : 0.41;
      return { asks: [{ price: ask, size: 50 }], bids: id === 'UP' ? [{ price: 0.3, size: 7 }, { price: 0.55, size: 12 }] : [] };
    },
  });
  const r = env.runner();
  await r.tick();
  assert.equal(evals.length, 1);
  assert.equal(evals[0].act, 'hold');
  assert.equal(evals[0].slug, MARKET.slug);
  assert.equal(evals[0].upAskSz, 50);
  assert.equal(evals[0].upBid, 0.55, 'meilleur bid = le plus haut');
  assert.equal(evals[0].upBidSz, 12);
  assert.equal(evals[0].downBid, null, 'pas de bid');
  assert.ok(Math.abs((evals[0].pUp as number) - p) < 1e-12);
  fair = false;
  env.setNow((SLOT + 190) * 1000);
  await r.tick();
  assert.equal(evals.length, 2);
  assert.equal(evals[1].act, 'buy');
  assert.equal(evals[1].side, 'UP');
  assert.ok((evals[1].stake as number) > 0);
  // un journal qui plante ne casse pas la stratégie
  const env2 = setup({ onEvaluation: () => { throw new Error('disque plein'); } });
  await env2.runner().tick();
  assert.equal(loadLedger(env2.ledgerPath)!.length, 1);
});

test('entrées bloquées (arrêt de sécurité) : aucun pari, mais l\'évaluation est journalisée', async () => {
  const evals: string[] = [];
  const env = setup({ entryBlock: () => 'perte significative', onEvaluation: r => evals.push(r.act) });
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 0);
  assert.deepEqual(evals, ['hold']);
  assert.ok(env.logs.some(l => /entrées bloquées \(perte significative\)/.test(l)));
});

test('mise à 0 par série de pertes : alerte onRiskStop (plus d\'arrêt silencieux)', async () => {
  const stops: string[] = [];
  const env = setup({ onRiskStop: r => stops.push(r) });
  const now = (SLOT + 180) * 1000;
  const losses = [...Array(8)].map((_, i) => ({
    id: `l${i}`, slug: `btc-updown-5m-${SLOT - 300 * (i + 1)}`, coin: 'BTC', side: 'UP' as const, stake: 0.5, costPerShare: 0.6,
    shares: 0.83, modelProb: 0.7, edge: 0.1, openedAt: new Date(now - 3_600_000).toISOString(), endMs: now - 3_000_000,
    status: 'lost' as const, pnl: -0.5, resolvedAt: new Date(now - 3_000_000 + i * 1000).toISOString(),
  }));
  const { saveLedger } = await import('../src/services/paper-ledger.ts');
  saveLedger(env.ledgerPath, losses);
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 8, 'aucun nouveau pari');
  assert.equal(stops.length, 1);
  assert.match(stops[0], /pertes consécutives/);
});

test('chien de garde : fin de passage, échecs consécutifs et dernier marché trouvé sont exposés', async () => {
  let fail = true;
  const env = setup({ scanMarkets: async () => { if (fail) throw new Error('gamma down'); return [MARKET]; } });
  const r = env.runner();
  await r.tick();
  await r.tick();
  assert.equal(r.consecutiveTickFailures, 2);
  assert.equal(r.lastMarketsFoundAt, 0);
  assert.ok(r.lastTickEndedAt > 0);
  fail = false;
  env.setNow((SLOT + 250) * 1000);
  await r.tick();
  assert.equal(r.consecutiveTickFailures, 0);
  assert.equal(r.lastMarketsFoundAt, (SLOT + 250) * 1000);
});

test('FV_COINS : liste filtrée, valeurs invalides ignorées, coins exclus jamais tradés', async () => {
  const { coinsFromEnv } = await import('../src/strategy/fair-value-runner.ts');
  assert.deepEqual(coinsFromEnv('btc, eth'), ['BTC', 'ETH']);
  assert.deepEqual(coinsFromEnv('PEPE'), ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'], 'rien de valide → tous');
  assert.deepEqual(coinsFromEnv(undefined).length, 5);
  const env = setup({ coins: ['ETH'] });
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 0, 'BTC exclu → aucun pari');
});

test('latence simulée : exécution sur le carnet relu ; opportunité disparue → pas de pari', async () => {
  // Le carnet UP passe de 0,60 (en retard) à la juste valeur entre la décision et l'exécution.
  const p = probUp({ spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!;
  let reads = 0;
  const sleeps: number[] = [];
  const env = setup({
    fillDelayMs: 1000,
    sleep: async ms => { sleeps.push(ms); },
    getBook: async id => {
      if (id !== 'UP') return { asks: [{ price: 0.41, size: 100 }], bids: [] };
      reads++;
      return { asks: [{ price: reads === 1 ? 0.6 : Math.ceil(p * 100) / 100, size: 100 }], bids: [] };
    },
  });
  await env.runner().tick();
  assert.deepEqual(sleeps, [1000]);
  assert.equal(reads, 2, 'carnet relu après le délai');
  assert.equal(loadLedger(env.ledgerPath)!.length, 0);
  assert.ok(env.logs.some(l => /opportunité disparue/.test(l)));

  // Carnet stable : le pari passe, au prix relu.
  const stable = setup({ fillDelayMs: 1000, sleep: async () => undefined });
  await stable.runner().tick();
  assert.equal(loadLedger(stable.ledgerPath)!.length, 1);
});

test('tick sur mouvement : pas de règlement ni de sortie (vitesse) ; tick de fond : oui', async () => {
  let fetches = 0;
  const env = setup({ fetchOutcome: async () => { fetches++; return { resolved: false, reason: '' }; } });
  const r = env.runner();
  await r.tick();
  env.setNow((SLOT + 330) * 1000);
  await r.tick(['BTC']);
  assert.equal(fetches, 0, 'tick sur mouvement : aucun appel Gamma');
  await r.tick();
  assert.equal(fetches, 1);
});

test('pause de risque : les sorties restent actives (vendre réduit le risque)', async () => {
  let open = true;
  const env = setup({ canTrade: () => open });
  const r = env.runner();
  await r.tick();
  open = false;
  env.deps.getRoundData = async () => ({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 0 });
  env.deps.getBook = async () => ({ asks: [], bids: [{ price: 0.8, size: 1000 }] });
  env.setNow((SLOT + 200) * 1000);
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'sold');
});

test('sortie avec latence : un bid disparu entre-temps n\'est pas vendu', async () => {
  let reads = 0;
  const env = setup({ fillDelayMs: 1000, sleep: async () => undefined });
  const r = env.runner();
  await r.tick();
  env.deps.getRoundData = async () => ({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 0 });
  env.deps.getBook = async () => ({ asks: [], bids: [{ price: reads++ === 0 ? 0.8 : 0.45, size: 1000 }] });
  env.setNow((SLOT + 200) * 1000);
  await r.tick();
  assert.equal(reads, 2, 'carnet relu après le délai');
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'open', 'le bid à 0,80 avait disparu');
});

test('mise sur le capital ACTUEL et minimum d\'ordre Polymarket', async () => {
  const { saveLedger } = await import('../src/services/paper-ledger.ts');
  const below: number[] = [];
  const env = setup({ minOrderUsd: 1, onBelowMinOrder: s => below.push(s) });
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 0, '1 % de 50 $ = 0,50 $ < 1 $ : pas de pari');
  assert.equal(below.length, 1);
  assert.ok(env.logs.some(l => /minimum Polymarket/.test(l)));

  // Capital 200 $ mais 20 $ déjà perdus (sur > 6 h, sans série en cours) : 1 % de 180 $ = 1,80 $.
  const rich = setup({ capital: () => 200, minOrderUsd: 1 });
  const old = new Date((SLOT - 86_400) * 1000).toISOString();
  saveLedger(rich.ledgerPath, [
    { id: 'x', slug: 'btc-updown-5m-1', coin: 'BTC', side: 'UP', stake: 20, costPerShare: 0.6, shares: 33, modelProb: 0.7, edge: 0.1, openedAt: old, endMs: 0, status: 'lost', pnl: -20, resolvedAt: old },
    { id: 'y', slug: 'btc-updown-5m-2', coin: 'BTC', side: 'UP', stake: 0, costPerShare: 0.6, shares: 0, modelProb: 0.7, edge: 0.1, openedAt: old, endMs: 0, status: 'won', pnl: 0, resolvedAt: old },
  ]);
  await rich.runner().tick();
  const t = loadLedger(rich.ledgerPath)!.find(x => x.id === MARKET.conditionId)!;
  assert.ok(t.stake <= 1.8 + 1e-9 && t.stake > 1, `mise ${t.stake} ≤ 1 % de 180 $`);
});

test('registre réparé en cours de route : un round déjà présent n\'est jamais ré-annoncé', async () => {
  const { saveLedger } = await import('../src/services/paper-ledger.ts');
  const env = setup();
  writeFileSync(env.ledgerPath, '{oups'); // illisible au démarrage : mémoire des rounds vide
  const r = env.runner();
  saveLedger(env.ledgerPath, [{
    id: MARKET.conditionId, slug: MARKET.slug, coin: 'BTC', side: 'UP', stake: 0.5, costPerShare: 0.62, shares: 0.8, modelProb: 0.9,
    edge: 0.2, openedAt: new Date((SLOT + 100) * 1000).toISOString(), endMs: (SLOT + 300) * 1000, status: 'open', pnl: null,
  }]);
  const before = env.messages.length;
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 1);
  assert.equal(env.messages.filter(m => /NOUVEAU PARI/.test(m)).length, 0);
  assert.ok(env.messages.length - before <= 1, 'au plus l\'alerte registre illisible');
});

test('pas de biais d\'anticipation : le spot qui bouge pendant la latence ne change pas la décision', async () => {
  let call = 0;
  // Après la décision, le spot repasse SOUS le strike (le pari devient mauvais) : un vrai
  // ordre, déjà parti, est quand même exécuté si le carnet est toujours sous la limite.
  const env = setup({
    fillDelayMs: 1000,
    sleep: async () => undefined,
    getRoundData: async () => ({ spot: call++ === 0 ? 100.12 : 99.9, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 0 }),
  });
  await env.runner().tick();
  const t = loadLedger(env.ledgerPath)!;
  assert.equal(t.length, 1, 'exécuté malgré le mouvement défavorable (pas de tri a posteriori)');
  assert.ok(Math.abs(t[0].modelProb - probUp({ spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!) < 1e-12, 'probabilité de la décision');
  assert.equal(call, 1, 'le modèle n\'est pas réévalué après la latence');
});

test('ordre limite : si le carnet remonte au-dessus de la limite pendant la latence, pas d\'exécution', async () => {
  const p = probUp({ spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!;
  const { maxBuyPriceForEdge } = await import('../src/services/fair-value.ts');
  const lim = maxBuyPriceForEdge(p, 0.04, 0.07)!;
  let reads = 0;
  const env = setup({
    fillDelayMs: 1000, sleep: async () => undefined,
    getBook: async id => (id === 'UP'
      ? { asks: [{ price: reads++ === 0 ? 0.6 : Math.ceil((lim + 0.01) * 100) / 100, size: 100 }], bids: [] }
      : { asks: [{ price: 0.41, size: 100 }], bids: [] }),
  });
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 0);
});

test('tick sur mouvement : passage complet forcé si le tick de fond est affamé', async () => {
  let fetches = 0;
  const env = setup({ fullPassEveryMs: 15_000, fetchOutcome: async () => { fetches++; return { resolved: true, upWon: true }; } });
  const r = env.runner();
  await r.tick(); // passage complet à SLOT+180
  env.setNow((SLOT + 190) * 1000);
  await r.tick(['BTC']);
  assert.equal(fetches, 0, 'passage complet récent : tick sur mouvement léger');
  env.setNow((SLOT + 330) * 1000);
  await r.tick(['BTC']);
  assert.equal(fetches, 1, 'dernier passage complet trop ancien : règlement fait');
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'won');
  assert.equal(r.lastFullPassAt, (SLOT + 330) * 1000);
});

test('revente : issue du round relevée ensuite (calibration) ; petite position jamais revendue', async () => {
  const env = setup({ minSellShares: 0 });
  const r = env.runner();
  await r.tick();
  env.deps.getRoundData = async () => ({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 0 });
  env.deps.getBook = async () => ({ asks: [], bids: [{ price: 0.8, size: 1000 }] });
  env.setNow((SLOT + 200) * 1000);
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'sold');
  env.setOutcome({ resolved: true, upWon: false });
  env.setNow((SLOT + 330) * 1000);
  await r.tick();
  const t = loadLedger(env.ledgerPath)![0];
  assert.equal(t.outcomeUpWon, false, 'issue relevée');
  assert.equal(t.status, 'sold', 'le PnL de la revente ne change pas');

  const small = setup({ minSellShares: 5 });
  const r2 = small.runner();
  await r2.tick();
  small.deps.getRoundData = async () => ({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 0 });
  small.deps.getBook = async () => ({ asks: [], bids: [{ price: 0.8, size: 1000 }] });
  small.setNow((SLOT + 200) * 1000);
  await r2.tick();
  assert.equal(loadLedger(small.ledgerPath)![0].status, 'open', '< 5 parts : gardé jusqu\'au règlement');
});

test('minimum d\'ordre : alerte seulement si la cause est le capital, pas un plafond temporaire', async () => {
  const { saveLedger } = await import('../src/services/paper-ledger.ts');
  const below: number[] = [];
  // Capital 200 $ (1 % = 2 $) mais exposition presque pleine (19 $ ouverts sur 20 $) → mise 1 $ max... sous 1,5 $
  const env = setup({ capital: () => 200, minOrderUsd: 1.5, onBelowMinOrder: s => below.push(s) });
  saveLedger(env.ledgerPath, [{
    id: 'busy', slug: `eth-updown-5m-${SLOT}`, coin: 'ETH', side: 'UP', stake: 19, costPerShare: 0.6, shares: 31, modelProb: 0.7, edge: 0.1,
    openedAt: new Date((SLOT + 100) * 1000).toISOString(), endMs: (SLOT + 300) * 1000, status: 'open', pnl: null,
  }]);
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 1, 'pas de nouveau pari');
  assert.equal(below.length, 0, 'cause temporaire (exposition) : pas d\'alerte « monter le capital »');
  assert.ok(env.logs.some(l => /mise réduite/.test(l)));
});

test('sortie avec mélange : le seuil de revente suit la même probabilité qu\'à l\'entrée', async () => {
  const sell = async (cfg: typeof DEFAULT_FAIR_VALUE_CONFIG, books: Record<string, Book>) => {
    const env = setup();
    const r = env.runner();
    await r.tick();
    assert.equal(loadLedger(env.ledgerPath)![0].status, 'open');
    // Spot revenu au strike : le modèle seul donne UP ≈ 0,5.
    env.deps.cfg = cfg;
    env.deps.getRoundData = async () => ({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 0 });
    const reads: string[] = [];
    env.deps.getBook = async id => { reads.push(id); return books[id]; };
    env.setNow((SLOT + 200) * 1000);
    await r.tick();
    return { status: loadLedger(env.ledgerPath)![0].status, reads };
  };
  // Carnets miroirs : UP bid 0,70 / ask 0,90 ; DOWN ask 0,30 → prix du carnet pour UP = 0,80.
  const mirror = { UP: { asks: [{ price: 0.9, size: 1000 }], bids: [{ price: 0.7, size: 1000 }] }, DOWN: { asks: [{ price: 0.3, size: 1000 }], bids: [] } };
  const raw = await sell(DEFAULT_FAIR_VALUE_CONFIG, mirror);
  assert.equal(raw.status, 'sold', 'modèle seul : 0,70 > 0,50 + marge → revente');
  assert.ok(raw.reads.every(id => id === 'UP'), 'sans mélange : le carnet DOWN n\'est jamais lu');
  const trusting = { ...DEFAULT_FAIR_VALUE_CONFIG, blendModel: 0.05, blendMarket: 1 };
  assert.equal((await sell(trusting, mirror)).status, 'open', 'carnet jugé informé (≈ 0,80) : vendre à 0,70 serait brader');
  // Carnets NON miroirs (scénario de la revue) : spot sous le strike, mélange partiel.
  // Milieu bid/ask du token UP = 0,61 ; formule d'entrée = (ask UP 0,62 + 1 − ask DOWN 0,30)/2 = 0,66.
  const partial = { ...DEFAULT_FAIR_VALUE_CONFIG, blendModel: 0.5, blendMarket: 1 };
  const pRaw = probUp({ spot: 99.956, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 100 })!;
  const netBid = 0.6 - DEFAULT_FAIR_VALUE_CONFIG.takerFeeRate * 0.6 * 0.4;
  assert.ok(netBid > blendWithMarket(pRaw, 0.61, partial)! + 0.04, 'l\'ancienne formule aurait revendu');
  assert.ok(netBid < blendWithMarket(pRaw, 0.66, partial)! + 0.04, 'la formule d\'entrée dit : garder');
  const skew = { UP: { asks: [{ price: 0.62, size: 1000 }], bids: [{ price: 0.6, size: 1000 }] }, DOWN: { asks: [{ price: 0.3, size: 1000 }], bids: [] } };
  const env = setup();
  const r = env.runner();
  await r.tick();
  env.deps.cfg = partial;
  env.deps.getRoundData = async () => ({ spot: 99.956, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 0 });
  const reads: string[] = [];
  env.deps.getBook = async id => { reads.push(id); return skew[id as 'UP' | 'DOWN']; };
  env.setNow((SLOT + 200) * 1000);
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'open', 'même probabilité qu\'à l\'entrée → pas de revente à 0,60');
  assert.ok(reads.includes('DOWN'), 'mélange actif : l\'autre carnet est lu');
});

test('bestLevel : plus bas ask, plus haut bid ; niveaux vides ou hors ]0 ; 1[ ignorés', async () => {
  const { bestLevel } = await import('../src/strategy/fair-value-runner.ts');
  const lv = [{ price: 0.6, size: 5 }, { price: 0.4, size: 0 }, { price: 0.5, size: 3 }, { price: 1, size: 9 }, { price: 0, size: 9 }];
  assert.deepEqual(bestLevel(lv, 'ask'), { price: 0.5, size: 3 });
  assert.deepEqual(bestLevel(lv, 'bid'), { price: 0.6, size: 5 });
  assert.equal(bestLevel([], 'bid'), null);
});
