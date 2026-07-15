// Formatting helpers for the planner UI. No i18n module dependency here —
// callers pass the active language explicitly so this module stays testable
// in isolation.
export type Lang = 'de' | 'en';

const LOCALES: Record<Lang, string> = { de: 'de-DE', en: 'en-GB' };

function padStart(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function formatNm(nm: number): string {
  return `${nm.toFixed(1)} nm`;
}

export function formatKn(kn: number): string {
  return `${kn.toFixed(1)} kn`;
}

export function formatHeading(deg: number): string {
  const normalized = ((Math.round(deg) % 360) + 360) % 360;
  return `${padStart(normalized, 3)}°`;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${padStart(minutes, 2)} min`;
}

/** Signed schedule drift in whole minutes, e.g. "+12 min" (behind) / "-10 min" (ahead) / "0 min". */
export function formatDriftMin(driftMs: number): string {
  const minutes = Math.round(driftMs / 60_000);
  const sign = minutes > 0 ? '+' : '';
  return `${sign}${minutes} min`;
}

export function formatTime(ms: number, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms);
}

export function formatDateTime(ms: number, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms);
}
