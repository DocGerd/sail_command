// Pure builder for the always-mounted seamarks overlay layer (#7) — the
// MapLibre wiring lives in components/DataLayers.tsx, mirroring how
// harborGeoJson.ts backs DataLayers' harbor markers.
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { SeamarkProperties } from '../types';
import { seamarkImageId } from './seamarkGlyphs';

export type SeamarkFeatureCollection = FeatureCollection<Point, SeamarkProperties>;

export type SeamarkPropertiesWithIcon = SeamarkProperties & { icon: string };

/**
 * Adds the `icon` property (the `map.addImage()` id `seamarkImageId()`
 * resolves to) to every feature, so the `sc-seamarks` layer's `icon-image`
 * can be a plain `['get', 'icon']` instead of re-deriving the family/colour/
 * shape logic in a MapLibre expression.
 */
export function seamarkFeatureCollectionWithIcons(
  fc: SeamarkFeatureCollection,
): FeatureCollection<Point, SeamarkPropertiesWithIcon> {
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f): Feature<Point, SeamarkPropertiesWithIcon> => ({
      ...f,
      properties: { ...f.properties, icon: seamarkImageId(f.properties) },
    })),
  };
}
