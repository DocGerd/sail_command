// Pure Live readouts derived from a GPS fix and the plan's legs (#1803).
// Information only: nothing here advises a course or a correction.
import type { LatLon, Leg } from '../types';
import { activeLegIndex } from './live';
import {
  alongTrackFraction,
  crossTrackNm,
  destinationPoint,
  haversineNm,
  initialBearingDeg,
} from './geo';
import { formatHeading } from './format';

/**
 * A rival leg must be nearer than the current one by MORE than this to take
 * over without the boat having passed the current leg's end. Sized above
 * typical GPS jitter, below the width of a real corner cut.
 */
export const LEG_SWITCH_MARGIN_NM = 0.05;

function assertLegIndex(legs: Leg[], i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= legs.length) {
    throw new RangeError(`liveMetrics: leg index ${i} out of range for ${legs.length} legs`);
  }
}

function remainingOnLegNm(p: LatLon, leg: Leg): number {
  const frac = Math.min(1, Math.max(0, alongTrackFraction(p, leg.start, leg.end)));
  return leg.distanceNm * (1 - frac);
}

/**
 * Remaining distance on leg `i` (from p's clamped projection onto it) and on
 * the whole route (that plus every later leg's full length).
 */
export function distanceToGoNm(
  legs: Leg[],
  i: number,
  p: LatLon,
): { legNm: number; routeNm: number } {
  assertLegIndex(legs, i);
  const legNm = remainingOnLegNm(p, legs[i]);
  let routeNm = legNm;
  for (let j = i + 1; j < legs.length; j++) routeNm += legs[j].distanceNm;
  return { legNm, routeNm };
}

/** 1-based position of leg `i` for a "leg N of M" readout. */
export function legPosition(legs: Leg[], i: number): { current: number; total: number } {
  assertLegIndex(legs, i);
  return { current: i + 1, total: legs.length };
}

export type TrackSide = 'port' | 'starboard';

export interface CrossTrack {
  /** Always >= 0. */
  distanceNm: number;
  /** Side of the track the boat is on, as seen travelling start -> end; null when exactly on the track line. */
  side: TrackSide | null;
  /**
   * Set when p projects before the leg's start or beyond its end. `distanceNm`
   * is then the distance to that nearest endpoint (the same metric
   * activeLegIndex uses), not a perpendicular offset; `side` still follows the
   * extended track line.
   */
  clamped: 'before-start' | 'beyond-end' | null;
}

/**
 * Where p lies relative to `leg`. Side convention: facing the leg's
 * start -> end direction, port is the left-hand side and starboard the
 * right (geo.crossTrackNm is positive to starboard).
 */
export function crossTrack(leg: Leg, p: LatLon): CrossTrack {
  if (haversineNm(leg.start, leg.end) === 0) {
    return { distanceNm: haversineNm(p, leg.start), side: null, clamped: null };
  }
  const rawFrac = alongTrackFraction(p, leg.start, leg.end);
  const signed = crossTrackNm(p, leg.start, leg.end);
  const side: TrackSide | null = signed > 0 ? 'starboard' : signed < 0 ? 'port' : null;
  if (rawFrac < 0) return { distanceNm: haversineNm(p, leg.start), side, clamped: 'before-start' };
  if (rawFrac > 1) return { distanceNm: haversineNm(p, leg.end), side, clamped: 'beyond-end' };
  return { distanceNm: Math.abs(signed), side, clamped: null };
}

/** Degrees true, zero-padded, e.g. "045°T". Rounding and 360 wrap follow formatHeading. */
export function formatTrueHeading(deg: number): string {
  return `${formatHeading(deg)}T`;
}

function distanceToLegNm(p: LatLon, leg: Leg): number {
  const frac = Math.min(1, Math.max(0, alongTrackFraction(p, leg.start, leg.end)));
  if (frac === 0) return haversineNm(p, leg.start);
  if (frac === 1) return haversineNm(p, leg.end);
  const projected = destinationPoint(
    leg.start,
    initialBearingDeg(leg.start, leg.end),
    frac * leg.distanceNm,
  );
  return haversineNm(p, projected);
}

export interface LegSwitchInput {
  /** Currently active leg; null before the first fix. */
  prevIndex: number | null;
  /** Nearest leg for this fix (activeLegIndex). */
  candidateIndex: number;
  prevDistNm: number;
  candidateDistNm: number;
  /** The boat's projection lies beyond the current leg's end. */
  prevEndPassed: boolean;
}

/**
 * Hysteresis for the active leg (ruling d). Switching is asymmetric: a LATER
 * leg takes over at once when the boat has passed the current leg's end, and
 * otherwise (either direction) only when it is nearer by more than
 * LEG_SWITCH_MARGIN_NM. Noise around a joint therefore cannot flip it back.
 */
export function nextActiveLegIndex(s: LegSwitchInput): number {
  if (s.prevIndex === null) return s.candidateIndex;
  if (s.candidateIndex === s.prevIndex) return s.prevIndex;
  if (s.candidateIndex > s.prevIndex && s.prevEndPassed) return s.candidateIndex;
  return s.prevDistNm - s.candidateDistNm > LEG_SWITCH_MARGIN_NM ? s.candidateIndex : s.prevIndex;
}

/** One hysteresis step for a fix; an out-of-range prevIndex (plan changed) acts as null. */
export function stepActiveLeg(legs: Leg[], p: LatLon, prevIndex: number | null): number {
  const candidateIndex = activeLegIndex(legs, p);
  if (prevIndex === null || prevIndex < 0 || prevIndex >= legs.length) return candidateIndex;
  const prev = legs[prevIndex];
  return nextActiveLegIndex({
    prevIndex,
    candidateIndex,
    prevDistNm: distanceToLegNm(p, prev),
    candidateDistNm: distanceToLegNm(p, legs[candidateIndex]),
    prevEndPassed: alongTrackFraction(p, prev.start, prev.end) > 1,
  });
}
