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
 * Picks which of several overlapping seamarks a tap belongs to: the one with
 * the LOWEST `priority`, i.e. the most navigationally significant (#200).
 *
 * `symbol-sort-key` is one knob driving two OPPOSITE behaviours. Below z12
 * (`icon-overlap: 'never'`) a lower key is placed first and wins collisions —
 * what FAMILY_RANK is designed for. At z>=12 overlap flips to 'always' and the
 * same key means a HIGHER value paints on top; `queryRenderedFeatures` returns
 * symbols top-to-bottom, so the plain `features[0]` this replaced handed the
 * tap to whichever mark mattered LEAST. Measured on the committed data at the
 * 49 hazard marks with a higher-key neighbour within 320 m: at z12, 31 were
 * partially covered and the worst cardinal was reduced to a 17 px^2 sliver of
 * its own 729 px^2 icon — not untappable in principle, but far below any
 * usable touch target.
 *
 * This does NOT create or destroy tappability, it only decides which of two
 * overlapping marks owns the ambiguous pixels: the mark painted on top keeps
 * every pixel it does not share, so it can never become unreachable, while the
 * mark underneath is the only one that can be reduced to a sliver. Handing the
 * shared pixels to the more significant mark is the same principle #200
 * applies to placement, applied to the second half of the same knob.
 *
 * Trade-off, accepted deliberately: inside the shared region the user sees the
 * top mark's glyph but gets the hazard's popover. The popover names the mark
 * type, so the result is honest rather than misleading, and the alternative —
 * a cardinal that cannot practically be tapped — is worse on a safety overlay.
 * Paint order itself is unchanged and remains a documented residual (see
 * SEAMARKS_LAYOUT); only a separate symbol layer per family group could
 * decouple placement priority from paint order.
 *
 * Defensive on purpose: the handler is registered per-layer so every feature
 * is a `sc-seamarks` one and carries the `priority` stamped by
 * seamarkFeatureCollectionWithIcons, but a feature without a numeric
 * `priority` must never win over one that has it, and an all-unranked set
 * falls back to the topmost feature (the previous behaviour).
 */
export function pickSeamarkByPriority<T extends { properties?: unknown }>(
  features: readonly T[] | undefined,
): T | undefined {
  if (!features || features.length === 0) return undefined;
  const rank = (f: T): number => {
    const p = (f.properties as { priority?: unknown } | undefined)?.priority;
    return typeof p === 'number' && Number.isFinite(p) ? p : Number.POSITIVE_INFINITY;
  };
  let best = features[0]!;
  let bestRank = rank(best);
  for (const f of features.slice(1)) {
    const r = rank(f);
    // Strictly-less-than keeps ties on the topmost feature — MapLibre's own
    // order is the right tiebreak between two equally significant marks.
    if (r < bestRank) {
      best = f;
      bestRank = r;
    }
  }
  return best;
}

/**
 * Layout for the `sc-seamarks` symbol layer (#144), exported so unit tests
 * pin the exact expressions without mounting MapLibre. DataLayers spreads
 * this and adds only the `visibility` wiring (component concern).
 *
 * - `icon-overlap` supersedes `icon-allow-overlap` in the installed
 *   style-spec. Below z12 near-coincident AtoN pairs collision-cull —
 *   `symbol-sort-key` makes the culling deterministic by DANGER-information
 *   content (lower `priority` wins) instead of arbitrary source order; the
 *   IALA R1001 derivation of that order lives on `FAMILY_RANK` in
 *   seamarkGlyphs.ts (#144 introduced the mechanism, #200 corrected the
 *   ordering so hazard-bearing marks are never culled in favour of routine
 *   ones).
 *   At z>=12 (harbor approach) overlap flips to 'always' so EVERY mark
 *   renders — the #36 extreme-zoom popup-safety valve, deliberate, not
 *   polish.
 *
 *   `symbol-sort-key` DRIVES BOTH BANDS, IN OPPOSITE DIRECTIONS — the single
 *   most surprising thing about this layer, so state it plainly. Per the
 *   style-spec: a lower key is placed first and wins collisions when overlap
 *   is 'never'; when overlap is 'always' a HIGHER key paints ON TOP. So the
 *   very ranking that protects hazard marks from being culled below z12 also
 *   paints them UNDERNEATH routine marks at z>=12. Two consequences, both
 *   accepted rather than fixed here:
 *     (a) Tap resolution is NOT left to paint order. `queryRenderedFeatures`
 *         returns symbols top-to-bottom, so DataLayers' click handler would
 *         otherwise open the popover of the least significant overlapping
 *         mark; it calls pickSeamarkByPriority() instead (see above).
 *     (b) Paint order is a REMAINING residual: where icons overlap at z>=12 a
 *         routine mark can visually cover a cardinal or isolated-danger mark.
 *         Measured on the committed data, 31 of 49 hazard marks with a
 *         higher-key neighbour within 320 m are partially covered at z12.
 *         Nothing in this layer can fix that — `symbol-z-order: 'viewport-y'`
 *         would disable sortFeaturesByKey and take the placement priority with
 *         it. Only splitting the hazard families into their own symbol layer,
 *         stacked above this one, decouples the two; that is a follow-up.
 *   Below z12 the older trade-off still stands: collision-hidden symbols are
 *   absent from queryRenderedFeatures, so culled minor marks are untappable
 *   by design. (There, at most one icon can cover any given point — an
 *   overlapping pair would have collided — so (a) is a no-op.)
 * - `icon-size` tapers from the pre-#144 constant 0.85 (kept at z13) down
 *   to 0.55 at z8 so survivors overprint less at medium zoom (same
 *   interpolate pattern as AisLayer's vessel icons).
 * - `icon-padding` is 0 (MapLibre default is 2px/side): the collision box
 *   fed to the below-z12 culling above is the icon box PLUS this padding,
 *   and #191's raster resize (24->32 logical px natural footprint) already
 *   grew that box +33%, which measurably culls MORE marks below z12 for the
 *   same on-screen crowding (a dense-channel regression, not a design goal —
 *   see the #191/#192 PR review). Dropping the padding claws back part of
 *   that growth at zero visual cost (padding is invisible collision margin,
 *   not rendered pixels) without touching the z12 overlap threshold (#144)
 *   or re-tuning icon-size (would trade away #191's readability fix).
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
  'icon-padding': 0,
};
