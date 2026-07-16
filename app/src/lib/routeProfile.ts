// Pure sampling + tick helpers for the route depth-over-time profile (#45).
// No React, no MapLibre, no canvas — jsdom-safe and unit-testable. Depth comes
// from the intact main-thread mask (NavMask.depthInfoM, a read-only view over
// the cached buffer); wind and the safety-depth overlay are layered on by the
// DepthProfile component, never baked into these samples (the profile stores
// absolute depth; the safety line is a render-time overlay).
import type { LatLon, Leg } from '../types';
import type { NavMask } from './mask';

const HOUR_MS = 3_600_000;
const FIVE_MIN_MS = 5 * 60_000;
const MIN_SAMPLES = 60;
const MAX_SAMPLES = 240;

export interface ProfileSample {
  tMs: number;
  pos: LatLon;
  depthM: number; // absolute depth; capped samples still carry 25.4 here
  capped: boolean; // underlying mask byte was the >= 25.4 m deep-cap sentinel
  motor: boolean; // the active leg is a motor leg
  headingDeg: number; // active leg's course over ground
  legIndex: number;
}

export interface LegPosition {
  pos: LatLon;
  headingDeg: number;
  legIndex: number;
  motor: boolean;
}

/** Uniform-time sample count: one per 5 min of trip, clamped to [60, 240]. */
export function sampleCount(durationMs: number): number {
  const n = Math.round(durationMs / FIVE_MIN_MS);
  return Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, n));
}

/**
 * Position, heading and propulsion on the route at absolute time `tMs`,
 * linearly interpolated along whichever leg is active then. Times before the
 * first leg / after the last clamp to that leg's endpoints. `null` only for an
 * empty leg list. Shared by profileSamples and the profile's wind/heading
 * indicators so both read the route the same way.
 */
export function legPositionAt(legs: Leg[], tMs: number): LegPosition | null {
  if (legs.length === 0) return null;
  // Active leg = last leg whose start is at or before tMs (clamped into range).
  let idx = 0;
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].startTimeMs <= tMs) idx = i;
    else break;
  }
  const leg = legs[idx];
  const span = leg.endTimeMs - leg.startTimeMs;
  const f = span > 0 ? Math.min(1, Math.max(0, (tMs - leg.startTimeMs) / span)) : 0;
  const pos: LatLon = {
    lat: leg.start.lat + (leg.end.lat - leg.start.lat) * f,
    lon: leg.start.lon + (leg.end.lon - leg.start.lon) * f,
  };
  return { pos, headingDeg: leg.headingDeg, legIndex: idx, motor: leg.kind === 'motor' };
}

/**
 * `n` uniform-in-time depth samples across the whole trip (endpoints
 * included). Depth (absolute, plus the deep-cap flag) is read from the mask at
 * each interpolated position. Deliberately takes no safety depth — the safety
 * overlay is a render-time concern, never baked into a sample.
 */
export function profileSamples(legs: Leg[], mask: NavMask, n: number): ProfileSample[] {
  if (legs.length === 0 || n <= 0) return [];
  const startMs = legs[0].startTimeMs;
  const endMs = legs[legs.length - 1].endTimeMs;
  const denom = n > 1 ? n - 1 : 1;
  const samples: ProfileSample[] = [];
  for (let i = 0; i < n; i++) {
    const tMs = startMs + ((endMs - startMs) * i) / denom;
    const lp = legPositionAt(legs, tMs);
    if (!lp) continue;
    const info = mask.depthInfoM(lp.pos);
    samples.push({
      tMs,
      pos: lp.pos,
      depthM: info.depthM,
      capped: info.capped,
      motor: lp.motor,
      headingDeg: lp.headingDeg,
      legIndex: lp.legIndex,
    });
  }
  return samples;
}

/** Adaptive X-axis tick interval: trip <= 4 h -> 30 min, <= 12 h -> 1 h, else 2 h. */
export function tickIntervalMs(durationMs: number): number {
  const hours = durationMs / HOUR_MS;
  if (hours <= 4) return 30 * 60_000;
  if (hours <= 12) return HOUR_MS;
  return 2 * HOUR_MS;
}

/**
 * Clock-aligned tick times within [startMs, endMs] at the adaptive interval.
 * Alignment is to the interval in epoch ms, so labels land on clean HH:mm
 * boundaries (00/30 for 30 min, whole hours otherwise) that a skipper can
 * cross-reference against the map ETA labels.
 */
export function tickTimes(startMs: number, endMs: number): number[] {
  const interval = tickIntervalMs(endMs - startMs);
  const ticks: number[] = [];
  for (let t = Math.ceil(startMs / interval) * interval; t <= endMs; t += interval) ticks.push(t);
  return ticks;
}

/**
 * Times for the wind/heading indicator strip — aligned to the X-axis ticks, so
 * every indicator sits above a labelled tick. Falls back to the trip midpoint
 * when the trip is shorter than one tick interval (no aligned tick inside it).
 */
export function indicatorTimes(startMs: number, endMs: number): number[] {
  const ticks = tickTimes(startMs, endMs);
  return ticks.length > 0 ? ticks : [startMs + (endMs - startMs) / 2];
}
