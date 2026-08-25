// Pure builder for the always-mounted seamarks overlay layer (#7) — the
// MapLibre wiring lives in components/DataLayers.tsx, mirroring how
// harborGeoJson.ts backs DataLayers' harbor markers.
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { FilterSpecification, SymbolLayerSpecification } from 'maplibre-gl';
import type { SeamarkProperties } from '../types';
import {
  SEAMARK_NATURAL_ICON_PX,
  SEAMARK_SIZE_SCALE,
  seamarkDisplayTier,
  seamarkImageId,
  seamarkPriority,
  type SeamarkDisplayTier,
} from './seamarkGlyphs';

export type SeamarkFeatureCollection = FeatureCollection<Point, SeamarkProperties>;

export type SeamarkPropertiesWithIcon = SeamarkProperties & {
  icon: string;
  priority: number;
  /** #353 PR2 — see `seamarkDisplayTier()`'s own doc comment. */
  displayTier: SeamarkDisplayTier;
};

/**
 * Adds the `icon` property (the `map.addImage()` id `seamarkImageId()`
 * resolves to) to every feature, so the `sc-seamarks` layer's `icon-image`
 * can be a plain `['get', 'icon']` instead of re-deriving the family/colour/
 * shape logic in a MapLibre expression — the `priority` collision rank
 * (#144) next to it, read by `symbol-sort-key` the same way — and the
 * `displayTier` display-category rank (#353 PR2), read by the layer's
 * `filter` via `seamarkDisplayFilter()` below.
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
        displayTier: seamarkDisplayTier(f.properties),
      },
    })),
  };
}

/**
 * MapLibre `filter` expression for the `sc-seamarks` layer's display
 * category (#353 PR2): keeps a feature only while its own `displayTier`
 * (stamped by `seamarkFeatureCollectionWithIcons` above) is at or below the
 * user's selected tier — tiers are CUMULATIVE (`SEAMARK_DISPLAY_TIER_ALL`
 * shows everything, matching the pre-#353 unfiltered layer exactly).
 */
export function seamarkDisplayFilter(selectedTier: SeamarkDisplayTier): FilterSpecification {
  return ['<=', ['get', 'displayTier'], selectedTier];
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
 * Extracts a Point feature's own `[lng, lat]` — the coordinates
 * `queryRenderedFeatures` reports on a picked feature's `geometry`, distinct
 * from the tap point (`e.lngLat`) that produced the click. Returns null for
 * anything that isn't a Point (defensive: `sc-seamarks` is Point-only, but
 * this stays generic like `pickSeamarkByPriority` above rather than assuming).
 */
function pointCoordinates(f: { geometry?: unknown } | undefined): [number, number] | null {
  const g = f?.geometry as { type?: unknown; coordinates?: unknown } | undefined;
  if (!g || g.type !== 'Point') return null;
  const c = g.coordinates;
  if (!Array.isArray(c) || c.length < 2) return null;
  const [lng, lat] = c;
  return typeof lng === 'number' && typeof lat === 'number' ? [lng, lat] : null;
}

/**
 * #232 item 4 — popup anchoring. `pickSeamarkByPriority` (above) can hand a
 * click to a mark that ISN'T the one under the user's finger/cursor: in the
 * shared pixels of two overlapping icons at z>=12, the user sees the TOP
 * glyph but the popover describes the HAZARD underneath it (deliberate — see
 * `pickSeamarkByPriority`'s own doc comment). Before this, every seamark
 * popup anchored at the tap point (`e.lngLat`), so in that mismatch case
 * there was no positional cue pointing at the mark the popover actually
 * describes.
 *
 * Anchoring UNCONDITIONALLY at the picked feature's own coordinates would
 * fix that case but change behaviour for the far more common
 * non-overlapping one too — today's tap-follow anchor is arguably the
 * better feel on touch there (a design nuance the implementer raised on PR
 * #225 and #232 explicitly carries forward rather than assuming away). So
 * this only moves the anchor when the priority pick DIFFERS from the
 * topmost feature — exactly the case where the user would otherwise have no
 * cue which mark they got. Ties, and the ordinary single-feature click,
 * keep the tap point unchanged (`picked === topmost`, including when both
 * are `undefined`).
 *
 * `picked`/`topmost` are handed in — rather than a raw features array this
 * re-derives `pickSeamarkByPriority` from — so the caller (DataLayers.tsx)
 * computes the pick exactly once per click and this stays a pure comparison
 * over its result.
 */
export function seamarkPopupAnchor<T extends { properties?: unknown; geometry?: unknown }, TTap>(
  picked: T | undefined,
  topmost: T | undefined,
  tapLngLat: TTap,
): [number, number] | TTap {
  // A separate `!picked` arm was here and is deliberately removed (PR #685
  // review): it was unreachable-as-discriminating from the real call site
  // (pickSeamarkByPriority returns undefined only when e.features is empty
  // or absent, in which case e.features?.[0] — topmost — is undefined too,
  // so `picked === topmost` already covers it) and pointCoordinates(undefined)
  // safely falls through to tapLngLat below regardless, so no defensiveness
  // is lost by dropping it.
  if (picked === topmost) return tapLngLat;
  return pointCoordinates(picked) ?? tapLngLat;
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
 *   paints them UNDERNEATH routine marks at z>=12. THREE consequences: (a)
 *   and (b) are accepted rather than fixed here; (c) is NOT accepted — it is
 *   a live, unresolved finding (see its own STATUS line below):
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
 *         stacked above this one, decouples the two; that is a follow-up,
 *         filed as #682 (out of scope for #232 items 2-4).
 *     (c) Cross-tile ordering (#232 item 2) — the issue's ORIGINAL hypothesis
 *         here ("the sort only orders within one tile, so a low-priority
 *         mark in an earlier tile can beat a high-priority one in a later
 *         tile, and no ranking fixes it") is REFUTED by source, read against
 *         `maplibre-gl` **6.5.0** (`app/node_modules/maplibre-gl`, matched
 *         to `app/package-lock.json`'s pin via `npm ci` before reading, not
 *         a possibly-stale `node_modules` — #392's documented trap).
 *         `sc-seamarks` sets a non-constant `symbol-sort-key` and never sets
 *         `symbol-z-order` — exactly the condition `LayerPlacement`'s
 *         `_sortAcrossTiles` flag tests (`style/pauseable_placement.ts:
 *         20-21`, the SAME predicate as `sortFeaturesByKey` above). When
 *         that flag is true, `continuePlacement` (`:29-58`) first collects
 *         ONE `BucketPart` per tile-local `sortKeyRange` from EVERY
 *         renderable tile of the source (`:33-41`; `getBucketParts`,
 *         `symbol/placement.ts:245,303-307` — `sortKeyRanges` are the
 *         WORKER-side per-tile grouping that `SymbolBucket.populate()`'s OWN
 *         per-tile sort (`data/bucket/symbol_bucket.ts:552-557`) feeds via
 *         `addToSortKeyRanges` (`:891-902`)), collects them all into ONE
 *         array, THEN sorts that whole array by `sortKey` GLOBALLY (`:43-46`)
 *         BEFORE placing any part of it (`:48-56`). So a hazard mark in a
 *         later-processed tile IS placed — and therefore collision-wins —
 *         before a routine mark in an earlier tile: `SymbolBucket.populate()`'s
 *         per-tile sort (`data/bucket/symbol_bucket.ts:552-557`) is a
 *         WORKER-side grouping step feeding this LATER, GLOBAL cross-tile
 *         merge — it is not itself the final placement order.
 *         STATUS: NOT resolved, and no longer documentable as "inherent" —
 *         that framing, and the closing condition it was meant to satisfy,
 *         are both withdrawn here. #200's measured z8/z9 hazard retention
 *         (high but not 100%) is a real number this comment does NOT
 *         explain any more: the cross-tile GLOBAL SORT mechanism verified in
 *         this bullet does not produce a cross-tile leak for this layer's
 *         configuration, and no alternative cause was established in this
 *         pass. #232 item 2 needs either a fresh investigation of the real
 *         cause, or a re-measurement confirming the residual still exists at
 *         all, before it can be closed either way — this comment records
 *         the refutation, not a resolution. (The single-non-tiled-source /
 *         `buffer`/`tolerance` options an earlier revision of this comment
 *         considered and rejected were evaluated against the now-refuted
 *         per-tile-only premise; they have NOT been re-evaluated against the
 *         mechanism verified above, and #232's own body still carries that
 *         option list verbatim if a future investigation needs it.)
 *   Below z12 the older trade-off still stands: collision-hidden symbols are
 *   absent from queryRenderedFeatures, so culled minor marks are untappable
 *   by design. (There, at most one icon can cover any given point — an
 *   overlapping pair would have collided — so (a) is a no-op.)
 * - `icon-size` tapers from the pre-#144 constant 0.85 (kept at z13) down
 *   to 0.55 at z8 so survivors overprint less at medium zoom (same
 *   interpolate pattern as AisLayer's vessel icons). #353 PR1: every stop is
 *   now `base * SEAMARK_SIZE_SCALE` (seamarkGlyphs.ts) rather than a bare
 *   literal — at the default scale of 1 this is byte-for-byte the same
 *   values (`x * 1 === x` exactly for every IEEE-754 double, no rounding).
 * - `icon-padding` is 0 at every zoom stop (MapLibre default is 2px/side):
 *   the collision box fed to the below-z12 culling above is the icon box
 *   PLUS this padding, and #191's raster resize (24->32 logical px natural
 *   footprint) already grew that box +33%, which measurably culls MORE
 *   marks below z12 for the same on-screen crowding (a dense-channel
 *   regression, not a design goal — see the #191/#192 PR review). Dropping
 *   the padding claws back part of that growth at zero visual cost (padding
 *   is invisible collision margin, not rendered pixels) without touching
 *   the z12 overlap threshold (#144) or re-tuning icon-size (would trade
 *   away #191's readability fix).
 *   #353 PR1: `icon-padding` is now a per-zoom-stop EXPRESSION
 *   (`iconPaddingAt`, below), derived exactly from the same
 *   BASE_ICON_SIZE_STOPS table `icon-size` uses plus SEAMARK_SIZE_SCALE, so
 *   a future non-1 scale keeps the collision footprint (displayed icon size
 *   + 2*padding — MapLibre applies padding per side, see
 *   `collision_feature.ts:71-74`'s `x1 -= padding[3]; x2 += padding[1]` etc.,
 *   read against `maplibre-gl@6.1.0` — confirmed via `npm ci` against
 *   `app/package-lock.json`'s pin, not just grepped from a possibly-stale
 *   `node_modules`, #392's documented trap) from growing in lockstep with a
 *   bigger on-screen icon — the #191/#192 lesson this parameterization
 *   exists not to repeat.
 *
 *   #484 F3: `Padding.parse` (@maplibre/maplibre-gl-style-spec@26.2.1, the
 *   lockfile's pin) has no floor at 0 on any branch, and the v8 style-spec's
 *   `icon-padding` entry declares no `minimum` either, so the validator will
 *   not reject a negative value — a scale > 1 genuinely shrinks the
 *   collision box below the bare icon box, not merely clawing back part of
 *   the growth the way the old flat `icon-padding: 0` did. But this is an
 *   ABSENCE in the spec, not a documented guarantee — unspecified behaviour
 *   this formula depends on. If a future MapLibre release adds a floor
 *   (in `Padding.parse`, in `getIconPadding`, or in the spec entry), the
 *   compensation below becomes a SILENT no-op: padding stays clamped to 0,
 *   the collision box grows in lockstep with icon size again exactly as
 *   #191/#192 did, nothing throws or warns, and no test at scale 1 (where
 *   padding is 0 already and a clamp is indistinguishable from no clamp)
 *   can see it. `seamarkGeoJson.test.ts`'s "#484 F3" test is the guard: it
 *   asserts the resolved expression is actually negative at scale > 1, so a
 *   future clamp reds a test instead of silently culling navigation marks.
 *   At the default scale of 1 every stop evaluates to `0` exactly (see
 *   `iconPaddingAt`'s own comment for why it's `+0`, never `-0`),
 *   reproducing today's flat value.
 * - NO minzoom, NO ['zoom'] filters here — layout expressions only (the
 *   RouteLayer rule).
 */

/**
 * Base icon-size zoom stops at SEAMARK_SIZE_SCALE = 1 (today's exact
 * values, #144/#191) — the single table every size-axis expression below is
 * derived from, so there is exactly one place encoding "how big at each
 * zoom" and one place (seamarkGlyphs.ts's SEAMARK_SIZE_SCALE) encoding "how
 * big overall".
 */
const BASE_ICON_SIZE_STOPS = [
  [8, 0.55],
  [11, 0.7],
  [13, 0.85],
] as const;

/**
 * #353 PR1: the icon-padding compensation for one zoom stop. Derivation,
 * with base icon-size value `v` and the glyph's SEAMARK_SIZE_SCALE-INVARIANT
 * natural footprint `SEAMARK_NATURAL_ICON_PX` (CSS px at icon-size 1 —
 * invariant because seamarkGlyphs.ts scales CANVAS_SIZE and PIXEL_RATIO
 * together, so their ratio never moves):
 *   displayed(scale) = v * scale * NATURAL
 *   displayed(1)      = v * NATURAL                          (today's value)
 *   growth            = displayed(scale) - displayed(1)
 *                     = (scale - 1) * v * NATURAL
 *   padding(scale)    = padding(1) - growth / 2, padding(1) = 0 today
 *                     = ((1 - scale) * v * NATURAL) / 2
 * Written as `(1 - scale)`, never negated after computing a positive growth
 * value, so scale = 1 evaluates to `+0` at every stop, not `-0`
 * (`Object.is(-0, 0) === false` — CLAUDE.md's #203 rule) — reproducing
 * today's flat `icon-padding: 0` exactly rather than a numerically-equal but
 * sign-different value.
 */
function iconPaddingAt(baseIconSize: number, scale: number): number {
  return ((1 - scale) * baseIconSize * SEAMARK_NATURAL_ICON_PX) / 2;
}

/**
 * #484 F1: `SEAMARKS_LAYOUT` used to be a module constant computed once from
 * the module-level `SEAMARK_SIZE_SCALE` import — which meant, since that
 * constant is fixed at 1 for the whole of PR1, that NOTHING in the committed
 * suite ever evaluated `iconPaddingAt` at a scale where it returns anything
 * other than `0`. Replacing every `iconPaddingAt(...)` call site with a
 * literal `0` left the entire committed suite green (measured — see the PR
 * description's F1 entry). Factored into a plain function of `scale` so
 * `seamarkGeoJson.test.ts` can drive a non-1 scale directly, the same
 * shape as seamarkGlyphs.ts's `seamarkRasterConfig(scale)` (#484 F4).
 * `SEAMARKS_LAYOUT` below is just `seamarksLayout(SEAMARK_SIZE_SCALE)` —
 * every existing consumer (DataLayers.tsx) is unaffected.
 */
export function seamarksLayout(scale: number): NonNullable<SymbolLayerSpecification['layout']> {
  return {
    // Precomputed per feature (seamarkFeatureCollectionWithIcons) —
    // seamarkType/category alone can't distinguish e.g. a red from a
    // green lateral buoy, which the glyph fidelity needs (seamarkGlyphs.ts).
    'icon-image': ['get', 'icon'],
    'icon-overlap': ['step', ['zoom'], 'never', 12, 'always'],
    'symbol-sort-key': ['get', 'priority'],
    'icon-size': [
      'interpolate',
      ['linear'],
      ['zoom'],
      BASE_ICON_SIZE_STOPS[0][0],
      BASE_ICON_SIZE_STOPS[0][1] * scale,
      BASE_ICON_SIZE_STOPS[1][0],
      BASE_ICON_SIZE_STOPS[1][1] * scale,
      BASE_ICON_SIZE_STOPS[2][0],
      BASE_ICON_SIZE_STOPS[2][1] * scale,
    ],
    'icon-padding': [
      'interpolate',
      ['linear'],
      ['zoom'],
      BASE_ICON_SIZE_STOPS[0][0],
      iconPaddingAt(BASE_ICON_SIZE_STOPS[0][1], scale),
      BASE_ICON_SIZE_STOPS[1][0],
      iconPaddingAt(BASE_ICON_SIZE_STOPS[1][1], scale),
      BASE_ICON_SIZE_STOPS[2][0],
      iconPaddingAt(BASE_ICON_SIZE_STOPS[2][1], scale),
    ],
  };
}

export const SEAMARKS_LAYOUT: NonNullable<SymbolLayerSpecification['layout']> =
  seamarksLayout(SEAMARK_SIZE_SCALE);
