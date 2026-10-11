/**
 * daily-report.ts — quand envoyer le rapport quotidien (verdict « edge ou pas ») sur Telegram.
 *
 * Une fois par jour local, à partir de l'heure choisie (TELEGRAM_DAILY_REPORT, défaut 08:00) ;
 * un bot démarré après l'heure l'envoie à son démarrage s'il n'est pas déjà parti ce jour-là.
 * La date du dernier envoi est persistée : un redémarrage ne le renvoie pas.
 *
 * Fonctions PURES (l'heure et le fuseau sont passés en paramètre), sauf lecture/écriture
 * du petit fichier d'état.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isValidTimeZone } from '../services/telegram-messages.js';

/** « 08:00 » → 480 ; null si invalide. */
export function parseHHMM(raw: string): number | null {
  const m = /^(\d{1,2})[:hH](\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/** Date locale « AAAA-MM-JJ » et minutes depuis minuit dans le fuseau (UTC si invalide). */
export function localDateTime(nowMs: number, timeZone: string): { date: string; minutes: number } {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Le rapport du jour est-il dû ? (heure passée et pas encore envoyé ce jour local) */
export function dailyReportDue(nowMs: number, timeZone: string, atMinutes: number, lastDate: string | null): { due: boolean; date: string } {
  const { date, minutes } = localDateTime(nowMs, timeZone);
  return { due: minutes >= atMinutes && lastDate !== date, date };
}

/** Date du dernier envoi (null si jamais, ou fichier illisible). */
export function readLastDailyReport(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const v = (JSON.parse(readFileSync(path, 'utf8')) as { lastDate?: unknown }).lastDate;
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Mémorise l'envoi du jour (écriture atomique ; une erreur disque n'est pas fatale). */
export function writeLastDailyReport(path: string, date: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastDate: date }));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
