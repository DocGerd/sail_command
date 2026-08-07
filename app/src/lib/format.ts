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

/**
 * Leg-scale duration for the legs table (#379) — `formatDuration` above is
 * passage-scale and renders a short manoeuvring leg as `0 h 04 min`, which
 * reads as "basically nothing" rather than the honest 4 minutes. Below one
 * hour this drops the leading `0 h ` entirely (`"47 min"`); at or above one
 * hour it falls back to the same `H h MM min` shape as `formatDuration`
 * (`"2 h 05 min"`). `h`/`min` are used untranslated by `formatDuration`
 * already, so this needs no new i18n value keys — only the column header
 * (`route.legs.duration`) is translated.
 */
export function formatLegDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
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

/**
 * Local CIVIL-day index for `ms`: the local Y/M/D read off `ms`, re-anchored
 * to a UTC midnight of the same Y/M/D and divided into whole days. Two
 * instants compare equal here iff they fall on the same local calendar day,
 * REGARDLESS of a DST transition between them — a 23h (spring-forward) or
 * 25h (fall-back) day is still exactly one day-index step, where naive
 * `Math.floor(ms / 86_400_000)` arithmetic on the raw instants would not be:
 * it measures elapsed real time, which a DST transition perturbs by an hour,
 * and that perturbation can flip which side of a day-count boundary two
 * timestamps fall on (see `formatSliderTime`'s 6-day tier below, and the
 * regression test that constructs exactly this discrepancy across the
 * 2026-03-29 spring-forward).
 */
function localDayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/**
 * Slider label for the wind-barb forecast-time control (#292). Three tiers,
 * evaluated in local wall-clock calendar days (never raw ms/24h arithmetic —
 * see `localDayIndex`):
 *
 * 1. Every candidate hour AND `nowMs` fall on the same local calendar day →
 *    bare `HH:MM` (today's forecast; a date/weekday would be pure noise).
 * 2. Otherwise, `ms` is within 6 calendar days of `nowMs` → short locale
 *    weekday + time (`Di 23:00` / `Wed 00:00`) — the "which day this week"
 *    case: a passage running past midnight, or a saved plan from a few days
 *    back.
 * 3. Otherwise → short locale DATE + time (`20. Aug. 14:00` / `20 Aug
 *    14:00`). A bare weekday cannot disambiguate "Tuesday this week" from
 *    "Tuesday three weeks ago" — the exact stale-saved-plan ambiguity #292
 *    names as a second, compounding case alongside the midnight-crossing one.
 *
 * `hourOptionsMs` is the slider's full snap-point list (RouteLayer's
 * `hourOptions`), not just the selected hour, so tier 1's "today-only"
 * check and the visible label's presence/width stay constant across the
 * whole range rather than popping in and out as the user drags.
 *
 * `nowMs` is an EXPLICIT parameter, never read from `Date.now()` in here —
 * it is only the reference point for CHOOSING a format tier, never a source
 * of displayed time (the displayed instant always comes from `ms`, which
 * comes from the plan's own stored wind grid). This keeps the function pure
 * and deterministic for tests; the caller supplies the real wall clock.
 *
 * KNOWN LIMITATION (accepted): the tier is computed at render time from
 * whatever `nowMs` the caller passes at that render — it does not re-run on
 * a timer, so a plan left open across a tier boundary (midnight, or the
 * 6-day cutoff) keeps showing its previous tier until the next re-render.
 */
export function formatSliderTime(
  ms: number,
  hourOptionsMs: readonly number[],
  lang: Lang,
  nowMs: number,
): string {
  const first = hourOptionsMs[0] ?? ms;
  const firstDay = localDayIndex(first);
  const allSameDay = hourOptionsMs.every((t) => localDayIndex(t) === firstDay);
  const todayDay = localDayIndex(nowMs);
  if (allSameDay && firstDay === todayDay) {
    return formatTime(ms, lang);
  }
  const dayDiff = Math.abs(localDayIndex(ms) - todayDay);
  if (dayDiff <= 6) {
    const weekday = new Intl.DateTimeFormat(LOCALES[lang], { weekday: 'short' }).format(ms);
    return `${weekday} ${formatTime(ms, lang)}`;
  }
  const shortDate = new Intl.DateTimeFormat(LOCALES[lang], {
    day: '2-digit',
    month: 'short',
  }).format(ms);
  return `${shortDate} ${formatTime(ms, lang)}`;
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

// datetime-local reads/writes LOCAL wall-clock time with no offset suffix;
// the Date getters/constructor operate in local time by design, so
// ms <-> string round-trips through the browser's own timezone. Shared by
// PlannerPanel's departure input and PlansList's recalculate editor (#114).
export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
