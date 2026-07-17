import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { Board, LatLon, Leg, LegKind, ManeuverKind, WindGrid } from '../types';
import { formatKn, formatTime, type Lang } from './format';
import { WindField } from './wind';
import type { NavMask } from './mask';

export interface LegProperties {
  kind: LegKind;
  board: Board | null;
  maneuver: ManeuverKind | null;
  // Index into the legs array, for RouteLayer's active-leg highlight layer
  // to filter on (`['==', ['get', 'legIndex'], activeLegIndex]`) without a
  // source re-set when the highlighted leg changes.
  legIndex: number;
  // Precomputed line-center label: sail -> "5.4 kn"; motor -> "M · 6.5 kn"
  // (the motor letter reinforces propulsion legibility, #46a). The letter is
  // injected by RouteLayer (t('route.motorLetter')) so this lib module never
  // imports the i18n dictionary; the 'M' default only mirrors that
  // language-invariant key for standalone/test callers.
  speedLabel: string;
  // #53: true when the leg crosses cells charted below the plan's requested
  // safety depth (leg.shallow present) — RouteLayer's sc-route-shallow
  // highlight layer filters on it.
  shallow: boolean;
}

export function legsToFeatureCollection(
  legs: Leg[],
  opts: { motorLetter?: string } = {},
): FeatureCollection<LineString, LegProperties> {
  const motorLetter = opts.motorLetter ?? 'M';
  return {
    type: 'FeatureCollection',
    features: legs.map((leg, legIndex): Feature<LineString, LegProperties> => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [leg.start.lon, leg.start.lat],
          [leg.end.lon, leg.end.lat],
        ],
      },
      properties: {
        kind: leg.kind,
        board: leg.kind === 'sail' ? leg.board : null,
        maneuver: leg.maneuverAtStart,
        legIndex,
        speedLabel:
          leg.kind === 'motor'
            ? `${motorLetter} · ${formatKn(leg.speedKn)}`
            : formatKn(leg.speedKn),
        shallow: leg.shallow !== undefined,
      },
    })),
  };
}

// Uniform annotation point over the route, feeding the shared MANEUVER_SOURCE
// (one point source for maneuver circles/letters, heading dots and ETA
// labels). `symbol-sort-key` is per-layer, so `rank` orders labels only WITHIN
// sc-eta-primary (finish 0 wins a collision, then start 1, then maneuvers 2) —
// it does NOT rank across layers. Heading changes live on the separate
// sc-eta-secondary layer; their subordination comes from that layer's order
// and its higher minzoom (12), not from rank (3 is set only for completeness).
// Layers filter on `kind`; zoom tiering is done with layer `minzoom` only.
export type RoutePointKind = 'start' | 'finish' | 'tack' | 'gybe' | 'heading';

export interface RoutePointProperties {
  kind: RoutePointKind;
  eta: string; // formatTime(ms, lang) — HH:mm, h23
  rank: number;
}

const POINT_RANK: Record<RoutePointKind, number> = {
  finish: 0,
  start: 1,
  tack: 2,
  gybe: 2,
  heading: 3,
};

export function routePointFeatures(
  legs: Leg[],
  etaMs: number,
  lang: Lang,
): FeatureCollection<Point, RoutePointProperties> {
  const features: Feature<Point, RoutePointProperties>[] = [];
  if (legs.length === 0) return { type: 'FeatureCollection', features };

  const point = (
    p: LatLon,
    kind: RoutePointKind,
    timeMs: number,
  ): Feature<Point, RoutePointProperties> => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { kind, eta: formatTime(timeMs, lang), rank: POINT_RANK[kind] },
  });

  const first = legs[0];
  features.push(point(first.start, 'start', first.startTimeMs));
  // Every joint at i >= 1 is either a maneuver (tack/gybe) or a plain heading
  // change; legs[0].start is the departure, not a joint. Motor legs carry
  // maneuverAtStart === null, so they surface as heading changes.
  for (let i = 1; i < legs.length; i++) {
    const leg = legs[i];
    const kind: RoutePointKind = leg.maneuverAtStart ?? 'heading';
    features.push(point(leg.start, kind, leg.startTimeMs));
  }
  const last = legs[legs.length - 1];
  features.push(point(last.end, 'finish', etaMs));

  return { type: 'FeatureCollection', features };
}

export interface BarbProperties {
  speedKn: number;
  dirFromDeg: number;
}

// Index into `timesMs` closest to `tMs`; ties resolve to the earlier index
// (strict `<` below, so an equal-or-later diff never displaces the current
// best). Exported for reuse by the RouteLayer time slider, which must snap
// to the same forecast-hour grid.
export function nearestHourIndex(timesMs: number[], tMs: number): number {
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < timesMs.length; i++) {
    const diff = Math.abs(timesMs[i] - tMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// Minimal viewport façade the adaptive barb sampler needs, so the function
// stays pure and unit-testable with a mock projector (no MapLibre in jsdom).
// RouteLayer builds it from the live map (map.project / map.getBounds).
export interface BarbView {
  project: (p: LatLon) => { x: number; y: number };
  bounds: { west: number; south: number; east: number; north: number };
}

const RIBBON_PX = 110; // along-leg ribbon spacing (screen px)
const NEAR_ROUTE_PX = 48; // ribbon dedupe radius AND near-route lattice skip
const LATTICE_TARGET_PX = 96; // target on-screen lattice spacing
const BARB_CAP = 500; // hard feature cap (ribbon first, then lattice)
// Subdivision is bounded at 4x the native grid (n >= -2, i.e. 2^-2): beyond
// that, interpolated barbs would pretend a precision the forecast doesn't have.
const MIN_SUBDIV_N = -2;

// Viewport-scoped, zoom-adaptive wind barbs sampled from the plan's stored
// grid at slider time `tMs` (never re-fetched). Two deterministic parts under
// one hard cap:
//   1. Route ribbon: samples every ~110 px along the legs (priority under the
//      cap) so the wind along the route is readable at any zoom (#36).
//   2. Grid-anchored lattice: fills the rest of the viewport at ~96 px, with
//      the step locked to power-of-two multiples of the native grid step
//      anchored at grid index 0 — so barbs are pan-stable (no jitter on move).
//      Subdivision is bounded at 4x the native grid (n >= -2); beyond that,
//      interpolated barbs would pretend a precision the forecast doesn't have.
// Density is deterministic by construction (no collision culling — the #36
// complaint was random barb disappearance), so `icon-allow-overlap` stays true.
export function adaptiveBarbFeatures(
  grid: WindGrid,
  tMs: number,
  view: BarbView,
  legs: Leg[],
  mask: NavMask | null,
): FeatureCollection<Point, BarbProperties> {
  const field = new WindField(grid);
  const features: Feature<Point, BarbProperties>[] = [];
  const ribbonScreen: { x: number; y: number }[] = [];

  const push = (p: LatLon): void => {
    const w = field.sample(p, tMs);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { speedKn: w.speedKn, dirFromDeg: w.dirFromDeg },
    });
  };

  // On-screen viewport rectangle (padded by one ribbon interval) that ribbon
  // candidates are clipped to below. Derived from all four projected bounds
  // corners so a rotated map still clips correctly.
  const corners = [
    view.project({ lat: view.bounds.north, lon: view.bounds.west }),
    view.project({ lat: view.bounds.north, lon: view.bounds.east }),
    view.project({ lat: view.bounds.south, lon: view.bounds.west }),
    view.project({ lat: view.bounds.south, lon: view.bounds.east }),
  ];
  const clipMinX = Math.min(...corners.map((c) => c.x)) - RIBBON_PX;
  const clipMaxX = Math.max(...corners.map((c) => c.x)) + RIBBON_PX;
  const clipMinY = Math.min(...corners.map((c) => c.y)) - RIBBON_PX;
  const clipMaxY = Math.max(...corners.map((c) => c.y)) + RIBBON_PX;

  // 1) Route ribbon — clipped to the padded viewport BEFORE the cap counts it.
  // Unclipped, a long route at deep zoom exhausts the 500-feature cap off-screen
  // and leaves zero barbs near the destination (defeats #36 at harbor-approach
  // zoom). Determinism stays per-viewport (same view -> same barbs). On-route,
  // so no land-cull.
  for (const leg of legs) {
    if (features.length >= BARB_CAP) break;
    const ps = view.project(leg.start);
    const pe = view.project(leg.end);
    const len = Math.hypot(pe.x - ps.x, pe.y - ps.y);
    if (len < 1e-6) continue;
    // Start half an interval in so ribbon barbs stay clear of the ETA labels
    // and maneuver markers at the joints.
    for (let d = RIBBON_PX / 2; d <= len; d += RIBBON_PX) {
      if (features.length >= BARB_CAP) break;
      const f = d / len;
      const sx = ps.x + (pe.x - ps.x) * f;
      const sy = ps.y + (pe.y - ps.y) * f;
      // Drop off-screen candidates so the cap budget is spent in-view.
      if (sx < clipMinX || sx > clipMaxX || sy < clipMinY || sy > clipMaxY) continue;
      let tooClose = false;
      for (const r of ribbonScreen) {
        if (Math.hypot(sx - r.x, sy - r.y) < NEAR_ROUTE_PX) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      ribbonScreen.push({ x: sx, y: sy });
      push({
        lat: leg.start.lat + (leg.end.lat - leg.start.lat) * f,
        lon: leg.start.lon + (leg.end.lon - leg.start.lon) * f,
      });
    }
  }

  // 2) Grid-anchored lattice.
  const nLat = grid.lats.length;
  const nLon = grid.lons.length;
  if (features.length < BARB_CAP && nLat >= 2 && nLon >= 2) {
    const latStep = grid.lats[1] - grid.lats[0];
    const lonStep = grid.lons[1] - grid.lons[0];
    // On-screen size of one native grid step at the viewport-center latitude.
    const centerLat = (view.bounds.south + view.bounds.north) / 2;
    const a = view.project({ lat: centerLat, lon: grid.lons[0] });
    const b = view.project({ lat: centerLat, lon: grid.lons[0] + lonStep });
    const p0 = Math.hypot(b.x - a.x, b.y - a.y);
    const n = p0 > 0 ? Math.max(MIN_SUBDIV_N, Math.round(Math.log2(LATTICE_TARGET_PX / p0))) : 0;
    const m = Math.pow(2, n); // lattice step in native-grid-index units

    // Viewport bounds expressed in fractional grid indices, clamped to the
    // grid bbox and padded one lattice step so edge barbs don't pop in/out.
    const vLat0 = (view.bounds.south - grid.lats[0]) / latStep;
    const vLat1 = (view.bounds.north - grid.lats[0]) / latStep;
    const vLon0 = (view.bounds.west - grid.lons[0]) / lonStep;
    const vLon1 = (view.bounds.east - grid.lons[0]) / lonStep;
    const latLo = Math.max(0, Math.min(vLat0, vLat1) - m);
    const latHi = Math.min(nLat - 1, Math.max(vLat0, vLat1) + m);
    const lonLo = Math.max(0, Math.min(vLon0, vLon1) - m);
    const lonHi = Math.min(nLon - 1, Math.max(vLon0, vLon1) + m);

    // Enumerate anchored indices k*m (anchor = grid index 0). This anchoring is
    // what makes the lattice pan-stable: which indices land in view changes,
    // but the index positions themselves never shift.
    for (let kLat = Math.ceil(latLo / m); kLat <= Math.floor(latHi / m); kLat++) {
      if (features.length >= BARB_CAP) break;
      const lat = grid.lats[0] + kLat * m * latStep;
      for (let kLon = Math.ceil(lonLo / m); kLon <= Math.floor(lonHi / m); kLon++) {
        if (features.length >= BARB_CAP) break;
        const lon = grid.lons[0] + kLon * m * lonStep;
        const p: LatLon = { lat, lon };
        // Land-cull once the real mask has loaded; skip gracefully otherwise.
        if (mask && mask.depthM(p) <= 0) continue;
        // Skip lattice barbs sitting on top of the denser route ribbon.
        if (ribbonScreen.length > 0) {
          const s = view.project(p);
          let near = false;
          for (const r of ribbonScreen) {
            if (Math.hypot(s.x - r.x, s.y - r.y) < NEAR_ROUTE_PX) {
              near = true;
              break;
            }
          }
          if (near) continue;
        }
        push(p);
      }
    }
  }

  return { type: 'FeatureCollection', features };
}
