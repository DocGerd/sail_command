import { useSyncExternalStore } from 'react';

// The Wetter tab's chosen hour (#1854). A module store so a slider tick
// re-renders only its subscribers (ConditionsPanel, RouteLayer), never App.

const HOUR_MS = 3_600_000;

let hourMs: number | null = null;
let seedDepartureMs: number | null = null;
const listeners = new Set<() => void>();

export function getConditionsHour(): number | null {
  return hourMs;
}

export function setConditionsHour(ms: number | null): void {
  if (ms === hourMs) return;
  hourMs = ms;
  for (const l of listeners) l();
}

export function subscribeConditionsHour(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useConditionsHour(): number | null {
  return useSyncExternalStore(subscribeConditionsHour, getConditionsHour);
}

export function resetConditionsHourForTests(): void {
  hourMs = null;
  seedDepartureMs = null;
  listeners.clear();
}

export function floorHourMs(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Forecast hours from the current hour to the end of the axis. */
export function validHours(timesMs: readonly number[], nowMs: number): number[] {
  const from = floorHourMs(nowMs);
  return timesMs.filter((t) => t >= from);
}

/** The option holding `ms` (the last option at or before it), clamped into range. */
export function clampHour(
  ms: number,
  options: readonly number[],
): { ms: number; clamped: boolean } | null {
  const first = options[0];
  const last = options[options.length - 1];
  if (first === undefined || last === undefined) return null;
  if (ms < first) return { ms: first, clamped: true };
  if (ms >= last + HOUR_MS) return { ms: last, clamped: true };
  let best = first;
  for (const t of options) {
    if (t <= ms) best = t;
    else break;
  }
  return { ms: best, clamped: false };
}

export function stepHour(options: readonly number[], current: number, delta: number): number {
  const i = options.indexOf(current);
  if (i < 0) return clampHour(current, options)?.ms ?? current;
  return options[Math.min(options.length - 1, Math.max(0, i + delta))] ?? current;
}

/** ±whole local days, keeping the clock hour, clamped into range. */
export function stepDay(options: readonly number[], current: number, delta: number): number {
  const d = new Date(current);
  d.setDate(d.getDate() + delta);
  return clampHour(floorHourMs(d.getTime()), options)?.ms ?? current;
}

/**
 * Tab entry. A departure that changed since the last seed becomes the hour;
 * otherwise the user's last hour is kept. Either is clamped into `options`,
 * which also moves a past hour forward. Returns whether the departure seed
 * had to be clamped.
 */
export function seedConditionsHour(departureMs: number, options: readonly number[]): boolean {
  if (options.length === 0) return false;
  const fromDeparture = departureMs !== seedDepartureMs || hourMs === null;
  seedDepartureMs = departureMs;
  const c = clampHour(fromDeparture ? floorHourMs(departureMs) : (hourMs ?? departureMs), options);
  setConditionsHour(c?.ms ?? null);
  return fromDeparture && (c?.clamped ?? false);
}
