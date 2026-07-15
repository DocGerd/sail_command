// Pure live-guidance math: projecting a GPS fix onto the planned route. Runs
// on every GPS fix while sailing (LiveView.tsx), so it stays pure/allocation-
// light and never re-routes (spec §2: "No live re-routing in v1").
import type { LatLon, Leg, ManeuverKind } from '../types';
import { alongTrackFraction, destinationPoint, haversineNm, initialBearingDeg } from './geo';

// Fraction of p's projection onto leg's segment, clamped to [0, 1] so a
// position before the leg's start or past its end still resolves to the
// nearest endpoint instead of extrapolating off the segment.
function clampedFraction(p: LatLon, leg: Leg): number {
  return Math.min(1, Math.max(0, alongTrackFraction(p, leg.start, leg.end)));
}

// Great-circle distance (nm) from p to its clamped projection onto leg's
// segment — the metric activeLegIndex minimizes over.
function distanceToLegNm(p: LatLon, leg: Leg): number {
  const frac = clampedFraction(p, leg);
  if (frac === 0) return haversineNm(p, leg.start);
  if (frac === 1) return haversineNm(p, leg.end);
  const projected = destinationPoint(leg.start, initialBearingDeg(leg.start, leg.end), frac * leg.distanceNm);
  return haversineNm(p, projected);
}

/**
 * Index of the leg whose segment (clamped projection) is nearest p. Ties
 * favor the earlier leg, which is what makes a maneuver "at the start of
 * leg i" read as already-happened once leg i is chosen as active (see
 * distanceToNextManeuverNm).
 */
export function activeLegIndex(legs: Leg[], p: LatLon): number {
  if (legs.length === 0) throw new Error('activeLegIndex: legs must be non-empty');
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < legs.length; i++) {
    const d = distanceToLegNm(p, legs[i]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Bearing from p to the active leg's end point — the heading-to-steer readout. */
export function headingToSteerDeg(legs: Leg[], i: number, p: LatLon): number {
  return initialBearingDeg(p, legs[i].end);
}

/**
 * Distance (nm) and kind of the next flagged event ahead of p on leg i: a
 * tack/gybe (Leg.maneuverAtStart), or a sail->motor transition. Motor legs
 * always have maneuverAtStart === null (types.ts), so a sail->motor
 * transition can't self-report through that field and is detected here as a
 * kind change instead. A motor->sail transition (engine off) is
 * deliberately NOT flagged — the brief calls out only the sail->motor case.
 *
 * Sums the remainder of leg i (from p's clamped projection) plus the full
 * length of every leg strictly between i and the flagged leg — the flagged
 * leg's own length isn't included, since the event happens at its start.
 * Returns null when nothing is flagged for the rest of the route.
 */
export function distanceToNextManeuverNm(
  legs: Leg[],
  i: number,
  p: LatLon,
): { distNm: number; kind: ManeuverKind | 'motor-start' } | null {
  const leg = legs[i];
  let distNm = leg.distanceNm * (1 - clampedFraction(p, leg));

  for (let j = i + 1; j < legs.length; j++) {
    const curr = legs[j];
    if (curr.maneuverAtStart !== null) return { distNm, kind: curr.maneuverAtStart };
    if (curr.kind === 'motor' && legs[j - 1].kind === 'sail') return { distNm, kind: 'motor-start' };
    distNm += curr.distanceNm;
  }
  return null;
}

/**
 * Plan ETA (the last leg's endTimeMs) shifted by schedule drift measured at
 * p's projected position on leg i: how far ahead of/behind that leg's own
 * planned timing p currently is. This is a linear projection of the
 * existing plan, never a re-route (spec §2).
 */
export function projectedEtaMs(legs: Leg[], i: number, p: LatLon, nowMs: number): number {
  const leg = legs[i];
  const expectedTimeAtPMs = leg.startTimeMs + clampedFraction(p, leg) * (leg.endTimeMs - leg.startTimeMs);
  const planEtaMs = legs[legs.length - 1].endTimeMs;
  return planEtaMs + (nowMs - expectedTimeAtPMs);
}
