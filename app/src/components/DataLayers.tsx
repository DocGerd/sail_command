import { useEffect, useRef, useState } from 'react';
import { Popup } from 'maplibre-gl';
import type { GeoJSONSource, Map as MaplibreMap, MapLayerMouseEvent } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import { loadRoutingAssets, type RoutingAssets } from '../services/assets';
import { harborFeatureCollection } from '../lib/harborGeoJson';
import { SEAMARKS_LAYOUT, seamarkFeatureCollectionWithIcons } from '../lib/seamarkGeoJson';
import { registerSeamarkImages } from '../lib/seamarkGlyphs';
import { seamarkPopoverRows } from '../lib/seamarkPopover';
import { buildDepthImageData, depthSourceCorners } from '../lib/depthColor';
import { installStyleSetup } from '../lib/styleReload';
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
          // ~1,794 points is dense enough that unculled icons would pile up
          // at low zoom (unlike the 33 harbor markers). #144: the culling is
          // priority-ordered (symbol-sort-key) with a z>=12 tap-safety
          // overlap valve and a zoom size taper — expressions pinned in
          // seamarkGeoJson.test.ts, rationale on SEAMARKS_LAYOUT itself.
          ...SEAMARKS_LAYOUT,
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
  // Same pattern and rationale as RouteLayer's styleEpoch: 0 = this
  // component's sources/layers don't exist yet; 1 once style AND assets are
  // first ready; +1 after every style-reload re-add (#153). The downstream
  // effects depend on it so each pass re-observes the current lang/toggle
  // state and repaints the freshly re-created sources.
  const [styleEpoch, setStyleEpoch] = useState(0);
  // True from the shared hook's first setup invocation on — i.e. once the
  // style is parsed. A ref, not state: the assets-arrival effect below needs
  // it synchronously and must not re-render anything itself.
  const styleReadyRef = useRef(false);
  // Latest assets, readable from the style setup without re-arming it (the
  // hook must be installed exactly once per map instance — see below).
  const assetsRef = useRef<RoutingAssets | null>(null);
  useEffect(() => {
    assetsRef.current = assets;
  });
  const setupRef = useRef<() => void>(() => {});

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

  // Style-setup arming. Installed from a [map]-effect so it happens at map
  // arrival — BEFORE 'load' can have fired (the installStyleSetup contract;
  // arming it only once assets resolve would race: by then 'load' may
  // already be history while isStyleLoaded() transiently reads false with
  // tiles streaming, stranding a once('load') that never fires). Source/
  // layer creation is gated on BOTH the style and the assets (unlike
  // RouteLayer, the data here comes from a fetch, not props): before assets
  // resolve, setup only records style readiness; the arrival effect below
  // calls back in. setupLayers keeps its own per-source guards; `missing`
  // additionally gates the epoch bump so routine 'styledata' firings stay
  // cheap no-ops (the updater returns the same value and React bails out),
  // while a style RELOAD (#153) — which wipes this component's sources —
  // re-creates them and bumps the epoch so the downstream effects repaint.
  // The `e === 0` half admits a remount that finds the previous instance's
  // layers still in place (DataLayers never removes them).
  useEffect(() => {
    if (!map) return;
    const setup = () => {
      styleReadyRef.current = true;
      const a = assetsRef.current;
      if (!a) return; // assets still loading — the arrival effect calls back in
      const missing = !map.getSource(HARBOR_SOURCE);
      if (missing) setupLayers(map, a.maskMeta, a.maskBuffer);
      setStyleEpoch((e) => (missing || e === 0 ? e + 1 : e));
    };
    setupRef.current = setup;
    const dispose = installStyleSetup(map, setup);
    return () => {
      styleReadyRef.current = false;
      setupRef.current = () => {};
      dispose();
    };
  }, [map]);

  // Assets usually resolve AFTER the style is ready. Re-arming the hook at
  // that point would risk the stranded-once('load') race documented above —
  // instead the already-armed setup is invoked directly, gated on the
  // readiness it recorded.
  useEffect(() => {
    if (!map || !assets || !styleReadyRef.current) return;
    setupRef.current();
  }, [map, assets]);

  // Harbor features follow the active language (#38: relabel on switch) —
  // rebuild the 33-feature collection rather than juggling per-lang fields.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
    (map.getSource(HARBOR_SOURCE) as GeoJSONSource | undefined)?.setData(
      harborFeatureCollection(assets.harbors, lang),
    );
  }, [map, styleEpoch, assets, lang]);

  // `assets` is a genuine dependency even though unused in the body: the
  // depth layer only exists once the setup effect (which needs assets) has
  // run, so this must re-sync after that transition, not just on toggles.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets || !map.getLayer(DEPTH_LAYER)) return;
    map.setLayoutProperty(DEPTH_LAYER, 'visibility', depthVisible ? 'visible' : 'none');
  }, [map, styleEpoch, assets, depthVisible]);

  // Seamark glyphs (#7) — registered/set once per assets load, independent of
  // the visibility toggle (so the layer is ready to paint the instant the
  // user opts in, no flash of unstyled icons). registerSeamarkImages is
  // idempotent (hasImage guard), so this is safe to re-run.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
    const withIcons = seamarkFeatureCollectionWithIcons(assets.seamarks);
    registerSeamarkImages(
      map,
      withIcons.features.map((f) => f.properties),
    );
    (map.getSource(SEAMARKS_SOURCE) as GeoJSONSource | undefined)?.setData(withIcons);
  }, [map, styleEpoch, assets]);

  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets || !map.getLayer(SEAMARKS_LAYER)) return;
    map.setLayoutProperty(SEAMARKS_LAYER, 'visibility', seamarksVisible ? 'visible' : 'none');
  }, [map, styleEpoch, assets, seamarksVisible]);

  // Click a seamark glyph -> a small info popover (type/category/colour,
  // light character/colour/period when tagged) — never a route pick (#7):
  // seamarks aren't route-pickable points, unlike harbor markers, so this
  // owns its own popup rather than calling back into App/PlannerPanel state.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
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
      new Popup({ closeButton: true, maxWidth: '240px', className: 'seamark-popup' })
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
  }, [map, styleEpoch, assets, t]);

  // Click-to-pick + hover cursor on the harbor circles. The callback lives in
  // a ref so a re-render of App (new onHarborPick identity) doesn't
  // re-register map listeners.
  const onHarborPickRef = useRef(onHarborPick);
  useEffect(() => {
    onHarborPickRef.current = onHarborPick;
  });

  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
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
  }, [map, styleEpoch, assets]);

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
