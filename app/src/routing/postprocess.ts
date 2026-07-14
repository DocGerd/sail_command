import type { Leg, Settings } from '../types';
import type { NavMask } from '../lib/mask';
import type { WindField } from '../lib/wind';
import { haversineNm, initialBearingDeg, normalizeDeg180 } from '../lib/geo';
import { boardOf } from './maneuver';

const MAX_MERGE_DEG = 10;

function tryMerge(a: Leg, b: Leg, mask: NavMask, wind: WindField, s: Settings): Leg | null {
  if (a.kind !== b.kind || a.board !== b.board || b.maneuverAtStart !== null) return null;
  if (Math.abs(normalizeDeg180(a.headingDeg - b.headingDeg)) > MAX_MERGE_DEG) return null;
  if (!mask.segmentNavigable(a.start, b.end, s.safetyDepthM)) return null;
  const headingDeg = initialBearingDeg(a.start, b.end);
  if (a.kind === 'sail') {
    const w = wind.sample(b.start, b.startTimeMs); // wind at the joint
    const twa = normalizeDeg180(w.dirFromDeg - headingDeg);
    if (a.board && boardOf(twa) !== a.board) return null; // merged course would flip the board
  }
  const distanceNm = haversineNm(a.start, b.end);
  return {
    ...a,
    end: b.end,
    endTimeMs: b.endTimeMs,
    headingDeg,
    distanceNm,
    speedKn: distanceNm / Math.max((b.endTimeMs - a.startTimeMs) / 3_600_000, 1e-9),
  };
}

export function mergeCollinearLegs(
  legs: Leg[],
  mask: NavMask,
  wind: WindField,
  settings: Settings,
): Leg[] {
  let out = [...legs];
  let changed = true;
  while (changed) {
    changed = false;
    const next: Leg[] = [];
    for (const leg of out) {
      const prev = next[next.length - 1];
      const merged = prev ? tryMerge(prev, leg, mask, wind, settings) : null;
      if (merged) {
        next[next.length - 1] = merged;
        changed = true;
      } else {
        next.push(leg);
      }
    }
    out = next;
  }
  return out;
}
