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

/**
 * How long the probe must read 'clear' before a displayed caution drops.
 * ~5 GPS fixes at the ~1 Hz fix rate. Deliberately asymmetric: a caution
 * appears instantly and leaves slowly, because a missed shallow warning costs
 * more than a redundant one.
 */
export const HEADING_DEPTH_CLEAR_MS = 5000;

export interface HeadingDepthHold {
  shown: HeadingDepthCheck;
  /** Cumulative time the probe has read 'clear' while a caution is displayed. */
  clearAccumMs: number;
  /** Timestamp of the previous 'clear' observation, or null if the run is broken. */
  lastClearMs: number | null;
}

export function initialHold(): HeadingDepthHold {
  return { shown: { state: 'unavailable' }, clearAccumMs: 0, lastClearMs: null };
}

/**
 * Fold one probe result into the displayed state.
 *
 * 'unavailable' is deliberately NOT treated as evidence the hazard is gone: it
 * holds the caution and breaks the accrual run without discarding the time
 * already banked, so an asset failure can never time out a warning.
 */
export function advanceHold(
  prev: HeadingDepthHold,
  raw: HeadingDepthCheck,
  nowMs: number,
  clearMs: number = HEADING_DEPTH_CLEAR_MS,
): HeadingDepthHold {
  if (raw.state === 'caution') return { shown: raw, clearAccumMs: 0, lastClearMs: null };
  if (prev.shown.state !== 'caution') return { shown: raw, clearAccumMs: 0, lastClearMs: null };
  if (raw.state === 'unavailable') return { ...prev, lastClearMs: null };
  const accum = prev.clearAccumMs + (prev.lastClearMs === null ? 0 : nowMs - prev.lastClearMs);
  if (accum >= clearMs) return { shown: raw, clearAccumMs: 0, lastClearMs: null };
  return { shown: prev.shown, clearAccumMs: accum, lastClearMs: nowMs };
}
