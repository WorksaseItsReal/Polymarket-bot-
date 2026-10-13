/**
 * tests/doctor.test.ts — diagnostic d'installation (configuration, fichiers, réseau, code déployé).
 * Exécution : `npx tsx --test tests/doctor.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configChecks, dashboardBuildCheck, deployedCodeCheck, fileChecks, gitDeployedCodeCheck, networkChecks, runtimeChecks, summarize } from '../src/services/doctor.ts';

const level = (cs: ReturnType<typeof configChecks>, label: string) => cs.find(c => c.label === label)?.level;

test('configuration : capital trop petit, variables obsolètes, réglages ignorés, mode réel refusé', () => {
  const bad = configChecks({ PAPER_CAPITAL: '50', DIPARB_ENABLED: 'true', FV_Z_SCALE: '9', TELEGRAM_BOT_TOKEN: 'abc', TELEGRAM_CHAT_ID: '1' });
  assert.equal(level(bad, 'Capital'), 'error');
  assert.equal(level(bad, 'Variables obsolètes'), 'warn');
  assert.match(bad.find(c => c.label === 'Réglages')!.detail, /FV_Z_SCALE=9/);
  assert.equal(level(bad, 'Telegram'), 'error', 'token à la mauvaise forme');
  assert.match(configChecks({ DRY_RUN: 'false' }).find(c => c.label === 'Mode')!.detail, /refusera de démarrer/);
  assert.equal(level(configChecks({ DRY_RUN: 'false' }), 'Mode'), 'error');
  const good = configChecks({ PAPER_CAPITAL: '250', FV_MIN_EDGE: '0.05', TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_CHAT_ID: '42' });
  assert.ok(good.every(c => c.level === 'ok'), summarize(good).text);
  assert.equal(configChecks({ POLYMARKET_PRIVATE_KEY: 'your_private_key_here' }).some(c => c.label === 'Variables obsolètes'), false, 'placeholder toléré');
  assert.equal(level(configChecks({ POLYMARKET_PRIVATE_KEY: '0x' + 'a'.repeat(64) }), 'Variables obsolètes'), 'warn');
  assert.match(configChecks({ DEEPSEEK_API_KEY: 'k', POLYGON_RPC_URL: 'https://x' }).find(c => c.label === 'Variables obsolètes')!.detail, /DEEPSEEK_API_KEY, POLYGON_RPC_URL/);
  const ancien = (env: Record<string, string>) => configChecks(env).find(c => c.label === 'Ancien nom')?.detail ?? '';
  assert.match(ancien({ CAPITAL_USD: '250' }), /CAPITAL_USD=250 sert de capital papier/, 'encore lu faute de PAPER_CAPITAL');
  assert.match(ancien({ CAPITAL_USD: '250', PAPER_CAPITAL: 'abc' }), /sert de capital papier/, 'PAPER_CAPITAL invalide = absent');
  assert.match(ancien({ CAPITAL_USD: '250', PAPER_CAPITAL: '300' }), /ignoré \(PAPER_CAPITAL prime\)/);
  assert.equal(ancien({ PAPER_CAPITAL: '300' }), '', 'rien à dire sans CAPITAL_USD');
  assert.equal(configChecks({ CAPITAL_USD: '250' }).some(c => c.label === 'Variables obsolètes'), false, 'CAPITAL_USD n\'est pas « sans effet »');
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

test('Node.js : ≥ 20.6 requis (PM2 lance le bot par node --import tsx)', () => {
  assert.equal(runtimeChecks('22.22.0')[0].level, 'ok');
  assert.equal(runtimeChecks('20.6.0')[0].level, 'ok');
  assert.equal(runtimeChecks('20.5.1')[0].level, 'error');
  assert.equal(runtimeChecks('18.19.0')[0].level, 'error');
  assert.equal(runtimeChecks()[0].level, 'ok', 'le Node qui fait tourner les tests');
});

test('réglages : ancien règlement ponctuel et marge de bruit désactivée signalés', () => {
  assert.equal(configChecks({}).some(c => c.label === 'Règlement' || c.label === 'Marge de bruit'), false, 'défauts : rien à signaler');
  const legacy = configChecks({ FV_TWAP_WINDOW_SEC: '0' }).find(c => c.label === 'Règlement')!;
  assert.equal(legacy.level, 'warn');
  assert.match(legacy.detail, /moyenne Chainlink des 60 s/);
  assert.equal(configChecks({ FV_NOISE_EDGE_K: '0' }).find(c => c.label === 'Marge de bruit')!.level, 'warn');
  assert.match(configChecks({ FV_NOISE_EDGE_K: '9' }).find(c => c.label === 'Réglages')!.detail, /FV_NOISE_EDGE_K=9/, 'hors bornes [0, 5]');
  assert.equal(configChecks({ FV_FILL_DELAY_MS: '0' }).find(c => c.label === 'Latence simulée')!.level, 'warn');
});

test('interface du dashboard : absente, périmée (sources plus récentes que la construction), à jour', () => {
  const repo = mkdtempSync(join(tmpdir(), 'doctor-dash-'));
  assert.equal(dashboardBuildCheck(repo).level, 'warn');
  assert.match(dashboardBuildCheck(repo).detail, /non construite/);
  mkdirSync(join(repo, 'dashboard', 'dist'), { recursive: true });
  mkdirSync(join(repo, 'dashboard', 'src', 'components'), { recursive: true });
  writeFileSync(join(repo, 'dashboard', 'dist', 'index.html'), '<html></html>');
  writeFileSync(join(repo, 'dashboard', 'src', 'components', 'App.tsx'), 'export {}');
  const old = Date.now() - 3_600_000;
  utimesSync(join(repo, 'dashboard', 'dist', 'index.html'), old / 1000, old / 1000);
  assert.match(dashboardBuildCheck(repo).detail, /construite avant la dernière modification de ses sources/);
  assert.equal(dashboardBuildCheck(repo).level, 'warn');
  utimesSync(join(repo, 'dashboard', 'dist', 'index.html'), Date.now() / 1000 + 5, Date.now() / 1000 + 5);
  assert.equal(dashboardBuildCheck(repo).level, 'ok');
});

test('code déployé : main seul (autre branche = erreur, HEAD détaché ou git indisponible = avertissement)', () => {
  const out = (o: string) => ({ ok: true as const, out: o });
  const fail = (error: string) => ({ ok: false as const, error });
  const main = deployedCodeCheck(out('main'), out('abc1234'));
  assert.equal(main.level, 'ok');
  assert.equal(main.label, 'Code déployé');
  assert.equal(main.detail, 'main @ abc1234');
  const branch = deployedCodeCheck(out('feat/fair-value-strategy'), out('def5678'));
  assert.equal(branch.level, 'error');
  assert.match(branch.detail, /^branche feat\/fair-value-strategy @ def5678 extraite/);
  assert.match(branch.detail, /ne déploie que main/);
  assert.match(branch.detail, /npm run upgrade/, 'la commande de correction');
  const detached = deployedCodeCheck(out('HEAD'), out('0a1b2c3'));
  assert.equal(detached.level, 'warn');
  assert.match(detached.detail, /^HEAD détaché @ 0a1b2c3/);
  assert.match(detached.detail, /npm run upgrade/);
  const absent = deployedCodeCheck(fail('git absent'), fail('git absent'));
  assert.equal(absent.level, 'warn');
  assert.match(absent.detail, /^branche illisible \(git absent\)/);
  assert.equal(deployedCodeCheck(fail('pas un dépôt git'), fail('pas un dépôt git')).level, 'warn');
  assert.equal(deployedCodeCheck(out(''), out('')).level, 'warn', 'sortie vide : illisible, pas « ok »');
  assert.equal(deployedCodeCheck(out('main'), fail('x')).detail, 'main', 'commit illisible : la branche suffit');
});

test('code déployé (adaptateur git) : vraie branche lue ; git absent ou hors dépôt → avertissement, sans planter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-git-'));
  const absent = gitDeployedCodeCheck(dir, 3000, join(dir, 'pas-de-git'));
  assert.equal(absent.level, 'warn');
  assert.match(absent.detail, /git absent/);
  const horsDepot = gitDeployedCodeCheck(dir);
  assert.equal(horsDepot.level, 'warn', horsDepot.detail);
  assert.match(horsDepot.detail, /^branche illisible/);

  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'initial');
  const main = gitDeployedCodeCheck(dir);
  assert.equal(main.level, 'ok', main.detail);
  assert.match(main.detail, /^main @ [0-9a-f]{7,}$/);
  git('checkout', '-q', '-b', 'feat/x');
  const feat = gitDeployedCodeCheck(dir);
  assert.equal(feat.level, 'error');
  assert.match(feat.detail, /^branche feat\/x @ [0-9a-f]{7,} extraite/);
  git('checkout', '-q', '--detach');
  assert.equal(gitDeployedCodeCheck(dir).level, 'warn');
  assert.match(gitDeployedCodeCheck(dir).detail, /^HEAD détaché @ [0-9a-f]{7,}/);
});
