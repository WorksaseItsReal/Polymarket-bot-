/**
 * report-runner.ts — exécute un script d'analyse (rapport du journal, backtest historique)
 * dans un processus SÉPARÉ, pour les commandes Telegram /rapport et /backtest.
 *
 * Pourquoi un processus : ces calculs lisent des centaines de milliers d'évaluations et
 * interrogent Gamma pendant une à plusieurs minutes. Dans le processus du bot, ils
 * bloqueraient la boucle de trading et gonfleraient sa mémoire (PM2 le redémarre à 400 Mo).
 * Ici : priorité basse (nice 10), un seul calcul à la fois, délai maximal, sortie bornée,
 * et l'enfant est tué à l'arrêt du bot.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setPriority } from 'node:os';

export interface ReportJob {
  /** Nom lisible (« rapport », « backtest »). */
  name: string;
  /** Chemin du script .ts. */
  script: string;
  args: string[];
}

export interface ReportResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  ms: number;
}

export interface ReportRunnerOptions {
  cwd: string;
  /** Arguments node avant le script (défaut : ceux du bot, `childNodeArgs`). */
  nodeArgs?: string[];
  timeoutMs?: number;
  /** Octets gardés par flux (le reste est ignoré). */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** Injection (tests). */
  spawnImpl?: typeof spawn;
  now?: () => number;
}

export class ReportRunner {
  private child: ChildProcess | null = null;
  private current: string | null = null;
  private startedAt = 0;

  constructor(private readonly o: ReportRunnerOptions) {}

  /** Nom du calcul en cours, ou null. */
  get busy(): string | null {
    return this.current;
  }

  /** Secondes écoulées depuis le début du calcul en cours (0 si aucun). */
  elapsedSec(): number {
    return this.current ? Math.max(0, ((this.o.now ?? Date.now)() - this.startedAt) / 1000) : 0;
  }

  /**
   * Lance le calcul s'il n'y en a pas déjà un ; false sinon. `done` est appelé une seule
   * fois, jamais de façon synchrone, et ne doit pas lever (erreurs ignorées).
   */
  start(job: ReportJob, done: (r: ReportResult) => void): boolean {
    if (this.current) return false;
    const now = this.o.now ?? Date.now;
    const t0 = now();
    this.current = job.name;
    this.startedAt = t0;
    const max = this.o.maxOutputBytes ?? 256 * 1024;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let finished = false;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    const finish = (code: number | null, spawnError?: Error): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      this.child = null;
      this.current = null;
      const stderr = Buffer.concat(err).toString('utf8') + (spawnError ? `\n${spawnError.message}` : '');
      const r: ReportResult = { ok: code === 0 && !timedOut && !spawnError, stdout: Buffer.concat(out).toString('utf8'), stderr, code, timedOut, ms: now() - t0 };
      setImmediate(() => { try { done(r); } catch { /* le rappel ne doit jamais faire tomber le bot */ } });
    };
    let child: ChildProcess;
    try {
      child = (this.o.spawnImpl ?? spawn)(process.execPath, [...(this.o.nodeArgs ?? childNodeArgs()), job.script, ...job.args], {
        cwd: this.o.cwd, env: this.o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.current = null;
      setImmediate(() => { try { done({ ok: false, stdout: '', stderr: (e as Error).message, code: null, timedOut: false, ms: 0 }); } catch { /* idem */ } });
      return true;
    }
    this.child = child;
    try { if (child.pid) setPriority(child.pid, 10); } catch { /* priorité : au mieux */ }
    child.stdout?.on('data', (b: Buffer) => { if (outLen < max) { out.push(b); outLen += b.length; } });
    child.stderr?.on('data', (b: Buffer) => { if (errLen < max) { err.push(b); errLen += b.length; } });
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* déjà fini */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* idem */ } }, 5000);
      killTimer.unref?.();
    }, this.o.timeoutMs ?? 15 * 60_000);
    timer.unref?.();
    child.on('error', e => finish(null, e));
    child.on('close', code => finish(code));
    return true;
  }

  /** Arrêt du bot : tue le calcul en cours (sans rappel utile : le bot s'arrête). */
  stop(): void {
    try { this.child?.kill('SIGTERM'); } catch { /* déjà fini */ }
  }
}

/**
 * Options node de l'enfant : celles du bot (chargeur TypeScript, préchargements), sans le
 * débogueur (port déjà pris) ; chargeur tsx ajouté s'il manque (bot lancé autrement).
 */
export function childNodeArgs(execArgv: readonly string[] = process.execArgv): string[] {
  const args = execArgv.filter(a => !/^--(inspect|debug)/.test(a));
  return args.some(a => a.includes('tsx')) ? args : ['--import', 'tsx', ...args];
}

/** Fin de la sortie d'erreur, lisible dans un message (dernières lignes, ≤ `max` caractères). */
export function stderrTail(stderr: string, max = 600): string {
  const s = stderr.trim();
  return s.length <= max ? s : `…${s.slice(-max)}`;
}
