/**
 * tests/daily-report.test.ts — rapport quotidien Telegram : heure locale, une fois par jour,
 * rattrapage au démarrage, état persisté.
 * Exécution : `npx tsx --test tests/daily-report.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dailyReportDue, localDateTime, parseHHMM, readLastDailyReport, writeLastDailyReport } from '../src/bot/daily-report.ts';
import { loadBotConfig } from '../src/bot/config.ts';

test('parseHHMM : 08:00, 8h30, bornes ; invalide → null', () => {
  assert.equal(parseHHMM('08:00'), 480);
  assert.equal(parseHHMM('8h30'), 510);
  assert.equal(parseHHMM(' 23:59 '), 1439);
  assert.equal(parseHHMM('24:00'), null);
  assert.equal(parseHHMM('12:60'), null);
  assert.equal(parseHHMM('midi'), null);
  assert.equal(parseHHMM(''), null);
});

test('heure locale (Paris, été et hiver) ; fuseau invalide → UTC', () => {
  // 11 oct. 2026 06:30 UTC = 08:30 à Paris (UTC+2)
  assert.deepEqual(localDateTime(Date.UTC(2026, 9, 11, 6, 30), 'Europe/Paris'), { date: '2026-10-11', minutes: 510 });
  // 15 janv. 2026 23:30 UTC = 16 janv. 00:30 à Paris (UTC+1)
  assert.deepEqual(localDateTime(Date.UTC(2026, 0, 15, 23, 30), 'Europe/Paris'), { date: '2026-01-16', minutes: 30 });
  assert.deepEqual(localDateTime(Date.UTC(2026, 9, 11, 6, 30), 'Pas/UnFuseau'), { date: '2026-10-11', minutes: 390 });
});

test('dû une fois par jour local, à partir de l\'heure ; rattrapage si le bot démarre après', () => {
  const at = 8 * 60;
  const tz = 'Europe/Paris';
  assert.equal(dailyReportDue(Date.UTC(2026, 9, 11, 5, 59), tz, at, null).due, false, '07:59 à Paris');
  assert.deepEqual(dailyReportDue(Date.UTC(2026, 9, 11, 6, 0), tz, at, null), { due: true, date: '2026-10-11' });
  assert.equal(dailyReportDue(Date.UTC(2026, 9, 11, 6, 1), tz, at, '2026-10-11').due, false, 'déjà envoyé aujourd\'hui');
  assert.equal(dailyReportDue(Date.UTC(2026, 9, 11, 15, 0), tz, at, '2026-10-10').due, true, 'démarrage à 17:00, pas encore envoyé');
  assert.equal(dailyReportDue(Date.UTC(2026, 9, 11, 22, 30), tz, at, '2026-10-11').due, false, '00:30 le 12 à Paris, mais avant 08:00');
  assert.equal(dailyReportDue(Date.UTC(2026, 9, 12, 6, 0), tz, at, '2026-10-11').due, true, 'lendemain 08:00');
});

test('état persisté : lu, écrit atomiquement ; illisible ou absent → null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-report-'));
  const p = join(dir, 'sub', 'daily-report.json');
  assert.equal(readLastDailyReport(p), null);
  assert.equal(writeLastDailyReport(p, '2026-10-11'), true);
  assert.equal(readLastDailyReport(p), '2026-10-11');
  writeFileSync(p, '{pas du json');
  assert.equal(readLastDailyReport(p), null);
  writeFileSync(p, JSON.stringify({ lastDate: 'hier' }));
  assert.equal(readLastDailyReport(p), null);
});

test('config : TELEGRAM_DAILY_REPORT (défaut 08:00, off) et TELEGRAM_DAILY_REPORT_DAYS', () => {
  assert.deepEqual(loadBotConfig({}).config.dailyReport, { atMinutes: 480, days: 3 });
  assert.deepEqual(loadBotConfig({ TELEGRAM_DAILY_REPORT: '21:15', TELEGRAM_DAILY_REPORT_DAYS: '7' }).config.dailyReport, { atMinutes: 1275, days: 7 });
  for (const off of ['off', 'false', '0', 'non', 'no']) assert.equal(loadBotConfig({ TELEGRAM_DAILY_REPORT: off }).config.dailyReport, null, off);
  const bad = loadBotConfig({ TELEGRAM_DAILY_REPORT: 'midi' });
  assert.deepEqual(bad.config.dailyReport, { atMinutes: 480, days: 3 });
  assert.ok(bad.warnings.some(w => /TELEGRAM_DAILY_REPORT=midi/.test(w)), bad.warnings.join('\n'));
  assert.ok(loadBotConfig({ TELEGRAM_DAILY_REPORT_DAYS: '99' }).warnings.some(w => /TELEGRAM_DAILY_REPORT_DAYS/.test(w)));
});
