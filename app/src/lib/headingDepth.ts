// #251: the Live view's heading-to-steer is a great-circle bearing to the
// active waypoint, not a depth-validated course. This module answers whether
// that bearing crosses water shallower than the plan's safety depth, as a
// three-valued result so "we could not check" is never mistaken for "clear".
import type { LatLon, Leg, MaskMeta } from '../types';
import type { NavMask } from './mask';

// `state` stays the three-valued vocabulary of spec §2. `caution`
// additionally names WHICH hazard was found, because the mask encodes land and
// shallow water in the same byte range and they are not the same warning (see
// checkHeadingDepth below).
export type HeadingDepthCheck =
  | { state: 'clear' }
  | { state: 'caution'; hazard: 'shallow'; shallowestM: number }
  | { state: 'caution'; hazard: 'land' }
  | { state: 'unavailable' };

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
  if (shallowestM === null) return { state: 'clear' };
  // A LAND cell is byte 0, and byte 0 is the ONLY byte NavMask.byteToDepthM
  // maps to 0.0 m (byte 1 already decodes to 0.1 m). So `shallowestM === 0` is
  // an exact test for "the bearing crosses charted land", not a heuristic on a
  // rounded depth. Land is reported as its own hazard rather than as a
  // "crosses 0.0 m" sounding: dressing land up as a depth reading understates
  // it, and 0.0 m is not a depth anyone can compare against a safety depth.
  // Land also wins over any shallow cell on the same bearing — it is both the
  // more severe hazard and the value the minimum already collapsed to.
  if (shallowestM === 0) return { state: 'caution', hazard: 'land' };
  return { state: 'caution', hazard: 'shallow', shallowestM };
}

/**
 * How long the probe must read 'clear' before a displayed caution drops.
 * ~5 GPS fixes at the ~1 Hz fix rate. Deliberately asymmetric: a caution
 * appears instantly and leaves slowly, because a missed shallow warning costs
 * more than a redundant one.
 *
 * The `nowMs` callers feed {@link advanceHold} must come from a MONOTONIC
 * source (`performance.now()`), never `Date.now()`: a forward wall-clock jump
 * — an NTP correction, the user setting the clock — would otherwise bank time
 * nobody observed and drop a caution early, which is the unsafe direction.
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
 *
 * `nowMs` must be monotonic — see {@link HEADING_DEPTH_CLEAR_MS}. A monotonic
 * source still advances across a suspended tab or a sleeping device, though,
 * while GPS delivers nothing, so `maxStepMs` additionally caps how much a
 * SINGLE step may bank: a gap longer than the window the run is accruing
 * towards is by definition not evidence of a continuous clear run, so it banks
 * nothing and restarts the step clock. The bound can only ever lengthen a
 * caution, never shorten it.
 */
export function advanceHold(
  prev: HeadingDepthHold,
  raw: HeadingDepthCheck,
  nowMs: number,
  clearMs: number = HEADING_DEPTH_CLEAR_MS,
  maxStepMs: number = clearMs,
): HeadingDepthHold {
  if (raw.state === 'caution') return { shown: raw, clearAccumMs: 0, lastClearMs: null };
  if (prev.shown.state !== 'caution') return { shown: raw, clearAccumMs: 0, lastClearMs: null };
  if (raw.state === 'unavailable') return { ...prev, lastClearMs: null };
  const stepMs = prev.lastClearMs === null ? 0 : nowMs - prev.lastClearMs;
  if (stepMs > maxStepMs) return { ...prev, lastClearMs: nowMs };
  const accum = prev.clearAccumMs + stepMs;
  if (accum >= clearMs) return { shown: raw, clearAccumMs: 0, lastClearMs: null };
  return { shown: prev.shown, clearAccumMs: accum, lastClearMs: nowMs };
}
