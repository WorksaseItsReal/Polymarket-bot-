/**
 * llm-setup.ts — branchement de la stratégie llm (PAPIER) dans le bot, UNIQUEMENT si
 * LLM_ENABLED=true (sinon app.ts n'appelle même pas ce module : formule et récolte inchangées).
 *
 * Même branchée, la stratégie démarre « off » : `/llm on` l'active, et seulement si la sonde
 * réelle (`npm run llm:probe`, sur ce serveur) a réussi pour la version FIGÉE du CLI et la
 * version des prompts en place (campagne de mesure).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig } from './config.js';
import type { LedgerStore } from '../services/ledger-store.js';
import type { RoundMarketData } from '../services/round-market-data.js';
import type { Book, ScannedMarket } from '../strategy/fair-value-runner.js';
import { cliBinaryPath, llmPaths } from '../strategy/llm/llm-config.js';
import { LlmJournal, campaignOf } from '../strategy/llm/llm-journal.js';
import { CallBudget } from '../strategy/llm/budget.js';
import { LlmState } from '../strategy/llm/llm-state.js';
import { defaultTokenPaths, readToken, tokenStatus } from '../strategy/llm/token.js';
import { makeCallFn, prepareHome, prepareRuntime } from '../strategy/llm/claude-runner.js';
import { AGENTS_SUBDIR, promptVersion } from '../strategy/llm/prompt-version.js';
import { LlmStrategy } from '../strategy/llm/llm-strategy.js';

export interface LlmSetupDeps {
  config: BotConfig;
  repoDir: string;
  ledger: LedgerStore;
  markets: () => Promise<ScannedMarket[]>;
  getBook: (tokenId: string) => Promise<Book>;
  getRoundData: (coin: string, slotSec: number, nowMs: number) => Promise<RoundMarketData | null>;
  globalBlock: () => string | null;
  notify: (html: string) => void;
  log: (level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE', msg: string) => void;
}

export interface LlmHandle {
  /** Réponse à `/llm [status|on|off]`. */
  command(args: string): string;
  /** Ligne du message de démarrage. */
  startupLine(): string;
  stop(): void;
}

/** Version annoncée par un binaire (`<bin> --version` → « 2.1.296 (Claude Code) »), ou null. */
export function readCliVersion(bin: string): string | null {
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DISABLE_UPDATES: '1', DISABLE_AUTOUPDATER: '1', NO_COLOR: '1' },
    });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Sonde réussie pour cette campagne (fichier écrit par scripts/llm/probe.ts) ? */
export function probePassed(probeDir: string, campaign: string): { ok: boolean; detail: string } {
  const f = join(probeDir, `${campaign}.json`);
  if (!existsSync(f)) return { ok: false, detail: `aucune sonde pour ${campaign} (lancer npm run llm:probe sur ce serveur)` };
  try {
    const r = JSON.parse(readFileSync(f, 'utf8')) as { ok?: unknown; at?: unknown };
    return r.ok === true ? { ok: true, detail: `sonde OK (${typeof r.at === 'string' ? r.at : '?'})` } : { ok: false, detail: `sonde en échec pour ${campaign} (voir ${f})` };
  } catch {
    return { ok: false, detail: `résultat de sonde illisible (${f})` };
  }
}

export function setupLlm(dep: LlmSetupDeps): LlmHandle {
  const { config } = dep;
  const cfg = config.llm;
  const home = (process.env.HOME ?? '').trim() || homedir();
  const paths = llmPaths(config.dataDir);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  try { chmodSync(paths.dir, 0o700); } catch { /* best effort */ }
  const tokens = defaultTokenPaths(process.env);
  const bin = cliBinaryPath(cfg, home) as string;

  // Version du CLI FIGÉE : vérifiée au démarrage puis toutes les 10 min (mise à jour = nouvelle campagne).
  let cliVersion: string | null = null;
  const checkCli = () => {
    const v = readCliVersion(bin);
    const ok = v !== null && v === cfg.cliVersion;
    if (!ok && cliVersion !== null) dep.notify(`⚠️ <b>llm</b> : CLI ${bin} annonce ${v ?? 'rien'} au lieu de ${cfg.cliVersion} — abstentions (version_cli) jusqu'à correction`);
    cliVersion = ok ? v : null;
  };
  checkCli();

  const agentsSrc = join(dep.repoDir, 'agents-runtime');
  let pVersion: string | null = null;
  try { pVersion = promptVersion(join(agentsSrc, AGENTS_SUBDIR)); } catch (err) { dep.log('ERROR', `llm : prompts illisibles (${(err as Error).message})`); }
  const runtime = prepareRuntime(agentsSrc);
  const isoHome = prepareHome();

  const budget = new CallBudget(paths.budget, { maxPerHour: cfg.maxPerHour, maxPerDay: cfg.maxPerDay });
  const MIN = 60_000;
  const state = new LlmState(paths.state, {
    failureThreshold: cfg.failuresBeforePause, failurePauseMs: cfg.failurePauseMin * MIN, quotaPauseMs: cfg.usagePauseMin * MIN,
    maxPauseMs: cfg.maxPauseHours * 60 * MIN, isolationPauseMs: Math.min(6 * 60, cfg.maxPauseHours * 60) * MIN, initialEnabled: false,
  });
  const journal = new LlmJournal(paths);
  const call = makeCallFn({
    binPath: bin, runtimeDir: runtime.dir, homeDir: isoHome.dir, token: () => readToken(tokens),
    schemaTools: cfg.schemaTools, onLaunch: () => { budget.recordCliCall(Date.now()); },
  });
  const tokenProblem = (): string | null => {
    const s = tokenStatus(tokens, Date.now());
    return s.state === 'ok' || s.state === 'expire_bientot' ? null : s.detail;
  };

  const strategy = new LlmStrategy({
    cfg, fv: config.fv, risk: config.risk, ledger: dep.ledger, journal, budget, state, call,
    promptVersion: pVersion, cliVersion: () => cliVersion, tokenProblem, minOrderUsd: config.minOrderUsd,
    now: () => Date.now(), markets: dep.markets, getBook: dep.getBook, getRoundData: dep.getRoundData,
    globalBlock: dep.globalBlock, notify: dep.notify, log: dep.log,
  });

  // Jeton : alerte quotidienne à ≤ 30 jours de l'expiration (calculée) ; sorties brutes : rétention.
  let lastDaily = '';
  const daily = () => {
    const day = new Date().toISOString().slice(0, 10);
    if (day === lastDaily) return;
    lastDaily = day;
    const s = tokenStatus(tokens, Date.now());
    if (s.state === 'expire_bientot' || s.state === 'expire') dep.notify(`⚠️ <b>llm</b> : ${s.detail} — renouveler avec « claude setup-token » puis « npm run llm:token »`);
    try { journal.pruneRaw(Date.now(), cfg.rawRetentionDays); } catch { /* prochaine fois */ }
  };
  daily();

  const tick = setInterval(() => { void strategy.tick(); }, 1000);
  tick.unref?.();
  const slow = setInterval(() => { checkCli(); daily(); }, 10 * 60_000);
  slow.unref?.();

  const campaign = () => campaignOf(cliVersion, pVersion);
  const fmtMs = (x: number | null) => (x === null ? '—' : `${(x / 1000).toFixed(1)} s`);

  return {
    command(args: string): string {
      const sub = args.trim().toLowerCase().split(/\s+/)[0] || 'status';
      const now = Date.now();
      if (sub === 'on') {
        if (!cliVersion) return `❌ llm non activée : CLI figé introuvable ou mauvaise version (attendu ${cfg.cliVersion} à ${bin}).`;
        const tp = tokenProblem();
        if (tp) return `❌ llm non activée : ${tp}`;
        const pr = probePassed(paths.probe, campaign());
        if (!pr.ok) return `❌ llm non activée : ${pr.detail}`;
        state.setEnabled(true, now);
        return `✅ llm activée (papier) — campagne ${campaign()}. Décision à ${cfg.decisionAtSec} s, échéance ${cfg.deadlineSec} s, ${cfg.coins.join(', ')}.`;
      }
      if (sub === 'off') {
        state.setEnabled(false, now);
        return '⏹️ llm désactivée (aucun appel au CLI jusqu\'à /llm on).';
      }
      const st = state.snapshot();
      const b = budget.snapshot(now);
      const lat = strategy.latencyStats();
      const tk = tokenStatus(tokens, now);
      const last = strategy.lastDecision;
      return [
        '🤖 <b>llm (papier)</b>',
        `État : ${st.enabled ? (st.pausedUntil && st.pausedUntil > now ? `en pause jusqu'à ${new Date(st.pausedUntil).toISOString().slice(11, 16)} UTC — ${st.pauseReason ?? ''}` : 'active') : 'désactivée'}${st.error ? ` · ⚠️ ${st.error}` : ''}`,
        `Échecs consécutifs : ${st.consecutiveFailures}`,
        `Décisions : ${b.decisionsLastHour}/${b.maxPerHour} sur l'heure, ${b.decisionsLastDay}/${b.maxPerDay} sur 24 h (appels CLI : ${b.cliCallsLastDay})${b.error ? ` · ⚠️ ${b.error}` : ''}`,
        `Latence (${lat.n}) : p50 ${fmtMs(lat.p50)} · p95 ${fmtMs(lat.p95)} · max ${fmtMs(lat.max)}`,
        `CLI : ${cliVersion ?? `introuvable (attendu ${cfg.cliVersion})`} · prompts ${pVersion ?? '?'} · campagne ${campaign()}`,
        `Jeton : ${tk.detail}`,
        `Dernière décision : ${last ? `${new Date(last.at).toISOString().slice(11, 19)} UTC — ${last.code} ${last.detail.slice(0, 120)}` : '—'}`,
      ].join('\n');
    },
    startupLine(): string {
      return `Stratégie llm (papier) : branchée, ${state.snapshot().enabled ? 'ACTIVE' : 'désactivée — /llm on'} · ${cfg.coins.join(', ')} · CLI ${cliVersion ?? 'introuvable'}`;
    },
    stop(): void {
      clearInterval(tick);
      clearInterval(slow);
      try { runtime.cleanup(); } catch { /* dossier temporaire */ }
      try { isoHome.cleanup(); } catch { /* dossier temporaire */ }
    },
  };
}
