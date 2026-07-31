import type { Leg, Settings } from '../types';
import type { NavMask } from '../lib/mask';
import type { WindField } from '../lib/wind';
import { haversineNm, initialBearingDeg, normalizeDeg180 } from '../lib/geo';
import { boardOf } from './maneuver';

const MAX_MERGE_DEG = 10;

function tryMerge(
  a: Leg,
  b: Leg,
  mask: NavMask,
  wind: WindField,
  s: Settings,
  comfortDepthM: number | undefined,
): Leg | null {
  if (a.kind !== b.kind || a.board !== b.board || b.maneuverAtStart !== null) return null;
  if (Math.abs(normalizeDeg180(a.headingDeg - b.headingDeg)) > MAX_MERGE_DEG) return null;
  // The merged span must itself stay navigable at the gate — unconditional,
  // exactly the pre-#243 check (segmentClearanceM returns null exactly when
  // segmentNavigable would report false; see mask.ts).
  const mergedClearanceM = mask.segmentClearanceM(a.start, b.end, s.safetyDepthM);
  if (mergedClearanceM === null) return null;
  // #243 §D.4: straightening a dogleg can cut a corner neither original leg
  // touched, silently undoing some of the depth comfort preference even
  // though the merge stays gate-valid (a quality gap, not a safety hole — the
  // check above already guarantees the gate). Only enforced when the
  // preference is actually active (comfortDepthM undefined ⇒ byte-identical
  // to the pre-#243 merge, same as everywhere else this feature touches).
  // Comparing against the WORSE (shallower) of the two original legs' own
  // clearances is what "reject a merge that worsens the merged span's
  // clearance" means: a merge that only touches water at least as deep as
  // both legs already crossed is never rejected here, however shallow that
  // floor is.
  if (comfortDepthM !== undefined) {
    const aClearanceM = mask.segmentClearanceM(a.start, a.end, s.safetyDepthM) ?? Infinity;
    const bClearanceM = mask.segmentClearanceM(b.start, b.end, s.safetyDepthM) ?? Infinity;
    if (mergedClearanceM < Math.min(aClearanceM, bClearanceM)) return null;
  }
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
  // #243: same requested-depth-anchored comfort depth planRoute.ts passes to
  // solve() — undefined on the pre-#243 / feature-off / preference-off-tier
  // paths, which keeps this pass byte-identical to before in those cases.
  comfortDepthM?: number,
): Leg[] {
  let out = [...legs];
  let changed = true;
  while (changed) {
    changed = false;
    const next: Leg[] = [];
    for (const leg of out) {
      const prev = next[next.length - 1];
      const merged = prev ? tryMerge(prev, leg, mask, wind, settings, comfortDepthM) : null;
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
