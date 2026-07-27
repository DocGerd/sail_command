import { normalizeDeg180 } from './geo';
import { OWNSHIP_VECTOR_MIN_SOG_KN } from './ownshipVector';
import type { MsgKey } from '../i18n/dict.de';

/**
 * #155: the pure half of the map-chrome pair — the north-arrow/track-up state
 * machine and the scale-bar rung picker. Everything here is a total function
 * of its arguments (no map, no DOM, no React), so the components can stay thin
 * imperative shells and the interesting behaviour is unit-testable.
 */

// ---------------------------------------------------------------- orientation

/**
 * `north` — bearing pinned to 0. `track` — the camera follows ownship COG.
 * `free` — the user rotated the map by hand and owns the bearing until they
 * tap the compass (the chart-plotter convention).
 *
 * Session-only by design (issue #155 decision 3): a reload always starts
 * north-up, which keeps a cold start deterministic for the user and for the
 * e2e canvas baselines.
 */
export type OrientationMode = 'north' | 'track' | 'free';

/**
 * What the compass button paints and reports through `data-orientation`.
 * `track-up-stale` is still `track` mode — the last bearing is being HELD
 * because the fix went away (decision 1: a boat head-to-wind must not spin
 * the chart), and the dimmed ring is what makes that honest.
 */
export type OrientationVisual = 'north-up' | 'track-up' | 'track-up-stale' | 'free';

/**
 * `reject` is NOT a no-op: the caller pulses the button and pushes a
 * screen-reader status (decision 4). The button is never greyed out — a dead
 * control on a chart reads as broken.
 */
export type OrientationAction = 'ease-north' | 'ease-track' | 'reject';

/** Fix loss / at-rest grace before the held-bearing ring dims. */
export const ORIENTATION_STALE_MS = 5_000;

/** Compass reset-to-north camera ease. */
export const EASE_NORTH_MS = 600;

/**
 * Track-up follow ease. Deliberately just under the 1 Hz GPS publish cadence
 * so consecutive eases chain into continuous motion instead of stepping.
 */
export const EASE_TRACK_MS = 900;

/**
 * Shortest-path bearing change below which a track-up follow is skipped —
 * consumer GPS jitters COG by a degree or two at low SOG, and re-easing the
 * whole chart on that noise is both ugly and pointless.
 */
export const TRACK_DEADBAND_DEG = 2;

/** Widened deadband under `prefers-reduced-motion` (fewer camera jumps). */
export const TRACK_DEADBAND_REDUCED_DEG = 5;

/**
 * In `free`, a hand rotation that lands within this many degrees of north
 * snaps the rest of the way on rotateend — the affordance every chart plotter
 * has, and the only way a gesture user gets back to an exact 0 bearing.
 */
export const FREE_SNAP_NORTH_DEG = 1;

/** How long the ineligible-tap status stays in the live region. */
export const COMPASS_STATUS_MS = 3_000;

/**
 * Stable `easeId` for every camera ease the compass owns, so MapLibre
 * suppresses the interrupted ease's rotateend/moveend when one compass ease
 * replaces another. See CompassControl's `easeBearing` for why this is
 * correctness rather than tidiness.
 */
export const COMPASS_EASE_ID = 'sc-compass';

/**
 * Tolerance for "the camera actually is where the compass says it is" (#203).
 *
 * MapLibre's ease lands exactly on the requested bearing (`easeFunc(1)` writes
 * the target verbatim), so this is a float-noise / wrap-around margin, not a
 * behavioural knob. Kept well BELOW `FREE_SNAP_NORTH_DEG` so the two
 * thresholds can never disagree about a bearing: anything the snap affordance
 * treats as "near enough to north to pull home" is still a bearing the
 * reconciler regards as NOT north-up until the snap ease has run.
 */
export const BEARING_MATCH_DEG = 0.5;

/** True when the camera sits on `targetDeg` (shortest-path, wrap-safe). */
export function bearingReached(actualDeg: number, targetDeg: number): boolean {
  return Math.abs(normalizeDeg180(targetDeg - actualDeg)) <= BEARING_MATCH_DEG;
}

/**
 * Tap transition table (issue #155, "Interaction rules"), extended in #203 by
 * the camera-truth guard on the `north` row. Exhaustive over
 * `mode` x `trackAvailable` x `assertedBearingDeg is north`:
 *
 *   north + at north + available   -> track, ease to COG
 *   north + at north + unavailable -> north, reject (pulse + SR status; camera
 *                                     untouched)
 *   north + NOT at north + *       -> north, ease to 0
 *   track + *                      -> north, ease to 0   (track-up is a toggle,
 *                                     and a stale/held track must stay escapable)
 *   free  + *                      -> north, ease to 0   (reset-north is what the
 *                                     button means while the user owns the bearing)
 *
 * `assertedBearingDeg` is the bearing the compass currently CLAIMS: its
 * outstanding ease target while one is in force, otherwise the live camera
 * bearing. The `north + NOT at north` row exists because #203 made `reject` an
 * absorbing dead end — an aborted reset-north left mode `north` with the chart
 * at, say, 40 degrees, and with no GPS the next tap rejected instead of
 * re-asserting, so the control refused to correct an orientation it was itself
 * mis-reporting. `north` is now the one mode whose action depends on the
 * camera: tapping it always reaches, or re-reaches, bearing 0.
 */
export function nextOrientation(
  mode: OrientationMode,
  trackAvailable: boolean,
  assertedBearingDeg: number,
): { mode: OrientationMode; action: OrientationAction } {
  if (mode === 'north') {
    if (!bearingReached(assertedBearingDeg, 0)) return { mode: 'north', action: 'ease-north' };
    return trackAvailable
      ? { mode: 'track', action: 'ease-track' }
      : { mode: 'north', action: 'reject' };
  }
  return { mode: 'north', action: 'ease-north' };
}

export function orientationVisual(mode: OrientationMode, stale: boolean): OrientationVisual {
  switch (mode) {
    case 'north':
      return 'north-up';
    case 'free':
      return 'free';
    case 'track':
      return stale ? 'track-up-stale' : 'track-up';
  }
}

/**
 * One aria-label per visual state; the label carries the state AND the action,
 * so no `aria-pressed` (a tri-state cycle is not a binary toggle). North-up
 * splits on availability so the user is told *why* course-up won't engage
 * before they tap. Degrees never appear in any of these strings.
 */
export function compassLabelKey(visual: OrientationVisual, trackAvailable: boolean): MsgKey {
  switch (visual) {
    case 'north-up':
      return trackAvailable ? 'map.compass.northUp' : 'map.compass.northUp.noTrack';
    case 'track-up':
      return 'map.compass.trackUp';
    case 'track-up-stale':
      return 'map.compass.trackUp.stale';
    case 'free':
      return 'map.compass.free';
  }
}

/**
 * Track-up eligibility. COG ONLY — `headingToSteerDeg` is a PLAN value (what
 * the router says you should steer), not a live heading, and must never steer
 * the chart. The SOG floor is imported from #141's ownship projection vector
 * rather than re-typed, so the "is the boat actually moving" threshold has
 * exactly one definition in the app.
 */
export function trackUpAvailable(
  showOwnship: boolean,
  fix: { cogDeg: number | null; sogKn: number | null } | null,
): boolean {
  return (
    showOwnship &&
    fix !== null &&
    fix.cogDeg !== null &&
    fix.sogKn !== null &&
    fix.sogKn >= OWNSHIP_VECTOR_MIN_SOG_KN
  );
}

/** True when the shortest-path turn from `bearingDeg` to `cogDeg` clears the deadband. */
export function shouldEaseToCourse(
  bearingDeg: number,
  cogDeg: number,
  deadbandDeg: number,
): boolean {
  return Math.abs(normalizeDeg180(cogDeg - bearingDeg)) >= deadbandDeg;
}

/** True when a hand-rotated bearing is close enough to north to snap the rest of the way. */
export function shouldSnapNorth(bearingDeg: number): boolean {
  return Math.abs(normalizeDeg180(bearingDeg)) <= FREE_SNAP_NORTH_DEG;
}

// ----------------------------------------------------------------- scale bar

/** Screen span the bar is measured against; the drawn bar is 40–100 px of it. */
export const SCALE_SAMPLE_PX = 100;

/**
 * The map's maximum zoom — MapLibre's own default, stated explicitly here and
 * passed to the Map constructor (MapView.tsx) rather than inherited, because
 * the scale bar's "every rung is an integer" property depends on it.
 *
 * The metre branch feeds `niceStep(maxNm * 1852)`; once that argument falls
 * below 1 the ladder starts returning 0.5 / 0.2 / 0.1, and ScaleBar renders
 * the magnitude with no decimal formatting and no locale separator — a German
 * UI that writes "0,5" everywhere else would print "0.5 m". At 54.85°N the
 * 100 px reference spans 1.074 m at z=22 (rung 1 m, ~7% of headroom) and drops
 * under 1 m at about z=22.1.
 *
 * So: raising this is not a free change. The property test sweeps up to this
 * constant and asserts integrality, so a bump to 23 fails the suite loudly
 * instead of silently producing a fractional label.
 */
export const MAP_MAX_ZOOM = 22;

/** Above this fraction of the viewport, a docked Live readout suppresses the bar entirely. */
export const SCALE_LIFT_MAX_VIEWPORT_FRACTION = 0.4;

/**
 * Breathing space between a docked Live readout's top edge and the lifted
 * scale bar. NAMED COUPLING: mirrors the `0.5rem` in `.scale-bar`'s stylesheet
 * offset (app.css) — a lifted bar replaces that offset wholesale.
 */
export const SCALE_LIFT_GAP_PX = 8;

const METRES_PER_NM = 1852;
const CABLES_PER_NM = 10;

export type ScaleUnit = 'nm' | 'cbl' | 'm';

export interface ScaleBarStep {
  /** Unit the bar is LABELLED in. */
  unit: ScaleUnit;
  /** Rung magnitude in `unit` — an integer everywhere the app can be zoomed. */
  value: number;
  /** The same rung in nautical miles: the bar's true ground length. */
  nm: number;
  /** Drawn bar length in CSS px. */
  widthPx: number;
}

/**
 * Largest 1-2-5-per-decade value <= `value` (`value` must be finite and > 0).
 *
 * `toPrecision(1)` is not cosmetic: `5 * 0.01` and friends land on doubles a
 * decimal digit away from the intended rung, which would leak into both the
 * label and the pinned test literals. Every rung has exactly one significant
 * digit, so rounding to it is lossless.
 */
function niceStep(value: number): number {
  let decade = Math.pow(10, Math.floor(Math.log10(value)));
  let mantissa = value / decade;
  // Guards against Math.log10 landing a hair either side of an exact decade.
  if (mantissa >= 10) {
    mantissa /= 10;
    decade *= 10;
  }
  if (mantissa < 1) {
    mantissa *= 10;
    decade /= 10;
  }
  const m = mantissa >= 5 ? 5 : mantissa >= 2 ? 2 : 1;
  return Number((m * decade).toPrecision(1));
}

/**
 * Picks the scale-bar rung for a viewport in which `SCALE_SAMPLE_PX` spans
 * `maxNm` of ground, and returns the bar geometry to draw.
 *
 * DELIBERATE, OWNER-APPROVED DEVIATION from the #155 design proposal (see the
 * issue comment recording it). The proposal pinned a fixed NM ladder
 * `[0.05 … 100]`; at 54.85°N a MapLibre (512 px tile) zoom above ~15.6 puts
 * 100 px below 0.05 NM, so the ladder ran out of rungs at ordinary
 * harbour-approach zoom and had no defined answer — the #36 failure class, a
 * design that only breaks at the zoom nobody sketched at. The fix is to pick
 * the rung IN THE UNIT THAT WILL BE LABELLED rather than converting an NM rung
 * into something else (0.05 NM converted is "93 m", which is not a scale bar):
 *
 *   maxNm >= 1     -> nautical miles, 1-2-5 ladder (1, 2, 5, 10, 20, 50, 100 …)
 *   0.1 <= maxNm<1 -> cables (1 cbl = 1/10 NM); rungs 1/2/5 cbl are exactly the
 *                     proposal's 0.1/0.2/0.5 NM rungs, so this branch adds no
 *                     new rung math
 *   maxNm < 0.1    -> metres, 1-2-5 ladder over maxNm * 1852
 *
 * The NM branch reproduces the approved ladder exactly wherever the approved
 * ladder was defined. Every rung in every branch is an INTEGER across the
 * app's whole reachable zoom range, so the label never needs decimal
 * formatting. `widthPx` is always within [40, 100] by construction (adjacent
 * 1-2-5 rungs are at most 2.5x apart, so the worst ratio is just over 0.4).
 *
 * Returns null for a degenerate viewport (non-finite or non-positive span) so
 * a NaN can never reach the DOM; the caller simply keeps the previous bar.
 */
export function pickScaleBar(maxNm: number, samplePx: number): ScaleBarStep | null {
  if (!Number.isFinite(maxNm) || maxNm <= 0) return null;
  if (!Number.isFinite(samplePx) || samplePx <= 0) return null;

  let unit: ScaleUnit;
  let value: number;
  let nm: number;
  if (maxNm >= 1) {
    unit = 'nm';
    value = niceStep(maxNm);
    nm = value;
  } else if (maxNm >= 0.1) {
    unit = 'cbl';
    value = niceStep(maxNm * CABLES_PER_NM);
    nm = value / CABLES_PER_NM;
  } else {
    unit = 'm';
    value = niceStep(maxNm * METRES_PER_NM);
    nm = value / METRES_PER_NM;
  }
  return { unit, value, nm, widthPx: (nm / maxNm) * samplePx };
}

/** Visible abbreviation (de `sm`/`kbl`/`m`, en `NM`/`cbl`/`m`). */
export function scaleUnitAbbrevKey(unit: ScaleUnit): MsgKey {
  switch (unit) {
    case 'nm':
      return 'map.scale.unit.nm';
    case 'cbl':
      return 'map.scale.unit.cbl';
    case 'm':
      return 'map.scale.unit.m';
  }
}

/**
 * FULL unit word for the aria-label — screen readers mangle "cbl"/"sm". Split
 * singular/plural because rung 1 is reachable in all three units.
 */
export function scaleUnitWordKey(unit: ScaleUnit, value: number): MsgKey {
  const one = value === 1;
  switch (unit) {
    case 'nm':
      return one ? 'map.scale.unit.nm.one' : 'map.scale.unit.nm.other';
    case 'cbl':
      return one ? 'map.scale.unit.cbl.one' : 'map.scale.unit.cbl.other';
    case 'm':
      return one ? 'map.scale.unit.m.one' : 'map.scale.unit.m.other';
  }
}
