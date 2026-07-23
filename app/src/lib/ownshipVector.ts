import { PROJECTION_VECTOR_MINUTES, projectionLine } from './projectionVector';
import type { LatLon } from '../types';

/**
 * #141: minimum SOG for drawing the ownship projection vector. The AIS
 * vectors (#25) use `sog > 0` — shipborne AIS reports quantized SOG, so any
 * nonzero value means real motion. Raw device GPS instead jitters a small
 * nonzero SOG (with a noise COG) at rest, so ownship needs a real noise
 * floor; 0.5 kn is the documented pick (issue #141), inclusive: exactly
 * 0.5 kn renders.
 */
export const OWNSHIP_VECTOR_MIN_SOG_KN = 0.5;

/**
 * GeoJSON for the ownship 6-minute COG/SOG projection vector (#141): a single
 * LineString from the fix along COG, length = 6 min at current SOG — the same
 * convention and shared `projectionLine` geometry as the AIS target vectors
 * (#25). Empty collection (suppress) when the device reports no COG or no
 * SOG, or SOG is below the noise floor above. Pure — BoatMarker feeds it to a
 * dedicated GeoJSON source; GPS-only, zero AIS coupling.
 */
export function ownshipVectorGeoJson(
  point: LatLon,
  cogDeg: number | null,
  sogKn: number | null,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (cogDeg !== null && sogKn !== null && sogKn >= OWNSHIP_VECTOR_MIN_SOG_KN) {
    const [start, end] = projectionLine(point, cogDeg, sogKn, PROJECTION_VECTOR_MINUTES);
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [start.lon, start.lat],
          [end.lon, end.lat],
        ],
      },
      properties: {},
    });
  }
  return { type: 'FeatureCollection', features };
}
