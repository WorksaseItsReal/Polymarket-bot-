/** Mise en forme partagée par les panneaux (français : virgule décimale, « $ » après). */

export function money(v: number, digits = 2): string {
  const s = Math.abs(v).toFixed(digits).replace('.', ',');
  return `${v < 0 ? '−' : v > 0 ? '+' : ''}${s} $`;
}

export function amount(v: number, digits = 2): string {
  return `${v.toFixed(digits).replace('.', ',')} $`;
}

export function pct(v: number | null | undefined, digits = 0): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits).replace('.', ',')} %`;
}

export function num(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits).replace('.', ',');
}

/** Durée courte : « 1 h 05 », « 4 min 03 s », « 12 s ». */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${s} s`;
}

export function ago(ms: number, now: number): string {
  if (!ms) return 'jamais';
  return `il y a ${duration(now - ms)}`;
}

export function clock(ms: number | string): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(ms: number | string): string {
  const d = new Date(ms);
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const pnlClass = (v: number) => (v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-300');
