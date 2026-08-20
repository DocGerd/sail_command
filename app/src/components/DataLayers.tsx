import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popup } from 'maplibre-gl';
import type {
  CanvasSource,
  GeoJSONSource,
  Map as MaplibreMap,
  MapLayerMouseEvent,
} from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useSettings } from '../state/AppState';
import { useLang, useT } from '../i18n';
import { loadRoutingAssets, type RoutingAssets } from '../services/assets';
import { harborFeatureCollection } from '../lib/harborGeoJson';
import {
  SEAMARKS_LAYOUT,
  pickSeamarkByPriority,
  seamarkDisplayFilter,
  seamarkFeatureCollectionWithIcons,
  seamarksLayout,
} from '../lib/seamarkGeoJson';
import {
  SEAMARK_SIZE_MAX,
  SEAMARK_SIZE_MIN,
  SEAMARK_SIZE_SCALE,
  registerSeamarkImages,
  seamarkImageIds,
  toSeamarkDisplayTier,
} from '../lib/seamarkGlyphs';
import { resolveSeamarkPopoverValue, seamarkPopoverRows } from '../lib/seamarkPopover';
import {
  buildDepthImageData,
  buildNavigabilityHatchImageData,
  depthSourceCorners,
} from '../lib/depthColor';
import { installStyleSetup } from '../lib/styleReload';
import { usePersistedToggle } from '../lib/usePersistedToggle';
import { usePersistedNumber } from '../lib/usePersistedNumber';
import { ROUTE_STACK_BOTTOM_LAYER } from './RouteLayer';
import { AIS_STACK_BOTTOM_LAYER } from './AisLayer';
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
// #492: the sparse hazard-hatch overlay — a SECOND canvas source/layer, kept
// structurally separate from DEPTH_SOURCE/DEPTH_LAYER above (depthColor.ts's
// HARD DOMAIN RULE: the absolute ramp never tracks safetyDepthM).
const DEPTH_HATCH_SOURCE = 'sc-depth-hatch';
const DEPTH_HATCH_LAYER = 'sc-depth-hatch';
// Debounce for rebuilding the hatch raster after safetyDepthM changes — the
// mask is ~5.28M cells, so this must not run on every keystroke/tick of
// whatever control edits the setting. 300ms: today's only editor
// (SettingsPanel/PlannerPanel's NumberInput, via SAFETY_DEPTH_FIELD) commits
// exclusively on blur (NumberInput.tsx: onCommit fires in handleBlur only),
// so a burst of rebuilds is not reachable through the number field at all —
// this debounce is cheap insurance against (a) a future continuous-drag
// control, and (b) the one burst path that IS live today: BoatPicker's boat
// radios select on arrow-key FOCUS, so arrowing through the list clamps
// safetyDepthM up once per boat traversed, at key-repeat rate (see
// BoatPicker.tsx's handleSelect comment). 300ms coalesces that while
// staying imperceptible for a single deliberate blur-commit. MEASURED
// (#492 review m6, in-browser Chromium against the real 2200x2400 mask,
// createImageData+putImageData included — same method as the e2e suite):
// three samples gave 28.3/28.7/28.5 ms for the hatch build vs 143.8/142.2/
// 144.5 ms for buildDepthCanvas's own absolute-ramp build — same order of
// magnitude, hatch ~5x cheaper (its LUT is a single boolean per byte, not
// an RGBA interpolation). Either way the debounce, not the compute, is the
// actual lag budget: today's only reachable path (a blur commit) always
// pays this 300 ms before the safety cue updates, not the ~30 ms build
// cost itself.
const DEPTH_HATCH_DEBOUNCE_MS = 300;
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

// Deterministic cross-component layer ordering. Documented invariant (#160,
// AisLayer's setupLayers): route stack above the AIS stack above these
// overlays. Each component adds layers whenever its own prerequisites happen
// to resolve, so the order must hold for EVERY interleaving, not by
// load-order luck. Anchors, each resolved at add time (both ids imported so
// a rename can't silently drop the ordering):
// - This component inserts below the AIS stack's bottom-most layer
//   (AIS_STACK_BOTTOM_LAYER) when AisLayer set up first (its layers only
//   wait for the map style, while these also wait for the assets fetch);
//   otherwise below RouteLayer's bottom-most layer (ROUTE_STACK_BOTTOM_LAYER,
//   the shallow casing — the first its setupLayers adds); otherwise appended.
// - AisLayer inserts below ROUTE_STACK_BOTTOM_LAYER, or appends: a
//   later-arriving AIS stack lands directly under the route anchor — above
//   overlays already sitting there — or on top of everything so far, and a
//   later-arriving overlay stack slots in underneath it via the AIS anchor.
// - RouteLayer appends with no beforeId, which always lands it on top.
// The same anchor resolution re-runs on every styledata re-add (#153), so a
// style reload re-establishes the identical order for any listener firing
// order. Either way route/maneuver/barb layers render above, an active route
// stays fully visible, and AIS traffic is never buried under seamarks.

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

// #492: same shape as buildDepthCanvas above, but for the navigability-hatch
// raster — a SEPARATE canvas/image, never merged into buildDepthCanvas's
// buffer (depthColor.ts's HARD DOMAIN RULE). Built with the CURRENT
// safetyDepthM at setup time so the cue is correct from the very first
// paint; later changes are repainted by rebuildHatchCanvas below, debounced.
function buildHatchCanvas(
  meta: MaskMeta,
  buffer: ArrayBuffer,
  safetyDepthM: number,
): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = meta.cols;
  canvas.height = meta.rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = ctx.createImageData(meta.cols, meta.rows);
  image.data.set(
    buildNavigabilityHatchImageData(new Uint8Array(buffer), meta.rows, meta.cols, safetyDepthM),
  );
  ctx.putImageData(image, 0, 0);
  return canvas;
}

// #492: repaints the ALREADY-CREATED hatch canvas in place (never
// removes/re-adds the source or layer — that would churn map state and risk
// a visible flash) whenever safetyDepthM changes, via the debounced effect
// below. `animate: false` (set at addSource, same as DEPTH_SOURCE) means
// MapLibre's CanvasSource only re-uploads its GL texture on a dimension
// change or while `_playing` is true
// (node_modules/maplibre-gl/src/source/canvas_source.ts's prepare()/play()/
// pause(), re-derived against maplibre-gl@6.3.0 — app/package-lock.json's
// pinned version as of this change): play() sets `_playing = true` and
// triggers a repaint; pause() re-uploads the texture (prepare()) THEN clears
// `_playing`. Calling both back-to-back therefore forces exactly one
// re-upload of the freshly painted pixels, then returns to the static,
// non-polling state — this stays a one-time raster build per change, not a
// per-frame redraw.
function rebuildHatchCanvas(
  map: MaplibreMap,
  meta: MaskMeta,
  maskBuffer: ArrayBuffer,
  safetyDepthM: number,
): void {
  const source = map.getSource(DEPTH_HATCH_SOURCE) as CanvasSource | undefined;
  if (!source) return;
  const canvas = source.getCanvas();
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // no 2D backend (jsdom) — matches buildHatchCanvas's own guard
  const image = ctx.createImageData(meta.cols, meta.rows);
  image.data.set(
    buildNavigabilityHatchImageData(new Uint8Array(maskBuffer), meta.rows, meta.cols, safetyDepthM),
  );
  ctx.putImageData(image, 0, 0);
  source.play();
  source.pause();
}

function setupLayers(
  map: MaplibreMap,
  meta: MaskMeta,
  maskBuffer: ArrayBuffer,
  safetyDepthM: number,
): void {
  // Anchor resolved at add time — see the ordering note above (#160).
  const beforeId = map.getLayer(AIS_STACK_BOTTOM_LAYER)
    ? AIS_STACK_BOTTOM_LAYER
    : map.getLayer(ROUTE_STACK_BOTTOM_LAYER)
      ? ROUTE_STACK_BOTTOM_LAYER
      : undefined;
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
  // #492: the hazard-hatch overlay. Added with the SAME beforeId anchor
  // right after DEPTH_LAYER above — MapLibre stacks same-beforeId additions
  // in INSERTION order (each addLayer(layer, beforeId) call inserts
  // immediately below beforeId, so a later call ends up ABOVE an earlier
  // one), so this paints directly ABOVE the absolute ramp (legible over it)
  // and, because every layer added further down this function (harbor
  // circles/labels, seamarks) also shares beforeId, BELOW all of them (never
  // obscures a click target or glyph). It also stays below the AIS/Route
  // stack via the shared anchor itself — a plotted route's own #53 shallow
  // casing, or AIS traffic, always wins if they ever visually coincide,
  // which is the safe direction: a general navigability cue should never
  // outrank a specific, already-computed safety warning.
  //
  // #492 review m9: this DOUBLES the depth overlay's retained memory —
  // arithmetic, not measured (this environment has no device/GPU profiler
  // to read GL texture memory back from): the mask is 2200x2400 cells
  // (mask.meta.json), so ONE full-resolution RGBA canvas backing store is
  // 2200*2400*4 = 21.12 MB, and CanvasSource.prepare() uploads it to an
  // equally-sized GL texture — ~42.2 MB total for this canvas, on top of
  // buildDepthCanvas's identical ~42.2 MB for the absolute ramp, so ~84.5 MB
  // retained for the depth overlay alone once both layers exist. Not
  // verified against a real mid-range device (none available here); the
  // e2e suite elsewhere exercises depth+AIS+route together without a crash,
  // which is weak evidence, not a memory profile. If this turns out to
  // matter, M8's screen-space fill-pattern alternative (#599, see
  // depthColor.ts's HATCH_PERIOD_CELLS comment) would also remove this
  // second full-resolution raster entirely — not attempted here, since the
  // maintainer's decision for THIS change was explicitly a second
  // COMPOSITED layer, and merging the two canvases is the one thing the
  // HARD DOMAIN RULE separation exists to prevent.
  if (!map.getSource(DEPTH_HATCH_SOURCE)) {
    const hatchCanvas = buildHatchCanvas(meta, maskBuffer, safetyDepthM);
    if (hatchCanvas) {
      map.addSource(DEPTH_HATCH_SOURCE, {
        type: 'canvas',
        canvas: hatchCanvas,
        animate: false,
        coordinates: depthSourceCorners(meta),
      });
      map.addLayer(
        {
          id: DEPTH_HATCH_LAYER,
          type: 'raster',
          source: DEPTH_HATCH_SOURCE,
          // Hidden at creation, same convention as DEPTH_LAYER — the
          // depthVisible sync effect applies the current state before any
          // paint. No independent toggle: the hatch is a navigability
          // annotation over the depth overlay, not an opt-in of its own.
          layout: { visibility: 'none' },
          paint: {
            'raster-fade-duration': 0,
            // #492 review M8: MapLibre's default 'linear' resampling
            // smears the hatch's hard-edged stripes into soft gradients —
            // an ADDITIONAL artifact on top of the documented zoom-scaling
            // degradation (depthColor.ts's HATCH_PERIOD_CELLS comment),
            // not a fix for it. 'nearest' at least keeps whatever renders
            // crisp rather than blurred. SCOPE, measured against
            // maplibre-gl@6.3.0: this governs MAGNIFICATION only —
            // webgl/draw/draw_raster.ts:119 binds the MINIFICATION filter
            // as a hardcoded gl.LINEAR_MIPMAP_NEAREST third argument
            // (webgl/texture.ts:161-162), independent of this property, so
            // at overview zoom (where the raster is minified) it has no
            // effect at all. The style spec says the same: "texture
            // magnification filter".
            'raster-resampling': 'nearest',
          },
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
  // #492 review m10: DataLayers reads safetyDepthM via useSettings()
  // directly rather than as a prop from App.tsx — a reviewed, confirmed
  // decision, not a stopgap. App.tsx already re-renders DataLayers on
  // every Settings/plan/rig/activeLegIndex change (rendered inline, no
  // memo()), so this context read adds ZERO additional re-renders; a prop
  // would give DataLayers a second, redundant source for a value it can
  // already read directly — this component has no OTHER dependency on
  // App.tsx at all, and already takes map/lang/t from context the same
  // way. See this file's own #492 rebuild-effect comment below for how
  // the value reaches the map.
  const [settings] = useSettings();
  const { safetyDepthM } = settings;
  // #63: default ON, persisted — mirrors RouteLayer's barbs/annotations
  // toggles. An explicit "off" survives reloads; a fresh profile sees depth.
  const [depthVisible, setDepthVisible] = usePersistedToggle('sc-depth-visible', true);
  // #7: default OFF — ~1,794 points is a dense specialist layer (vs. 33
  // harbor markers) that would clutter the map before the user opts in.
  const [seamarksVisible, setSeamarksVisible] = usePersistedToggle('sc-seamarks-visible', false);
  // #353 PR2: the seamark size/display-category controls live in
  // SettingsPanel.tsx, not here — this component only APPLIES the persisted
  // value to the map. Both hooks call `usePersistedNumber` with the SAME
  // keys SettingsPanel uses; the hook's own cross-instance sync (see its
  // module comment) is what keeps this always-mounted component in step
  // with a change made in the (conditionally-mounted) Settings tab, without
  // either component needing a prop from a shared ancestor.
  const [seamarkSizeScaleStored] = usePersistedNumber(
    'sc-seamark-size-scale',
    SEAMARK_SIZE_MIN,
    SEAMARK_SIZE_MAX,
  );
  const seamarkSizeScale = seamarkSizeScaleStored ?? SEAMARK_SIZE_SCALE;
  // #513 R4: bounds are UNCLAMPED (-Infinity/Infinity), deliberately not
  // [BASE, ALL] — `usePersistedNumber`'s own clamp runs BEFORE
  // `toSeamarkDisplayTier` ever sees the value, so a [0, 2]-bounded read
  // would launder a corrupt negative value (e.g. a hand-edited "-1") into a
  // seemingly-valid `0` = BASE, the MOST-HIDDEN tier — exactly backwards
  // from `toSeamarkDisplayTier`'s "fail toward showing" guarantee. Leaving
  // this read unclamped makes `toSeamarkDisplayTier` the SOLE validator.
  const [seamarkDisplayTierStored] = usePersistedNumber(
    'sc-seamark-display-tier',
    -Infinity,
    Infinity,
  );
  const seamarkDisplayTier = toSeamarkDisplayTier(seamarkDisplayTierStored);
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
  // #492: same pattern and rationale as assetsRef above — the style-setup
  // closure below is armed ONCE per map instance/mount and must read the
  // LATEST safetyDepthM at whatever moment a style reload re-creates the
  // hatch source, not the value captured when the closure was created.
  const safetyDepthMRef = useRef(safetyDepthM);
  useEffect(() => {
    safetyDepthMRef.current = safetyDepthM;
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

  // Style-setup arming. Installed exactly once per map instance per mount,
  // from this [map]-effect — the installStyleSetup contract (#159): the hook
  // is safe at any point in the map lifetime, but later dependencies (here
  // the assets arrival) must invoke the already-armed setup directly instead
  // of re-installing it (see the arrival effect below). Source/
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
      if (missing) setupLayers(map, a.maskMeta, a.maskBuffer, safetyDepthMRef.current);
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

  // Assets usually resolve AFTER the style is ready. Per the
  // installStyleSetup contract, the already-armed setup is invoked directly
  // — gated on the readiness it recorded — rather than the hook being
  // re-installed.
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
    // #492: no independent toggle for the hazard-hatch layer — it rides the
    // SAME depthVisible state as the absolute ramp above (this file's
    // FORBIDDEN-file allowlist for this change excludes the i18n dict a new
    // checkbox label would need, and conceptually the hatch is an
    // annotation over the depth overlay, not a separate opt-in). A legend
    // explaining the symbol itself is a separate gap, tracked as #598.
    // Guarded
    // separately from DEPTH_LAYER's own `!map.getLayer` check above since
    // the hatch layer can legitimately not exist yet (jsdom has no 2D
    // canvas backend at all — see buildHatchCanvas — or a slow style reload
    // window) even once DEPTH_LAYER does.
    if (map.getLayer(DEPTH_HATCH_LAYER)) {
      map.setLayoutProperty(DEPTH_HATCH_LAYER, 'visibility', depthVisible ? 'visible' : 'none');
    }
  }, [map, styleEpoch, assets, depthVisible]);

  // #492: rebuild the hazard-hatch raster whenever safetyDepthM changes,
  // DEBOUNCED (DEPTH_HATCH_DEBOUNCE_MS — see that constant's own comment for
  // the interval and why). Also fires once on initial setup (styleEpoch
  // 0 -> 1), redundantly repainting the SAME data buildHatchCanvas already
  // painted at creation — harmless (idempotent) and simpler than special-
  // casing the first run. `map.getLayer(DEPTH_HATCH_LAYER)` inside the
  // timeout, not the effect guard, so a change queued just before a style
  // reload wipes the layer doesn't throw — it just quietly finds nothing to
  // repaint, matching the depthVisible effect's own no-op-when-absent shape.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
    const timer = window.setTimeout(() => {
      if (!map.getLayer(DEPTH_HATCH_LAYER)) return;
      rebuildHatchCanvas(map, assets.maskMeta, assets.maskBuffer, safetyDepthM);
    }, DEPTH_HATCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [map, styleEpoch, assets, safetyDepthM]);

  // Seamark glyphs (#7) — registered/set once per assets load, independent of
  // the visibility toggle (so the layer is ready to paint the instant the
  // user opts in, no flash of unstyled icons). registerSeamarkImages is
  // idempotent (hasImage guard) AT AN UNCHANGED scale, so this is safe to
  // re-run; #353 PR2 adds `seamarkSizeScale` to the dependency array
  // because that guard is scale-BLIND — an id already registered at the OLD
  // raster size would otherwise never be redrawn at the new one, so a live
  // slider change removes every id first (seamarkImageIds — same dedup
  // logic registerSeamarkImages itself uses) before re-registering.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
    const withIcons = seamarkFeatureCollectionWithIcons(assets.seamarks);
    const props = withIcons.features.map((f) => f.properties);
    for (const id of seamarkImageIds(props)) {
      if (map.hasImage(id)) map.removeImage(id);
    }
    registerSeamarkImages(map, props, seamarkSizeScale);
    (map.getSource(SEAMARKS_SOURCE) as GeoJSONSource | undefined)?.setData(withIcons);
  }, [map, styleEpoch, assets, seamarkSizeScale]);

  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets || !map.getLayer(SEAMARKS_LAYER)) return;
    map.setLayoutProperty(SEAMARKS_LAYER, 'visibility', seamarksVisible ? 'visible' : 'none');
  }, [map, styleEpoch, assets, seamarksVisible]);

  // #353 PR2: the layer is CREATED (setupLayers) at the SEAMARKS_LAYOUT
  // default (scale 1) — this effect corrects icon-size/icon-padding to the
  // persisted scale, same "hidden/default at creation, synced by an effect"
  // convention as the visibility toggle above. Only these two layout
  // properties vary with scale (icon-image/icon-overlap/symbol-sort-key do
  // not), so only these two are re-set rather than the whole layout object.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets || !map.getLayer(SEAMARKS_LAYER)) return;
    const layout = seamarksLayout(seamarkSizeScale);
    map.setLayoutProperty(SEAMARKS_LAYER, 'icon-size', layout['icon-size']);
    map.setLayoutProperty(SEAMARKS_LAYER, 'icon-padding', layout['icon-padding']);
  }, [map, styleEpoch, assets, seamarkSizeScale]);

  // #353 PR2 (mapping corrected #513 F1/F2): the display-category filter.
  // `seamarkDisplayFilter` is cumulative (SEAMARK_DISPLAY_TIER_ALL
  // reproduces the unfiltered pre-#353 layer exactly), and the Base tier
  // (isolatedDanger/cardinal/lateral/safeWater/lightMajor) is NEVER excluded
  // by any selection — see seamarkGlyphs.ts's `seamarkDisplayTier` doc
  // comment for the full MSC.232(82)-informed mapping and why Base is a
  // product-specific floor rather than a literal ECDIS Display Base.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets || !map.getLayer(SEAMARKS_LAYER)) return;
    map.setFilter(SEAMARKS_LAYER, seamarkDisplayFilter(seamarkDisplayTier));
  }, [map, styleEpoch, assets, seamarkDisplayTier]);

  // Click a seamark glyph -> a small info popover (type/category/colour,
  // light character/colour/period when tagged) — never a route pick (#7):
  // seamarks aren't route-pickable points, unlike harbor markers, so this
  // owns its own popup rather than calling back into App/PlannerPanel state.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
    const handleClick = (e: MapLayerMouseEvent) => {
      // NOT features[0] (#200): at z>=12 `icon-overlap` is 'always' and
      // `symbol-sort-key` then paints the HIGHEST key on top, so the topmost
      // feature — the one queryRenderedFeatures returns first — is the least
      // navigationally significant of an overlapping group. Pick by priority
      // so a cardinal or isolated-danger mark owns the shared pixels. Below
      // z12 overlapping icons collision-cull, so this is a no-op there.
      const props = pickSeamarkByPriority(e.features)?.properties as SeamarkProperties | undefined;
      if (!props) return;
      const container = document.createElement('div');
      container.className = 'seamark-popover';
      for (const row of seamarkPopoverRows(props)) {
        const line = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = `${t(row.labelKey)}: `;
        // resolveSeamarkPopoverValue is the join/translate logic under direct
        // unit test with a stub t (#300 F4) — this call is a thin DOM wrapper.
        line.append(label, document.createTextNode(resolveSeamarkPopoverValue(row, t)));
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

  // #598 review follow-up: publishes `.data-layer-controls`'s LIVE rendered
  // height as a CSS custom property, so `.depth-legend` (a SIBLING, not a
  // child — see the return below) can be positioned just below it without
  // contributing to ITS height. Mirrors lib/useBannerHeight.ts's own
  // established pattern (ResizeObserver -> `document.documentElement.style.
  // setProperty`) for the identical reason: `.data-layer-controls`'s
  // rendered height is EMERGENT, not CSS-authored — it comes from the
  // global `input, select { min-height: 40px }` rule plus font metrics plus
  // the narrow+short `flex-direction: row` variant (app.css) — no single
  // number describes it across every language/viewport/breakpoint, so only
  // a live measurement can position something after it without guessing.
  // The compass's OWN height, by contrast, IS a stable CSS-authored
  // constant (2.75rem/44px, `.compass-control .compass-btn`) — only this
  // one value needs measuring, not two.
  //
  // No `useState`/return value needed (unlike useBannerHeight): nothing in
  // THIS component's own render depends on the number, only the DOM side
  // effect does — no other call site exists today, so it isn't exported.
  //
  // `useLayoutEffect`, not `useEffect`: matches useBannerHeight's own
  // reasoning (PR #382 review) — the value affects `.depth-legend`'s
  // position from the very first paint, and a plain `useEffect` fires AFTER
  // paint, leaving a frame where the CSS fallback below governs.
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== 'function') return; // jsdom guard, matches useBannerHeight.ts
    const el = document.querySelector<HTMLElement>('.data-layer-controls');
    if (!el) return;
    // MEASURED bug caught before shipping: `ResizeObserverEntry.contentRect`
    // reports the CONTENT box (padding excluded) — `.data-layer-controls`
    // has `padding: 0.5rem` (16px total), so reading `contentRect.height`
    // under-measured by exactly that 16px (97.59px vs the real 113.59px
    // border-box height, confirmed live). `useBannerHeight.ts` reads the
    // same `contentRect` field safely only because `.banner-area` happens
    // to carry zero padding — that isn't a property of the TECHNIQUE, it's
    // a property of THAT element, so it doesn't generalise here. Read
    // `getBoundingClientRect().height` (border-box, matching `offsetHeight`
    // and everything `.depth-legend`'s `top` calc needs to clear) on every
    // callback instead of trusting the entry.
    const write = () => {
      document.documentElement.style.setProperty(
        '--sc-depth-controls-height',
        `${el.getBoundingClientRect().height}px`,
      );
    };
    const ro = new ResizeObserver(write);
    ro.observe(el);
    // Same reasoning as useBannerHeight.ts's own first-callback comment: the
    // initial ResizeObserver callback is queued for a later frame, not
    // delivered synchronously, so measure once immediately too.
    write();
    return () => ro.disconnect();
  }, []);

  // Always-mounted control cluster — top-LEFT of the map, so it can never
  // collide with RouteLayer's plan-gated cluster at the top-right (app.css).
  return (
    <>
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
      {/* #598 review follow-up: a SIBLING of `.data-layer-controls`, not a
          child of it — a Fragment return with two roots, so App.tsx's
          `<div className="map-stack-tl"><DataLayers/><CompassControl/>
          </div>` places this as a THIRD `.map-stack-tl` child. Two prior
          shapes were tried and rejected, in order:
            1. Nested inside `.data-layer-controls`, full 44px touch target
               — pushed `.map-stack-tl`'s own measured height +49px at
               375x667 (166px -> 215px), suppressing ScaleBar (a REAL e2e
               regression, `compass.spec.ts`'s #208 test).
            2. Nested, shrunk to a 20px row to buy back that height — passed
               the layout tests but landed a SUB-MINIMUM touch target
               (WCAG 2.5.8 requires >=24x24 CSS px; this is a control meant
               to be tapped on a boat, one-handed, in motion).
          This third shape spends neither: taken OUT of
          `.data-layer-controls`'s flex flow entirely (so it costs
          `.map-stack-tl` ZERO measured height, structurally, not by a tuned
          number) via `position: absolute` in app.css, positioned BELOW the
          compass. `.map-stack-tl` already has `position: absolute` itself
          (app.css) — already a valid containing block, no extra wrapper —
          and sets no `overflow`, so an over-height legend can extend past
          its own box unclipped, same as the compass already can (that
          rule's own comment). Reading order stays sensible either way:
          toggles, then this legend, then the compass. */}
      <details className="depth-legend">
        <summary>{t('map.depth.legend.title')}</summary>
        <div className="depth-legend-body">
          <p className="depth-legend-row">
            <span className="depth-legend-swatch" aria-hidden="true" />
            {t('map.depth.legend.hatchLabel')}
          </p>
          <p>{t('map.depth.legend.basis')}</p>
          <p>{t('map.depth.legend.caveat')}</p>
        </div>
      </details>
    </>
  );
}
