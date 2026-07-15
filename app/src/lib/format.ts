// Formatting helpers for the planner UI. No i18n module dependency here —
// callers pass the active language explicitly so this module stays testable
// in isolation.
import type { LatLon } from '../types';

export type Lang = 'de' | 'en';

const LOCALES: Record<Lang, string> = { de: 'de-DE', en: 'en-GB' };

function zeroPad(n: number, width: number): string {
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
  return `${zeroPad(normalized, 3)}°`;
}

/**
 * Plain decimal-degree coordinate label for a map-tap-picked point, e.g.
 * `54.789°N 9.433°E` — deliberately NOT formatHeading (that's for 0..360°
 * bearings, no decimals/hemisphere letter). Zero is treated as N/E.
 */
export function formatLatLon(p: LatLon): string {
  const ns = p.lat < 0 ? 'S' : 'N';
  const ew = p.lon < 0 ? 'W' : 'E';
  return `${Math.abs(p.lat).toFixed(3)}°${ns} ${Math.abs(p.lon).toFixed(3)}°${ew}`;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${zeroPad(minutes, 2)} min`;
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
