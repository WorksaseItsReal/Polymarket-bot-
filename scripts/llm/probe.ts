/**
 * Sonde RÉELLE de la stratégie llm : vrais appels au CLI Claude (abonnement), à lancer sur le
 * serveur, à la main, avant `/llm on` et après tout changement de version du CLI ou des prompts.
 *
 *   npm run llm:probe            (≈ 9 appels Haiku : 3 décisions complètes sur un instantané fictif)
 *   npm run llm:probe -- --schema   (+ 1 décision avec --json-schema, pour voir s'il est utilisable)
 *
 * Vérifie : version figée du CLI, jeton, démarrage avec un HOME isolé, agents trouvés, AUCUN
 * outil (le fil-piège du code tue le processus sinon : code « isolation »), réponses valides,
 * latence. Écrit ~/.polymarket/llm/probe/<campagne>.json — exigé par `/llm on`.
 * Aucune donnée réelle n'est envoyée : instantané fictif, prix normalisés.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBotConfig } from '../../src/bot/config.js';
import { readCliVersion } from '../../src/bot/llm-setup.js';
import { cliBinaryPath, llmPaths } from '../../src/strategy/llm/llm-config.js';
import { campaignOf } from '../../src/strategy/llm/llm-journal.js';
import { defaultTokenPaths, readToken, tokenStatus } from '../../src/strategy/llm/token.js';
import { makeCallFn, prepareHome, prepareRuntime } from '../../src/strategy/llm/claude-runner.js';
import { AGENTS_SUBDIR, promptVersion } from '../../src/strategy/llm/prompt-version.js';
import { buildSnapshot } from '../../src/strategy/llm/snapshot.js';
import { runPipeline } from '../../src/strategy/llm/pipeline.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

async function main(): Promise<number> {
  const { config } = loadBotConfig(process.env);
  const cfg = config.llm;
  const home = (process.env.HOME ?? '').trim() || homedir();
  if (!cfg.cliVersion) { console.error('❌ LLM_CLI_VERSION absent du .env (version du CLI à figer, ex. 2.1.296).'); return 1; }
  const bin = cliBinaryPath(cfg, home) as string;
  const v = readCliVersion(bin);
  if (v !== cfg.cliVersion) { console.error(`❌ ${bin} annonce ${v ?? 'rien'} au lieu de ${cfg.cliVersion}.`); return 1; }
  const tokens = defaultTokenPaths(process.env);
  const ts = tokenStatus(tokens, Date.now());
  if (ts.state !== 'ok' && ts.state !== 'expire_bientot') { console.error(`❌ Jeton : ${ts.detail}`); return 1; }
  const agents = join(REPO, 'agents-runtime');
  const pv = promptVersion(join(agents, AGENTS_SUBDIR));
  const campaign = campaignOf(v, pv);
  console.log(`Campagne ${campaign} · CLI ${bin} · jeton : ${ts.detail}`);

  const runtime = prepareRuntime(agents);
  const isoHome = prepareHome();
  const call = makeCallFn({ binPath: bin, runtimeDir: runtime.dir, homeDir: isoHome.dir, token: () => readToken(tokens), schemaTools: cfg.schemaTools });
  const now = Date.now();
  const slot = Math.floor(now / 300_000) * 300;
  const lv = (p: number, n = 3): Array<readonly [number, number]> => Array.from({ length: n }, (_, i) => [Math.round((p + i * 0.01) * 100) / 100, 50 + i * 40] as const);
  const snapshot = buildSnapshot({
    roundId: `btc-updown-5m-${slot}`, coin: 'BTC', startMs: slot * 1000, endMs: slot * 1000 + 300_000, nowMs: slot * 1000 + 90_000,
    open: 100, spot: 100.03, sigmaPerSqrtSec: 0.00004, formulaPUp: 0.58, formulaPUpRaw: 0.59,
    book: { up: { asks: lv(0.56), bids: lv(0.53) }, down: { asks: lv(0.46), bids: lv(0.43) } },
    feeRate: config.fv.takerFeeRate, minOrderUsd: 1,
    risk: { capitalUsd: 250, maxStakeUsd: 2, pnlTodayUsd: 0, dailyLimitUsd: 12.5, blocked: false }, openPositions: [],
  });

  const runs: Array<{ code: string; ms: number; steps: Array<{ role: string; code: string; ms: number; models: string[] }>; schema: boolean }> = [];
  const total = process.argv.includes('--schema') ? 4 : 3;
  for (let i = 0; i < total; i++) {
    const schema = i === 3;
    const t0 = Date.now();
    const res = await runPipeline({ snapshot, call, deadlineAtMs: Date.now() + 150_000, agentTimeoutMs: cfg.agentTimeoutSec * 1000, feeRate: config.fv.takerFeeRate, jsonSchemas: schema, promptVersion: pv });
    const steps = res.steps.map(s => ({ role: s.role, code: s.code, ms: s.outcome.latencyMs, models: s.outcome.ok ? s.outcome.usage.models : [] }));
    runs.push({ code: res.code, ms: Date.now() - t0, steps, schema });
    console.log(`${schema ? '[--json-schema] ' : ''}décision ${i + 1} : ${res.code} en ${((Date.now() - t0) / 1000).toFixed(1)} s — ${steps.map(s => `${s.role} ${s.code} ${(s.ms / 1000).toFixed(1)} s`).join(' · ')}`);
    for (const s of res.steps) if (!s.outcome.ok) console.log(`   ${s.role} : ${s.outcome.detail.slice(0, 300)}`);
  }
  runtime.cleanup();
  isoHome.cleanup();

  const plain = runs.filter(r => !r.schema);
  const good = plain.filter(r => ['ok', 'veto', 'abstention_agent'].includes(r.code)).length;
  const isolation = runs.some(r => r.code === 'isolation');
  const lat = plain.map(r => r.ms).sort((a, b) => a - b);
  const ok = good >= 2 && !isolation;
  const out = { ok, at: new Date().toISOString(), campaign, cliVersion: v, promptVersion: pv, runs, latencyMs: { p50: lat[Math.floor(lat.length / 2)] ?? null, max: lat[lat.length - 1] ?? null } };
  const dir = llmPaths(config.dataDir).probe;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${campaign}.json`), JSON.stringify(out, null, 2), { mode: 0o600 });
  console.log(`\nLatence d'une décision complète : médiane ${((out.latencyMs.p50 ?? 0) / 1000).toFixed(1)} s, max ${((out.latencyMs.max ?? 0) / 1000).toFixed(1)} s`);
  console.log(ok
    ? `✅ Sonde réussie (${good}/${plain.length}) : « /llm on » est permis pour la campagne ${campaign}. Régler LLM_DEADLINE_S ≥ LLM_DECISION_AT_S + 2 × latence max.`
    : `❌ Sonde en échec (${good}/${plain.length} valides${isolation ? ', fil-piège d\'isolation déclenché' : ''}) : llm reste désactivée.`);
  return ok ? 0 : 1;
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
