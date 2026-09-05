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
 * AIS vessels differ from seamarks in the mechanism that makes growth safe.
 * Seamarks confine their #860 growth to z>=12, the zoom band where
 * `icon-overlap` flips to 'always' (immune to being CULLED there). AIS
 * vessels are `icon-allow-overlap: true` UNCONDITIONALLY — every zoom, not
 * zoom-gated — so AIS glyphs were never at risk of being culled themselves.
 * But growing `icon-size` still grows AIS's own COLLISION BOX
 * (`icon-ignore-placement` is unset), and AIS sits ABOVE DataLayers' whole
 * harbor/seamark stack in placement priority (#160: DataLayers inserts
 * below the AIS stack, and placement runs top-to-bottom), so a bigger AIS
 * box could newly cull a lower-priority label near a vessel — the #378
 * shape: `icon-allow-overlap` without `icon-ignore-placement` still blocks
 * OTHERS.
 *
 * The fix therefore does not rely on a safe zoom band: it adds ONE new stop
 * at z13 (1.4, matching seamarks' own #860 choice: 1.4 * 32 = 44.8px,
 * clearing 44px with margin for float rounding) paired with an
 * `icon-padding` compensation (the #191 lever — "the lever for enlarging a
 * tap target without changing the collision footprint") solved so the
 * collision footprint (iconPx + 2*paddingPx) is the pre-#957 z12 value
 * (28.8 + 2*2 = 32.8px) at BOTH z12 and z13. Because icon-size and
 * icon-padding are each linear in zoom between those two points, matching
 * footprint at the endpoints holds it CONSTANT across the whole [12,13]
 * segment — two linear functions agreeing at two points agree everywhere
 * between them — and both clamp flat past z13, so the invariant holds
 * forever above it too. z8-z12 stay BYTE-IDENTICAL to before: no new stop,
 * and icon-padding's domain starts at 12 so it flat-extrapolates to the
 * MapLibre default (2px/side) below it.
 */
const AIS_VESSEL_ICON_SIZE: NonNullable<
  NonNullable<SymbolLayerSpecification['layout']>['icon-size']
> = ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 0.9, 13, 1.4];
const AIS_VESSEL_ICON_PADDING: NonNullable<
  NonNullable<SymbolLayerSpecification['layout']>['icon-padding']
> = ['interpolate', ['linear'], ['zoom'], 12, 2, 13, -6];

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
    'icon-padding': AIS_VESSEL_ICON_PADDING,
    'icon-allow-overlap': true,
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
