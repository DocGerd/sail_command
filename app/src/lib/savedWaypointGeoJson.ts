// #924: pure builders for the saved-waypoint map layer — the MapLibre wiring
// lives in components/SavedWaypointsLayer.tsx, mirroring how
// harborGeoJson.ts backs DataLayers.tsx's harbour markers and routeGeoJson.ts
// backs RouteLayer.tsx.
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { SavedWaypoint } from '../services/db';

export interface SavedWaypointProperties {
  /** The IndexedDB record id — the ONLY property the click handler reads.
   * The handler resolves it back to the full record rather than trusting the
   * feature's own copy of lat/lon, so a coordinate can never diverge between
   * what the map drew and what gets inserted into the route. */
  id: string;
  /** Rendered by the label layer. Never absent: SavedWaypoints.tsx fills an
   * unnamed via point's name with its formatted coordinates before saving
   * (#848), so `name` is required on `SavedWaypoint` itself. */
  name: string;
}

export function savedWaypointFeatureCollection(
  waypoints: readonly SavedWaypoint[],
): FeatureCollection<Point, SavedWaypointProperties> {
  return {
    type: 'FeatureCollection',
    features: waypoints.map(
      (w): Feature<Point, SavedWaypointProperties> => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
        properties: { id: w.id, name: w.name },
      }),
    ),
  };
}
