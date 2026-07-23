// Pure builder for the always-mounted seamarks overlay layer (#7) — the
// MapLibre wiring lives in components/DataLayers.tsx, mirroring how
// harborGeoJson.ts backs DataLayers' harbor markers.
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { SymbolLayerSpecification } from 'maplibre-gl';
import type { SeamarkProperties } from '../types';
import { seamarkImageId, seamarkPriority } from './seamarkGlyphs';

export type SeamarkFeatureCollection = FeatureCollection<Point, SeamarkProperties>;

export type SeamarkPropertiesWithIcon = SeamarkProperties & { icon: string; priority: number };

/**
 * Adds the `icon` property (the `map.addImage()` id `seamarkImageId()`
 * resolves to) to every feature, so the `sc-seamarks` layer's `icon-image`
 * can be a plain `['get', 'icon']` instead of re-deriving the family/colour/
 * shape logic in a MapLibre expression — and the `priority` collision rank
 * (#144) next to it, read by `symbol-sort-key` the same way.
 */
export function seamarkFeatureCollectionWithIcons(
  fc: SeamarkFeatureCollection,
): FeatureCollection<Point, SeamarkPropertiesWithIcon> {
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f): Feature<Point, SeamarkPropertiesWithIcon> => ({
      ...f,
      properties: {
        ...f.properties,
        icon: seamarkImageId(f.properties),
        priority: seamarkPriority(f.properties),
      },
    })),
  };
}

/**
 * Layout for the `sc-seamarks` symbol layer (#144), exported so unit tests
 * pin the exact expressions without mounting MapLibre. DataLayers spreads
 * this and adds only the `visibility` wiring (component concern).
 *
 * - `icon-overlap` supersedes `icon-allow-overlap` in the installed
 *   style-spec. Below z12 near-coincident AtoN pairs collision-cull —
 *   `symbol-sort-key` makes the culling deterministic by navigational
 *   significance (lower `priority` wins) instead of arbitrary source order.
 *   At z>=12 (harbor approach) overlap flips to 'always' so EVERY mark
 *   renders and stays tappable — the #36 extreme-zoom popup-safety valve,
 *   deliberate, not polish. Trade-off: collision-hidden symbols are absent
 *   from queryRenderedFeatures, so culled minor marks are untappable below
 *   z12 by design.
 * - `icon-size` tapers from the pre-#144 constant 0.85 (kept at z13) down
 *   to 0.55 at z8 so survivors overprint less at medium zoom (same
 *   interpolate pattern as AisLayer's vessel icons).
 * - NO minzoom, NO ['zoom'] filters here — layout expressions only (the
 *   RouteLayer rule).
 */
export const SEAMARKS_LAYOUT: NonNullable<SymbolLayerSpecification['layout']> = {
  // Precomputed per feature (seamarkFeatureCollectionWithIcons) —
  // seamarkType/category alone can't distinguish e.g. a red from a
  // green lateral buoy, which the glyph fidelity needs (seamarkGlyphs.ts).
  'icon-image': ['get', 'icon'],
  'icon-overlap': ['step', ['zoom'], 'never', 12, 'always'],
  'symbol-sort-key': ['get', 'priority'],
  'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 11, 0.7, 13, 0.85],
};
