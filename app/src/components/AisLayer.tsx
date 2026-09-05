import { useEffect, useRef } from 'react';
import { Popup } from 'maplibre-gl';
import type {
  GeoJSONSource,
  LngLatLike,
  Map as MaplibreMap,
  MapLayerMouseEvent,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import { ROUTE_STACK_BOTTOM_LAYER } from './RouteLayer';
import { aisFeatureCollection, aisPopupRows, type AisPopupProps } from '../lib/aisGeoJson';
import { HALO_COLOR, INK_COLOR, STARBOARD_COLOR } from '../lib/mapColors';
import { installStyleSetup } from '../lib/styleReload';
import type { AisTargetSnapshot } from '../lib/aisTargets';
import type { Lang } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';

export const AIS_SOURCE = 'sc-ais';
export const AIS_VECTOR_LAYER = 'sc-ais-vectors';
export const AIS_VESSEL_LAYER = 'sc-ais-vessels';
export const AIS_LABEL_LAYER = 'sc-ais-labels';
// Bottom-most layer of the AIS stack (the first setupLayers adds below) —
// imported by DataLayers as its insert anchor so the depth/harbor/seamark
// overlays always slot in BELOW the whole AIS stack no matter which
// component happens to set up first (#160; the ROUTE_STACK_BOTTOM_LAYER
// pattern — imported so a rename can't silently drop the ordering).
export const AIS_STACK_BOTTOM_LAYER = AIS_VECTOR_LAYER;

// Exported (alongside registerAisImages below) so the #192 registration
// contract — canvas size, pixelRatio, and the scale transform, mirroring
// seamarkGlyphs.ts's registerSeamarkImages coverage — can be unit-tested
// directly rather than only through the no-canvas-backend component mount.
export const ARROW_IMAGE = 'sc-ais-arrow';
export const DOT_IMAGE = 'sc-ais-dot';
// #715: sourced from lib/mapColors.ts. Okabe-Ito green, distinct from
// BoatMarker's blue (BOAT_COLOR).
const AIS_COLOR = STARBOARD_COLOR;

// #192: LOGICAL_SIZE is the coordinate space the arrow/dot geometry below is
// expressed in (unchanged, so the arrow's proportions — nose/wings — stay
// identical). CANVAS_SIZE is the actual raster resolution registered with
// the map, matched by PIXEL_RATIO so the resulting natural footprint
// (CANVAS_SIZE / PIXEL_RATIO = 32 logical px) is 2x the pre-#192 16px —
// comparable to seamarkGlyphs.ts's #191 resize (also natural 32) — while a
// canvas-transform scale (not just a bigger icon-size multiplier) keeps the
// glyph crisp instead of an upscaled blur of the old 32px bitmap.
const LOGICAL_SIZE = 32;
const CANVAS_SIZE = 64;
const PIXEL_RATIO = 2;

// A crisp directional arrow + a neutral dot, registered as map images so the
// symbol layer can rotate the arrow via icon-rotate. Built on a canvas (no DOM
// image fetch); skipped where there's no 2D backend (jsdom).
// eslint-disable-next-line react-refresh/only-export-components
export function registerAisImages(map: MaplibreMap): void {
  const scale = CANVAS_SIZE / LOGICAL_SIZE;
  const size = LOGICAL_SIZE;
  if (!map.hasImage(ARROW_IMAGE)) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.moveTo(size / 2, 3); // bow (points "up" = 0°, rotated by icon-rotate)
      ctx.lineTo(size - 7, size - 5);
      ctx.lineTo(size / 2, size - 11);
      ctx.lineTo(7, size - 5);
      ctx.closePath();
      ctx.fillStyle = AIS_COLOR;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = HALO_COLOR;
      ctx.stroke();
      map.addImage(ARROW_IMAGE, ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE), {
        pixelRatio: PIXEL_RATIO,
      });
    }
  }
  if (!map.hasImage(DOT_IMAGE)) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 6, 0, 2 * Math.PI);
      ctx.fillStyle = AIS_COLOR;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = HALO_COLOR;
      ctx.stroke();
      map.addImage(DOT_IMAGE, ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE), {
        pixelRatio: PIXEL_RATIO,
      });
    }
  }
}

// #957: natural render footprint at icon-size 1 (CSS px). Same equivalence
// the #192 comment above already establishes for LOGICAL_SIZE
// (CANVAS_SIZE / PIXEL_RATIO); named separately here because this is a
// size-AXIS constant (mirrors seamarkGlyphs.ts's SEAMARK_NATURAL_ICON_PX),
// not a canvas-drawing coordinate.
export const AIS_NATURAL_ICON_PX = CANVAS_SIZE / PIXEL_RATIO;

/**
 * #957: pre-#957 `icon-size` was `['interpolate', ['linear'], ['zoom'], 8,
 * 0.5, 12, 0.9]` — CLAMPED at 0.9 forever past z12 (`interpolate` clamps
 * outside its domain), a measured 16-28.8px displayed glyph against the
 * locked >=44px gloved-use touch-target floor (CLAUDE.md's a11y-ranking
 * ruling on #860, which fixed the identical shape for seamark glyphs).
 *
 * REJECTED APPROACH (PR #974 round 1, refuted in review): grow `icon-size`
 * to a new z13 stop (1.4) and compensate with a NEGATIVE `icon-padding` so
 * the collision footprint stays at the pre-#957 value. This does not work,
 * for two independent reasons confirmed against the installed
 * `maplibre-gl@6.6.0` source (`app/package-lock.json`-pinned):
 *
 * 1. `queryRenderedFeatures` resolves a symbol via the COLLISION INDEX, not
 *    the rendered icon quad — `collision_index.ts`'s `queryRenderedSymbols`
 *    doc comment says so directly ("we use the CollisionIndex to look up
 *    the symbol part of queryRenderedFeatures"), and it queries
 *    `this.grid.query(...).concat(this.ignoredGrid.query(...))`. So the
 *    collision footprint IS the tap target — compensating it back down to
 *    the pre-#957 size cancels the fix outright; the icon LOOKS bigger but
 *    taps exactly as before.
 * 2. Even ignoring (1), the padding math assumed `icon-size` and
 *    `icon-padding` are evaluated at the SAME zoom. They are not:
 *    `symbol_layout.ts:98` evaluates `icon-size` at `bucket.zoom + 1`
 *    (deliberately, to keep anchor/collision geometry stable across a
 *    tile's whole zoom range — the same call also does this for
 *    `text-size`, per that file's own comment), while `getIconPadding`
 *    (`symbol_style_layer.ts`, called from `symbol_layout.ts:316`)
 *    evaluates `icon-padding` off the layer's already-recalculated
 *    `layout` — `bucket.zoom`, no `+1`. A one-zoom-level mismatch between
 *    the two terms of the footprint sum meant the "constant footprint"
 *    invariant was false by construction; measured in review at 49px on
 *    z12/z12.5 tiles instead of the intended 32.8px.
 *
 * FIX (this version): keep growing `icon-size` (same z13 stop, 1.4 * 32 =
 * 44.8px, matching seamarks' own #860 choice), but do NOT touch
 * `icon-padding` at all — leave it at the MapLibre default (2px/side), so
 * the tap target genuinely grows with the icon. To close the #378-shape
 * hazard this still raises (AIS's own collision box growing, and AIS
 * sitting ABOVE DataLayers' whole harbor/seamark stack in placement
 * priority per #160, so it is placed BEFORE them and could newly cull a
 * lower-priority label near a vessel), set `icon-ignore-placement: true`.
 * `collision_index.ts`'s `insertCollisionBox` files a feature into
 * `this.ignoredGrid` rather than `this.grid` when `ignorePlacement` is
 * true, and the SELF-placement hitTest (`placeCollisionBox`, ~:173) and
 * every OTHER feature's collision check both read `this.grid` ONLY, never
 * `this.ignoredGrid` — so an ignored-placement box can never block another
 * symbol's placement, while `queryRenderedSymbols`'s
 * `grid.concat(ignoredGrid)` still returns it for taps. This is the SAME
 * fix #378 already applied to `sc-wind-barbs` for the identical
 * icon-allow-overlap-without-icon-ignore-placement shape (RouteLayer.tsx).
 * AIS already had `icon-allow-overlap: true` (immune to being culled
 * itself); this adds the missing "don't block others" half.
 *
 * z8-z11 stay BYTE-IDENTICAL to before, and the `icon-size` TABLE is
 * unchanged through z12 with `icon-padding` untouched at every zoom. The
 * z12 BEHAVIOUR does change, as reason 2 above implies: a z12 bucket
 * builds its collision box from `size(13) = 1.4`, so the tap target there
 * grows 32.8px -> 48.8px one zoom before the icon visibly grows. That is
 * harmless and wanted — `icon-ignore-placement` means the bigger box
 * blocks nothing — but it is not byte-identity, so do not cite this
 * paragraph as evidence that z12 is untouched.
 *
 * PRODUCT TRADE-OFF, flagged for maintainer sign-off rather than decided
 * here: `icon-ignore-placement: true` means AIS vessels no longer cull
 * ANY other layer's symbol near them — a seamark or harbor label that
 * would previously have been hidden by a nearby vessel's collision box now
 * stays visible (arguably a safety improvement: a temporarily-adjacent icon
 * beats a permanently-culled mark). It does NOT change AIS-vs-AIS overlap
 * behaviour, which was already unconditional via `icon-allow-overlap: true`
 * before this PR. Paint order (which layer draws on top) is independent of
 * collision and unaffected either way — AIS already paints above the
 * harbor/seamark stack.
 */
const AIS_VESSEL_ICON_SIZE: NonNullable<
  NonNullable<SymbolLayerSpecification['layout']>['icon-size']
> = ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 0.9, 13, 1.4];

// Exported so #957's tap-target floor and z8-z12 byte-identity can be pinned
// directly against the returned layout, without a live map.
// eslint-disable-next-line react-refresh/only-export-components
export function aisVesselLayout(): NonNullable<SymbolLayerSpecification['layout']> {
  return {
    'icon-image': [
      'step',
      ['zoom'],
      DOT_IMAGE,
      9,
      ['case', ['get', 'hasCourse'], ARROW_IMAGE, DOT_IMAGE],
    ],
    'icon-rotate': ['get', 'rotation'],
    'icon-rotation-alignment': 'map',
    'icon-size': AIS_VESSEL_ICON_SIZE,
    'icon-allow-overlap': true,
    // #957: do NOT block other layers' symbols from being placed near a
    // vessel — see the doc comment above for the mechanism and the #378
    // precedent this mirrors.
    'icon-ignore-placement': true,
  };
}

function setupLayers(map: MaplibreMap): void {
  // Anchor below the route stack (resolved at add time) so AIS renders BELOW
  // the route stack and the ownship marker (a DOM Marker, always on top) but
  // ABOVE the depth/seamark overlays. The overlay half of that invariant is
  // owned by DataLayers (#160): it anchors below AIS_STACK_BOTTOM_LAYER
  // whenever the AIS stack already exists, so the order holds for either
  // setup interleaving (DataLayers additionally waits for the routing-assets
  // fetch) and on every styledata re-add, not by setup-order luck.
  const beforeId = map.getLayer(ROUTE_STACK_BOTTOM_LAYER) ? ROUTE_STACK_BOTTOM_LAYER : undefined;
  if (map.getSource(AIS_SOURCE)) return;
  map.addSource(AIS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  // COG vectors (below the vessel glyph); hidden below ~zoom 9 (declutter).
  map.addLayer(
    {
      id: AIS_VECTOR_LAYER,
      type: 'line',
      source: AIS_SOURCE,
      filter: ['==', ['get', 'kind'], 'vector'],
      minzoom: 9,
      paint: {
        'line-color': AIS_COLOR,
        'line-width': 1.5,
        'line-opacity': ['match', ['get', 'tier'], 'stale', 0.4, 0.85],
      },
    },
    beforeId,
  );

  // Vessel glyphs: arrow when a course is known (and zoom ≥ 9), else a neutral
  // dot; stale targets faded. icon-rotate turns the arrow to heading/COG.
  map.addLayer(
    {
      id: AIS_VESSEL_LAYER,
      type: 'symbol',
      source: AIS_SOURCE,
      filter: ['==', ['get', 'kind'], 'vessel'],
      layout: aisVesselLayout(),
      paint: { 'icon-opacity': ['match', ['get', 'tier'], 'stale', 0.5, 1] },
    },
    beforeId,
  );

  // Name labels only at ≥ ~zoom 11, collision-culled.
  map.addLayer(
    {
      id: AIS_LABEL_LAYER,
      type: 'symbol',
      source: AIS_SOURCE,
      filter: ['==', ['get', 'kind'], 'vessel'],
      minzoom: 11,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': INK_COLOR,
        'text-halo-color': HALO_COLOR,
        'text-halo-width': 1.2,
        'text-opacity': ['match', ['get', 'tier'], 'stale', 0.55, 1],
      },
    },
    beforeId,
  );
}

// #831: extracted so a SECOND, DOM-based trigger (the keyboard-reachable
// AisVesselsInView list in AisTraffic.tsx) can open the exact same themed
// popup a pointer click on the symbol-layer glyph opens — one renderer of
// aisPopupRows(), never two. `lngLat` is typed as the general LngLatLike so
// a caller with only a target's lat/lon (no MapLayerMouseEvent) can pass a
// plain {lng, lat} object.
// eslint-disable-next-line react-refresh/only-export-components
export function openAisPopup(
  map: MaplibreMap,
  lngLat: LngLatLike,
  props: AisPopupProps,
  t: (key: MsgKey, vars?: Record<string, string | number>) => string,
  lang: Lang,
): Popup {
  const container = document.createElement('div');
  container.className = 'ais-popover';
  for (const row of aisPopupRows(props, Date.now(), lang)) {
    const line = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = `${t(row.labelKey)}: `;
    line.append(label, document.createTextNode(row.value));
    container.append(line);
  }
  const disclaimer = document.createElement('p');
  disclaimer.className = 'ais-popover-disclaimer';
  disclaimer.textContent = t('ais.disclaimer');
  container.append(disclaimer);
  return new Popup({ closeButton: true, maxWidth: '240px', className: 'ais-popup' })
    .setLngLat(lngLat)
    .setDOMContent(container)
    .addTo(map);
}

export default function AisLayer({ targets }: { targets: AisTargetSnapshot[] }) {
  const map = useMapInstance();
  const t = useT();
  const [lang] = useLang();
  const styleReadyRef = useRef(false);
  const tRef = useRef(t);
  // #525: same fixRef idiom as tRef below — the click handler is registered
  // once (deps `[map]`), so it must read the CURRENT language from a ref
  // rather than closing over a stale one from mount.
  const langRef = useRef(lang);
  // Latest snapshot, readable from the style setup below without re-running
  // that effect per snapshot: a re-add after a mid-session style reload must
  // paint the CURRENT targets, not the ones the mount effect closed over
  // (#153, BoatMarker's fixRef idiom).
  const targetsRef = useRef(targets);
  useEffect(() => {
    tRef.current = t;
    langRef.current = lang;
    targetsRef.current = targets;
  });

  // Source/layer/image setup — run once the style is ready and re-run after
  // every style reload via the shared installStyleSetup hook (#153): a
  // mid-session map.setStyle() drops custom sources/layers/images, and
  // 'styledata' fires once the replacement style is in place. The guard makes
  // routine 'styledata' firings (any addLayer map-wide, including this
  // setup's own adds) cheap no-ops; the styleReadyRef half admits a remount
  // that finds the previous instance's layers still in place (AisLayer never
  // removes them) and must still repaint + re-arm its own setData effect.
  useEffect(() => {
    if (!map) return;
    const setup = () => {
      if (map.getSource(AIS_SOURCE) && styleReadyRef.current) return;
      registerAisImages(map);
      setupLayers(map);
      styleReadyRef.current = true;
      // Paint whatever targets already arrived (first ready) or the current
      // snapshot (re-add after a reload).
      (map.getSource(AIS_SOURCE) as GeoJSONSource | undefined)?.setData(
        aisFeatureCollection(targetsRef.current),
      );
    };
    // Unmount: the layers stay in place for the map's lifetime (as before),
    // but both listeners must go — a post-unmount 'load'/'styledata' must
    // never resurrect anything ownerless.
    return installStyleSetup(map, setup);
  }, [map]);

  // ≤1 Hz setData: `targets` is already published at ≤1 Hz by useAisTraffic.
  useEffect(() => {
    if (!map || !styleReadyRef.current) return;
    (map.getSource(AIS_SOURCE) as GeoJSONSource | undefined)?.setData(
      aisFeatureCollection(targets),
    );
  }, [map, targets]);

  // Tap a vessel -> themed popup (seamark pattern): built via DOM APIs, one
  // popup at a time, dismissed by a tap elsewhere (MapLibre default). The
  // build+open logic itself is the exported openAisPopup() below (#831) so
  // the keyboard-reachable vessel list (AisTraffic.tsx's AisVesselsInView)
  // opens the IDENTICAL popup a pointer click does, rather than a second
  // hand-rolled renderer of the same aisPopupRows() data.
  useEffect(() => {
    if (!map) return;
    const handleClick = (e: MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties as Record<string, unknown> | undefined;
      if (!p) return;
      const props: AisPopupProps = {
        mmsi: String(p.mmsi ?? ''),
        name: String(p.name ?? ''),
        shipType: typeof p.shipType === 'number' ? p.shipType : null,
        sog: typeof p.sog === 'number' ? p.sog : null,
        cog: typeof p.cog === 'number' ? p.cog : null,
        heading: typeof p.heading === 'number' ? p.heading : null,
        lastUpdateMs: typeof p.lastUpdateMs === 'number' ? p.lastUpdateMs : Date.now(),
      };
      openAisPopup(map, e.lngLat, props, tRef.current, langRef.current);
    };
    const enter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', AIS_VESSEL_LAYER, handleClick);
    map.on('mouseenter', AIS_VESSEL_LAYER, enter);
    map.on('mouseleave', AIS_VESSEL_LAYER, leave);
    return () => {
      map.off('click', AIS_VESSEL_LAYER, handleClick);
      map.off('mouseenter', AIS_VESSEL_LAYER, enter);
      map.off('mouseleave', AIS_VESSEL_LAYER, leave);
    };
  }, [map]);

  return null;
}
