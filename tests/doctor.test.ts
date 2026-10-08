/**
 * tests/doctor.test.ts — diagnostic d'installation (configuration, fichiers, réseau).
 * Exécution : `npx tsx --test tests/doctor.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configChecks, fileChecks, networkChecks, summarize } from '../src/services/doctor.ts';

const level = (cs: ReturnType<typeof configChecks>, label: string) => cs.find(c => c.label === label)?.level;

test('configuration : capital trop petit, anciennes stratégies, réglages ignorés, mode réel', () => {
  const bad = configChecks({ PAPER_CAPITAL: '50', DIPARB_ENABLED: 'true', FV_Z_SCALE: '9', TELEGRAM_BOT_TOKEN: 'abc', TELEGRAM_CHAT_ID: '1' });
  assert.equal(level(bad, 'Capital'), 'error');
  assert.equal(level(bad, 'Anciennes stratégies'), 'warn');
  assert.match(bad.find(c => c.label === 'Réglages FV')!.detail, /FV_Z_SCALE=9/);
  assert.equal(level(bad, 'Telegram'), 'error', 'token à la mauvaise forme');
  assert.equal(level(configChecks({ DRY_RUN: 'false' }), 'Mode'), 'error');
  const good = configChecks({ PAPER_CAPITAL: '250', FV_MIN_EDGE: '0.05', TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_CHAT_ID: '42' });
  assert.ok(good.every(c => c.level === 'ok'), summarize(good).text);
});

test('fichiers : registre illisible et arrêt de sécurité actif = erreurs', () => {
  const poly = mkdtempSync(join(tmpdir(), 'doctor-'));
  writeFileSync(join(poly, 'fv-ledger.json'), '{tronqué');
  writeFileSync(join(poly, 'fv-guard.json'), '{"reason":"perte"}');
  const cs = fileChecks(poly, mkdtempSync(join(tmpdir(), 'repo-')));
  assert.equal(cs.find(c => c.label === 'Registre')!.level, 'error');
  assert.equal(cs.find(c => c.label === 'Arrêt de sécurité')!.level, 'error');
  assert.equal(cs.find(c => c.label === 'Interface du dashboard')!.level, 'warn');
  mkdirSync(join(poly, 'journal'));
  writeFileSync(join(poly, 'journal', 'decisions-2026-10-07.jsonl'), 'x'.repeat(2000));
  assert.match(fileChecks(poly, poly).find(c => c.label === 'Journal des décisions')!.detail, /1 fichier/);
});

test('réseau : Gamma + carnet OK, Binance bloqué (451) avec repli, horloge décalée détectée', async () => {
  const now = 1_790_000_100_000;
  const slot = Math.floor(now / 1000 / 300) * 300;
  const fetchImpl = (async (u: string | URL | Request) => {
    const url = String(u);
    const json = (x: unknown, status = 200, date = new Date(now + 10_000).toUTCString()) =>
      new Response(JSON.stringify(x), { status, headers: { date } });
    if (url.includes('gamma-api')) {
      return json([{ slug: `btc-updown-5m-${slot}`, markets: [{ conditionId: '0x' + 'a'.repeat(64), outcomes: '["Up","Down"]', clobTokenIds: `["${'1'.repeat(20)}","${'2'.repeat(20)}"]`, closed: false }] }]);
    }
    if (url.includes('clob.polymarket.com/book')) return json({ bids: [], asks: [] });
    if (url.includes('api.binance.com')) return json({ msg: 'restricted location' }, 451);
    if (url.includes('binance.vision')) return json([[0, '1', '1', '1', '1', '1', 0]]);
    return json({}, 404);
  }) as typeof fetch;
  const cs = await networkChecks(fetchImpl, now);
  const by = (l: string) => cs.find(c => c.label === l)!;
  assert.equal(by('Polymarket Gamma').level, 'ok');
  assert.equal(by('Carnet CLOB').level, 'ok');
  assert.equal(by('Binance').level, 'warn');
  assert.match(by('Binance').detail, /451 \(pays bloqué\)/);
  assert.equal(by('Horloge').level, 'error', '10 s de décalage');
  const down = await networkChecks((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch, now, 200);
  assert.ok(down.every(c => c.level === 'error'));
});
