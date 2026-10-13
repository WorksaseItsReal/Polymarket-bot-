/**
 * claude-runner.ts — couche « processus » de la stratégie llm : UN appel au CLI Claude Code
 * en mode headless, SANS AUCUN OUTIL, pour l'un des 3 agents (analyste, décideur, sécurité).
 *
 * PAPIER uniquement : ce module ne fait que TRANSPORTER du texte (stdin → CLI → stdout). Il
 * n'interprète jamais le contenu du marché, n'importe rien du trading réel et ne connaît ni
 * clé privée, ni wallet, ni ordre.
 *
 * Garanties tenues PAR CE CODE (les options du CLI ne sont qu'une couche en plus) :
 *   - timeout DUR : SIGKILL sur TOUT le groupe de processus (lancé en `detached`) ;
 *   - plafond de sortie (stdout + stderr) → kill ;
 *   - fils-pièges : un outil listé par l'événement init, un bloc tool_use (sous-agents
 *     compris), un serveur MCP connecté → kill immédiat, code 'isolation' ;
 *   - environnement MINIMAL construit de zéro (rien n'est hérité de process.env : ni
 *     ANTHROPIC_API_KEY, ni les secrets du bot) ;
 *   - dossier de travail temporaire ne contenant que nos définitions d'agents ;
 *   - un seul processus claude à la fois ('occupe' sinon) ;
 *   - toute anomalie → CallOutcome { ok: false, code } (abstention) ; jamais d'exception.
 *
 * Sources (CLI Claude Code) :
 *   - https://code.claude.com/docs/en/cli-reference : --tools « Use "" to disable all » ;
 *     « doesn't affect MCP tools; to deny those too, use --disallowedTools "mcp__*" » ;
 *     --max-turns « Exits with an error when the limit is reached » ; --permission-prompts
 *     requiert v2.1.259+.
 *   - https://code.claude.com/docs/en/sub-agents : « --agent <name> … the main thread itself
 *     takes on that subagent's tool restrictions and model ».
 *   - https://code.claude.com/docs/en/headless : stream-json, dernière ligne `result` ;
 *     `system/init` liste model, tools, mcp_servers, plugins ; `system/api_retry` porte
 *     `error` (authentication_failed, billing_error, rate_limit…) ; « exits with code 0 on
 *     success and a non-zero code when the run fails » ; « When a failure happens inside the
 *     run, such as missing authentication, Claude Code prints the failure as the result on
 *     stdout » ; SIGTERM laisse le tour inachevé (code 143) → on tue en SIGKILL.
 *     Sans --bare, `-p` charge hooks, .mcp.json et agents du dossier de travail → dossier
 *     temporaire stérile (prepareRuntime). --bare n'est pas utilisable ici : il ne lit pas
 *     CLAUDE_CODE_OAUTH_TOKEN (doc authentication).
 *     ATTENTION : en dontAsk, les lectures de fichiers du dossier de travail passent sans
 *     demande (doc headless) → la vraie barrière est `--tools ""` + le fil-piège de ce code.
 *   - https://code.claude.com/docs/en/agent-sdk/typescript : SDKSystemMessage (init) porte
 *     `claude_code_version` ; SDKResultMessage : subtype 'success' ou error_* (+ `errors`).
 *   - https://code.claude.com/docs/en/errors : messages de limite d'usage (« You've hit your
 *     session limit · resets 3:45pm », weekly, Opus, Sonnet, « monthly spend limit »).
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AbstentionCode, AgentRole, CallFn, CallOutcome, UsageInfo } from './types.js';

export const AGENT_ROLES: readonly AgentRole[] = ['analyste', 'decideur', 'securite'];
/** Alias de modèle du CLI (pas un identifiant de modèle). */
export const CLI_MODEL_ALIAS = 'haiku';
export const DEFAULT_MAX_TURNS = 2;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Plafond absolu du timeout, quelle que soit la demande. */
export const MAX_TIMEOUT_MS = 10 * 60_000;
/** --permission-prompts est documenté à partir de cette version. */
export const DEFAULT_MIN_CLI_VERSION = '2.1.259';
/** Message utilisateur maximum (le CLI plafonne stdin à 10 Mo ; nos messages font quelques Ko). */
export const MAX_STDIN_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 2000;
const STDERR_KEEP = 64 * 1024;

// ---------------------------------------------------------------------------
// Arguments et environnement
// ---------------------------------------------------------------------------

export interface BuildArgsOptions {
  /** Tours maximum (1 à 10), 2 par défaut. */
  maxTurns?: number;
  /** Schéma passé à --json-schema (JSON compact). */
  jsonSchema?: object;
}

/** Arguments du CLI (tableau : jamais de shell). `--tools` reçoit la chaîne vide, argument distinct. */
export function buildArgs(role: AgentRole, opts: BuildArgsOptions = {}): string[] {
  if (!AGENT_ROLES.includes(role)) throw new Error(`rôle inconnu : ${String(role).slice(0, 40)}`);
  const t = opts.maxTurns;
  const turns = typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= 10 ? t : DEFAULT_MAX_TURNS;
  const args = [
    '-p',
    '--agent', role,
    '--tools', '',
    '--disallowedTools', 'mcp__*',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--no-session-persistence',
    '--max-turns', String(turns),
    '--model', CLI_MODEL_ALIAS,
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (opts.jsonSchema !== undefined) {
    if (opts.jsonSchema === null || typeof opts.jsonSchema !== 'object' || Array.isArray(opts.jsonSchema)) {
      throw new Error('jsonSchema : objet JSON attendu');
    }
    args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  }
  return args;
}

export interface ChildEnvOptions {
  /** Chemin ABSOLU du binaire claude (son dossier est mis dans PATH). */
  binPath: string;
  /** HOME isolé (prepareHome). */
  homeDir: string;
  /** Jeton `claude setup-token`. */
  token: string;
}

/**
 * Environnement du CLI, construit de ZÉRO : aucune variable du bot n'est héritée. En
 * particulier jamais ANTHROPIC_API_KEY (doc authentication : « In non-interactive mode (-p),
 * the key is always used when present ») ni les autres sources d'identifiants qui priment sur
 * CLAUDE_CODE_OAUTH_TOKEN (ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_USE_*, ANTHROPIC_PROFILE…) ; HOME
 * isolé : pas de ~/.claude, ~/.config/anthropic ni login du compte de la machine.
 */
export function childEnv(o: ChildEnvOptions): Record<string, string> {
  if (!isAbsolute(o.binPath)) throw new Error('chemin du binaire claude non absolu');
  if (!isAbsolute(o.homeDir)) throw new Error('HOME isolé non absolu');
  if (typeof o.token !== 'string' || o.token.trim() === '') throw new Error('jeton absent');
  return {
    PATH: [dirname(o.binPath), '/usr/bin', '/bin'].join(':'),
    HOME: o.homeDir,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    NO_COLOR: '1',
    CLAUDE_CODE_OAUTH_TOKEN: o.token.trim(),
    DISABLE_UPDATES: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
  };
}

// ---------------------------------------------------------------------------
// Dossiers temporaires
// ---------------------------------------------------------------------------

export interface TempDir {
  dir: string;
  cleanup: () => void;
}

function isInside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message.slice(0, 200) : 'erreur');
}

/**
 * Dossier de travail du CLI : temporaire (0700), HORS du dépôt, ne contenant QUE
 * `.claude/agents/*.md` copiés depuis `srcDir`. Sans --bare, `-p` charge hooks, .mcp.json,
 * agents du dossier de travail (doc headless) : il ne doit donc rien y avoir d'autre.
 */
export function prepareRuntime(srcDir: string): TempDir & { agents: string[] } {
  const srcAgents = join(srcDir, '.claude', 'agents');
  const dir = mkdtempSync(join(tmpdir(), 'llm-runtime-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    chmodSync(dir, 0o700);
    if (isInside(realpathSync(dir), realpathSync(srcDir))) throw new Error('dossier temporaire situé DANS le dépôt (TMPDIR ?) : refusé');
    const dst = join(dir, '.claude', 'agents');
    mkdirSync(dst, { recursive: true, mode: 0o700 });
    const agents: string[] = [];
    for (const name of readdirSync(srcAgents).sort()) {
      if (!name.endsWith('.md')) continue;
      if (!lstatSync(join(srcAgents, name)).isFile()) continue; // ni lien symbolique, ni dossier
      copyFileSync(join(srcAgents, name), join(dst, name));
      chmodSync(join(dst, name), 0o600);
      agents.push(name);
    }
    return { dir, cleanup, agents };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** HOME isolé du CLI : dossier temporaire 0700 vide. */
export function prepareHome(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), 'llm-home-'));
  chmodSync(dir, 0o700);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Fil-piège du dossier de travail, vérifié avant CHAQUE lancement : il ne doit contenir que
 * `.claude/agents/*.md` (fichiers ordinaires) et l'agent demandé doit y être.
 */
export function verifyRuntime(dir: string, role: AgentRole): { code: AbstentionCode; detail: string } | null {
  try {
    const top = readdirSync(dir).filter(n => n !== '.claude');
    if (top.length) return { code: 'isolation', detail: `élément inattendu dans le dossier d'exécution : ${top[0]}` };
    const cl = readdirSync(join(dir, '.claude')).filter(n => n !== 'agents');
    if (cl.length) return { code: 'isolation', detail: `élément inattendu : .claude/${cl[0]}` };
    const agentsDir = join(dir, '.claude', 'agents');
    const names = readdirSync(agentsDir);
    for (const n of names) {
      if (!n.endsWith('.md') || !lstatSync(join(agentsDir, n)).isFile()) return { code: 'isolation', detail: `élément inattendu : .claude/agents/${n}` };
    }
    if (!names.includes(`${role}.md`)) return { code: 'lancement_impossible', detail: `définition d'agent .claude/agents/${role}.md absente` };
    return null;
  } catch (e) {
    return { code: 'lancement_impossible', detail: `dossier d'exécution illisible (${errCode(e)})` };
  }
}

// ---------------------------------------------------------------------------
// Classification des échecs
// ---------------------------------------------------------------------------

/** Limites d'usage (doc errors) : « You've hit your session|weekly|Opus|Sonnet limit », dépense mensuelle. */
const USAGE_LIMIT_PATTERNS = [/you(?:'|’)ve hit your [^\n]{0,40}?limit/i, /monthly spend limit/i];
const AUTH_PATTERNS = [
  /failed to authenticate/i, /not logged in/i, /login expired/i, /oauth token revoked/i,
  /oauth token has expired/i, /invalid api key/i, /\b401\b/,
];
/** Course de rafraîchissement entre deux processus : transitoire, PAS un problème de jeton. */
const REFRESH_RACE = /another claude code process is refreshing/i;
const USAGE_CATEGORIES = new Set(['rate_limit', 'billing_error']);
const AUTH_CATEGORIES = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold']);

/**
 * Cause d'un échec, à partir des textes (result, errors, stderr) et des catégories d'erreur
 * API (system/api_retry, assistant.error). null = échec ordinaire ('resultat_erreur'…).
 */
export function classifyFailure(texts: readonly string[], categories: readonly string[] = []): 'limite_usage' | 'authentification' | null {
  const blob = texts.join('\n');
  if (USAGE_LIMIT_PATTERNS.some(r => r.test(blob)) || categories.some(c => USAGE_CATEGORIES.has(c))) return 'limite_usage';
  if (REFRESH_RACE.test(blob)) return null;
  if (AUTH_PATTERNS.some(r => r.test(blob)) || categories.some(c => AUTH_CATEGORIES.has(c))) return 'authentification';
  return null;
}

/** Compare deux versions « a.b.c » ; une version illisible est tenue pour plus ancienne. */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1, 4).map(Number) ?? null;
  const x = p(a);
  const y = p(b);
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

export interface RunSpec {
  binPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
  /** Plafond stdout + stderr (octets), 1 Mo par défaut. */
  maxOutputBytes?: number;
  /** Outils tolérés dans init / tool_use (défaut : aucun). */
  allowedInitTools?: readonly string[];
  /** Version minimale du CLI exigée dans l'événement init (null/absent : pas de contrôle). */
  minCliVersion?: string | null;
}

export interface RunnerDeps {
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Horloge (latence, contrôle d'échéance). */
  now?: () => number;
  /** Tue tout le groupe de processus (défaut : process.kill(-pid, 'SIGKILL')). */
  killGroup?: (pid: number) => void;
  /** Attente maximale de 'close' après un kill ou une sortie (ms). */
  closeGraceMs?: number;
}

function defaultKillGroup(pid: number): void {
  process.kill(-pid, 'SIGKILL');
}

/** Groupes vivants : tués si le bot s'arrête pendant un appel (process 'exit'). */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const p of liveGroups) {
      try { process.kill(-p, 'SIGKILL'); } catch { /* déjà mort */ }
    }
  });
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Lance le CLI et rend son issue. Ne rejette jamais : toute anomalie est une abstention.
 *
 * Ligne non-JSON sur stdout : le flux n'est plus fiable → kill immédiat du groupe et
 * 'flux_invalide' (requalifié en limite d'usage / authentification si la ligne le dit).
 */
export function runClaude(spec: RunSpec, deps: RunnerDeps = {}): Promise<CallOutcome> {
  const now = deps.now ?? Date.now;
  const spawnFn = deps.spawn ?? nodeSpawn;
  const killGroup = deps.killGroup ?? defaultKillGroup;
  const grace = deps.closeGraceMs ?? CLOSE_GRACE_MS;
  const maxBytes = typeof spec.maxOutputBytes === 'number' && spec.maxOutputBytes > 0 ? Math.floor(spec.maxOutputBytes) : DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = Math.min(Math.max(Number.isFinite(spec.timeoutMs) ? spec.timeoutMs : 0, 1), MAX_TIMEOUT_MS);
  const allowed = new Set(spec.allowedInitTools ?? []);
  const secret = spec.env.CLAUDE_CODE_OAUTH_TOKEN;
  const scrub = (s: string) => (secret && secret.length >= 8 && s.includes(secret) ? s.split(secret).join('[jeton masqué]') : s);
  const t0 = now();

  return new Promise<CallOutcome>(resolveOutcome => {
    let settled = false;
    let child: ChildProcess | null = null;
    let pid: number | undefined;
    const rawChunks: Buffer[] = [];
    let rawBytes = 0;
    let totalBytes = 0;
    let stderrText = '';
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let verdict: { code: AbstentionCode; detail: string } | null = null;
    let init: { model: string | null; version: string | null } | null = null;
    let result: Json | null = null;
    const categories: string[] = [];
    const strayLines: string[] = [];
    let exitInfo: { code: number | null; signal: string | null } | null = null;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const raw = () => scrub(Buffer.concat(rawChunks).toString('utf8'));
    const finish = (o: CallOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (pid !== undefined) liveGroups.delete(pid);
      resolveOutcome(o);
    };
    const fail = (code: AbstentionCode, detail: string): CallOutcome => ({
      ok: false, code, detail: scrub(detail), latencyMs: now() - t0, raw: raw(),
      exitCode: exitInfo?.code ?? null, signal: exitInfo?.signal ?? null,
    });
    const killAll = () => {
      if (pid === undefined) return;
      try { killGroup(pid); } catch { /* groupe déjà vide (ESRCH) */ }
    };
    const startGrace = () => {
      if (graceTimer === undefined) graceTimer = setTimeout(() => finalize(true), grace);
    };
    /** Arrêt décidé par ce code : SIGKILL du groupe, puis 'close' attendu au plus `grace` ms. */
    const abort = (code: AbstentionCode, detail: string) => {
      if (verdict || settled) return;
      verdict = { code, detail };
      killAll();
      startGrace();
    };

    const onInit = (e: Json) => {
      const tools = e.tools;
      if (!Array.isArray(tools) || !tools.every(t => typeof t === 'string')) {
        abort('flux_invalide', 'événement init sans liste d\'outils : isolation non vérifiable');
        return;
      }
      const extra = (tools as string[]).filter(t => !allowed.has(t));
      if (extra.length) {
        abort('isolation', `outils présents à l'init : ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? '…' : ''}`);
        return;
      }
      const servers = Array.isArray(e.mcp_servers) ? e.mcp_servers : [];
      const connected = servers.find(s => isObj(s) && s.status === 'connected');
      if (connected) {
        abort('isolation', `serveur MCP connecté : ${String((connected as Json).name ?? '?').slice(0, 60)}`);
        return;
      }
      const version = typeof e.claude_code_version === 'string' ? e.claude_code_version : null;
      init = { model: typeof e.model === 'string' ? e.model : null, version };
      if (spec.minCliVersion && (!version || compareVersions(version, spec.minCliVersion) < 0)) {
        abort('version_cli', `version du CLI ${version ?? 'inconnue'} < ${spec.minCliVersion} requise`);
      }
    };

    const onAssistant = (e: Json) => {
      if (typeof e.error === 'string') categories.push(e.error);
      const content = isObj(e.message) ? e.message.content : undefined;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (!isObj(b) || typeof b.type !== 'string' || !b.type.endsWith('tool_use')) continue;
        const name = typeof b.name === 'string' ? b.name : '?';
        if (!allowed.has(name)) {
          const sub = e.parent_tool_use_id ? ' (dans un sous-agent)' : '';
          abort('isolation', `appel d'outil ${name.slice(0, 60)}${sub}`);
          return;
        }
      }
    };

    const handleLine = (line: string) => {
      if (verdict) return;
      const s = line.trim();
      if (!s) return;
      let ev: unknown;
      try {
        ev = JSON.parse(s);
      } catch {
        strayLines.push(s.slice(0, 500));
        abort('flux_invalide', `ligne non JSON sur stdout : ${s.slice(0, 120)}`);
        return;
      }
      if (!isObj(ev)) {
        abort('flux_invalide', 'événement JSON qui n\'est pas un objet');
        return;
      }
      if (ev.type === 'system') {
        if (ev.subtype === 'init') onInit(ev);
        else if (ev.subtype === 'api_retry' && typeof ev.error === 'string') categories.push(ev.error);
      } else if (ev.type === 'assistant') {
        onAssistant(ev);
      } else if (ev.type === 'result') {
        result = ev;
      }
    };

    const failureTexts = (r: Json | null): string[] => {
      const t: string[] = [];
      if (r) {
        if (typeof r.result === 'string') t.push(r.result);
        if (Array.isArray(r.errors)) for (const x of r.errors) if (typeof x === 'string') t.push(x);
      }
      return [...t, ...strayLines, stderrText];
    };
    const excerpt = (texts: string[]) => texts.map(s => s.trim()).filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 300);

    function finalize(late: boolean): void {
      if (settled) return;
      const lateNote = late ? ` ; processus non terminé ${grace} ms après l'arrêt` : '';
      if (verdict) {
        let v: { code: AbstentionCode; detail: string } = verdict;
        if (v.code === 'flux_invalide') {
          const c = classifyFailure([...strayLines, stderrText], categories);
          if (c) v = { code: c, detail: `${v.detail} (${c})` };
        }
        finish(fail(v.code, v.detail + lateNote));
        return;
      }
      // Sortie du CLI sans 'close' (flux tenu par un descendant échappé) : on lit ce qu'on a.
      if (late) {
        pending += decoder.end();
        if (pending.trim()) handleLine(pending);
        pending = '';
        if (verdict) { finalize(false); return; }
      }
      const code = exitInfo?.code ?? null;
      const sig = exitInfo?.signal ?? null;
      const r: Json | null = result;
      if (r) {
        const success = r.subtype === 'success' && r.is_error !== true;
        if (success) {
          if (typeof r.result !== 'string') { finish(fail('resultat_erreur', 'résultat « success » sans texte')); return; }
          if (sig) { finish(fail('signal', `résultat reçu mais CLI tué par ${sig}`)); return; }
          if (code !== 0) { finish(fail('code_sortie', `résultat reçu mais code de sortie ${code}`)); return; }
          if (!init) { finish(fail('flux_invalide', 'événement init absent : isolation non vérifiée')); return; }
          const latencyMs = now() - t0;
          if (latencyMs > timeoutMs) { finish(fail('apres_echeance', `réponse après l'échéance (${latencyMs} ms > ${timeoutMs} ms)`)); return; }
          const mu = isObj(r.modelUsage) ? r.modelUsage : undefined;
          const keys = mu ? Object.keys(mu) : [];
          const usage: UsageInfo = {
            numTurns: num(r.num_turns), durationMs: num(r.duration_ms), durationApiMs: num(r.duration_api_ms),
            totalCostUsd: num(r.total_cost_usd), modelUsage: mu,
            models: keys.length ? keys : init.model ? [init.model] : [],
          };
          finish({
            ok: true, text: r.result, structured: r.structured_output ?? null, usage,
            cliVersion: init.version, latencyMs, raw: raw(),
          });
          return;
        }
        const cats = [...categories];
        if (r.api_error_status === 401) cats.push('authentication_failed');
        if (r.api_error_status === 429) cats.push('rate_limit');
        const texts = failureTexts(r);
        const c = classifyFailure(texts, cats);
        finish(fail(c ?? 'resultat_erreur', `résultat en erreur (${String(r.subtype).slice(0, 40)}) : ${excerpt(texts) || 'sans message'}`));
        return;
      }
      if (sig) { finish(fail('signal', `CLI tué par ${sig} sans résultat`)); return; }
      const texts = failureTexts(null);
      const c = classifyFailure(texts, categories);
      if (c) { finish(fail(c, `échec sans résultat : ${excerpt(texts) || categories.join(', ')}`)); return; }
      if (code !== 0) { finish(fail('code_sortie', `code de sortie ${code} sans résultat${excerpt(texts) ? ` : ${excerpt(texts)}` : ''}`)); return; }
      finish(fail('resultat_absent', 'sortie normale sans événement result'));
    }

    try {
      child = spawnFn(spec.binPath, spec.args, {
        cwd: spec.cwd, env: spec.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      });
    } catch (e) {
      finish(fail('lancement_impossible', `lancement impossible (${errCode(e)})`));
      return;
    }
    pid = child.pid;
    if (pid !== undefined && !deps.killGroup) trackGroup(pid);

    child.on('error', err => {
      // Sans pid : le processus n'a jamais démarré (ENOENT, EACCES…). Sinon l'issue vient de 'close'.
      if (child?.pid === undefined) finish(fail('lancement_impossible', `lancement impossible (${errCode(err)})`));
    });
    child.stdout?.on('data', (b: Buffer) => {
      totalBytes += b.length;
      if (rawBytes < maxBytes) {
        const take = b.subarray(0, maxBytes - rawBytes);
        rawChunks.push(take);
        rawBytes += take.length;
      }
      if (totalBytes > maxBytes) { abort('sortie_trop_grande', `sortie supérieure à ${maxBytes} octets`); return; }
      if (verdict) return;
      pending += decoder.write(b);
      let i: number;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        handleLine(line);
        if (verdict) { pending = ''; return; }
      }
    });
    child.stderr?.on('data', (b: Buffer) => {
      totalBytes += b.length;
      if (stderrText.length < STDERR_KEEP) stderrText += b.toString('utf8').slice(0, STDERR_KEEP - stderrText.length);
      if (totalBytes > maxBytes) abort('sortie_trop_grande', `sortie supérieure à ${maxBytes} octets`);
    });
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      killAll(); // descendants restés dans le groupe : aucun ne survit à l'appel
      startGrace();
    });
    child.on('close', (code, signal) => {
      exitInfo ??= { code, signal };
      if (!verdict) {
        pending += decoder.end();
        if (pending.trim()) handleLine(pending);
        pending = '';
      }
      finalize(false);
    });

    // EPIPE : le CLI s'est arrêté avant d'avoir tout lu ; l'issue vient de 'close'.
    child.stdin?.on('error', () => { /* ignoré */ });
    try {
      child.stdin?.end(spec.stdin);
    } catch { /* idem */ }

    timer = setTimeout(() => abort('timeout', `pas de réponse complète en ${timeoutMs} ms`), timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Fonction d'appel pour le pipeline
// ---------------------------------------------------------------------------

export interface CallFnConfig {
  /** Chemin ABSOLU du binaire claude. */
  binPath: string;
  /** Dossier de travail préparé par prepareRuntime. */
  runtimeDir: string;
  /** HOME isolé préparé par prepareHome. */
  homeDir: string;
  /** Jeton relu à chaque appel (rotation sans redémarrage) ; null = absent. Jamais loggué. */
  token: () => string | null;
  maxTurns?: number;
  maxOutputBytes?: number;
  /** Outils tolérés par le fil-piège (défaut : aucun). */
  allowedInitTools?: readonly string[];
  /**
   * Outils tolérés EN PLUS quand un --json-schema est passé (défaut : aucun). À renseigner
   * seulement si la sonde réelle montre que la sortie structurée passe par un outil interne.
   */
  schemaTools?: readonly string[];
  /** Version minimale du CLI (défaut DEFAULT_MIN_CLI_VERSION ; null : pas de contrôle). */
  minCliVersion?: string | null;
  /** Appelé juste avant chaque lancement (compteur d'appels CLI bruts). */
  onLaunch?: (role: AgentRole) => void;
  deps?: RunnerDeps;
}

/** Un seul processus claude à la fois, pour TOUT le bot. */
let callInFlight = false;

function refusal(code: AbstentionCode, detail: string): CallOutcome {
  return { ok: false, code, detail, latencyMs: 0, raw: '', exitCode: null, signal: null };
}

export function makeCallFn(cfg: CallFnConfig): CallFn {
  return async req => {
    if (callInFlight) return refusal('occupe', 'un appel au CLI est déjà en cours');
    callInFlight = true;
    let token: string | null = null;
    try {
      if (!req || !AGENT_ROLES.includes(req.role)) return refusal('lancement_impossible', 'rôle d\'agent inconnu');
      if (typeof req.stdin !== 'string' || Buffer.byteLength(req.stdin) > MAX_STDIN_BYTES) {
        return refusal('lancement_impossible', `message absent ou supérieur à ${MAX_STDIN_BYTES} octets`);
      }
      try { token = cfg.token(); } catch { token = null; }
      if (!token || !token.trim()) return refusal('jeton_absent', 'aucun jeton utilisable (npm run llm:token)');
      const bad = verifyRuntime(cfg.runtimeDir, req.role);
      if (bad) return refusal(bad.code, bad.detail);
      const args = buildArgs(req.role, { maxTurns: cfg.maxTurns, jsonSchema: req.jsonSchema });
      const env = childEnv({ binPath: cfg.binPath, homeDir: cfg.homeDir, token });
      try { cfg.onLaunch?.(req.role); } catch { /* compteur d'information */ }
      return await runClaude({
        binPath: cfg.binPath, args, cwd: cfg.runtimeDir, env, stdin: req.stdin, timeoutMs: req.timeoutMs,
        maxOutputBytes: cfg.maxOutputBytes,
        allowedInitTools: [...(cfg.allowedInitTools ?? []), ...(req.jsonSchema !== undefined ? cfg.schemaTools ?? [] : [])],
        minCliVersion: cfg.minCliVersion === undefined ? DEFAULT_MIN_CLI_VERSION : cfg.minCliVersion,
      }, cfg.deps);
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      if (token && token.length >= 8) msg = msg.split(token).join('[jeton masqué]');
      return refusal('lancement_impossible', `préparation de l'appel impossible : ${msg.slice(0, 200)}`);
    } finally {
      callInFlight = false;
    }
  };
}
