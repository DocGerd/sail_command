import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { Board, Leg, LegKind, ManeuverKind, WindGrid } from '../types';

export interface LegProperties {
  kind: LegKind;
  board: Board | null;
  maneuver: ManeuverKind | null;
  // Index into the legs array, for RouteLayer's active-leg highlight layer
  // to filter on (`['==', ['get', 'legIndex'], activeLegIndex]`) without a
  // source re-set when the highlighted leg changes.
  legIndex: number;
}

export function legsToFeatureCollection(legs: Leg[]): FeatureCollection<LineString, LegProperties> {
  return {
    type: 'FeatureCollection',
    features: legs.map(
      (leg, legIndex): Feature<LineString, LegProperties> => ({
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
        },
      }),
    ),
  };
}

export interface ManeuverProperties {
  kind: ManeuverKind;
}

export function maneuverFeatures(legs: Leg[]): FeatureCollection<Point, ManeuverProperties> {
  const features: Feature<Point, ManeuverProperties>[] = [];
  for (const leg of legs) {
    if (!leg.maneuverAtStart) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [leg.start.lon, leg.start.lat] },
      properties: { kind: leg.maneuverAtStart },
    });
  }
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

export function barbFeatures(
  grid: WindGrid,
  tMs: number,
  stride = 2,
): FeatureCollection<Point, BarbProperties> {
  const ti = nearestHourIndex(grid.timesMs, tMs);
  const nLat = grid.lats.length;
  const nLon = grid.lons.length;
  const features: Feature<Point, BarbProperties>[] = [];
  for (let latIdx = 0; latIdx < nLat; latIdx += stride) {
    for (let lonIdx = 0; lonIdx < nLon; lonIdx += stride) {
      // Flattened index per types.ts: ((ti * lats.length) + latIdx) * lons.length + lonIdx
      const k = (ti * nLat + latIdx) * nLon + lonIdx;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [grid.lons[lonIdx], grid.lats[latIdx]] },
        properties: { speedKn: grid.speedKn[k], dirFromDeg: grid.dirFromDeg[k] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
