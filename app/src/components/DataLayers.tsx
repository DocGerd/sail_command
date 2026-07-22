import { useEffect, useRef, useState } from 'react';
import { Map as MaplibreMap, Popup } from 'maplibre-gl';
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import { loadRoutingAssets, type RoutingAssets } from '../services/assets';
import { harborFeatureCollection } from '../lib/harborGeoJson';
import { seamarkFeatureCollectionWithIcons } from '../lib/seamarkGeoJson';
import { registerSeamarkImages } from '../lib/seamarkGlyphs';
import { seamarkPopoverRows } from '../lib/seamarkPopover';
import { buildDepthImageData, depthSourceCorners } from '../lib/depthColor';
import { usePersistedToggle } from '../lib/usePersistedToggle';
import { ROUTE_STACK_BOTTOM_LAYER } from './RouteLayer';
import type { Harbor, MaskMeta, SeamarkProperties } from '../types';

// Always-mounted host for the plan-independent map data layers (#38 harbor
// markers, #39 depth overlay). Deliberately a SIBLING of RouteLayer, not part
// of it: RouteLayer is plan-gated (`if (!plan) return null`), while harbors
// and bathymetry are most useful BEFORE any plan exists.
//
// Not unit-tested beyond its pure helpers (harborGeoJson.ts, depthColor.ts):
// jsdom has no MapLibre/WebGL/canvas runtime — same rationale as
// RouteLayer.tsx's own note; App.test.tsx covers the click-to-pick wiring
// through a mocked map, and the real rendering is verified in-browser.

export interface DataLayersProps {
  // A click on a harbor marker, resolved to the curated harbor. App.tsx turns
  // it into the same PickedPoint shape the PlannerPanel search picker builds.
  onHarborPick: (harbor: Harbor) => void;
}

const DEPTH_SOURCE = 'sc-depth';
const DEPTH_LAYER = 'sc-depth';
const HARBOR_SOURCE = 'sc-harbors';
// Exported so App can hand MapView the same id its raw-tap gate queries: the
// 'sc-harbor-points' literal lives in one place in production source. (The
// App.test.tsx FakeMap still hardcodes it — a vi.mock factory is hoisted above
// the imports and can't reference this constant.) (#38)
export const HARBOR_CIRCLE_LAYER = 'sc-harbor-points';
const HARBOR_LABEL_LAYER = 'sc-harbor-labels';
const SEAMARKS_SOURCE = 'sc-seamarks';
// Exported for the same reason as HARBOR_CIRCLE_LAYER: App hands MapView this
// id so a click landing on a seamark glyph is gated OUT of the generic
// tap-to-pick handler (a seamark click always opens the info popover below,
// never sets origin/destination). (#7)
export const SEAMARKS_LAYER = 'sc-seamarks';

// Deterministic cross-component layer ordering, anchored on RouteLayer's
// bottom-most layer (ROUTE_STACK_BOTTOM_LAYER, the shallow casing — the first
// its setupLayers adds — imported so a rename can't silently drop the
// ordering). Both components add layers
// whenever their own prerequisites happen to resolve, so ordering must hold for
// either interleaving, not by load-order luck:
// - Route layers exist first (the common case — they only wait for the map
//   style, while these layers also wait for the assets fetch): everything
//   here is inserted BEFORE the anchor, i.e. below the whole route stack.
// - These layers exist first: RouteLayer appends its layers with no beforeId,
//   which always lands them on top.
// Either way route/maneuver/barb layers render above, and an active route
// stays fully visible.

// Same one-shot helper as RouteLayer.tsx's whenStyleReady — see the caveats
// documented there (map 'load' fires exactly once; only valid for one-time
// setup, never for repeated updates).
function whenStyleReady(map: MaplibreMap, fn: () => void): void {
  if (map.isStyleLoaded()) fn();
  else map.once('load', fn);
}

// One-time raster build (#39): decode the INTACT main-thread mask buffer
// (usePlanFlow only ever transfers a .slice(0) copy to the worker, so reading
// here never touches routing), color it via the pure depth ramp, and draw the
// vertically-flipped result (mask row 0 = south, canvas row 0 = north) into a
// canvas for a MapLibre canvas source. MapLibre resamples on pan/zoom — no
// per-frame redraw. Returns null where there's no 2D canvas backend (jsdom).
function buildDepthCanvas(meta: MaskMeta, buffer: ArrayBuffer): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = meta.cols;
  canvas.height = meta.rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = ctx.createImageData(meta.cols, meta.rows);
  image.data.set(buildDepthImageData(new Uint8Array(buffer), meta.rows, meta.cols));
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function setupLayers(map: MaplibreMap, meta: MaskMeta, maskBuffer: ArrayBuffer): void {
  // Anchor resolved at add time — see ROUTE_STACK_BOTTOM_LAYER above.
  const beforeId = map.getLayer(ROUTE_STACK_BOTTOM_LAYER) ? ROUTE_STACK_BOTTOM_LAYER : undefined;
  if (!map.getSource(DEPTH_SOURCE)) {
    const canvas = buildDepthCanvas(meta, maskBuffer);
    if (canvas) {
      map.addSource(DEPTH_SOURCE, {
        type: 'canvas',
        canvas,
        animate: false,
        // Corner order (top-left, top-right, bottom-right, bottom-left) derived
        // from the mask bbox — kept in depthColor.ts alongside the row-flip it
        // must stay coupled to, and unit-tested there.
        coordinates: depthSourceCorners(meta),
      });
      map.addLayer(
        {
          id: DEPTH_LAYER,
          type: 'raster',
          source: DEPTH_SOURCE,
          // Hidden at creation; the depthVisible sync effect (below, same
          // commit) applies the persisted/default state — ON for a fresh
          // profile (#63) — before any paint.
          layout: { visibility: 'none' },
          // Opacity lives in the ramp's per-pixel alpha (land fully
          // transparent, deep water fading out); no fade so the toggle
          // flips instantly.
          paint: { 'raster-fade-duration': 0 },
        },
        beforeId,
      );
    }
  }
  if (!map.getSource(HARBOR_SOURCE)) {
    map.addSource(HARBOR_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }, // populated by the lang-following data effect
    });
    map.addLayer(
      {
        id: HARBOR_CIRCLE_LAYER,
        type: 'circle',
        source: HARBOR_SOURCE,
        paint: {
          // Black fill + white stroke (#38/#39 review): the prior #E69F00
          // collided with depthColor.ts's ~2 m ramp band (orange markers over
          // orange shallows). Black is distinct from every depth-ramp stop and,
          // being achromatic, can't collide with any symbol on the map under
          // colour-blindness; the 2 px white stroke keeps it popping over both
          // plain water and every band of the depth raster.
          'circle-radius': 5.5,
          'circle-color': '#000000',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: HARBOR_LABEL_LAYER,
        type: 'symbol',
        source: HARBOR_SOURCE,
        layout: {
          'text-field': ['get', 'name'],
          // Explicit stack: it must exist under basemap-assets/fonts/ —
          // MapLibre's implicit default stack does not.
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-anchor': 'top',
          'text-offset': [0, 0.8],
          // Collision-culled (unlike the maneuver letters): 33 labels around
          // a small map would otherwise pile up at low zoom.
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#1a1a1a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.2,
        },
      },
      beforeId,
    );
  }
  if (!map.getSource(SEAMARKS_SOURCE)) {
    map.addSource(SEAMARKS_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }, // populated once seamarks.json resolves
    });
    map.addLayer(
      {
        id: SEAMARKS_LAYER,
        type: 'symbol',
        source: SEAMARKS_SOURCE,
        layout: {
          // Precomputed per feature (seamarkFeatureCollectionWithIcons) —
          // seamarkType/category alone can't distinguish e.g. a red from a
          // green lateral buoy, which the glyph fidelity needs (seamarkGlyphs.ts).
          'icon-image': ['get', 'icon'],
          // ~1,794 points is dense enough that unculled icons would pile up
          // at low zoom (unlike the 33 harbor markers) — collision-cull like
          // the harbor labels, not like the sparser route wind barbs.
          'icon-allow-overlap': false,
          'icon-size': 0.85,
          // Hidden at creation; the seamarksVisible sync effect (below, same
          // commit) applies the persisted/default state — OFF for a fresh
          // profile (#7, opt-in specialist layer) — before any paint.
          visibility: 'none',
        },
      },
      beforeId,
    );
  }
}

export default function DataLayers({ onHarborPick }: DataLayersProps) {
  const map = useMapInstance();
  const [lang] = useLang();
  const t = useT();
  // #63: default ON, persisted — mirrors RouteLayer's barbs/annotations
  // toggles. An explicit "off" survives reloads; a fresh profile sees depth.
  const [depthVisible, setDepthVisible] = usePersistedToggle('sc-depth-visible', true);
  // #7: default OFF — ~1,794 points is a dense specialist layer (vs. 33
  // harbor markers) that would clutter the map before the user opts in.
  const [seamarksVisible, setSeamarksVisible] = usePersistedToggle('sc-seamarks-visible', false);
  const [assets, setAssets] = useState<RoutingAssets | null>(null);
  // Same pattern and rationale as RouteLayer's styleReady state. Registered
  // from a [map]-effect (below) so the whenStyleReady call happens at map
  // arrival — BEFORE 'load' can have fired. Waiting for the assets fetch
  // first and only then calling whenStyleReady would race: by then 'load'
  // may already be history while isStyleLoaded() transiently reads false
  // (tiles streaming — see RouteLayer's whenStyleReady caveats), stranding a
  // once('load') that never fires.
  const [styleReady, setStyleReady] = useState(false);

  // Module-cached promise shared with App.tsx's own eager load — no second
  // fetch. Best-effort like App's: a failed fetch just leaves the layers off
  // the map, it must not take the app down.
  useEffect(() => {
    let cancelled = false;
    void loadRoutingAssets()
      .then((a) => {
        if (!cancelled) setAssets(a);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!map) return;
    whenStyleReady(map, () => setStyleReady(true));
  }, [map]);

  // Source/layer creation, gated on BOTH the style and the assets (unlike
  // RouteLayer, the data here comes from a fetch, not props). setupLayers is
  // idempotent (getSource guards), and every dependency transitions at most
  // once — this effectively runs once, with no setState of its own: the
  // downstream effects share these deps and are declared AFTER this one, so
  // within the commit that finally has map+style+assets they re-run in order
  // and find the sources/layers already created.
  useEffect(() => {
    if (!map || !styleReady || !assets) return;
    setupLayers(map, assets.maskMeta, assets.maskBuffer);
  }, [map, styleReady, assets]);

  // Harbor features follow the active language (#38: relabel on switch) —
  // rebuild the 33-feature collection rather than juggling per-lang fields.
  useEffect(() => {
    if (!map || !styleReady || !assets) return;
    (map.getSource(HARBOR_SOURCE) as GeoJSONSource | undefined)?.setData(
      harborFeatureCollection(assets.harbors, lang),
    );
  }, [map, styleReady, assets, lang]);

  // `assets` is a genuine dependency even though unused in the body: the
  // depth layer only exists once the setup effect (which needs assets) has
  // run, so this must re-sync after that transition, not just on toggles.
  useEffect(() => {
    if (!map || !styleReady || !assets || !map.getLayer(DEPTH_LAYER)) return;
    map.setLayoutProperty(DEPTH_LAYER, 'visibility', depthVisible ? 'visible' : 'none');
  }, [map, styleReady, assets, depthVisible]);

  // Seamark glyphs (#7) — registered/set once per assets load, independent of
  // the visibility toggle (so the layer is ready to paint the instant the
  // user opts in, no flash of unstyled icons). registerSeamarkImages is
  // idempotent (hasImage guard), so this is safe to re-run.
  useEffect(() => {
    if (!map || !styleReady || !assets) return;
    const withIcons = seamarkFeatureCollectionWithIcons(assets.seamarks);
    registerSeamarkImages(
      map,
      withIcons.features.map((f) => f.properties),
    );
    (map.getSource(SEAMARKS_SOURCE) as GeoJSONSource | undefined)?.setData(withIcons);
  }, [map, styleReady, assets]);

  useEffect(() => {
    if (!map || !styleReady || !assets || !map.getLayer(SEAMARKS_LAYER)) return;
    map.setLayoutProperty(SEAMARKS_LAYER, 'visibility', seamarksVisible ? 'visible' : 'none');
  }, [map, styleReady, assets, seamarksVisible]);

  // Click a seamark glyph -> a small info popover (type/category/colour,
  // light character/colour/period when tagged) — never a route pick (#7):
  // seamarks aren't route-pickable points, unlike harbor markers, so this
  // owns its own popup rather than calling back into App/PlannerPanel state.
  useEffect(() => {
    if (!map || !styleReady || !assets) return;
    const handleClick = (e: MapLayerMouseEvent) => {
      const props = e.features?.[0]?.properties as SeamarkProperties | undefined;
      if (!props) return;
      const container = document.createElement('div');
      container.className = 'seamark-popover';
      for (const row of seamarkPopoverRows(props)) {
        const line = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = `${t(row.labelKey)}: `;
        line.append(label, document.createTextNode(row.value));
        container.append(line);
      }
      const disclaimer = document.createElement('p');
      disclaimer.className = 'seamark-popover-disclaimer';
      disclaimer.textContent = t('app.disclaimer');
      container.append(disclaimer);
      new Popup({ closeButton: true, maxWidth: '240px' })
        .setLngLat(e.lngLat)
        .setDOMContent(container)
        .addTo(map);
    };
    const handleEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const handleLeave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', SEAMARKS_LAYER, handleClick);
    map.on('mouseenter', SEAMARKS_LAYER, handleEnter);
    map.on('mouseleave', SEAMARKS_LAYER, handleLeave);
    return () => {
      map.off('click', SEAMARKS_LAYER, handleClick);
      map.off('mouseenter', SEAMARKS_LAYER, handleEnter);
      map.off('mouseleave', SEAMARKS_LAYER, handleLeave);
    };
  }, [map, styleReady, assets, t]);

  // Click-to-pick + hover cursor on the harbor circles. The callback lives in
  // a ref so a re-render of App (new onHarborPick identity) doesn't
  // re-register map listeners.
  const onHarborPickRef = useRef(onHarborPick);
  useEffect(() => {
    onHarborPickRef.current = onHarborPick;
  });

  useEffect(() => {
    if (!map || !styleReady || !assets) return;
    const handleClick = (e: MapLayerMouseEvent) => {
      const id: unknown = e.features?.[0]?.properties?.id;
      const harbor = assets.harbors.find((h) => h.id === id);
      if (harbor) onHarborPickRef.current(harbor);
    };
    const handleEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const handleLeave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', HARBOR_CIRCLE_LAYER, handleClick);
    map.on('mouseenter', HARBOR_CIRCLE_LAYER, handleEnter);
    map.on('mouseleave', HARBOR_CIRCLE_LAYER, handleLeave);
    return () => {
      map.off('click', HARBOR_CIRCLE_LAYER, handleClick);
      map.off('mouseenter', HARBOR_CIRCLE_LAYER, handleEnter);
      map.off('mouseleave', HARBOR_CIRCLE_LAYER, handleLeave);
    };
  }, [map, styleReady, assets]);

  // Always-mounted control cluster — top-LEFT of the map, so it can never
  // collide with RouteLayer's plan-gated cluster at the top-right (app.css).
  return (
    <div className="data-layer-controls">
      <label>
        <input
          type="checkbox"
          checked={depthVisible}
          onChange={(e) => setDepthVisible(e.target.checked)}
        />
        {t('map.depth.toggle')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={seamarksVisible}
          onChange={(e) => setSeamarksVisible(e.target.checked)}
        />
        {t('map.seamarks.toggle')}
      </label>
    </div>
  );
}
