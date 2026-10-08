/**
 * tests/doctor.test.ts — diagnostic d'installation (configuration, fichiers, réseau).
 * Exécution : `npx tsx --test tests/doctor.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configChecks, fileChecks, networkChecks, runtimeChecks, summarize } from '../src/services/doctor.ts';

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

test('clé du wallet : forme vérifiée sans jamais la citer', () => {
  const key = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  const check = (k: string | undefined, extra: Record<string, string> = {}) => configChecks({ POLYMARKET_PRIVATE_KEY: k, ...extra }).find(c => c.label === 'Clé du wallet')!;
  assert.equal(check(undefined).level, 'ok');
  assert.equal(check('your_private_key_here').level, 'ok');
  assert.match(check('0x' + key).detail, /bonne forme ; en papier elle ne signe rien/);
  assert.match(check(` 0x${key} `).detail, /espaces autour ignorés/);
  const typo = check(key.slice(0, 20) + 'O' + key.slice(21));
  assert.equal(typo.level, 'warn');
  assert.match(typo.detail, /1 caractère\(s\) non hexadécimal/);
  assert.match(check(key.slice(1)).detail, /63 caractères au lieu de 64 — sans effet en papier/);
  assert.equal(check(key.slice(1), { DRY_RUN: 'false' }).level, 'error');
  assert.equal(check(undefined, { DRY_RUN: 'false' }).level, 'error');
  for (const k of [key, key.slice(1), key.slice(0, 20) + 'O' + key.slice(21)]) {
    assert.ok(configChecks({ POLYMARKET_PRIVATE_KEY: k }).every(c => !c.detail.includes(k.slice(0, 12))), 'jamais citée');
  }
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
  assert.equal(fileChecks(poly, poly).find(c => c.label === 'Plantages')!.level, 'ok');
  const now = 1_790_000_000_000;
  writeFileSync(join(poly, 'run-state.json'), JSON.stringify({ crashes: [now - 25 * 3_600_000, now - 3 * 3_600_000, now - 12 * 60_000], lastAlertAt: 0, alertGapMs: 0 }));
  const crash = fileChecks(poly, poly, now).find(c => c.label === 'Plantages')!;
  assert.equal(crash.level, 'warn');
  assert.match(crash.detail, /^2 arrêt\(s\) anormal\(aux\) en 24 h, dernier il y a 12 min/);
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

test('horloge : des requêtes lentes AVANT Binance ne passent plus pour un décalage', async () => {
  let t = 1_790_000_100_000;
  const fetchImpl = (async (u: string | URL | Request) => {
    const url = String(u);
    if (url.includes('gamma-api') || url.includes('api.binance.com')) {
      t += 6000; // Gamma lent, puis api.binance.com qui expire : 12 s perdues avant le repli
      throw new Error('timeout');
    }
    // binance.vision répond tout de suite, à la bonne heure
    return new Response('[]', { status: 200, headers: { date: new Date(t).toUTCString() } });
  }) as typeof fetch;
  const cs = await networkChecks(fetchImpl, t, 6000, () => t);
  assert.equal(cs.find(c => c.label === 'Horloge')!.level, 'ok', JSON.stringify(cs));
});

test('configuration : mêmes lectures que le bot (FV_MIN_ORDER_USD > 100 ignoré, FV_TAILS invalide signalé)', () => {
  const cs = configChecks({ PAPER_CAPITAL: '250', FV_MIN_ORDER_USD: '150', FV_TAILS: 'T4' });
  assert.equal(cs.find(c => c.label === 'Capital')!.level, 'ok', 'le bot utilise 1 $ (150 hors bornes)');
  assert.match(cs.find(c => c.label === 'Réglages FV')!.detail, /FV_TAILS=T4/);
});

test('réglages du bot : valeurs ramenées ou ignorées signalées (comme le bot les lit)', () => {
  const cs = configChecks({ PAPER_CAPITAL: '250', FV_POLL_SEC: '1', FV_FILL_DELAY_MS: '0', FV_COINS: 'BTC,ADA', FV_EXIT_EDGE: '2' });
  const d = cs.find(c => c.label === 'Réglages du bot')!;
  assert.equal(d.level, 'warn');
  assert.match(d.detail, /FV_POLL_SEC=1 → 5/);
  assert.match(d.detail, /aucune latence simulée/);
  assert.match(d.detail, /ADA inconnu/);
  assert.match(d.detail, /FV_EXIT_EDGE=2 ignoré/);
  assert.equal(configChecks({ PAPER_CAPITAL: '250', FV_POLL_SEC: '10', FV_COINS: 'btc,eth' }).find(c => c.label === 'Réglages du bot')!.level, 'ok');
});

test('Node.js : ≥ 20.6 requis (PM2 lance le bot par node --import tsx)', () => {
  assert.equal(runtimeChecks('22.22.0')[0].level, 'ok');
  assert.equal(runtimeChecks('20.6.0')[0].level, 'ok');
  assert.equal(runtimeChecks('20.5.1')[0].level, 'error');
  assert.equal(runtimeChecks('18.19.0')[0].level, 'error');
  assert.equal(runtimeChecks()[0].level, 'ok', 'le Node qui fait tourner les tests');
});
