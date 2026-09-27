/**
 * Vérification RÉELLE du comportement erreurs réseau / retries / timeouts
 * (en stubant globalThis.fetch — le reste du code est celui du projet).
 */
import { GammaApiClient } from '/root/clawd/Polymarket-bot/src/clients/gamma-api.js';
import { DataApiClient } from '/root/clawd/Polymarket-bot/src/clients/data-api.js';
import { RateLimiter } from '/root/clawd/Polymarket-bot/src/core/rate-limiter.js';
import { createUnifiedCache } from '/root/clawd/Polymarket-bot/src/core/unified-cache.js';

const lr = new RateLimiter();
const cache = createUnifiedCache();
const gamma = new GammaApiClient(lr, cache);
const dataApi = new DataApiClient(lr, cache);
const origFetch = globalThis.fetch;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function run(title: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`  ${title} -> OK (${Date.now() - t0} ms)`, JSON.stringify(r).slice(0, 90));
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(`  ${title} -> ERREUR ${err.code ?? ''} "${err.message.slice(0, 110)}" (${Date.now() - t0} ms)`);
  }
}

(async () => {
  console.log('== A. 429 (rate limit) avec Retry-After: 1, puis 200 ==');
  let n429 = 0;
  globalThis.fetch = (async () => {
    n429++;
    if (n429 <= 2) return json({ error: 'usage limit reached' }, 429, { 'retry-after': '1' });
    return json([{ id: '1', conditionId: '0x' + 'a'.repeat(64), slug: 's', question: 'q', outcomes: '["Up","Down"]', outcomePrices: '["0.5","0.5"]' }]);
  }) as typeof fetch;
  await run(`getMarkets (attendu: succès après 2 retries, ~2 s, fetch appelé ${'3'}x)`, () => gamma.getMarkets({ limit: 1 }));
  console.log('  fetch() appelé', n429, 'fois');

  console.log('== B. 5xx persistant (retryable) ==');
  let n5 = 0;
  globalThis.fetch = (async () => { n5++; return json({ message: 'bad gateway' }, 502); }) as typeof fetch;
  await run('getMarkets', () => gamma.getMarkets({ limit: 1 }));
  console.log('  fetch() appelé', n5, 'fois');

  console.log('== C. 404 (non retryable → échec immédiat, 1 seul appel) ==');
  let n4 = 0;
  globalThis.fetch = (async () => { n4++; return json({ message: 'not found' }, 404); }) as typeof fetch;
  await run('getMarkets', () => gamma.getMarkets({ limit: 1 }));
  console.log('  fetch() appelé', n4, 'fois');

  console.log('== D. timeout réseau (réponse jamais envoyée) ==');
  let nT = 0;
  globalThis.fetch = ((_u: string, init?: RequestInit) => {
    nT++;
    return new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        (e as Error & { name: string }).name = 'AbortError';
        rej(e);
      });
    });
  }) as typeof fetch;
  await run('getMarkets (attendu: TIMEOUT après 3 tentatives × 10 s)', () => gamma.getMarkets({ limit: 1 }));
  console.log('  fetch() appelé', nT, 'fois');

  console.log('== E. Data API : réponse 200 non-tableau (panne déguisée en donnée) ==');
  globalThis.fetch = (async () => json({ error: 'usage limit reached' }, 200)) as typeof fetch;
  await run('getTrades', () => dataApi.getTrades({ market: '0x' + 'b'.repeat(64), limit: 5 }));
  await run('getPositions', () => dataApi.getPositions('0xabc', { limit: 5 }));

  console.log('== F. Data API : panne réseau ==');
  globalThis.fetch = (async () => { throw new Error('ENOTFOUND'); }) as typeof fetch;
  await run('getTrades', () => dataApi.getTrades({ market: '0x' + 'b'.repeat(64), limit: 5 }));

  globalThis.fetch = origFetch;
})().catch(e => { console.error('FAIL', e); process.exit(1); });
