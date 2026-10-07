/**
 * tests/round-discovery.test.ts — découverte des rounds 5 min par slug déterministe.
 * Exécution : `npx tsx --test tests/round-discovery.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoundDiscovery, parseDiscoveryEvent, roundSlug, slotStart } from '../src/services/round-discovery.ts';

const SLOT = 1_790_000_100;
const CID = '0x' + 'ab'.repeat(32);
const UP = '1'.repeat(70);
const DOWN = '2'.repeat(70);

function event(slug: string, over: Record<string, unknown> = {}) {
  return [{
    slug, title: 'Bitcoin Up or Down',
    markets: [{
      conditionId: CID, question: 'Bitcoin Up or Down - 10:15AM-10:20AM ET', closed: false,
      outcomes: '["Up","Down"]', clobTokenIds: JSON.stringify([UP, DOWN]), ...over,
    }],
  }];
}

test('slot et slug : début de round aligné sur 5 min', () => {
  assert.equal(slotStart(SLOT * 1000 + 299_999), SLOT);
  assert.equal(slotStart(SLOT * 1000 + 300_000), SLOT + 300);
  assert.equal(roundSlug('DOGE', SLOT), `doge-updown-5m-${SLOT}`);
});

test('parse : tokens associés par LIBELLÉ, réponses douteuses rejetées', () => {
  const slug = roundSlug('BTC', SLOT);
  const ok = parseDiscoveryEvent(event(slug), 'BTC', slug)!;
  assert.equal(ok.conditionId, CID);
  assert.equal(ok.upTokenId, UP);
  assert.equal(ok.downTokenId, DOWN);
  assert.equal(ok.durationMinutes, 5);
  const reversed = parseDiscoveryEvent(event(slug, { outcomes: '["Down","Up"]' }), 'BTC', slug)!;
  assert.equal(reversed.upTokenId, DOWN, 'ordre inversé → on suit le libellé');
  assert.equal(parseDiscoveryEvent(event('xi-jinping-out-before-2027'), 'BTC', slug), null, 'autre slug');
  assert.equal(parseDiscoveryEvent(event(slug, { closed: true }), 'BTC', slug), null, 'marché clôturé');
  assert.equal(parseDiscoveryEvent(event(slug, { outcomes: '["Yes","No"]' }), 'BTC', slug), null);
  assert.equal(parseDiscoveryEvent(event(slug, { clobTokenIds: '[]' }), 'BTC', slug), null);
  assert.equal(parseDiscoveryEvent(event(slug, { clobTokenIds: JSON.stringify([UP, UP]) }), 'BTC', slug), null);
  assert.equal(parseDiscoveryEvent(event(slug, { conditionId: '0x12' }), 'BTC', slug), null);
  for (const junk of [null, {}, [], [{ slug }], 'html']) assert.equal(parseDiscoveryEvent(junk, 'BTC', slug), null);
});

test('RoundDiscovery : un appel par round (cache), réessai borné des rounds introuvables', async () => {
  const urls: string[] = [];
  let ethReady = false;
  const fetchImpl = (async (u: string | URL | Request) => {
    const url = String(u);
    urls.push(url);
    const slug = decodeURIComponent(url.split('slug=')[1]);
    if (slug.startsWith('eth') && !ethReady) return new Response('[]');
    if (slug.startsWith('sol')) return new Response('bad gateway', { status: 502 });
    const coin = slug.split('-')[0].toUpperCase();
    return new Response(JSON.stringify(event(slug, { conditionId: '0x' + coin.charCodeAt(0).toString(16).padStart(2, '0').repeat(32) })));
  }) as typeof fetch;
  const d = new RoundDiscovery({ fetchImpl, retryMs: 15_000 });
  const now = SLOT * 1000 + 30_000;

  let r = await d.current(now, ['BTC', 'ETH', 'SOL']);
  assert.deepEqual(r.map(x => x.underlying), ['BTC']);
  assert.ok(urls.every(u => u.startsWith('https://gamma-api.polymarket.com/events?slug=')));
  assert.equal(urls.length, 3);

  // 5 s plus tard : BTC en cache, ETH/SOL pas réessayés (retryMs)
  r = await d.current(now + 5000, ['BTC', 'ETH', 'SOL']);
  assert.equal(urls.length, 3);
  assert.equal(r.length, 1);

  // 20 s plus tard : ETH est publié → trouvé ; SOL toujours en panne
  ethReady = true;
  r = await d.current(now + 20_000, ['BTC', 'ETH', 'SOL']);
  assert.deepEqual(r.map(x => x.underlying).sort(), ['BTC', 'ETH']);
  assert.equal(urls.length, 5);

  // Nouveau round : nouveaux slugs
  r = await d.current(now + 300_000, ['BTC']);
  assert.equal(r[0].slug, roundSlug('BTC', SLOT + 300));
});

test('RoundDiscovery : réseau en panne ou délai dépassé → liste vide, jamais une exception', async () => {
  const d = new RoundDiscovery({
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch,
    timeoutMs: 20,
  });
  assert.deepEqual(await d.current(SLOT * 1000, ['BTC']), []);
});
