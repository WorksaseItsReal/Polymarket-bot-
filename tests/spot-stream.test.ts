/**
 * tests/spot-stream.test.ts — flux spot temps réel (serveur WebSocket LOCAL), ordonnanceur
 * des évaluations, et usage du prix temps réel dans les données de round.
 * Exécution : `npx tsx --test tests/spot-stream.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket as WsClient } from 'ws';
import { SpotStream, parseAggTrade } from '../src/services/spot-stream.ts';
import { MoveScheduler } from '../src/strategy/move-scheduler.ts';
import { clearRoundDataCache, getRoundMarketData } from '../src/services/round-market-data.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const trade = (s: string, p: number, T = Date.now()) => JSON.stringify({ stream: `${s.toLowerCase()}@aggTrade`, data: { e: 'aggTrade', s, p: String(p), T, E: T } });

async function server() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const port = (wss.address() as { port: number }).port;
  const clients: WsClient[] = [];
  const paths: string[] = [];
  wss.on('connection', (c, req) => { clients.push(c); paths.push(req.url ?? ''); });
  return { wss, url: `ws://127.0.0.1:${port}/stream?streams=`, clients, paths };
}

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('délai dépassé');
    await sleep(10);
  }
}

test('parseAggTrade : format combiné Binance, rejette le reste', () => {
  assert.deepEqual(parseAggTrade(trade('BTCUSDT', 62000.5, 1000)), { coin: 'BTC', price: 62000.5, eventTime: 1000 });
  assert.equal(parseAggTrade(trade('PEPEUSDT', 1)), null);
  assert.equal(parseAggTrade('{"data":{"e":"trade","s":"BTCUSDT","p":"1","T":1}}'), null);
  assert.equal(parseAggTrade(trade('BTCUSDT', 0)), null);
  assert.equal(parseAggTrade('pas du json'), null);
});

test('flux : prix temps réel, événement move au-delà du seuil, abonnement aux bons flux', async () => {
  const srv = await server();
  const s = new SpotStream({ coins: ['BTC', 'ETH'], urls: [srv.url], moveBps: 5 });
  const moves: Array<[string, number]> = [];
  s.on('move', (c: string, p: number) => moves.push([c, p]));
  s.start();
  try {
    await until(() => srv.clients.length === 1);
    assert.match(srv.paths[0], /btcusdt@aggTrade\/ethusdt@aggTrade$/);
    srv.clients[0].send(trade('BTCUSDT', 100));
    await until(() => s.price('BTC') !== null);
    assert.equal(s.price('BTC')!.price, 100);
    assert.equal(s.price('ETH'), null, 'aucun prix inventé pour un coin sans trade');
    srv.clients[0].send(trade('BTCUSDT', 100.04)); // 4 bps : sous le seuil
    srv.clients[0].send(trade('BTCUSDT', 100.06)); // 6 bps : move
    await until(() => moves.length === 1);
    assert.deepEqual(moves[0], ['BTC', 100.06]);
    assert.equal(s.isConnected(), true);
  } finally {
    s.stop();
    srv.wss.close();
  }
});

test('flux : prix périmé → null ; reconnexion après coupure ; source muette → source suivante', async () => {
  let t = 1_000_000;
  const a = await server();
  const b = await server();
  // A accepte la connexion mais n'envoie jamais rien (proxy muet) ; B fonctionne.
  const s = new SpotStream({ coins: ['BTC'], urls: [a.url, b.url], staleMs: 300, now: () => t });
  s.start();
  try {
    await until(() => a.clients.length === 1);
    t += 1000; // le chien de garde constate le silence
    await until(() => b.clients.length >= 1, 5000);
    b.clients[0].send(trade('BTCUSDT', 50, t));
    await until(() => s.price('BTC') !== null);
    t += 5000;
    assert.equal(s.price('BTC'), null, 'prix vieux de 5 s → ignoré');
    assert.ok(s.price('BTC', 10_000));
    // coupure brutale côté serveur → reconnexion
    const before = b.clients.length;
    b.clients[0].terminate();
    await until(() => b.clients.length > before || a.clients.length > 1, 6000);
  } finally {
    s.stop();
    a.wss.close();
    b.wss.close();
  }
});

test('flux : horloge décalée détectée (médiane réception − horodatage)', async () => {
  const srv = await server();
  const s = new SpotStream({ coins: ['BTC'], urls: [srv.url], maxClockSkewMs: 2000 });
  const skews: number[] = [];
  s.on('clockSkew', (ms: number) => skews.push(ms));
  s.start();
  try {
    await until(() => srv.clients.length === 1);
    for (let i = 0; i < 25; i++) srv.clients[0].send(trade('BTCUSDT', 100, Date.now() - 5000));
    await until(() => skews.length === 1);
    assert.ok(skews[0] >= 4900, `décalage mesuré ${skews[0]} ms`);
  } finally {
    s.stop();
    srv.wss.close();
  }
});

test('ordonnanceur : regroupe, bride par coin, réessaie si la stratégie est occupée', async () => {
  const calls: string[][] = [];
  let busy = true;
  const sch = new MoveScheduler({
    run: async coins => { calls.push(coins); if (busy) { busy = false; return false; } return true; },
    minIntervalMs: 100, debounceMs: 10, retryMs: 20,
  });
  sch.onMove('BTC');
  sch.onMove('BTC');
  sch.onMove('ETH');
  await until(() => calls.length === 2);
  assert.deepEqual(calls[0].sort(), ['BTC', 'ETH'], 'regroupés en un seul passage');
  assert.deepEqual(calls[1].sort(), ['BTC', 'ETH'], 'repris après un passage occupé');
  sch.onMove('BTC'); // < 100 ms après : bridé puis exécuté
  await until(() => calls.length === 3);
  assert.deepEqual(calls[2], ['BTC']);
  sch.stop();
  sch.onMove('SOL');
  await sleep(60);
  assert.equal(calls.length, 3, 'plus rien après stop()');
});

test('données de round : le prix temps réel remplace la bougie si même source et frais', async () => {
  const slot = 1_790_000_100;
  const now = (slot + 150) * 1000;
  const lastOpen = Math.floor(now / 60_000) * 60_000;
  const klines = Array.from({ length: 61 }, (_, i) => {
    const t = lastOpen - (60 - i) * 60_000;
    const p = 100 * Math.exp(((i % 2) ? 1 : -1) * 0.0005);
    return [t, '100', '101', '99', String(p), '1', t + 59_999];
  });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify(klines)); }) as typeof fetch;
  try {
    clearRoundDataCache();
    const live = await getRoundMarketData('BTC', slot, now, { price: 100.5, ageMs: 200, source: 'binance-ws' });
    assert.equal(live!.spot, 100.5);
    assert.equal(live!.source, 'binance+ws');
    // strike : (O+H+L+C)/4 de la bougie précédant l'ouverture (O 100, H 101, L 99, C p)
    const prev = klines.find(k => k[0] === slot * 1000 - 60_000)!;
    assert.ok(Math.abs(live!.strike - (100 + 101 + 99 + Number(prev[4])) / 4) < 1e-12);
    // prix temps réel trop vieux → bougie
    const old = await getRoundMarketData('BTC', slot, now + 1000, { price: 100.5, ageMs: 9000, source: 'binance-ws' });
    assert.notEqual(old!.spot, 100.5);
    // avec un flux frais, les bougies sont gardées 30 s (strike et vol seulement)
    const before = calls;
    await getRoundMarketData('BTC', slot, now + 10_000, { price: 100.6, ageMs: 100, source: 'binance-ws' });
    assert.equal(calls, before, 'pas de requête REST supplémentaire');
  } finally {
    globalThis.fetch = original;
    clearRoundDataCache();
  }
});

test('données de round : le prix temps réel est relu APRÈS le chargement des bougies', async () => {
  const slot = 1_790_000_100;
  const now = (slot + 150) * 1000;
  const lastOpen = Math.floor(now / 60_000) * 60_000;
  const klines = Array.from({ length: 61 }, (_, i) => {
    const t = lastOpen - (60 - i) * 60_000;
    return [t, '100', '101', '99', String(100 * Math.exp(((i % 2) ? 1 : -1) * 0.0005)), '1', t + 59_999];
  });
  const original = globalThis.fetch;
  let live = { price: 100.1, ageMs: 100, source: 'binance-ws' };
  globalThis.fetch = (async () => {
    live = { price: 100.3, ageMs: 50, source: 'binance-ws' }; // le spot bouge pendant la requête
    return new Response(JSON.stringify(klines));
  }) as typeof fetch;
  try {
    clearRoundDataCache();
    const d = await getRoundMarketData('BTC', slot, now, () => live);
    assert.equal(d!.spot, 100.3, 'spot lu après la requête, pas avant');
  } finally {
    globalThis.fetch = original;
    clearRoundDataCache();
  }
});

test('données de round : flux décroché pendant le chargement → exigences du mode REST', async () => {
  const slot = 1_790_000_100;
  const now = (slot + 150) * 1000;
  const lastOpen = Math.floor(now / 60_000) * 60_000;
  // Dernière bougie = minute PRÉCÉDENTE (90 s) : acceptable pour strike/vol, pas comme spot.
  const klines = Array.from({ length: 61 }, (_, i) => {
    const t = lastOpen - 60_000 - (60 - i) * 60_000;
    return [t, '100', '101', '99', String(100 * Math.exp(((i % 2) ? 1 : -1) * 0.0005)), '1', t + 59_999];
  });
  const original = globalThis.fetch;
  let live: { price: number; ageMs: number; source: string } | null = { price: 100.1, ageMs: 100, source: 'binance-ws' };
  globalThis.fetch = (async () => { live = null; return new Response(JSON.stringify(klines)); }) as typeof fetch;
  try {
    clearRoundDataCache();
    const d = await getRoundMarketData('BTC', slot, now + 30_000, () => live);
    assert.equal(d, null, 'sans flux, une bougie de > 65 s n\'est pas un spot');
  } finally {
    globalThis.fetch = original;
    clearRoundDataCache();
  }
});
