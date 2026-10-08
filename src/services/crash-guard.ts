/**
 * Suivi des arrêts anormaux entre deux lancements, pour Telegram.
 *
 * PM2 (5.x) relance le bot sans jamais abandonner : il ne compte un redémarrage comme
 * « instable » que si le process a tourné moins de `min_uptime` (1 s), et tsx met plus
 * longtemps que ça à démarrer. Un bot qui plante en boucle était donc relancé toutes les
 * 15 s au plus (`exp_backoff_restart_delay`, plafond PM2), et chaque tour envoyait DEUX
 * messages (alerte d'arrêt + message de démarrage) : des milliers par jour.
 *
 * Ici : la 1re alerte part tout de suite, les suivantes sont espacées (10 min, 20, 40…
 * jusqu'à 6 h) tant que les arrêts se suivent à moins d'une heure ; le message de
 * démarrage n'est envoyé que si l'arrêt qui le précède a été signalé. Un arrêt brutal
 * (kill -9, mémoire saturée : aucun gestionnaire ne tourne) est détecté au lancement
 * suivant grâce au marqueur `running` laissé en place.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const HOUR = 3_600_000;
const FIRST_GAP_MS = 10 * 60_000;
const MAX_GAP_MS = 6 * HOUR;

interface CrashState {
  /** Process en cours (retiré par l'arrêt propre ou sur erreur). */
  running?: { pid: number; startedAt: number };
  /** Horodatages des arrêts anormaux des dernières 24 h. */
  crashes: number[];
  lastAlertAt: number;
  alertGapMs: number;
  /** Dernier arrêt passé par le gestionnaire d'arrêt (`silenced` : son alerte a été tue). */
  lastStop?: { at: number; abnormal: boolean; silenced?: boolean };
}

export interface StartReport {
  /** Arrêt brutal détecté (le process précédent n'est pas passé par l'arrêt). */
  brutal: boolean;
  /** Le lancement précédent s'est arrêté sur erreur (exception, code ≠ 0). */
  afterError: boolean;
  /** Arrêts anormaux dans la dernière heure (y compris l'arrêt brutal détecté). */
  recentCrashes: number;
  /** Envoyer le message de démarrage (sinon : boucle de plantage déjà signalée). */
  announce: boolean;
  /** Un autre bot semble tourner avec le même dossier d'état. */
  otherInstance: boolean;
}

export interface StopReport {
  /** Envoyer l'alerte d'arrêt sur erreur. */
  alert: boolean;
  recentCrashes: number;
  /** Écart minimal avant l'alerte suivante (0 : la prochaine part tout de suite). */
  nextGapMs: number;
}

function load(file: string): CrashState {
  try {
    if (existsSync(file)) {
      const s = JSON.parse(readFileSync(file, 'utf8'));
      return {
        running: s?.running && Number.isFinite(s.running.pid) && Number.isFinite(s.running.startedAt) ? s.running : undefined,
        crashes: Array.isArray(s?.crashes) ? s.crashes.filter((t: unknown) => Number.isFinite(t)) : [],
        lastAlertAt: Number.isFinite(s?.lastAlertAt) ? s.lastAlertAt : 0,
        alertGapMs: Number.isFinite(s?.alertGapMs) ? s.alertGapMs : 0,
        lastStop: s?.lastStop && Number.isFinite(s.lastStop.at)
          ? { at: s.lastStop.at, abnormal: s.lastStop.abnormal === true, silenced: s.lastStop.silenced === true } : undefined,
      };
    }
  } catch { /* fichier illisible : on repart de zéro, ce n'est qu'un suivi d'alertes */ }
  return { crashes: [], lastAlertAt: 0, alertGapMs: 0 };
}

function save(file: string, s: CrashState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, file);
  } catch { /* disque plein ou en lecture seule : les alertes ne sont simplement pas espacées */ }
}

/**
 * Le PID est-il un bot en cours ? Sous Linux, on lit sa ligne de commande et son
 * environnement : après un redémarrage de la machine, un process sans rapport peut avoir
 * repris le PID de l'ancien bot (sinon : « autre instance » à tort, et plus aucun arrêt
 * brutal détecté). Sous PM2 (`node --import tsx`), la ligne de commande est celle du
 * lanceur de PM2 : le script est dans la variable `pm_exec_path`. Ailleurs : existence.
 */
export function isBotProcess(pid: number): boolean {
  try {
    if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('bot-with-dashboard')) return true;
    try { return /(^|\0)pm_exec_path=[^\0]*bot-with-dashboard/.test(readFileSync(`/proc/${pid}/environ`, 'utf8')); } catch { return false; }
  } catch {
    if (existsSync('/proc/self')) return false; // Linux : pas de /proc/<pid> = process mort
  }
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

/**
 * Enregistre un arrêt anormal et décide s'il faut le signaler (espacement exponentiel).
 * `canNotify` faux (Telegram pas encore connecté) : l'arrêt est compté mais PAS considéré
 * comme signalé — sinon un incident pouvait passer entièrement sous silence.
 */
function registerCrash(s: CrashState, now: number, canNotify = true): boolean {
  s.crashes = s.crashes.filter(t => now - t < 24 * HOUR && t <= now);
  // Aucun arrêt dans l'heure précédente : situation stable, l'espacement repart de zéro.
  if (!s.crashes.some(t => now - t < HOUR)) s.alertGapMs = 0;
  s.crashes.push(now);
  if (s.crashes.length > 500) s.crashes.splice(0, s.crashes.length - 500);
  if (!canNotify) return false;
  const alert = now - s.lastAlertAt >= s.alertGapMs;
  if (alert) {
    s.lastAlertAt = now;
    s.alertGapMs = s.alertGapMs ? Math.min(MAX_GAP_MS, s.alertGapMs * 2) : FIRST_GAP_MS;
  }
  return alert;
}

const recent = (s: CrashState, now: number) => s.crashes.filter(t => now - t < HOUR && t <= now).length;

/** À appeler au lancement : détecte un arrêt brutal précédent et pose le marqueur. */
export function noteStart(file: string, now = Date.now(), pid = process.pid, isRunning: (pid: number) => boolean = isBotProcess): StartReport {
  const s = load(file);
  let brutal = false;
  let otherInstance = false;
  if (s.running) {
    // noteStart n'est appelé qu'une fois par process : un marqueur à NOTRE pid vient d'un
    // process mort qui avait le même (PID réattribués à l'identique après un redémarrage
    // de conteneur, ou reboot + resurrect).
    if (s.running.pid !== pid && isRunning(s.running.pid)) otherInstance = true;
    else brutal = true;
  }
  // Démarrage annoncé sauf si l'arrêt qui le précède a été tu (boucle de plantage déjà
  // signalée). Un arrêt brutal n'a pu être signalé que par ce message : il suit l'espacement.
  // (Avant : décidé sur le dernier PLANTAGE de l'heure → un `pm2 restart` volontaire après
  // une boucle restait sans message de démarrage, le bot paraissait arrêté.)
  const announce = brutal ? registerCrash(s, now) : !s.lastStop?.silenced;
  if (!otherInstance) s.running = { pid, startedAt: now };
  save(file, s);
  const afterError = !brutal && !otherInstance && s.lastStop?.abnormal === true;
  return { brutal, afterError, recentCrashes: recent(s, now), announce, otherInstance };
}

/** À appeler à l'arrêt : retire le marqueur ; sur erreur, décide si l'alerte part. */
export function noteStop(file: string, abnormal: boolean, now = Date.now(), pid = process.pid, canNotify = true): StopReport {
  const s = load(file);
  if (s.running?.pid === pid) s.running = undefined;
  const alert = abnormal ? registerCrash(s, now, canNotify) : false;
  s.lastStop = { at: now, abnormal, silenced: abnormal && canNotify && !alert };
  save(file, s);
  return { alert, recentCrashes: recent(s, now), nextGapMs: s.alertGapMs };
}

/** Pour le diagnostic : arrêts anormaux des dernières 24 h et date du plus récent. */
export function crashSummary(file: string, now = Date.now()): { last24h: number; lastAt: number | null } {
  const c = load(file).crashes.filter(t => now - t < 24 * HOUR && t <= now);
  return { last24h: c.length, lastAt: c.length ? Math.max(...c) : null };
}
