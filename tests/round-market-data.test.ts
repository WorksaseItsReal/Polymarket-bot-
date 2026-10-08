/**
 * tests/round-market-data.test.ts — lecture spot/strike/vol avec `fetch` simulé.
 * Exécution : `npx tsx --test tests/round-market-data.test.ts`
 *
 * Aucun réseau : `globalThis.fetch` est remplacé le temps du test. On vérifie le
 * format réel des réponses Binance, le repli sur la source suivante et le refus
 * d'un round non encore ouvert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRoundMarketData } from '../src/services/round-market-data.ts';

const SLOT = 1_790_000_100;
const NOW = (SLOT + 150) * 1000; // 2 min 30 s dans le round

/** 61 bougies 1 min au format Binance /api/v3/klines, la dernière = minute en cours. */
function binanceKlines(): unknown[] {
  const out: unknown[] = [];
  const lastOpen = Math.floor(NOW / 60_000) * 60_000;
  let px = 60_000;
  for (let i = 60; i >= 0; i--) {
    const openTime = lastOpen - i * 60_000;
    const open = px;
    px = px * Math.exp((i % 2 ? 1 : -1) * 0.0005);
    out.push([openTime, String(open), String(px * 1.001), String(px * 0.999), String(px), '1', openTime + 59_999]);
  }
  return out;
}

async function withFetch<T>(impl: (url: string) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => impl(String(input))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('Binance indisponible → repli binance-vision ; strike = (O+H+L+C)/4 de la minute précédant l\'ouverture, spot = close courant', async () => {
  const urls: string[] = [];
  const klines = binanceKlines();
  const d = await withFetch(async (url) => {
    urls.push(url);
    if (url.startsWith('https://api.binance.com')) return new Response('geo-blocked', { status: 451 });
    return new Response(JSON.stringify(klines), { status: 200 });
  }, () => getRoundMarketData('ETH', SLOT, NOW));
  assert.ok(d, 'données attendues');
  assert.equal(d!.source, 'binance-vision');
  assert.ok(urls[0].includes('api.binance.com') && urls[1].includes('data-api.binance.vision'));
  const prevRow = (klines.find(k => (k as unknown[])[0] === SLOT * 1000 - 60_000) as unknown[]).map(x => Number(x));
  const ohlc4 = (prevRow[1] + prevRow[2] + prevRow[3] + prevRow[4]) / 4;
  assert.ok(Math.abs(d!.strike - ohlc4) < 1e-9, `${d!.strike} ≠ ${ohlc4}`);
  assert.equal(d!.spot, parseFloat((klines[klines.length - 1] as unknown[])[4] as string));
  assert.ok(Math.abs(d!.sigmaPerSqrtSec - 0.0005 / Math.sqrt(60)) < 1e-9);
});

test('toutes les sources en échec → null (aucun prix inventé)', async () => {
  const d = await withFetch(async () => { throw new Error('réseau coupé'); }, () => getRoundMarketData('SOL', SLOT, NOW));
  assert.equal(d, null);
});

test('round pas encore ouvert → null sans requête réseau', async () => {
  let calls = 0;
  const d = await withFetch(async () => { calls++; return new Response('[]'); }, () => getRoundMarketData('XRP', SLOT, SLOT * 1000 - 1));
  assert.equal(d, null);
  assert.equal(calls, 0);
});
