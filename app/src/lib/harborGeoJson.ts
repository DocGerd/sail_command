// Pure builders for the always-mounted harbor marker layer (#38) — the
// MapLibre wiring lives in components/DataLayers.tsx, mirroring how
// routeGeoJson.ts backs RouteLayer.tsx.
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { Harbor } from '../types';

export interface HarborProperties {
  id: string;
  // Pre-localized for the active language; DataLayers rebuilds the source
  // data on a language switch (33 features — trivially cheap) rather than
  // carrying all three name variants per feature.
  name: string;
}

export function harborFeatureCollection(
  harbors: Harbor[],
  lang: 'de' | 'en',
): FeatureCollection<Point, HarborProperties> {
  return {
    type: 'FeatureCollection',
    features: harbors.map((h): Feature<Point, HarborProperties> => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [h.snap.lon, h.snap.lat] },
      properties: { id: h.id, name: h.names[lang] },
    })),
  };
}

/**
 * Which endpoint a harbor-marker click should fill (#38). Runs inside the
 * same map 'click' event as MapView's generic tap handler, so the two must
 * agree on ownership:
 *
 * - Armed for 'origin'/'destination' (tap-to-pick): the harbor pick wins
 *   that field — clicking a marker while aiming for a coordinate is a more
 *   specific intent, and the curated snap point beats a raw tap.
 * - Armed for 'via': the raw tap handler has already appended the tapped
 *   point as a via; answering 'origin'/'destination' here would double-handle
 *   the click, so the harbor click resolves to nothing.
 * - Disarmed (the issue's headline case): fill origin if still empty,
 *   otherwise (re)fill destination.
 */
export function resolveHarborPickTarget(
  armedTarget: 'origin' | 'destination' | 'via' | null,
  hasOrigin: boolean,
): 'origin' | 'destination' | null {
  if (armedTarget === 'via') return null;
  if (armedTarget) return armedTarget;
  return hasOrigin ? 'destination' : 'origin';
}
