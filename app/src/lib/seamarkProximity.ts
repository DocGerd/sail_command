// #615: the advisory seamark-proximity count — how many DISTINCT cardinal or
// isolated-danger marks the active rig's route passes closer than
// SEAMARK_PROXIMITY_M to. PRESENTATION-ONLY, deliberately, and the same shape
// as MarginalDepthNotice (RouteSummary.tsx) + lib/shallowExposure.ts:
// recomputed at render from the plan's own legs and the already-loaded
// `assets.seamarks`, so `PlanResult` gains no field, `types.ts` and
// `routing/**` are untouched, the plan's bytes are identical and NO #282
// acceptance sweep is owed. geo.ts's primitives are IMPORTED, never
// extended: `lib/geo.ts` is inside the sweep's import closure
// (sweepArms.ts -> lib/mask.ts -> lib/geo.ts), so adding the segment helper
// THERE would flip the closure verdict to OWED for a purely presentational
// change. Decision record: docs/spikes/615-seamark-proximity.md.
//
// The route/mark relationship it reports is GEOMETRY ONLY. Nothing here reads
// a cardinal's named quadrant or an isolated-danger mark's extent, and
// nothing downstream may: which side of a mark to pass is a chart question,
// and this app claims no chart authority (#495 option 1 stays open, tracking
// seamarks as a routing input; this is #495 option 2 alone).
import { alongTrackFraction, crossTrackNm, haversineNm } from './geo';
import type { SeamarkFeatureCollection } from './seamarkGeoJson';
import { isHazardSeamark } from './seamarkGlyphs';
import type { LatLon, Leg } from '../types';

const M_PER_NM = 1852;

/**
 * The proximity threshold, in metres. A maintainer JUDGEMENT CALL (ratified
 * 2026-09-02 on the #615 design brief), in the sense panelWidth.ts's
 * PANEL_MAP_RESERVE_PX names: not derived from any measured layout or data
 * constant, and labelled so a future reader does not mistake it for one.
 *
 * What chose it, method and aperture stated: four routes solved against the
 * real committed mask.bin / mask.meta.json / Salona-45 polars at
 * DEFAULT_SETTINGS, `uniformWindGrid(12, 225)`, departure
 * `Date.UTC(2026, 6, 15, 6, 0, 0)` — sweepArms.ts's exact PlanDeps/
 * PlanRequest construction — then, per route, the count of hazard marks
 * (isHazardSeamark: cardinal + isolatedDanger, 127 of the 1794 shipped
 * features) whose point-to-segment distance to any leg of the recommended
 * rig fell under each candidate:
 *
 *   route                    50 m  100 m  200 m  300 m  500 m
 *   flensburg->soenderborg      0      0      0      1      4
 *   flensburg->marstal          1      1      3      3      4
 *   flensburg->bagenkop         0      2      3      3      4
 *   marstal->svendborg          2      3      3      5      8
 *   routes firing             2/4    3/4    3/4    4/4    4/4
 *
 * 300 m is the smallest value that fires on all four (1-5 marks each — a
 * one-line count, not a list), ≈0.16 nm, ≈6.5 of the mask's ~46 m cells,
 * and it catches both of #495's measured passes (37 m and 174 m). 50 m and
 * 100 m are at or near one mask cell and assert a positional precision the
 * merged isochrone-chord polyline does not have; 200 m leaves
 * flensburg->soenderborg silent while it passes five cardinals inside 1 km
 * (nearest 269 m). APERTURE: four Flensburg-/Marstal-origin routes. The
 * 33-harbour scan that widened it is recorded in the PR body for #615's
 * implementation and in the spike doc, not here — a number in a comment is a
 * claim, and the scan is the evidence.
 *
 * Interpolated into the copy as `{dist}` (route.seamarks.proximity in both
 * dicts) — the dict never types the number, so copy and constant cannot
 * drift apart silently.
 */
export const SEAMARK_PROXIMITY_M = 300;

/**
 * Great-circle distance in METRES from `p` to the segment a->b, endpoint-
 * clamped: the along-track projection decides which of the three regimes
 * applies (before a, between, past b), exactly the shape the #615 research
 * control proved 10/10 against constructed offsets. A zero-length segment
 * degrades to the plain point distance (alongTrackFraction returns 0 there,
 * so the `f <= 0` branch would already catch it — the explicit guard just
 * makes the degenerate case readable).
 */
export function pointToSegmentM(p: LatLon, a: LatLon, b: LatLon): number {
  if (haversineNm(a, b) === 0) return haversineNm(p, a) * M_PER_NM;
  const f = alongTrackFraction(p, a, b);
  if (f <= 0) return haversineNm(p, a) * M_PER_NM;
  if (f >= 1) return haversineNm(p, b) * M_PER_NM;
  return Math.abs(crossTrackNm(p, a, b)) * M_PER_NM;
}

/**
 * The hazard population: every Point feature `isHazardSeamark` admits
 * (seamarkGlyphs.ts's single definition of the two families — never
 * re-enumerated here, so the notice and the map's `sc-seamarks-hazard`
 * layer agree by construction), deduplicated by EXACT coordinate. Measured
 * on the shipped seamarks.json: one cardinal pair shares identical
 * coordinates, which the user sees as ONE symbol — an undeduplicated count
 * would say "2 marks" for it. Malformed features (non-Point, short or
 * non-numeric coordinates) are skipped, never thrown on: this is an
 * advisory nudge and fails OPEN to "not counted", per the guard-asymmetry
 * rule.
 */
function hazardMarkPoints(seamarks: SeamarkFeatureCollection): LatLon[] {
  const seen = new Set<string>();
  const out: LatLon[] = [];
  for (const f of seamarks.features) {
    if (!f?.properties || !isHazardSeamark(f.properties)) continue;
    const g = f.geometry as { type?: unknown; coordinates?: unknown } | null | undefined;
    if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) {
      continue;
    }
    const [lon, lat] = g.coordinates as unknown[];
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const key = `${lon},${lat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lat, lon });
  }
  return out;
}

/**
 * How many DISTINCT hazard marks lie closer than `thresholdM` to ANY leg of
 * `legs` — the number the results-panel notice states. "Closer than" is a
 * strict `<`, matching the copy's own upper-bound phrasing ("closer than
 * {dist} m"); a mark at exactly the threshold is not counted.
 *
 * Cost is O(marks × legs) with no spatial index — measured in the #615
 * research at 1-20 ms naive for 14-400 legs over the 127-mark population,
 * paid once per plan render behind a useMemo. The per-pair early-out below
 * is the only pruning, and it is EXACT: great-circle distance is a metric,
 * so for every point q on the segment d(m, q) >= d(m, start) - d(start, q)
 * >= d(m, start) - chord; a mark whose distance to the leg START exceeds
 * threshold + chord therefore cannot be within threshold of the leg. Nothing
 * about latitude, degrees or projection is assumed.
 */
export function nearbyHazardMarkCount(
  legs: readonly Leg[],
  seamarks: SeamarkFeatureCollection,
  thresholdM: number = SEAMARK_PROXIMITY_M,
): number {
  if (legs.length === 0) return 0;
  const marks = hazardMarkPoints(seamarks);
  if (marks.length === 0) return 0;
  const chordsM = legs.map((leg) => haversineNm(leg.start, leg.end) * M_PER_NM);
  let count = 0;
  for (const m of marks) {
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;
      if (haversineNm(m, leg.start) * M_PER_NM - chordsM[i]! > thresholdM) continue;
      if (pointToSegmentM(m, leg.start, leg.end) < thresholdM) {
        count++;
        break;
      }
    }
  }
  return count;
}
