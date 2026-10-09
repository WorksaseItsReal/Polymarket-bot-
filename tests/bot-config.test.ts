/**
 * tests/bot-config.test.ts — configuration unique du bot (lue pareil par le bot et le doctor).
 * Exécution : `npx tsx --test tests/bot-config.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FAIR_VALUE_CONFIG } from '../src/services/fair-value.ts';
import { capitalWarning, dataPaths, isDryRun, loadBotConfig } from '../src/bot/config.ts';

test('défauts : papier, 50 $, 10 s, 5 coins, Telegram absent, aucune alerte', () => {
  const { config: c, warnings } = loadBotConfig({ HOME: '/tmp/x' });
  assert.deepEqual(warnings, []);
  assert.equal(c.dryRun, true);
  assert.equal(c.capital, 50);
  assert.equal(c.pollMs, 10_000);
  assert.deepEqual([...c.coins], ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']);
  assert.equal(c.telegram, null);
  assert.equal(c.exitEdge, DEFAULT_FAIR_VALUE_CONFIG.minEdge, 'FV_EXIT_EDGE suit FV_MIN_EDGE');
  assert.equal(c.timeZone, 'Europe/Paris');
  assert.equal(c.dataDir, '/tmp/x/.polymarket');
  assert.equal(c.dashboard.host, '127.0.0.1');
  assert.equal(c.journal.keepDays, 30);
});

test('valeurs lues : capital papier prioritaire, coins filtrés, Telegram, dashboard, journal', () => {
  const { config: c, warnings } = loadBotConfig({
    PAPER_CAPITAL: '250', CAPITAL_USD: '1000', FV_POLL_SEC: '5', FV_COINS: 'eth, btc', FV_MIN_EDGE: '0.05',
    TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_CHAT_ID: '42', TELEGRAM_SUMMARY_MIN: '30', TELEGRAM_TZ: 'UTC',
    DASHBOARD_HOST: '0.0.0.0', DASHBOARD_PORT: '3005', DASHBOARD_TOKEN: 'abc', FV_JOURNAL: 'false', FV_SPOT_STREAM: 'false',
    FV_EXIT_EDGE: '0.02', HTTP_TIMEOUT_MS: '5000',
  });
  assert.deepEqual(warnings, []);
  assert.equal(c.capital, 250);
  assert.equal(c.pollMs, 5000);
  assert.deepEqual([...c.coins], ['BTC', 'ETH']);
  assert.equal(c.fv.minEdge, 0.05);
  assert.equal(c.exitEdge, 0.02);
  assert.deepEqual(c.telegram, { token: '123456789:' + 'A'.repeat(35), chatId: '42' });
  assert.equal(c.summaryEveryMin, 30);
  assert.equal(c.timeZone, 'UTC');
  assert.deepEqual(c.dashboard, { host: '0.0.0.0', port: 3005, token: 'abc' });
  assert.equal(c.journal.enabled, false);
  assert.equal(c.spotStream, false);
  assert.equal(c.httpTimeoutMs, 5000);
});

test('valeurs invalides : défaut + avertissement nommé, jamais un 0 silencieux', () => {
  const { config: c, warnings } = loadBotConfig({
    FV_POLL_SEC: '2', FV_MIN_EDGE: '0.9', FV_Z_SCALE: 'abc', FV_TAILS: 'cauchy', FV_COINS: 'ADA', TELEGRAM_TZ: 'Mars/Olympus',
    FV_SPOT_STREAM: 'peut-être', TELEGRAM_BOT_TOKEN: 'abc', TELEGRAM_CHAT_ID: '1', FV_MIN_TAU_SEC: '30', FV_MAX_TAU_SEC: '50',
  });
  assert.equal(c.pollMs, 10_000);
  assert.equal(c.fv.minEdge, DEFAULT_FAIR_VALUE_CONFIG.minEdge);
  assert.equal(c.fv.zScale, 1);
  assert.equal(c.fv.tails, 'normal');
  assert.equal(c.coins.length, 5);
  assert.equal(c.timeZone, 'Europe/Paris');
  assert.equal(c.spotStream, true);
  assert.equal(c.fv.minTauSec, DEFAULT_FAIR_VALUE_CONFIG.minTauSec, 'fenêtre τ vide → défauts');
  const text = warnings.join('\n');
  for (const k of ['FV_POLL_SEC=2', 'FV_MIN_EDGE=0.9', 'FV_Z_SCALE=abc', 'FV_TAILS=cauchy', 'FV_COINS=ADA', 'TELEGRAM_TZ=Mars/Olympus', 'FV_SPOT_STREAM=peut-être', 'TELEGRAM_BOT_TOKEN', 'FV_MIN_TAU_SEC=30']) {
    assert.ok(text.includes(k), `avertissement attendu pour ${k}\n${text}`);
  }
});

test('DRY_RUN : réel UNIQUEMENT si exactement false', () => {
  for (const v of [undefined, '', 'true', '1', 'no', 'off', 'faux', '0']) assert.equal(isDryRun({ DRY_RUN: v }), true, `DRY_RUN=${v}`);
  // même règle que depuis toujours dans le projet : insensible à la casse et aux espaces
  for (const v of ['false', ' FALSE ', 'False']) assert.equal(isDryRun({ DRY_RUN: v }), false, `DRY_RUN=${v}`);
});

test('capital face au minimum d\'ordre : trop petit, à peine, suffisant', () => {
  assert.match(capitalWarning({ capital: 50, minOrderUsd: 1 }, 0.01) ?? '', /aucun pari ne sera pris/);
  assert.match(capitalWarning({ capital: 150, minOrderUsd: 1 }, 0.01) ?? '', /à peine au-dessus/);
  assert.equal(capitalWarning({ capital: 250, minOrderUsd: 1 }, 0.01), null);
  assert.equal(capitalWarning({ capital: 10, minOrderUsd: 0 }, 0.01), null, 'contrôle désactivé');
});

test('chemins des données : tous sous le dossier d\'état', () => {
  const p = dataPaths('/srv/poly');
  assert.equal(p.ledger, '/srv/poly/fv-ledger.json');
  assert.equal(p.journalDir, '/srv/poly/journal');
  assert.ok(Object.values(p).every(x => x.startsWith('/srv/poly/')));
});

test('limites de perte : réglables, hiérarchie vérifiée (sinon défauts + avertissement)', () => {
  const { config: c, warnings } = loadBotConfig({ DAILY_MAX_LOSS_PCT: '0.03', MONTHLY_MAX_LOSS_PCT: '0.10', MAX_DRAWDOWN_PCT: '0.2', TOTAL_MAX_LOSS_PCT: '0.5' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(c.risk, { dailyMaxLossPct: 0.03, monthlyMaxLossPct: 0.1, maxDrawdownFromPeak: 0.2, totalMaxLossPct: 0.5 });
  const bad = loadBotConfig({ DAILY_MAX_LOSS_PCT: '0.3', MONTHLY_MAX_LOSS_PCT: '0.1' });
  assert.deepEqual(bad.config.risk, { dailyMaxLossPct: 0.05, monthlyMaxLossPct: 0.15, maxDrawdownFromPeak: 0.25, totalMaxLossPct: 0.4 });
  assert.match(bad.warnings.join('\n'), /limites de perte incohérentes/);
  assert.match(loadBotConfig({ TOTAL_MAX_LOSS_PCT: '2' }).warnings.join('\n'), /TOTAL_MAX_LOSS_PCT=2 ignoré/);
});
