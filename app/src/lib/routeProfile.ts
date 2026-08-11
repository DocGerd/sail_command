// Pure sampling + tick helpers for the route depth-over-time profile (#45).
// No React, no MapLibre, no canvas — jsdom-safe and unit-testable. Depth comes
// from the intact main-thread mask (NavMask.depthInfoM, a read-only view over
// the cached buffer); wind and the safety-depth overlay are layered on by the
// DepthProfile component, never baked into these samples (the profile stores
// absolute depth; the safety line is a render-time overlay).
import type { LatLon, Leg, MaskMeta } from '../types';
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

// Mirrors lib/headingDepth.ts's private withinMask: the mask is a lat/lon
// rectangle (MaskMeta west/south/east/north), so testing both endpoints is
// enough to know the whole segment stays inside coverage. Upper bounds are
// exclusive, matching NavMask.cellOf's row/col range check. Duplicated
// (rather than imported/exported from headingDepth.ts) to keep this fix's
// diff inside routeProfile.ts/mask.ts — headingDepth.ts is a different
// feature (#251's Live heading-to-steer check) with its own review surface.
function withinMask(meta: MaskMeta, p: LatLon): boolean {
  return p.lat >= meta.south && p.lat < meta.north && p.lon >= meta.west && p.lon < meta.east;
}

/**
 * #505: the depth-profile's headline "min." figure, computed EXHAUSTIVELY
 * over every leg's actual geometry via NavMask.segmentMinDepthInfoM — the
 * same Amanatides–Woo cell walk planRoute.ts's flagShallowLegs uses to build
 * the shallow-water banner's minGateDepthM — rather than from
 * {@link profileSamples}' uniform-in-TIME series. That series is sized for
 * chart rendering (60-240 points across the whole trip) and can step clean
 * over a leg shorter than the sample interval, understating the true
 * minimum depth; this cannot, because it visits every cell every leg
 * touches. The plotted CURVE keeps using the sparse series unchanged — this
 * only replaces the single scalar headline figure.
 *
 * This is NOT expected to always equal the shallow-water banner's
 * minGateDepthM: planRoute.ts's flagShallowLegs folds minGateDepthM over
 * BOTH rigs' legs and only counts cells charted below the plan's REQUESTED
 * safety depth (see app/src/i18n/dict.en.ts's route.shallow.detail comment),
 * while this is the ACTIVE rig's own true minimum with no threshold at all.
 * What this closes is the SAMPLING gap the issue is about — a short leg the
 * two figures could disagree over only because one of them skipped it — not
 * that scope difference, which is a separate, already-documented and
 * deliberate #452 design choice.
 *
 * Per #251/#255, `segmentMinDepthInfoM`'s null return must not be trusted
 * without first bound-checking both of a leg's endpoints against
 * `mask.meta` — so a leg whose endpoints fail that check (or whose walk
 * still returns null) makes this return null for the WHOLE route rather
 * than silently omitting just that leg's contribution: an omitted leg could
 * have been the true minimum, and a headline reading deeper than the true
 * minimum is the unsafe direction for a safety figure. Callers should fall
 * back to a less precise minimum (e.g. the sparse sample series) when this
 * returns null.
 */
export function exhaustiveMinDepth(
  legs: Leg[],
  mask: NavMask,
): { depthM: number; capped: boolean } | null {
  let min: { depthM: number; capped: boolean } | null = null;
  for (const leg of legs) {
    if (!withinMask(mask.meta, leg.start) || !withinMask(mask.meta, leg.end)) return null;
    const info = mask.segmentMinDepthInfoM(leg.start, leg.end);
    if (info === null) return null;
    if (min === null || info.depthM < min.depthM) min = info;
  }
  return min;
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
 * Alignment is to the interval in epoch ms, so in any whole-hour-offset
 * timezone (incl. the target region's CET/CEST) labels land on clean HH:mm
 * boundaries (00/30 for 30 min, whole hours otherwise). Under a fractional
 * offset (e.g. UTC+5:30) an hourly tick would render :30 instead — the ticks
 * still coincide with the map ETA labels regardless of offset, which is the
 * property a skipper cross-references.
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
