// #830: the viewport filter behind the keyboard-reachable "seamarks in
// view" list (components/SeamarksInView.tsx) — a keyboard user's DOM
// equivalent of DataLayers.tsx's pointer-only seamark click (WCAG 2.1.1).
// PRESENTATION-ONLY, the same shape as lib/seamarkProximity.ts (#615):
// recomputed at render from the already-loaded `assets.seamarks` collection
// (state/useSeamarks.ts — the fetch-once singleton, never a second loader)
// and the map's own current bounds, so `PlanResult`, `types.ts` and
// `routing/**` are untouched and NO #282 acceptance sweep is owed.
//
// The population is deliberately VIEWPORT-BOUNDED, mirroring what a sighted
// mouse user can actually click: the #714 spike rejected a region-wide list
// (1,794 features in the shipped seamarks.json) on scale and on fidelity.
// What it does NOT mirror is MapLibre's z<12 collision culling — a mark the
// map culled for lack of screen room is still listed here. That is the safe
// direction (a keyboard user gets a SUPERSET of what the mouse user sees,
// never a subset), and it is why the list needs a cap rather than trusting
// the renderer to have thinned the set already.
import { haversineNm } from './geo';
import type { SeamarkFeatureCollection } from './seamarkGeoJson';
import { seamarkDisplayTier, type SeamarkDisplayTier } from './seamarkGlyphs';
import type { SeamarkProperties } from '../types';

/** The map's current view: bounds as MapLibre's `getBounds()` reports them
 * (west/east may exceed ±180 or wrap at low zoom) plus the centre the list
 * sorts around. state/useMapViewport.ts produces it, settle-gated. */
export interface ViewportBounds {
  west: number;
  south: number;
  east: number;
  north: number;
  centerLon: number;
  centerLat: number;
}

export interface SeamarkInView {
  /** Stable identity: the feature's index in the shipped collection (a
   * fetch-once singleton, so the index survives every viewport change). Two
   * shipped cardinals share one coordinate pair (#615), so coordinates alone
   * could not key a row. */
  key: string;
  props: SeamarkProperties;
  lon: number;
  lat: number;
  /** Great-circle distance from the map centre — the sort key. */
  distanceNm: number;
}

export interface SeamarksInViewResult {
  /** At most `max` marks, nearest to the map centre first. */
  marks: SeamarkInView[];
  /** Every mark in view, before the cap — what the summary count states. */
  total: number;
}

/**
 * The row cap. A maintainer JUDGEMENT CALL in the sense panelWidth.ts's
 * PANEL_MAP_RESERVE_PX names — not derived from a measurement. At the
 * start zoom (z9 over the fjord) a phone viewport already holds well over
 * a hundred of the 1,794 shipped marks; a flat list that long is not a
 * usable keyboard surface at any viewport this app targets (down to 280px),
 * and the copy tells the user to zoom in for the rest
 * (`seamarks.inView.truncated`). Interpolated into that copy as `{shown}`
 * so constant and sentence cannot drift apart.
 */
export const SEAMARKS_IN_VIEW_MAX = 50;

// MapLibre's bounds can span more than the whole world at very low zoom
// (`east - west >= 360`) or wrap across the antimeridian (`west > east`);
// neither happens over the Flensburg Fjord at the zooms this app is used
// at, but a filter that silently listed NOTHING in either case would be a
// wrong answer with no visible failure, so both are handled explicitly.
function lonInRange(lon: number, west: number, east: number): boolean {
  if (east - west >= 360) return true;
  if (west <= east) return lon >= west && lon <= east;
  return lon >= west || lon <= east;
}

/**
 * Every well-formed Point feature inside `viewport` that the map's own
 * display-tier cut would show at `selectedTier` (the same cumulative
 * `seamarkDisplayTier(props) <= tier` test seamarkGeoJson.ts's
 * `seamarkDisplayTierExpression` applies as a layer filter — one
 * definition, never re-enumerated), nearest to the map centre first,
 * capped at `max` with `total` still counting the whole in-view set.
 *
 * Malformed features (non-Point, short or non-numeric coordinates, a
 * missing `seamarkType`) are skipped, never thrown on — same fail-open
 * treatment as seamarkProximity.ts's `hazardMarkPoints`: this is a list, a
 * bad feature costs one missing row, not a crashed panel.
 */
export function seamarksInView(
  seamarks: SeamarkFeatureCollection,
  viewport: ViewportBounds,
  selectedTier: SeamarkDisplayTier,
  max: number = SEAMARKS_IN_VIEW_MAX,
): SeamarksInViewResult {
  const centre = { lat: viewport.centerLat, lon: viewport.centerLon };
  const inView: SeamarkInView[] = [];
  const features = seamarks.features as ReadonlyArray<
    | {
        properties?: SeamarkProperties | null;
        geometry?: { type?: unknown; coordinates?: unknown } | null;
      }
    | null
    | undefined
  >;
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const props = f?.properties;
    if (!props || typeof props.seamarkType !== 'string') continue;
    const g = f.geometry;
    if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) {
      continue;
    }
    const [lon, lat] = g.coordinates as unknown[];
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lat < viewport.south || lat > viewport.north) continue;
    if (!lonInRange(lon, viewport.west, viewport.east)) continue;
    if (seamarkDisplayTier(props) > selectedTier) continue;
    inView.push({
      key: String(i),
      props,
      lon,
      lat,
      distanceNm: haversineNm(centre, { lat, lon }),
    });
  }
  // Array.prototype.sort is stable (ES2019), so equidistant marks keep their
  // collection order — the same two-marks-one-coordinate case #615 measured
  // still yields a deterministic row order.
  inView.sort((a, b) => a.distanceNm - b.distanceNm);
  return { marks: inView.slice(0, max), total: inView.length };
}
