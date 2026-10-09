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
import { saveLedger, type LedgerTrade } from '../src/services/paper-ledger.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('bot complet sur faux réseau : évalue, journalise, parie et règle, dashboard, arrêt propre', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-e2e-'));
  const tgLog = join(home, 'telegram.jsonl');
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const seconds = Number(process.env.E2E_SECONDS ?? '35');
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './tests/fixtures/fake-live-net.ts', 'bot-with-dashboard.ts'], {
    env: {
      // DOTENV_CONFIG_PATH : le .env du serveur (FV_*, clés…) ne doit pas influencer le test
      ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null', DRY_RUN: 'true', PAPER_CAPITAL: '1000', FV_POLL_SEC: '5', FV_SPOT_STREAM: 'false',
      TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_CHAT_ID: '42', FAKE_TELEGRAM_LOG: tgLog, FAKE_TELEGRAM_CMD: '/status',
      DASHBOARD_PORT: String(port), POLYMARKET_PRIVATE_KEY: '',
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
    assert.match(String((state.fairValue as { goLive?: string } | undefined)?.goLive), /Avant le réel/);
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

  // Telegram : vrais messages du vrai bot, HTML valide, démarrage puis paris/résultats.
  const tg = existsSync(tgLog) ? readFileSync(tgLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { text: string; problem: string | null }) : [];
  assert.ok(tg.length >= 1, 'au moins le message de démarrage');
  assert.match(tg[0].text, /Bot Polymarket démarré.*mode PAPIER/s);
  assert.deepEqual(tg.filter(m => m.problem).map(m => m.problem), [], 'HTML accepté par Telegram');
  assert.match(tg[tg.length - 1].text, /Bot arrêté \(SIGINT\)/, 'message d\'arrêt envoyé avant la sortie');
  assert.ok(tg.some(m => /ÉTAT.*bot papier en marche depuis.*Entrées : ▶️ autorisées/s.test(m.text)), 'réponse du vrai bot à la commande /status');
  const tradesMsgs = tg.filter(m => /NOUVEAU PARI|GAGNÉ|PERDU|REVENDU/.test(m.text));
  if (process.env.SHOW_TELEGRAM) for (const m of tg) console.log('---\n' + m.text);

  const poly = join(home, '.polymarket');
  // Historique de session : dans ~/.polymarket, JAMAIS dans le dépôt (un fichier versionné
  // modifié à chaque arrêt bloquait les `git pull` du serveur).
  assert.ok(existsSync(join(poly, 'session-history.json')), 'historique de session enregistré à l\'arrêt');
  assert.ok(!existsSync(join(process.cwd(), 'data', 'session-history.json')), 'rien d\'écrit dans le dépôt');
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
    assert.equal(tradesMsgs.filter(m => /NOUVEAU PARI/.test(m.text)).length, trades.length, 'un message par pari ouvert');
    const closed = trades.filter(t => t.status !== 'open').length;
    assert.equal(tradesMsgs.filter(m => /GAGNÉ|PERDU|REVENDU/.test(m.text)).length, closed, 'un message par pari réglé');
  }
});

test('clé mal saisie jamais affichée ; kill -9 détecté et signalé au lancement suivant', { timeout: 90_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-e2e-crash-'));
  const tgLog = join(home, 'telegram.jsonl');
  // 63 caractères : la faute de frappe que ethers recopiait dans les logs et le dashboard.
  const typoKey = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f36231';
  const run = async (stop: 'SIGKILL' | 'SIGINT') => {
    const port = 30_000 + Math.floor(Math.random() * 20_000);
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', './tests/fixtures/fake-live-net.ts', 'bot-with-dashboard.ts'], {
      env: {
        ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null', DRY_RUN: 'true', PAPER_CAPITAL: '1000', FV_POLL_SEC: '5', FV_SPOT_STREAM: 'false',
        TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_CHAT_ID: '42', FAKE_TELEGRAM_LOG: tgLog,
        DASHBOARD_PORT: String(port), POLYMARKET_PRIVATE_KEY: typoKey, FAKE_TIME_SPEED: '20',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
    let logs = '';
    try {
      for (let i = 0; i < 60 && !/Bot \+ Dashboard running/.test(out); i++) await sleep(500);
      assert.match(out, /Bot \+ Dashboard running/, out.slice(-2000));
      logs = await (await fetch(`http://127.0.0.1:${port}/api/logs`)).text();
    } finally {
      child.kill(stop);
    }
    await Promise.race([exited, sleep(12_000)]);
    return { out, logs };
  };

  const first = await run('SIGKILL');
  const second = await run('SIGINT');
  for (const { out, logs } of [first, second]) {
    assert.ok(!out.includes(typoKey.slice(0, 30)) && !logs.includes(typoKey.slice(0, 30)), 'clé absente de la console et du dashboard');
    assert.match(out, /POLYMARKET PAPER BOT/);
  }
  assert.match(second.out, /terminé brutalement/);
  const tg = readFileSync(tgLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { text: string });
  const starts = tg.filter(m => /Bot Polymarket démarré/.test(m.text));
  assert.equal(starts.length, 2);
  assert.doesNotMatch(starts[0].text, /Relancé/);
  assert.match(starts[1].text, /↻ Relancé après un arrêt brutal/);
  assert.ok(!tg.some(m => m.text.includes(typoKey.slice(0, 30))));
});

test('porte de risque câblée : registre à −26 % du plus haut → aucun pari, état « bloqué », raison visible, alerte Telegram', { timeout: 90_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-e2e-risk-'));
  const tgLog = join(home, 'telegram.jsonl');
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  // Un trade perdu de 260 $ sur 1 000 $ : baisse de 26 % depuis le plus haut ≥ 25 % (couche
  // « drawdown », sans échéance : indépendante de l'heure UTC à laquelle le test tourne).
  const at = new Date().toISOString();
  const lost: LedgerTrade = {
    id: 'seed-risk', slug: 'btc-updown-5m-1790000100', coin: 'BTC', side: 'UP', stake: 260, costPerShare: 0.5, shares: 520,
    modelProb: 0.7, edge: 0.1, openedAt: at, endMs: Date.now() - 600_000, status: 'lost', pnl: -260, resolvedAt: at,
  };
  saveLedger(join(home, '.polymarket', 'fv-ledger.json'), [lost]);
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './tests/fixtures/fake-live-net.ts', 'bot-with-dashboard.ts'], {
    env: {
      ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null', DRY_RUN: 'true', PAPER_CAPITAL: '1000', FV_POLL_SEC: '5', FV_SPOT_STREAM: 'false',
      TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_CHAT_ID: '42', FAKE_TELEGRAM_LOG: tgLog,
      DASHBOARD_PORT: String(port), POLYMARKET_PRIVATE_KEY: '', FAKE_TIME_SPEED: '20', FAKE_BOOK_LAG_SEC: '45',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
  let state: Record<string, unknown> = {};
  try {
    await sleep(30_000); // ×20 : dix minutes simulées, plusieurs rounds avec des signaux (carnet en retard)
    state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as Record<string, unknown>;
  } finally {
    child.kill('SIGINT');
  }
  const code = await Promise.race([exited, sleep(12_000).then(() => 'timeout' as const)]);
  if (code === 'timeout') child.kill('SIGKILL');
  assert.equal(code, 0, `arrêt propre attendu (code ${code})\n${out.slice(-2000)}`);
  const risk = state.risk as { allowed: boolean; layer: string | null; reason: string | null; drawdown: number };
  assert.equal(risk.allowed, false, 'entrées refusées');
  assert.equal(risk.layer, 'drawdown');
  assert.match(String(risk.reason), /baisse de 26[.,]0 % depuis le plus haut/);
  assert.match(out, /⏸️ Porte de risque : baisse de 26/, 'journalisé');
  const evals = (state.fairValue as { lastEvaluations: Array<{ reason: string; act: string }> }).lastEvaluations;
  assert.ok(evals.length >= 1, 'évaluations publiées malgré la pause (la mesure continue)');
  assert.ok(evals.some(e => /signal (UP|DOWN) ignoré : entrées bloquées/.test(e.reason)), `raison du refus visible : ${JSON.stringify(evals.map(e => e.reason))}`);
  const trades = JSON.parse(readFileSync(join(home, '.polymarket', 'fv-ledger.json'), 'utf8')).trades as unknown[];
  assert.equal(trades.length, 1, 'aucun nouveau pari pendant la pause');
  const tg = readFileSync(tgLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { text: string });
  assert.ok(tg.some(m => /ALERTE.*baisse de 26[.,]0 %.*ARRÊTER le bot/s.test(m.text)), `alerte Telegram attendue : ${tg.map(m => m.text.slice(0, 60)).join(' | ')}`);
  assert.doesNotMatch(out, /TypeError|ReferenceError|Rejet de promesse non géré|Exception non rattrapée/, out.slice(-3000));
});

test('DRY_RUN=false : refus compté par le garde-fou de plantage et signalé sur Telegram (pas de boucle PM2 muette)', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-e2e-live-'));
  const tgLog = join(home, 'telegram.jsonl');
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './tests/fixtures/fake-live-net.ts', 'bot-with-dashboard.ts'], {
    env: {
      ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null', DRY_RUN: 'false', PAPER_CAPITAL: '1000', FV_SPOT_STREAM: 'false',
      TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_CHAT_ID: '42', FAKE_TELEGRAM_LOG: tgLog,
      DASHBOARD_PORT: String(30_000 + Math.floor(Math.random() * 20_000)), POLYMARKET_PRIVATE_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const code = await Promise.race([new Promise<number | null>(r => child.on('exit', c => r(c))), sleep(30_000).then(() => 'timeout' as const)]);
  if (code === 'timeout') child.kill('SIGKILL');
  assert.equal(code, 1, `refus attendu (code ${code})\n${out.slice(-1500)}`);
  assert.match(out, /DRY_RUN=false : le mode RÉEL n'est pas implémenté/);
  assert.match(out, /Arrêt du bot \(DRY_RUN=false refusé/);
  assert.ok(existsSync(join(home, '.polymarket', 'run-state.json')), 'refus compté par le garde-fou (alertes espacées sous PM2)');
  const tg = existsSync(tgLog) ? readFileSync(tgLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { text: string }) : [];
  assert.ok(tg.some(m => /ALERTE.*bot arrêté sur erreur \(DRY_RUN=false refusé/s.test(m.text)), `alerte attendue : ${tg.map(m => m.text.slice(0, 80)).join(' | ')}`);
  assert.doesNotMatch(out, /NOUVEAU PARI|Dashboard : http/, 'rien ne démarre');
});

test('flux spot temps réel (faux WebSocket Binance) : santé « connecté », réactions aux sauts, mesures fin de round, arrêt propre', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-e2e-stream-'));
  const tgLog = join(home, 'telegram.jsonl');
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const wsPort = port + 1;
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './tests/fixtures/fake-live-net.ts', 'bot-with-dashboard.ts'], {
    env: {
      ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null', DRY_RUN: 'true', PAPER_CAPITAL: '1000', FV_POLL_SEC: '5',
      FV_SPOT_STREAM: 'true', FAKE_SPOT_WS_PORT: String(wsPort), SPOT_STREAM_URL: `ws://127.0.0.1:${wsPort}/stream?streams=`,
      TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_CHAT_ID: '42', FAKE_TELEGRAM_LOG: tgLog,
      DASHBOARD_PORT: String(port), POLYMARKET_PRIVATE_KEY: '', FAKE_TIME_SPEED: '20', FAKE_BOOK_LAG_SEC: '45',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
  let state: Record<string, unknown> = {};
  try {
    await sleep(40_000); // ×20 : plus de deux rounds, dont deux dernières minutes
    state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as Record<string, unknown>;
  } finally {
    child.kill('SIGINT');
  }
  const code = await Promise.race([exited, sleep(12_000).then(() => 'timeout' as const)]);
  if (code === 'timeout') child.kill('SIGKILL');
  assert.equal(code, 0, `arrêt propre attendu (code ${code})\n${out.slice(-2000)}`);
  assert.match(out, /Flux spot temps réel connecté/, out.slice(-1500));
  const health = state.health as { spotStream: string; clockSkewMs: number | null };
  assert.equal(health.spotStream, 'live', 'santé : flux connecté et prix frais');
  const poly = join(home, '.polymarket');
  const lines = readdirSync(join(poly, 'journal')).flatMap(f => readFileSync(join(poly, 'journal', f), 'utf8').split('\n').filter(Boolean)).map(l => JSON.parse(l) as Record<string, unknown>);
  assert.ok(lines.some(r => r.mv === true), 'évaluations déclenchées par un saut du spot');
  assert.ok(lines.some(r => /\+ws$/.test(String(r.src))), 'spot pris sur le flux');
  const late = lines.filter(r => r.lt === true);
  assert.ok(late.length >= 1, `mesures fin de round attendues (τ < 60 s) : ${late.length}`);
  assert.ok(late.every(r => typeof r.pl === 'number' && (r.pl as number) > 0 && (r.pl as number) < 1 && (r.kn as number) >= 0 && (r.kn as number) <= 60 && r.act === 'hold' && (r.tau as number) < 60), JSON.stringify(late[0]));
  const trades = existsSync(join(poly, 'fv-ledger.json')) ? (JSON.parse(readFileSync(join(poly, 'fv-ledger.json'), 'utf8')).trades as Array<{ openedAt: string; endMs: number }>) : [];
  for (const t of trades) assert.ok(t.endMs - Date.parse(t.openedAt) >= 60_000, 'aucun pari ouvert dans la dernière minute');
  assert.doesNotMatch(out, /TypeError|ReferenceError|Rejet de promesse non géré|Exception non rattrapée/, out.slice(-3000));
});
