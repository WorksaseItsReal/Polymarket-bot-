/**
 * tests/bot-e2e.test.ts — le VRAI point d'entrée (bot-with-dashboard.ts) de bout en bout,
 * sur un faux Polymarket/Binance et une horloge accélérée ×20 (tests/fixtures/fake-live-net.ts).
 * Exécution : `npx tsx --test tests/bot-e2e.test.ts` (~40 s).
 *
 * Vérifie le câblage réel, que les tests unitaires ne voient pas : démarrage en papier sans
 * clé, découverte des rounds, évaluations journalisées, registre cohérent, mesure « modèle
 * vs carnet », dashboard (/api/state), arrêt propre sur SIGINT — sans aucune erreur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('bot complet sur faux réseau : évalue, journalise, parie et règle, dashboard, arrêt propre', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-e2e-'));
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const seconds = Number(process.env.E2E_SECONDS ?? '35');
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './tests/fixtures/fake-live-net.ts', 'bot-with-dashboard.ts'], {
    env: {
      ...process.env, HOME: home, DRY_RUN: 'true', PAPER_CAPITAL: '1000', FV_POLL_SEC: '5', FV_SPOT_STREAM: 'false',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', DASHBOARD_PORT: String(port), POLYMARKET_PRIVATE_KEY: '',
      FAKE_TIME_SPEED: '20', FAKE_BOOK_LAG_SEC: '45',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
  try {
    await sleep(Math.round(seconds * 0.6) * 1000);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as Record<string, unknown>;
    assert.ok(state.ledger, 'statistiques du registre envoyées au dashboard');
    assert.match(String((state.fairValueSummary as { goLive?: string } | undefined)?.goLive), /Avant le réel/);
    await sleep(Math.round(seconds * 0.4) * 1000);
  } finally {
    child.kill('SIGINT');
  }
  const code = await Promise.race([exited, sleep(12_000).then(() => 'timeout' as const)]);
  if (code === 'timeout') child.kill('SIGKILL');
  assert.equal(code, 0, `arrêt propre attendu (code ${code})\n${out.slice(-2000)}`);
  assert.match(out, /Arrêt du bot \(SIGINT\)/);
  assert.doesNotMatch(out, /TypeError|ReferenceError|Rejet de promesse non géré|Exception non rattrapée|FATAL/, out.slice(-3000));
  assert.match(out, /→ HOLD|NOUVEAU PARI|\[SIMULATION\]/, 'le bot a évalué des rounds');

  const poly = join(home, '.polymarket');
  const jfiles = readdirSync(join(poly, 'journal'));
  const lines = jfiles.flatMap(f => readFileSync(join(poly, 'journal', f), 'utf8').split('\n').filter(Boolean)).map(l => JSON.parse(l));
  assert.ok(lines.length >= 5, `journal : ${lines.length} évaluations`);
  assert.ok(lines.every(r => typeof r.slug === 'string' && 'pRaw' in r && r.zs === 1), 'champs du journal');

  assert.ok(existsSync(join(poly, 'fv-ledger.json')) || lines.every(r => r.act !== 'buy'));
  if (existsSync(join(poly, 'fv-ledger.json'))) {
    const trades = JSON.parse(readFileSync(join(poly, 'fv-ledger.json'), 'utf8')).trades as Array<Record<string, number | string | null>>;
    assert.equal(new Set(trades.map(t => t.id)).size, trades.length, 'un pari par round');
    for (const t of trades) {
      assert.ok(['open', 'won', 'lost', 'sold'].includes(String(t.status)));
      if (t.status === 'won') assert.ok(Math.abs((t.pnl as number) - ((t.shares as number) - (t.stake as number))) < 1e-9);
      if (t.status === 'lost') assert.ok(Math.abs((t.pnl as number) + (t.stake as number)) < 1e-9);
      // mise ≤ 1 % du capital ACTUEL (1 000 $ + gains réalisés, au plus)
      const gains = trades.reduce((a, x) => a + Math.max(0, typeof x.pnl === 'number' ? x.pnl : 0), 0);
      assert.ok((t.stake as number) <= 0.01 * (1000 + gains) + 1e-9, `mise ${t.stake} > 1 % du capital`);
    }
  }
});
