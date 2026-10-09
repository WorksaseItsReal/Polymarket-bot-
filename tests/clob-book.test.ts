/**
 * tests/clob-book.test.ts — lecture publique du carnet CLOB, sans SDK.
 * Exécution : `npx tsx --test tests/clob-book.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { fetchClobBook, parseClobBook } from '../src/services/clob-book.ts';

test('parseClobBook : niveaux triés (asks croissants, bids décroissants), déchets ignorés', () => {
  const b = parseClobBook({
    asset_id: '123', bids: [{ price: '0.40', size: '10' }, { price: '0.45', size: '5' }, { price: 'x', size: '1' }],
    asks: [{ price: '0.60', size: '7' }, { price: '0.55', size: '3' }, { price: '0.5', size: '-1' }],
  }, '123');
  assert.deepEqual(b.asks, [{ price: 0.55, size: 3 }, { price: 0.6, size: 7 }]);
  assert.deepEqual(b.bids, [{ price: 0.45, size: 5 }, { price: 0.4, size: 10 }]);
});

test('parseClobBook : 404, erreur, asset_id absent ou carnet vide → exception explicite (jamais un 50/50 fantôme)', () => {
  assert.throws(() => parseClobBook({ error: 'No orderbook exists for the requested token id' }, '9', 404), /périmé ou inconnu/);
  assert.throws(() => parseClobBook({ bids: [], asks: [] }, '9'), /périmé ou inconnu/);
  assert.throws(() => parseClobBook({ asset_id: '9', bids: [], asks: [] }, '9'), /carnet vide/);
  assert.throws(() => parseClobBook(null, '9'), /périmé ou inconnu/);
});

test('fetchClobBook : GET /book?token_id=…, délai, 404 lue sans AxiosError', async () => {
  const calls: Array<{ url: string; params: unknown; timeout?: number }> = [];
  const http = axios.create();
  http.defaults.adapter = async config => {
    calls.push({ url: String(config.url), params: config.params, timeout: config.timeout });
    const token = (config.params as { token_id: string }).token_id;
    if (token === 'dead') return { data: { error: 'No orderbook exists' }, status: 404, statusText: 'Not Found', headers: {}, config };
    return { data: { asset_id: token, bids: [{ price: '0.4', size: '1' }], asks: [{ price: '0.6', size: '2' }] }, status: 200, statusText: 'OK', headers: {}, config };
  };
  const book = await fetchClobBook('42', { http, timeoutMs: 1234, host: 'https://clob.example/' });
  assert.deepEqual(book, { bids: [{ price: 0.4, size: 1 }], asks: [{ price: 0.6, size: 2 }] });
  assert.deepEqual(calls[0], { url: 'https://clob.example/book', params: { token_id: '42' }, timeout: 1234 });
  await assert.rejects(fetchClobBook('dead', { http }), /périmé ou inconnu/);
});
