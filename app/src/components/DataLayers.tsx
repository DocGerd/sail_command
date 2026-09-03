import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popup } from 'maplibre-gl';
import type {
  CanvasSource,
  GeoJSONSource,
  Map as MaplibreMap,
  MapLayerMouseEvent,
} from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useSettings, useActivePlan } from '../state/AppState';
import { useLang, useT } from '../i18n';
import { loadRoutingAssets, type RoutingAssets } from '../services/assets';
import { harborFeatureCollection } from '../lib/harborGeoJson';
import { HALO_COLOR, INK_COLOR } from '../lib/mapColors';
import {
  SEAMARKS_LAYOUT,
  pickSeamarkByPriority,
  seamarkFeatureCollectionWithIcons,
  seamarkHazardFilter,
  seamarkPopupAnchor,
  seamarkRoutineFilter,
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
  hatchBandForZoom,
} from '../lib/depthColor';
import { installStyleSetup } from '../lib/styleReload';
import { usePersistedToggle } from '../lib/usePersistedToggle';
import { usePersistedNumber } from '../lib/usePersistedNumber';
import { LEGEND_COLLAPSED_HEIGHT_PX } from '../lib/depthLegendGate';
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
// Debounce for rebuilding the hatch raster after safetyDepthM OR the #599
// zoom band changes — the
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
//
// #599 RE-MEASURED, same method (in-browser Chromium, real 2200x2400 mask,
// createImageData+putImageData included), 5 samples: 40.7 / 27.1 / 28.7 /
// 35.3 / 34.4 ms — median 34.4, range 27-41. The 28.x figures above are
// still reproducible but sit at the OPTIMISTIC end of today's spread, so
// size anything against ~35-40 ms, not ~28.
//
// #599 also makes ZOOM a second trigger, and that is the one that could
// turn this into a per-interaction cost. It is deliberately NOT a second
// debounce; the band is folded into the SAME timer below, for two reasons.
// (1) Both inputs feed the identical rebuild, so one timer means a
// simultaneous change (zoom while a boat radio is clamping safetyDepthM)
// costs ONE rebuild, where two independent timers would cost two.
// (2) The trigger is the BAND, not the zoom, and hatchBandForZoom quantises
// to whole zoom levels (#599 fix wave), so only SIX bands are reachable
// across z9-z22 (FIVE before #648 added the z>=14 full-coverage wash band —
// depthColor.ts's HATCH_WASH_BAND) and a gesture that stays inside one arms
// no timer at all.
// MEASURED, not predicted — an earlier revision of this comment asserted
// "five distinct values / no timer at all" while selection was still
// CONTINUOUS, where 15 bands are reachable and it was simply false: eight
// wheel notches from z9 rebuilt 7-8 times. After quantisation the same eight
// notches rebuild 1-4 times depending on notch size (2 at a 0.25 notch, 1 at
// 0.125, 4 at a coarse 0.5). Band changes over a full z9->z22 sweep drop
// from 14 to 4, all at integer crossings — 5 since #648, whose extra
// crossing is z13->z14 and is likewise an integer one. (The notch
// measurement above was taken from z9 and is untouched by #648, which
// changes nothing below z14.)
// `zoomend` (not `zoom`) is the source, so a continuous pinch/wheel
// gesture is already coalesced by MapLibre before this debounce sees it.
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
// #682: the hazard-family overlay (isolatedDanger, cardinal —
// seamarkGlyphs.ts's isHazardSeamark) — see SEAMARKS_LAYOUT's own doc
// comment in seamarkGeoJson.ts for the full mechanism and why this must be
// the LAST layer added among this component's own layers (same beforeId,
// later addLayer call — stacks it above SEAMARKS_LAYER). Exported for the
// SAME reason as SEAMARKS_LAYER just above: App.tsx's
// INTERACTIVE_MAP_LAYER_IDS raw-tap gate must include this id too, or a
// click landing on a hazard-only mark (no longer present on SEAMARKS_LAYER
// after the split) falls through to the origin/destination picker instead
// of being gated to the seamark popover this component's own click handler
// (below) opens for it.
export const SEAMARKS_HAZARD_LAYER = 'sc-seamarks-hazard';
// #682: every seamark symbol layer this component owns, module-scope so the
// click/hover effect below doesn't rebuild an array literal every render
// just to hand it to map.on/map.off. NOT exported as an array — Vite's
// react-refresh lint (`allowConstantExport`) only recognises a Literal/
// TemplateLiteral export as component-safe, so an exported array here would
// fail lint (measured). App.tsx's own `INTERACTIVE_MAP_LAYER_IDS` raw-tap
// gate — which must include every id in this array (see App.tsx's own
// comment) — is instead pinned by `App.test.tsx`'s '#682 tap-safety' test,
// which derives the expected set by REFLECTING over this module's own named
// exports (every string export matching `/^SEAMARKS.*LAYER$/`) rather than
// importing this array directly, so a future third `SEAMARKS_*_LAYER`
// export is covered automatically with no test-file edit, as long as it
// follows the naming convention `SEAMARKS_LAYER`/`SEAMARKS_HAZARD_LAYER`
// already set.
const SEAMARK_LAYER_IDS = [SEAMARKS_LAYER, SEAMARKS_HAZARD_LAYER];

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
//
// #599: takes `map` purely to read the CURRENT zoom for hatchBandForZoom, so
// the very first paint already uses the right band. ORDERING IS LOAD-BEARING:
// map.getZoom() is called only AFTER the `!ctx` bail-out, because jsdom has no
// 2D canvas backend and the shared test fake exposes no getZoom — every unit
// test that mounts this component takes the `return null` path and must never
// reach the call.
function buildHatchCanvas(
  map: MaplibreMap,
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
    buildNavigabilityHatchImageData(
      new Uint8Array(buffer),
      meta.rows,
      meta.cols,
      safetyDepthM,
      hatchBandForZoom(map.getZoom()),
    ),
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
  // #599: same ordering rule as buildHatchCanvas — getZoom() sits behind both
  // bail-outs above, so jsdom (where the source never exists) never reaches it.
  image.data.set(
    buildNavigabilityHatchImageData(
      new Uint8Array(maskBuffer),
      meta.rows,
      meta.cols,
      safetyDepthM,
      hatchBandForZoom(map.getZoom()),
    ),
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
  // matter, M8's screen-space fill-pattern alternative (the option #599 did
  // NOT take — see depthColor.ts's hatchBandForZoom comment) would also remove this
  // second full-resolution raster entirely — not attempted here, since the
  // maintainer's decision for THIS change was explicitly a second
  // COMPOSITED layer, and merging the two canvases is the one thing the
  // HARD DOMAIN RULE separation exists to prevent.
  if (!map.getSource(DEPTH_HATCH_SOURCE)) {
    const hatchCanvas = buildHatchCanvas(map, meta, maskBuffer, safetyDepthM);
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
          // depthVisible/hatchVisible sync effect applies the current state
          // before any paint. #681: the hatch DOES now have its own
          // independent toggle (hatchVisible, in the depth-legend body
          // below) — this comment previously said it did not; see that
          // effect's own #681 comment for the composite condition.
          layout: { visibility: 'none' },
          paint: {
            'raster-fade-duration': 0,
            // #492 review M8: MapLibre's default 'linear' resampling
            // smears the hatch's hard-edged stripes into soft gradients —
            // an ADDITIONAL artifact, independent of the zoom-scaling
            // degradation #599's hatchBandForZoom addresses (depthColor.ts),
            // and neither fixes the other. 'nearest' at least keeps whatever renders
            // crisp rather than blurred. #648 makes this choice load-bearing for
            // SAFETY as well as legibility: from z14 the raster is a
            // full-coverage wash (HATCH_WASH_BAND), so 'linear' would no longer
            // blur stripes but would fade each marginal region's OUTER cells
            // toward transparent — i.e. render genuinely marginal water lighter
            // at exactly the boundary a reader is judging. 'nearest' keeps that
            // edge at the mask's own cell resolution. SCOPE, measured against
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
          // plain water and every band of the depth raster. #715: the fill is
          // PURE black (#000000), deliberately NOT lib/mapColors.ts's
          // INK_COLOR (#1A1A1A, the map's near-black ink) — a different,
          // separately-chosen value, so it stays a literal here. The stroke
          // IS the same white used everywhere else, so it is HALO_COLOR.
          'circle-radius': 5.5,
          'circle-color': '#000000',
          'circle-stroke-width': 2,
          'circle-stroke-color': HALO_COLOR,
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
          'text-color': INK_COLOR,
          'text-halo-color': HALO_COLOR,
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
    // #682: the hazard-family overlay, reading the SAME source and SAME
    // layout as SEAMARKS_LAYER just above (icon-image/icon-overlap/
    // symbol-sort-key/icon-size/icon-padding are all identical — only the
    // FILTER differs, applied by the effects below via
    // seamarkRoutineFilter/seamarkHazardFilter). Added AFTER SEAMARKS_LAYER
    // with the SAME beforeId anchor — MapLibre stacks same-beforeId
    // additions in INSERTION order (see the #492 addLayer comment above:
    // "each addLayer(layer, beforeId) call inserts immediately below
    // beforeId, so a later call ends up ABOVE an earlier one"), so this
    // paints above the routine layer while staying below the AIS/Route
    // anchor exactly like every other layer in this function. See
    // seamarkGeoJson.ts's SEAMARKS_LAYOUT doc comment (b) for why stacking
    // order ALONE — with no cross-layer symbol-sort-key coordination —
    // fixes BOTH the z>=12 paint-order inversion and the z<12 placement
    // priority (#682).
    map.addLayer(
      {
        id: SEAMARKS_HAZARD_LAYER,
        type: 'symbol',
        source: SEAMARKS_SOURCE,
        layout: {
          ...SEAMARKS_LAYOUT,
          // Same "hidden/no filter at creation, synced by an effect"
          // convention as SEAMARKS_LAYER — no visible flash risk either way,
          // since SEAMARKS_SOURCE's own data starts empty until the same
          // assets-gated effect that first sets these filters also
          // populates it.
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
  // #813: whether an active plan exists — the consolidated-legend gate.
  // RouteLayer.tsx (plan-gated, `if (!plan) return null`) mounts its own
  // RouteLegend once a plan exists, which now ALSO carries the #598
  // depth-hatch entries folded in under their own sub-heading (see
  // RouteLegend.tsx's own #813 comment for the full rationale). So this
  // component's `.depth-legend` disclosure below must render ONLY while
  // plan===null — otherwise the app would show TWO "Legende"/"Legend"
  // disclosures again, the exact defect #813 exists to fix. The two are
  // COMPLEMENTARY, never both mounted: whichever is absent, the other one
  // is what carries the #597 safety caveat forward WHEN IT RENDERS. That
  // is narrower than "reachable in every state" (#842): this component's
  // OWN `.depth-legend` is additionally gated by the `legendHidden` state
  // set in the measurement effect below, which hides it — `hidden`, out of
  // the accessibility tree — in short landscape and in a narrow column too
  // cramped for `LEGEND_COLLAPSED_HEIGHT_PX`. In those states, with
  // plan===null, neither legend carries the caveat at all.
  const { plan } = useActivePlan();
  // #63: default ON, persisted — mirrors RouteLayer's barbs/annotations
  // toggles. An explicit "off" survives reloads; a fresh profile sees depth.
  const [depthVisible, setDepthVisible] = usePersistedToggle('sc-depth-visible', true);
  // #681: a SECOND, independent persisted toggle for the hazard-hatch overlay
  // alone — same fail-open-by-default reasoning as depthVisible above, and
  // load-bearing here specifically: #455 (mask optimism, ~10,746 gate-crossing
  // cells) was closed on the basis that #492's per-cell hatch already
  // discloses exactly that criterion, so `defaultValue: true` is what keeps a
  // fresh profile seeing today's disclosure. This does NOT get its own row in
  // `.data-layer-controls` (see the return JSX below) — a third checkbox row
  // there measures +51.59px at 375x667 (re-measured against a real DOM
  // injection during review) and drops the `.depth-legend` reachability
  // budget from 62.556px to 10.96px, under `LEGEND_COLLAPSED_HEIGHT_PX` (44)
  // — hiding the WHOLE legend, `#597` caveat included, behind `hidden`. What
  // rendering the toggle inside `.depth-legend-body` instead preserves is
  // that binary reachability gate, not the caveat's position inside the
  // legend body's OWN scrollport — see the return JSX below for the full,
  // precisely-stated derivation.
  const [hatchVisible, setHatchVisible] = usePersistedToggle('sc-depth-hatch-visible', true);
  // #598 review round 3: whether `.depth-legend` has enough room to render
  // reachably at all — computed in the `useLayoutEffect` below (not
  // persisted; this is pure layout, recomputed every time the geometry it
  // depends on changes). `false` (reachable) is the right INITIAL guess for
  // the common case — a real first-paint mismatch is closed by
  // `useLayoutEffect` running before paint, same as the `--sc-depth-
  // controls-height` write below.
  const [legendHidden, setLegendHidden] = useState(false);
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
  // #599: a CHANGE TRIGGER for the hatch rebuild, not the band itself — the
  // rebuild reads the live zoom straight off the map (behind the jsdom
  // guards in rebuildHatchCanvas), so what this state has to carry is only
  // "the band is no longer the one the canvas was painted with". Storing the
  // band's identity as a string is what makes that work: React bails out of
  // a setState to an Object.is-equal value, so every zoomend landing inside
  // the SAME band re-renders nothing and arms no timer — only a genuine
  // boundary crossing reaches the debounced effect below. An object would
  // defeat that (a fresh reference every time) and rebuild on every gesture.
  // Starts null: the setup path already painted the correct band for the
  // initial zoom, and the first zoomend simply re-confirms it.
  const [hatchBandKey, setHatchBandKey] = useState<string | null>(null);
  useEffect(() => {
    if (!map) return;
    const onZoomEnd = () => {
      const band = hatchBandForZoom(map.getZoom());
      setHatchBandKey(`${band.periodCells}/${band.stripeCells}`);
    };
    map.on('zoomend', onZoomEnd);
    return () => {
      map.off('zoomend', onZoomEnd);
    };
  }, [map]);

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
    // #681: the hazard-hatch layer now has its OWN persisted toggle
    // (hatchVisible), but it is still a dependent annotation over the depth
    // overlay — meaningless, and never drawable, once depthVisible itself is
    // off. The composite `depthVisible && hatchVisible` is the #384
    // defect-class fix (PR #384 review): gating only the checkbox's
    // `disabled` attribute in the return JSX below would leave a layer the
    // persisted hatchVisible flag already made visible still rendered the
    // instant depthVisible flips back on, even if the user never touched the
    // hatch checkbox at all. Both the `disabled` attribute AND this
    // visibility effect must carry the composite condition.
    // Guarded
    // separately from DEPTH_LAYER's own `!map.getLayer` check above since
    // the hatch layer can legitimately not exist yet (jsdom has no 2D
    // canvas backend at all — see buildHatchCanvas — or a slow style reload
    // window) even once DEPTH_LAYER does.
    if (map.getLayer(DEPTH_HATCH_LAYER)) {
      map.setLayoutProperty(
        DEPTH_HATCH_LAYER,
        'visibility',
        depthVisible && hatchVisible ? 'visible' : 'none',
      );
    }
  }, [map, styleEpoch, assets, depthVisible, hatchVisible]);

  // #492/#599: rebuild the hazard-hatch raster whenever safetyDepthM OR the
  // zoom band changes,
  // DEBOUNCED (DEPTH_HATCH_DEBOUNCE_MS — see that constant's own comment for
  // the interval, the re-measured build cost, and why the two triggers share
  // ONE timer instead of getting a debounce each). `hatchBandKey` is in the
  // dependency array purely as that trigger; the band VALUE is re-read from
  // the map inside rebuildHatchCanvas, so a rebuild can never paint a band
  // staler than the current camera. Also fires once on initial setup (styleEpoch
  // 0 -> 1), redundantly repainting the SAME data buildHatchCanvas already
  // painted at creation — harmless (idempotent) and simpler than special-
  // casing the first run. `map.getLayer(DEPTH_HATCH_LAYER)` inside the
  // timeout, not the effect guard, so a change queued just before a style
  // reload wipes the layer doesn't throw — it just quietly finds nothing to
  // repaint, matching the depthVisible effect's own no-op-when-absent shape.
  useEffect(() => {
    // #599 review m7: gated on depthVisible — repainting a 2200x2400 raster
    // nobody can see is pure cost, and zoom being a trigger makes it a
    // RECURRING one (4 invisible rebuilds across 8 measured gestures before
    // this gate). `depthVisible` is a dependency as well as a guard, so
    // turning the overlay back ON re-runs this and repaints with whatever
    // safetyDepthM/band changed while it was hidden — the canvas can never
    // be shown stale, which is what makes skipping the hidden rebuilds safe.
    // #681: `hatchVisible` joins the SAME guard/dependency pair for the SAME
    // reason — the issue's own "fold into the rebuild gate, do not skip
    // this" requirement. Without it, turning the hatch off via its own
    // checkbox would still pay the ~30-40ms rebuild cost (DEPTH_HATCH_
    // DEBOUNCE_MS's own comment) every time safetyDepthM/the zoom band
    // changes, for a raster the user explicitly chose not to see.
    if (!map || styleEpoch === 0 || !assets || !depthVisible || !hatchVisible) return;
    const timer = window.setTimeout(() => {
      if (!map.getLayer(DEPTH_HATCH_LAYER)) return;
      rebuildHatchCanvas(map, assets.maskMeta, assets.maskBuffer, safetyDepthM);
    }, DEPTH_HATCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [map, styleEpoch, assets, safetyDepthM, hatchBandKey, depthVisible, hatchVisible]);

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

  // #682: both sc-seamarks* layers toggle together — a single opt-in
  // "seamarks" affordance to the user, split into two layers purely as a
  // paint-order/placement-priority implementation detail (SEAMARKS_LAYOUT's
  // own doc comment (b)), never a second independently-toggleable overlay.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
    if (map.getLayer(SEAMARKS_LAYER)) {
      map.setLayoutProperty(SEAMARKS_LAYER, 'visibility', seamarksVisible ? 'visible' : 'none');
    }
    if (map.getLayer(SEAMARKS_HAZARD_LAYER)) {
      map.setLayoutProperty(
        SEAMARKS_HAZARD_LAYER,
        'visibility',
        seamarksVisible ? 'visible' : 'none',
      );
    }
  }, [map, styleEpoch, assets, seamarksVisible]);

  // #353 PR2: the layer is CREATED (setupLayers) at the SEAMARKS_LAYOUT
  // default (scale 1) — this effect corrects icon-size/icon-padding to the
  // persisted scale, same "hidden/default at creation, synced by an effect"
  // convention as the visibility toggle above. Only these two layout
  // properties vary with scale (icon-image/icon-overlap/symbol-sort-key do
  // not), so only these two are re-set rather than the whole layout object.
  // #682: both layers share SEAMARKS_LAYOUT verbatim, so both get the SAME
  // re-derived layout object.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
    const layout = seamarksLayout(seamarkSizeScale);
    for (const layerId of [SEAMARKS_LAYER, SEAMARKS_HAZARD_LAYER]) {
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(layerId, 'icon-size', layout['icon-size']);
      map.setLayoutProperty(layerId, 'icon-padding', layout['icon-padding']);
    }
  }, [map, styleEpoch, assets, seamarkSizeScale]);

  // #353 PR2 (mapping corrected #513 F1/F2): the display-category filter.
  // The tier cut is cumulative (SEAMARK_DISPLAY_TIER_ALL reproduces the
  // unfiltered pre-#353 feature set, now split across the two layers), and
  // the Base tier (isolatedDanger/cardinal/lateral/safeWater/lightMajor) is
  // NEVER excluded by any selection — see seamarkGlyphs.ts's
  // `seamarkDisplayTier` doc comment for the full MSC.232(82)-informed
  // mapping and why Base is a product-specific floor rather than a literal
  // ECDIS Display Base.
  // #682: the SAME tier cut now applies to TWO layers, each additionally
  // partitioned on the `hazard` boolean — seamarkRoutineFilter/
  // seamarkHazardFilter (seamarkGeoJson.ts) so a feature renders on exactly
  // one of the two, never both and never neither.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
    if (map.getLayer(SEAMARKS_LAYER)) {
      map.setFilter(SEAMARKS_LAYER, seamarkRoutineFilter(seamarkDisplayTier));
    }
    if (map.getLayer(SEAMARKS_HAZARD_LAYER)) {
      map.setFilter(SEAMARKS_HAZARD_LAYER, seamarkHazardFilter(seamarkDisplayTier));
    }
  }, [map, styleEpoch, assets, seamarkDisplayTier]);

  // Click a seamark glyph -> a small info popover (type/category/colour,
  // light character/colour/period when tagged) — never a route pick (#7):
  // seamarks aren't route-pickable points, unlike harbor markers, so this
  // owns its own popup rather than calling back into App/PlannerPanel state.
  // #682: registered on BOTH sc-seamarks* layer ids via maplibre-gl's array
  // form of the delegated `on(type, layerIds, fn)` overload
  // (`node_modules/maplibre-gl/dist/maplibre-gl.d.ts:13727`, re-derived
  // against the installed 6.5.0, matched to `app/package-lock.json`'s pin —
  // #392's documented trap) — MapLibre's own delegate implementation
  // (`ui/map.ts`'s `_createDelegatedListener`) queries EVERY given layer at
  // the tap point and merges the results into ONE `e.features` array before
  // invoking this handler once, so pickSeamarkByPriority below still sees
  // candidates from whichever layer the tap actually hit, same as before
  // the split.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !assets) return;
    const handleClick = (e: MapLayerMouseEvent) => {
      // NOT features[0] (#200): at z>=12 `icon-overlap` is 'always' and
      // `symbol-sort-key` then paints the HIGHEST key on top, so the topmost
      // feature — the one queryRenderedFeatures returns first — is the least
      // navigationally significant of an overlapping group. Pick by priority
      // so a cardinal or isolated-danger mark owns the shared pixels. Below
      // z12 overlapping icons collision-cull, so this is a no-op there.
      const picked = pickSeamarkByPriority(e.features);
      const props = picked?.properties as SeamarkProperties | undefined;
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
      // #232 item 4: anchor at the picked feature's own coordinates only when
      // the priority pick differs from the topmost (overlap-mismatch) feature
      // — the ordinary, non-overlapping case keeps the tap-point anchor
      // unchanged. See seamarkPopupAnchor's own doc comment for the full
      // rationale (this was a deliberate design nuance carried into #232,
      // not assumed away).
      new Popup({ closeButton: true, maxWidth: '240px', className: 'seamark-popup' })
        .setLngLat(seamarkPopupAnchor(picked, e.features?.[0], e.lngLat))
        .setDOMContent(container)
        .addTo(map);
    };
    const handleEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const handleLeave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', SEAMARK_LAYER_IDS, handleClick);
    map.on('mouseenter', SEAMARK_LAYER_IDS, handleEnter);
    map.on('mouseleave', SEAMARK_LAYER_IDS, handleLeave);
    return () => {
      map.off('click', SEAMARK_LAYER_IDS, handleClick);
      map.off('mouseenter', SEAMARK_LAYER_IDS, handleEnter);
      map.off('mouseleave', SEAMARK_LAYER_IDS, handleLeave);
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
  // #598 review round 3 (Major 1 + Minor 1): this effect ALSO decides
  // whether `.depth-legend` is reachable at all, via the `legendHidden`
  // state below, set on the native `hidden` attribute in the return JSX.
  // A pure-CSS `max-height` clip was tried first and rejected TWICE —
  // app.css's own `.depth-legend` comment carries the full story — because
  // CSS `calc()` can neither branch on which of `.map-stack-tl`'s THREE
  // layout modes (wide / narrow column / narrow-and-short row) is live, nor
  // remove a 0-height element from the accessibility tree or tab order.
  // Both are ordinary `if`/DOM-attribute operations in JS, so the whole
  // reachability decision (not just the height measurement) moved here.
  //
  // `useLayoutEffect`, not `useEffect`: matches useBannerHeight's own
  // reasoning (PR #382 review) — both the position AND the reachability of
  // this element must be correct from the very first paint, and a plain
  // `useEffect` fires AFTER paint, leaving a frame where a stale/default
  // state would show.
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
    //
    // The SAME query string as app.css's own short-landscape rule
    // (`@media (max-width: 1023.98px) and (max-height: 500px) and
    // (orientation: landscape)`) — kept as a literal, not a shared constant,
    // because CSS media-query text and a JS `matchMedia` argument have no
    // common module to live in; re-check this string against that rule's
    // own text if either ever changes (NAMED COUPLING).
    const SHORT_LANDSCAPE_QUERY =
      '(max-width: 1023.98px) and (max-height: 500px) and (orientation: landscape)';
    // Read directly rather than through `--sc-banner-height`
    // (`useBannerHeight.ts`'s own custom property): that property is
    // written by a SEPARATE `ResizeObserver` instance owned by that other
    // hook, observing the SAME `.banner-area` element this effect also
    // observes below — MEASURED live (round 3 self-review, the tab-strip-
    // overlap regression test): when `.banner-area` grows from 0 to 48px on
    // a real cold load, this component's own resize callback can fire
    // before that OTHER observer's callback has written the fresh value,
    // so reading the property here saw a stale `0px` and computed a budget
    // that was `>=44` when the real, settled budget was `14.56`. Reading
    // `bannerEl`'s own `getBoundingClientRect().height` sidesteps the
    // cross-observer ordering entirely — same technique this effect
    // already uses for `.data-layer-controls`'s own height, above.
    const bannerEl = document.querySelector<HTMLElement>('.banner-area');
    const recompute = () => {
      document.documentElement.style.setProperty(
        '--sc-depth-controls-height',
        `${el.getBoundingClientRect().height}px`,
      );
      // Wide layout: no sheet-overlay ceiling exists at all (app.css's own
      // wide-layout comment on `.depth-legend-body`) — always reachable.
      if (window.matchMedia('(min-width: 1024px)').matches) {
        setLegendHidden(false);
        return;
      }
      // Short landscape: `.map-stack-tl` flips to `flex-direction: row`
      // (app.css), putting the compass BESIDE the toggles instead of below
      // them — `.depth-legend`'s own `top` (60px past the compass, in
      // COLUMN terms) no longer corresponds to real free space in that
      // layout. Rather than derive a second, row-mode geometry for a
      // control that would be sharing an already cramped strip with the
      // compass, this repo's own `#231` fix already spends this viewport
      // class's scarce height budget on the compass and the two PRIMARY
      // toggles; the legend simply does not fit there and says so.
      if (window.matchMedia(SHORT_LANDSCAPE_QUERY).matches) {
        setLegendHidden(true);
        return;
      }
      // Narrow column layout: mirrors `.map-stack-tl`'s own proven-safe
      // ceiling (`calc(100dvh - var(--sc-banner-clear-top) - 55vh -
      // 0.5rem)`, app.css) minus everything `.depth-legend` itself sits
      // below within that budget (the compass's own 60px offset, above,
      // plus the 44px touch target this checks room FOR) — the identical
      // arithmetic app.css's rejected CSS draft used, just able to branch
      // on layout mode and produce a boolean instead of an unenforceable
      // clip. `bannerEl` may not be mounted yet (defensive only —
      // `.banner-area` renders unconditionally, App.tsx) or may genuinely
      // be 0px tall (no banner showing); either way `0` is the CORRECT
      // real measurement, not a fallback standing in for one — this reads
      // `.banner-area`'s own live geometry directly (see this effect's own
      // comment above `bannerEl`'s declaration), never the generous 176px
      // constant, which is for a DIFFERENT failure mode (no measurement
      // possible at all) that does not apply here.
      const bannerHeightPx = bannerEl ? bannerEl.getBoundingClientRect().height : 0;
      const bannerClearTopPx = 56 + bannerHeightPx; // 3.5rem + banner
      const budgetPx =
        window.innerHeight -
        bannerClearTopPx -
        window.innerHeight * 0.55 -
        8 - // 0.5rem
        el.getBoundingClientRect().height -
        60; // gap + compass + gap, matching `.depth-legend`'s own `top`
      // #641: TWINNED to `app.css`'s `.depth-legend > summary { min-height:
      // 44px }` — the legend's whole COLLAPSED box, since #638's chrome
      // padding on `.depth-legend` is horizontal-only by design. No compiler
      // spans CSS and TypeScript, so `lib/depthLegendGate.test.ts` pins the
      // two together (both the number AND the zero-vertical-padding property
      // that makes the number the right one); read that file's header before
      // changing either side.
      setLegendHidden(budgetPx < LEGEND_COLLAPSED_HEIGHT_PX);
    };
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    // `.banner-area` independently changes the SAME budget (a banner can
    // mount/unmount/resize without `.data-layer-controls` itself changing
    // size) — observe it too, same ResizeObserver instance. `bannerEl` was
    // already queried above, before `recompute`'s own closure, so both this
    // observation and the read inside `recompute` share the SAME node.
    if (bannerEl) ro.observe(bannerEl);
    // A pure viewport resize/rotation (no `.data-layer-controls` or
    // `.banner-area` size change) also moves the budget — `window.innerHeight`
    // and the media queries above both depend on it directly.
    window.addEventListener('resize', recompute);
    // Same reasoning as useBannerHeight.ts's own first-callback comment: the
    // initial ResizeObserver callback is queued for a later frame, not
    // delivered synchronously, so measure once immediately too.
    recompute();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recompute);
    };
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
          toggles, then this legend, then the compass.
          #598 review round 3: `hidden={legendHidden}` (native HTML
          attribute, set by the `useLayoutEffect` above) is what actually
          decides reachability now — `display: none`, out of the
          accessibility tree, unfocusable, all at once. See that effect's
          own comment for the full derivation across all three layout
          modes; app.css's `.depth-legend` comment records why a CSS-only
          `max-height` clip was tried first and rejected.

          #813: this whole `<details>` is now ADDITIONALLY gated on
          `plan === null` (the `useActivePlan()` read above) — never
          rendered at all once a plan is active, because RouteLegend.tsx's
          own `.route-legend` disclosure takes over as the SOLE
          "Legende"/"Legend" surface at that point, folding this content in
          under its own sub-heading. Consolidating this WAY — suppressing
          the free-floating pill rather than the panel-gated one — is what
          keeps the #597 caveat's disclosure mounted with NO plan at all,
          subject to this component's own `legendHidden` gate above (the
          state RouteLegend can't cover, since RouteLayer.tsx returns null
          before ever mounting it): the alternative direction (fold this
          content INTO RouteLegend and never touch this component) would
          silently make the caveat unreachable until a route is planned,
          the exact "two individually-correct fixes silence the complement of two
          conditions" trap CLAUDE.md's Working-style section warns about.

          #681 x #813: the independent hatch toggle (below, inside the
          body) rides along with this `plan === null` gate rather than
          needing one of its own — it is a CHILD of this `<details>`, so it
          is reachable in exactly the same states this whole disclosure is.
          The COMPLEMENTARY copy folded into RouteLegend.tsx's
          `.route-legend-depth` (its own #681 comment) carries an identical
          checkbox wired to the SAME `usePersistedToggle` keys
          (`sc-depth-hatch-visible`, `sc-depth-visible`), which is what keeps
          the control itself reachable once a plan exists — this component
          stays the always-mounted layer-visibility driver in EITHER
          state, but is no longer the only place the control is offered. */}
      {plan === null && (
        <details className="depth-legend" hidden={legendHidden}>
          <summary>{t('map.depth.legend.title')}</summary>
          <div className="depth-legend-body">
            {/* #839: `hatchLabel` (with its swatch) describes the hatch CUE
                itself, so it must not be offered once that cue is off the
                map — #681's own DoD bullet ("The hatch legend is not offered
                while the hatch is off") that shipped without this guard.
                Gated on the SAME `depthVisible && hatchVisible` composite the
                layer-visibility effect above already applies (the #384
                defect-class shape), never `hatchVisible` alone: the hatch is
                equally absent from the map when the whole depth overlay is
                off. The toggle checkbox below stays unconditional so the
                user can still turn the hatch back on. */}
            {depthVisible && hatchVisible && (
              <p className="depth-legend-row">
                <span className="depth-legend-swatch" aria-hidden="true" />
                {t('map.depth.legend.hatchLabel')}
              </p>
            )}
            {/* #681: the independent hatch toggle lives HERE, inside the
                legend's own disclosure body — not as a third `.data-layer-
                controls` row (deferred v0.18.0 investigation; see #681's own
                issue thread) and not on `.depth-legend`'s own always-visible
                summary either. A third `.data-layer-controls` row measures
                +51.59px at 375x667 (re-measured against a real DOM
                injection, not read off a comment — the earlier +49px figure
                this comment quoted was itself a stale citation) and drops
                the legend's reachability budget (`budgetPx`, the
                useLayoutEffect above) from 62.556px to 10.96px, under
                LEGEND_COLLAPSED_HEIGHT_PX (44) — hiding the whole legend,
                `#597` caveat included, behind the `hidden` attribute:
                `display: none`, out of the accessibility tree entirely.
                Placing it HERE instead costs `.data-layer-controls` (and
                therefore `budgetPx`) exactly zero, so that binary
                reachability gate is unaffected either way (verified
                byte-identical before/after this change). That is NOT the
                same claim as "the caveat is easy to reach" — this
                `.depth-legend-body` scrollport is a pre-existing 16px
                window over ~1150-1200px of content at this viewport
                (present on `develop` before this PR), and this addition
                measurably adds ~52px of scroll depth ABOVE the caveat
                inside that already-cramped window. What is preserved is
                the binary `legendHidden` gate, not the caveat's in-
                scrollport position — a scroll offset is recoverable by the
                user; a `display: none` legend is not, which is why this
                placement is still the right call, not because it is free.
                Residual, and it fails the SAFE direction: while
                `legendHidden` is true (the legend itself unreachable) or the
                `<details>` is simply collapsed, this checkbox is unreachable
                too — but `hatchVisible` still defaults `true` (#455's
                disclosure basis), so an unreachable toggle means the hatch
                stays ON, never that it silently vanishes.
                `disabled={!depthVisible}` mirrors the composite condition the
                visibility effect above applies — the #384 defect class: the
                control must not offer to change a layer that
                `depthVisible=false` already keeps invisible regardless. */}
            <label className="depth-legend-row">
              <input
                type="checkbox"
                checked={hatchVisible}
                disabled={!depthVisible}
                onChange={(e) => setHatchVisible(e.target.checked)}
              />
              {t('map.depth.legend.hatchToggle')}
            </label>
            {/* #839: same composite guard as the hatchLabel row above — the
                "diagonal hatching flags..." sentence describes the hatch cue
                specifically, unlike the #597 caveat below (a mask-coverage
                gap that exists independent of the hatch toggle's own
                state). */}
            {depthVisible && hatchVisible && <p>{t('map.depth.legend.basis')}</p>}
            <p>{t('map.depth.legend.caveat')}</p>
          </div>
        </details>
      )}
    </>
  );
}
