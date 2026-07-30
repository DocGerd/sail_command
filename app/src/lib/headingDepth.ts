// #251: the Live view's heading-to-steer is a great-circle bearing to the
// active waypoint, not a depth-validated course. This module answers whether
// that bearing crosses water shallower than the plan's safety depth, as a
// three-valued result so "we could not check" is never mistaken for "clear".
import type { LatLon, Leg, MaskMeta } from '../types';
import type { NavMask } from './mask';

export type HeadingDepthCheck =
  { state: 'clear' } | { state: 'caution'; shallowestM: number } | { state: 'unavailable' };

// The mask is a lat/lon rectangle (MaskMeta west/south/east/north), so testing
// both endpoints is enough to know the whole segment stays inside coverage.
// Upper bounds are exclusive, matching NavMask.cellOf's row/col range check.
function withinMask(meta: MaskMeta, p: LatLon): boolean {
  return p.lat >= meta.south && p.lat < meta.north && p.lon >= meta.west && p.lon < meta.east;
}

/**
 * Whether the straight line from `p` to the active leg's end crosses water
 * charted below `safetyDepthM`.
 *
 * The coverage check is NOT redundant: NavMask.segmentShallowestBelow returns
 * null both when nothing is shallow AND when the walk leaves the grid, so it
 * cannot tell "clear" from "could not check". Testing the endpoints first is
 * what makes a subsequent null trustworthy as 'clear'.
 */
export function checkHeadingDepth(
  mask: NavMask | null,
  legs: Leg[],
  legIndex: number,
  p: LatLon,
  safetyDepthM: number,
): HeadingDepthCheck {
  if (!mask) return { state: 'unavailable' };
  const leg = legs[legIndex];
  if (!leg) return { state: 'unavailable' };
  if (!withinMask(mask.meta, p) || !withinMask(mask.meta, leg.end)) return { state: 'unavailable' };
  const shallowestM = mask.segmentShallowestBelow(p, leg.end, safetyDepthM);
  return shallowestM === null ? { state: 'clear' } : { state: 'caution', shallowestM };
}

/**
 * Identity of the mask cell containing `p`, for memoising the probe: a boat
 * that has not left its cell cannot have changed the answer. Returns a stable
 * string; points outside coverage collapse to a single 'out' key, which is
 * correct because they all yield 'unavailable'.
 */
export function maskCellKey(meta: MaskMeta, p: LatLon): string {
  if (!withinMask(meta, p)) return 'out';
  const row = Math.floor(((p.lat - meta.south) / (meta.north - meta.south)) * meta.rows);
  const col = Math.floor(((p.lon - meta.west) / (meta.east - meta.west)) * meta.cols);
  return `${row}:${col}`;
}
