import { useEffect, useMemo, useState } from 'react';
import { LngLatBounds, Map as MaplibreMap } from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import { formatDateTime, formatSliderTime } from '../lib/format';
import { activeRigResult } from '../lib/plan';
import {
  adaptiveBarbFeatures,
  legsToFeatureCollection,
  nearestHourIndex,
  routePointFeatures,
} from '../lib/routeGeoJson';
import { installStyleSetup } from '../lib/styleReload';
import { usePersistedToggle } from '../lib/usePersistedToggle';
import { useWideLayout } from '../lib/useWideLayout';
import { registerBarbImages } from '../lib/windBarbs';
import { NavMask } from '../lib/mask';
import { loadRoutingAssets } from '../services/assets';
import ViaMarkers from './ViaMarkers';
import RouteLegend from './RouteLegend';
import Disclosure from './Disclosure';
import type { LatLon, Plan, SailId } from '../types';

export interface RouteLayerProps {
  plan: Plan | null;
  rig: SailId | null;
  // From useActivePlan() (published by LiveView off the GPS fix). Drives a
  // cheap setFilter() on the highlight layer only — never a source re-set —
  // so near-boundary GPS noise flipping between adjacent legs stays cheap.
  activeLegIndex: number | null;
  // #571 redesign: via-waypoint editing. ViaMarkers is rendered here (not as
  // a sibling in App.tsx) mirroring LiveView's own BoatMarker — a plan's via
  // points are route-scoped, and RouteLayer already receives `plan`. All
  // three props are only meaningful once `plan` exists (renders null before
  // that), so App.tsx's wiring only needs to keep them defined once a plan
  // is active.
  //
  // `draftViaPoints` is App.tsx's DRAFT via list (never `plan.request.
  // viaPoints` directly) — ViaMarkers renders FROM the draft, not the
  // committed list, which is what makes an add/remove/reorder/drag show up
  // on the map immediately, before the next Plan-route press applies it.
  draftViaPoints: LatLon[];
  // No longer means "a replan is in flight" (#571 redesign removed the
  // auto-replan-on-edit path) — it now means "the draft differs from the
  // committed plan.request.viaPoints", i.e. there is an unapplied edit.
  // PROP NAME kept as `viaReplanning` — see ViaMarkers.tsx's own comment on
  // its identically-named, identically-repurposed prop.
  viaReplanning: boolean;
  onViaDragEnd: (index: number, next: LatLon) => Promise<boolean>;
}

// jsdom has no MapLibre/WebGL runtime — map.addSource/addLayer/getSource
// etc. either no-op or return undefined, so nothing here can render for
// real under jsdom. RouteLayer.test.tsx still pins the STATIC layer specs
// (paint/layout objects, filter expressions, beforeId anchoring, toggle
// visibility sync) against the shared fake map (test/fakeMaplibre.ts),
// which records addLayer's arguments verbatim without needing a real
// renderer — that catches an accidental spec revert at unit-test speed. What
// stays real-browser-only is whether any of this actually RENDERS/is
// legible (tile compositing, collision placement, on-screen contrast); the
// pure feature-building logic (routeGeoJson.ts) is covered separately too.

const ROUTE_SOURCE = 'sc-route';
// #324: the non-displayed rig's route (map-only overlay, no labels/points —
// see the effects and setupLayers comment below).
const ROUTE_ALT_SOURCE = 'sc-route-alt';
const ALT_ROUTE_LAYERS = ['sc-route-alt-sail', 'sc-route-alt-motor'] as const;
const MANEUVER_SOURCE = 'sc-maneuvers';
const BARB_SOURCE = 'sc-barbs';
// #378: the three annotation symbol layers below (sc-eta-primary,
// sc-eta-secondary, sc-leg-speed) each set
// `'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 12, 13, 15, 15]`
// — zoom-interpolated, replacing a flat `text-size: 11` that was legible at a
// desk but too small on a phone on deck in daylight. Growth is DELIBERATELY
// zoom-gated rather than flat: MapLibre's collision footprint scales 1:1
// with text-size, and under text-allow-overlap:false a bigger box culls MORE
// labels — the coupling #378 itself calls out. Held near the current size
// through the low/mid zoom range (9 -> 12, +9%) where the most annotation
// points are simultaneously in view (widening it there would worsen the
// "ETAs vanish" complaint, defeating the point of this fix), then grown
// further from z12 up (12 -> 13, 15 -> 15) where a narrower viewport holds
// fewer competing points. Written out per layer (not hoisted to a shared
// const): a `const` array here loses TypeScript's tuple narrowing for
// MapLibre's `DataDrivenPropertyValueSpecification<number>` expression type
// (contextual typing only narrows an inline literal, not a value pulled from
// a separate declaration) — this also matches the file's existing pattern of
// inlining each symbol layer's layout/paint literals, see
// sc-eta-primary/-secondary's already-duplicated text-font/halo pair.
// The three annotation symbol layers the "Times & speeds" checkbox flips
// together (heading dots stay on — they're tiny and minzoom-gated).
const ANNOTATION_LAYERS = ['sc-eta-primary', 'sc-eta-secondary', 'sc-leg-speed'] as const;
const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };
// The active-leg halo. Translucent, and (since #68) painted ABOVE the shallow
// casing so a leg that is both shallow and active keeps BOTH signals — the
// yellow "you are here" wash on top, the orange shallow casing showing through
// beneath — instead of the halo being reduced to a sliver. Still below the
// sail/motor route lines.
export const HIGHLIGHT_LAYER = 'sc-route-highlight';
// #53 shallow-leg casing AND the cross-component z-order anchor: it is the
// bottom-most layer of RouteLayer's stack (added first in setupLayers), so
// DataLayers inserts its plan-independent layers BEFORE this one — below the
// whole route stack, so the depth overlay never paints over the shallow
// warning. Exported/shared so a rename here can't silently break that ordering
// (a stale string literal would resolve to no beforeId and drop the layers on
// top, with no error).
export const ROUTE_STACK_BOTTOM_LAYER = 'sc-route-shallow';
// No leg can ever have this index — an always-false filter, used while no
// leg is active instead of toggling the layer's visibility on/off.
const NO_HIGHLIGHT_IDX = -1;

// Style setup/re-add gating lives in the shared installStyleSetup hook
// (lib/styleReload.ts, #153) — see its doc for the 'load'-fires-once and
// styledata-re-add caveats. The later, repeated update effects below call the
// map APIs directly instead: they're safe any time after the style exists,
// regardless of transient tile-loading state.

function setupLayers(map: MaplibreMap): void {
  if (!map.getSource(ROUTE_SOURCE)) {
    map.addSource(ROUTE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    // #53 shallow-leg casing — a wide casing under the sail/motor route lines
    // in the established safety-depth warning color (#E69F00: depth overlay +
    // DepthProfile), marking legs that cross cells charted below the plan's
    // requested safety depth. Added FIRST so it is the bottom-most route layer:
    // it is the z-order anchor DataLayers inserts below (the depth overlay must
    // never paint over this warning), and the translucent active-leg halo is
    // added right after so the halo paints ABOVE this casing rather than being
    // occluded by it — before #68 a leg that was both shallow and active kept
    // only a sliver of the halo.
    map.addLayer({
      id: ROUTE_STACK_BOTTOM_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      filter: ['==', ['get', 'shallow'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 9,
        'line-color': '#E69F00',
        'line-opacity': 0.8,
      },
    });
    // Active-leg halo, added above the shallow casing but still before (below)
    // the sail/motor lines. Translucent (0.55), so on a shallow+active leg the
    // orange casing shows through the yellow wash and both stay legible. Starts
    // matching nothing (NO_HIGHLIGHT_IDX); the activeLegIndex-sync effect below
    // re-filters it with a cheap setFilter() call — never a source re-set — as
    // the live fix moves.
    map.addLayer({
      id: HIGHLIGHT_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      filter: ['==', ['get', 'legIndex'], NO_HIGHLIGHT_IDX],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 10,
        'line-color': '#FFD400',
        'line-opacity': 0.55,
        'line-blur': 1,
      },
    });
    // Two filtered layers rather than one data-driven layer: line-dasharray
    // is not a data-driven-capable paint property in the MapLibre style
    // spec, so sail vs. motor legs (only the latter dashed) need separate
    // layers on the shared source.
    map.addLayer({
      id: 'sc-route-sail',
      type: 'line',
      source: ROUTE_SOURCE,
      filter: ['==', ['get', 'kind'], 'sail'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 3.5,
        // Okabe-Ito colorblind-safe green/red, echoing the port/starboard
        // nav-light convention. Mirrored in RouteSummary.tsx's board dots.
        'line-color': ['case', ['==', ['get', 'board'], 'port'], '#D55E00', '#009E73'],
      },
    });
    map.addLayer({
      id: 'sc-route-motor',
      type: 'line',
      source: ROUTE_SOURCE,
      filter: ['==', ['get', 'kind'], 'motor'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 3.5,
        'line-color': '#5b5b5b',
        'line-dasharray': [2, 1.5],
      },
    });
    // Per-leg speed label along the line (#35). line-center placement only
    // renders when the label fits the on-screen leg length and collision
    // culls overlaps, so short legs stay unlabeled at low zoom and gain a
    // label as you zoom in — no hand-tuned nm threshold. Text stays achromatic
    // for contrast; the board colors live on the line beneath it. #378:
    // text-padding trimmed from the 2px default to partially offset the
    // larger collision box the zoom-interpolated text-size introduces — see
    // the #378 comment above BARB_SOURCE (top of file) for the full
    // text-size/collision coupling rationale.
    // symbol-placement:'line-center' cannot use text-variable-anchor (that
    // property only applies to point placement), so unlike the two ETA
    // layers below this one keeps its existing anchor behavior unchanged.
    map.addLayer({
      id: 'sc-leg-speed',
      type: 'symbol',
      source: ROUTE_SOURCE,
      minzoom: 10,
      layout: {
        'text-field': ['get', 'speedLabel'],
        'symbol-placement': 'line-center',
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 12, 13, 15, 15],
        'text-font': ['Noto Sans Regular'],
        'text-rotation-alignment': 'map',
        'text-padding': 1,
      },
      paint: {
        'text-color': '#1a1a1a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.4,
      },
    });
  }
  if (!map.getSource(ROUTE_ALT_SOURCE)) {
    map.addSource(ROUTE_ALT_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    // #324: "show both foresail routes" — the rig NOT currently displayed as
    // the primary route (usually, but not always, plan.result.recommended:
    // RouteSummary lets the user switch which rig is primary, and this
    // overlay always shows whichever one that isn't). Map-only per the
    // settled design — no maneuver points, ETA labels or speed labels, so it
    // adds nothing to the collision index (#378's fragile ETA/speed
    // placement stays untouched) and needs no per-hour barb sampling either.
    // Anchored explicitly BELOW HIGHLIGHT_LAYER with an explicit beforeId
    // (added earlier in this same setup pass, so the anchor always exists
    // when this runs) — deliberately below the primary route's highlight,
    // sail and motor layers (all added later, on top) so the recommendation
    // stays visually dominant wherever the two tracks cross. Still above
    // ROUTE_STACK_BOTTOM_LAYER (the shallow casing), which stays the
    // genuine bottom of the stack DataLayers anchors against — a considered
    // trade-off, not an oversight: sitting ABOVE the shallow casing means the
    // overlay can paint over the orange safety-depth warning where the two
    // geometries happen to coincide (rare — the shallow casing traces the
    // PRIMARY route's legs, not the overlay's), but sitting BELOW
    // ROUTE_STACK_BOTTOM_LAYER instead would move DataLayers' own depth
    // overlay (which anchors below that same layer) ABOVE the alt-rig track,
    // hiding the whole overlay under it whenever depth shading is on — a
    // strictly worse failure (#53 safety content survives either choice;
    // this overlay would not survive the second one).
    // Reuses the SAME board/motor color vocabulary as the primary route
    // (colour already carries sail-vs-motor/port-vs-starboard meaning — issue
    // #324's own "open design questions" section names this directly: "dash
    // pattern, opacity, and colour are the available axes, and colour is
    // already carrying meaning") and is distinguished purely by dash pattern
    // + reduced opacity, per the settled design. The dasharray is deliberately
    // NOT the primary motor line's [2, 1.5] — a denser dash so the overlay
    // reads as "the other rig", not "a motor leg". Created hidden
    // (visibility 'none'): the default is OFF (#324), and the
    // altRigVisible sync effect below applies the persisted/default state,
    // mirroring sc-wind-barbs' own creation-hidden pattern above.
    map.addLayer(
      {
        id: 'sc-route-alt-sail',
        type: 'line',
        source: ROUTE_ALT_SOURCE,
        filter: ['==', ['get', 'kind'], 'sail'],
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
        paint: {
          'line-width': 3.5,
          'line-color': ['case', ['==', ['get', 'board'], 'port'], '#D55E00', '#009E73'],
          'line-dasharray': [1, 1.5],
          'line-opacity': 0.45,
        },
      },
      HIGHLIGHT_LAYER,
    );
    map.addLayer(
      {
        id: 'sc-route-alt-motor',
        type: 'line',
        source: ROUTE_ALT_SOURCE,
        filter: ['==', ['get', 'kind'], 'motor'],
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
        paint: {
          'line-width': 3.5,
          'line-color': '#5b5b5b',
          'line-dasharray': [1, 1.5],
          'line-opacity': 0.45,
        },
      },
      HIGHLIGHT_LAYER,
    );
  }
  if (!map.getSource(MANEUVER_SOURCE)) {
    map.addSource(MANEUVER_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    // MANEUVER_SOURCE now carries the whole uniform point set (routePointFeatures):
    // start/finish/tack/gybe/heading. The maneuver circle+letter layers must
    // therefore filter to tack/gybe (inlined below), or they'd draw r=9 circles
    // at every point.
    // Heading-change dots (#37): a "mini" maneuver circle, same achromatic
    // family, clearly subordinate. Added first so it paints beneath the r=9
    // maneuver circles. minzoom 11 — declutter is by zoom, not a toggle.
    map.addLayer({
      id: 'sc-heading-dots',
      type: 'circle',
      source: MANEUVER_SOURCE,
      minzoom: 11,
      filter: ['==', ['get', 'kind'], 'heading'],
      paint: {
        'circle-radius': 3,
        'circle-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#1a1a1a',
      },
    });
    map.addLayer({
      id: 'sc-maneuver-circles',
      type: 'circle',
      source: MANEUVER_SOURCE,
      filter: ['in', ['get', 'kind'], ['literal', ['tack', 'gybe']]],
      paint: {
        'circle-radius': 9,
        'circle-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#1a1a1a',
      },
    });
    map.addLayer({
      id: 'sc-maneuver-labels',
      type: 'symbol',
      source: MANEUVER_SOURCE,
      filter: ['in', ['get', 'kind'], ['literal', ['tack', 'gybe']]],
      layout: {
        'text-field': '', // populated by the lang-sync effect below
        'text-size': 11,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#1a1a1a' },
    });
    // ETA text labels (#35). Two layers so zoom-tiering is by layer minzoom
    // (never a ['zoom'] filter): primary (departure/arrival/maneuvers) from
    // z9, secondary (plain heading joints) from z12 — one step after the dots
    // appear at 11, so a dot never pops in already-labeled. symbol-sort-key
    // = rank, so on a collision the destination ETA (rank 0) wins, then the
    // departure, then maneuvers — but that ranking is per-LAYER only (see
    // CLAUDE.md's symbol-sort-key note); it does not arbitrate a primary-vs-
    // secondary collision. text-allow-overlap:false → MapLibre declutters.
    // (Layout/paint inlined per layer so addLayer's contextual typing applies.)
    //
    // #378: text-anchor:'left' + a fixed text-offset gave MapLibre exactly
    // ONE candidate placement per point — any collision at that one spot
    // culled the label outright with no fallback. text-variable-anchor gives
    // MapLibre up to 4 fallback placements (left/right/top/bottom) before it
    // gives up and culls, directly attacking the disappearance rather than
    // trading it against size. text-variable-anchor is incompatible with
    // text-anchor/text-offset in the MapLibre style spec — text-radial-offset
    // is the documented replacement (same 0.9-em magnitude as the old
    // text-offset[0.9,0], now radial instead of purely horizontal), paired
    // with text-justify:'auto' so each candidate placement's text aligns
    // toward the anchor point. text-padding trimmed from the 2px default to
    // partially offset the larger collision box the zoom-interpolated
    // text-size introduces.
    //
    // #378 root cause, MEASURED not assumed (queryRenderedFeatures at a
    // z9-z14 zoom sweep centered on a real tack/gybe cluster, real mask/
    // polars — see BARB_SOURCE's sc-wind-barbs layer below for the fix).
    // TWO hypotheses were tested here and REFUTED by direct measurement
    // before the real cause was found, recorded so a future reader doesn't
    // re-walk the same dead ends: (1) the #191/#192 icon-overlap z12
    // threshold — inapplicable, these are point/line TEXT symbols with no
    // icon-image, icon-overlap is never set on them; (2) a primary-vs-
    // secondary cross-layer collision priority fight — ruled out by hiding
    // sc-eta-secondary entirely and re-measuring: sc-eta-primary's evicted
    // 'gybe' label stayed at count 0 regardless. The actual cause was
    // sc-wind-barbs (see that layer's comment): hiding barbs alone, with
    // secondary still visible, brought the label straight back.
    map.addLayer({
      id: 'sc-eta-primary',
      type: 'symbol',
      source: MANEUVER_SOURCE,
      minzoom: 9,
      filter: ['in', ['get', 'kind'], ['literal', ['start', 'finish', 'tack', 'gybe']]],
      layout: {
        'text-field': ['get', 'eta'],
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': 0.9,
        'text-justify': 'auto',
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 12, 13, 15, 15],
        'text-font': ['Noto Sans Regular'],
        'text-allow-overlap': false,
        'text-padding': 1,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': '#1a1a1a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.4,
      },
    });
    map.addLayer({
      id: 'sc-eta-secondary',
      type: 'symbol',
      source: MANEUVER_SOURCE,
      minzoom: 12,
      filter: ['==', ['get', 'kind'], 'heading'],
      layout: {
        'text-field': ['get', 'eta'],
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': 0.9,
        'text-justify': 'auto',
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 12, 13, 15, 15],
        'text-font': ['Noto Sans Regular'],
        'text-allow-overlap': false,
        'text-padding': 1,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': '#1a1a1a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.4,
      },
    });
  }
  if (!map.getSource(BARB_SOURCE)) {
    registerBarbImages(map);
    map.addSource(BARB_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'sc-wind-barbs',
      type: 'symbol',
      source: BARB_SOURCE,
      layout: {
        // barb-{round(speed/5)*5}, clamped to the 0..50 range registerBarbImages() drew.
        'icon-image': [
          'concat',
          'barb-',
          ['to-string', ['max', 0, ['min', 50, ['*', ['round', ['/', ['get', 'speedKn'], 5]], 5]]]],
        ],
        // Points INTO the FROM direction (standard barb convention) — see windBarbs.ts.
        'icon-rotate': ['get', 'dirFromDeg'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        // #378 root cause, MEASURED not assumed: with icon-ignore-placement
        // unset (defaulting to false), every barb icon — deliberately dense,
        // ~96-110px screen spacing at every zoom per routeGeoJson.ts's own
        // comment on this source — still INSERTED a collision box that
        // blocked the ETA/speed text layers below, even though
        // icon-allow-overlap:true already made the barbs themselves immune
        // to being blocked. That combination is the actual "ETAs vanish at
        // some zooms" mechanism (isolated with queryRenderedFeatures: hiding
        // sc-wind-barbs alone took sc-eta-primary's evicted 'gybe' label at
        // z12 from 0 back to present, and sc-leg-speed on the same route
        // from 0 to 7) — not the #191/#192 icon-overlap z12 threshold the
        // issue guessed at (these are point/line TEXT symbols with no
        // icon-image; icon-overlap is never set on them at all), and not
        // primary-vs-secondary layer order (ruled out directly: hiding
        // sc-eta-secondary alone left sc-eta-primary at 0). Setting
        // icon-ignore-placement here completes the "barbs sit outside the
        // collision system" intent routeGeoJson.ts's adaptiveBarbFeatures
        // comment already states for icon-allow-overlap — that comment's
        // "no collision culling" was only half true before this fix.
        'icon-ignore-placement': true,
        // Hidden at creation; the barbsVisible sync effect applies the
        // persisted/default state (ON for a fresh profile — #63) in the same
        // commit, before any paint.
        visibility: 'none',
      },
    });
  }
}

export default function RouteLayer({
  plan,
  rig,
  activeLegIndex,
  draftViaPoints,
  viaReplanning,
  onViaDragEnd,
}: RouteLayerProps) {
  const map = useMapInstance();
  const [lang] = useLang();
  const t = useT();
  // #628: default-open state for the collapsible controls cluster below is
  // layout-dependent, not persisted — wide (side-panel) layouts have room to
  // spare so the cluster starts open there; narrow (map-overlay) layouts are
  // exactly where this cluster obstructs the chart, so it starts collapsed.
  // Read once per mount (Disclosure's own `defaultOpen` contract); a manual
  // user toggle is never overridden by a later resize, only by the whole
  // `.route-layer-controls` block unmounting (plan -> null) and remounting.
  const isWide = useWideLayout();
  // #63: both overlays default ON (a skipper wants the wind and the numbers
  // without hunting for checkboxes) and persist an explicit choice across
  // reloads. The toggles below stay as the clean-chart escape hatch.
  const [barbsVisible, setBarbsVisible] = usePersistedToggle('sc-barbs-visible', true);
  const [annotationsVisible, setAnnotationsVisible] = usePersistedToggle(
    'sc-annotations-visible',
    true,
  );
  // #324: map-only overlay of the OTHER rig's route, default OFF (settled
  // design — showing two routes by default clutters harbour-approach zoom).
  const [altRigVisible, setAltRigVisible] = usePersistedToggle('sc-alt-rig-visible', false);
  // Real land/depth mask for barb land-culling — loaded once, best-effort.
  // A plain Uint8Array VIEW over the module-cached buffer (never a copy, never
  // transferred, never mutated). null until it resolves; sampling skips
  // culling gracefully in the meantime.
  const [mask, setMask] = useState<NavMask | null>(null);
  const [hourIdx, setHourIdx] = useState(0);
  // Reference "now" for the slider label's day-vs-today tier decision
  // (#292) — computed once at mount, matching PlannerPanel's departure-
  // bounds pattern, NOT a ticking clock. Reading Date.now() directly during
  // render is flagged by the react-hooks/react-compiler purity lint; this
  // lazy useState initializer runs exactly once. Accepted limitation: a plan
  // left open across a tier boundary (midnight, the 6-day cutoff) keeps
  // showing its previous tier until something else re-renders this
  // component — no timer is added to chase that.
  const [nowMs] = useState(() => Date.now());
  // Reset the slider to departure whenever the plan itself changes (not on
  // every render). Adjusted during render — React's documented pattern for
  // deriving state from a prop change (mirrors OptionsPanel.tsx's
  // NumberField) — rather than in an effect, which would cause an extra
  // cascading render after the DOM already committed the stale index.
  const [prevPlanId, setPrevPlanId] = useState(plan?.id ?? null);
  if ((plan?.id ?? null) !== prevPlanId) {
    setPrevPlanId(plan?.id ?? null);
    setHourIdx(0);
  }

  const result = plan && rig ? activeRigResult(plan, rig) : null;
  // #324/#54: whichever sail is NOT currently shown as the primary route.
  // `rig` defaults to plan.result.recommended but is user-switchable
  // (RouteSummary tabs) — this always tracks the complement of whatever IS
  // primary, not a fixed "recommended vs. non-recommended" pair. Derived
  // from the plan's OWN `sails` list (never a bare sail-id literal) — cap N
  // at 2 (spec §J OQ-3) means "the other one" is well-defined as long as
  // exactly two sails were requested.
  const otherRig: SailId | null =
    plan && rig ? (plan.result.sails.find((s) => s.sailId !== rig)?.sailId ?? null) : null;
  const altResult = plan && otherRig ? activeRigResult(plan, otherRig) : null;
  // #324 (PR #384 review): the toggle needs BOTH a primary result to be
  // de-emphasised against AND an alt result to show — not `altResult` alone.
  // RouteSummary's rig tabs are not gated, so `rig` can point at a rig whose
  // own result is null while the complement solved; in that state `result`
  // is null (the primary route layers paint nothing, see the ROUTE_SOURCE
  // effect below) while `altResult` is truthy, so an `!altResult`-only check
  // would leave the toggle enabled and let the ONLY real route be drawn as
  // the dashed, reduced-opacity "other rig" track — a composition inversion,
  // not a double-draw.
  const altToggleAvailable = Boolean(result) && Boolean(altResult);

  // Counts completed setup passes for the current map instance: 0 = sources/
  // layers don't exist yet; 1 once the style is first ready; +1 after every
  // style-reload re-add (#153). Re-rendering on each bump — rather than just
  // calling setupLayers from a fire-and-forget callback — matters because
  // that callback fires with only its mount-time closure (map, no plan yet);
  // the effects below need to re-observe the *current* result/plan/toggles
  // and repaint the freshly re-created (empty) sources, which only happens
  // via a dependency-driven re-run. The pre-#153 boolean could only drive
  // the first pass, so layers silently vanished after a map.setStyle().
  const [styleEpoch, setStyleEpoch] = useState(0);

  // Create sources/layers once the style is ready and again after every
  // style reload, via the shared installStyleSetup hook (#153). setupLayers
  // keeps its own per-source guards; `missing` additionally gates the epoch
  // bump so routine 'styledata' firings (any addLayer map-wide, including
  // this setup's own adds) stay cheap no-ops — the updater returns the same
  // value and React bails out. The `e === 0` half admits a remount that
  // finds the previous instance's layers still in place (RouteLayer never
  // removes them) and must still run its first data pass.
  useEffect(() => {
    if (!map) return;
    const setup = () => {
      const missing = !map.getSource(ROUTE_SOURCE);
      if (missing) setupLayers(map);
      setStyleEpoch((e) => (missing || e === 0 ? e + 1 : e));
    };
    return installStyleSetup(map, setup);
  }, [map]);

  // E2E handle: publish the live map so Playwright can introspect the barb and
  // annotation layers (queryRenderedFeatures / getLayoutProperty) — there is no
  // DOM handle for symbol counts. Mirrors the window.__sailGlyphWarmup E2E
  // signal convention; a reference to an already-in-memory object, harmless in
  // production.
  useEffect(() => {
    if (!map) return;
    const w = window as unknown as { __scMap?: MaplibreMap };
    w.__scMap = map;
    return () => {
      if (w.__scMap === map) delete w.__scMap;
    };
  }, [map]);

  // Load the real mask once (for barb land-culling). new Uint8Array(buffer) is
  // a read-only VIEW over the module-cached maskBuffer — no copy, no transfer,
  // no mutation; NavMask only reads. Best-effort: on failure, barbs still
  // render without land-culling.
  useEffect(() => {
    let cancelled = false;
    loadRoutingAssets()
      .then((assets) => {
        if (cancelled) return;
        setMask(new NavMask(assets.maskMeta, new Uint8Array(assets.maskBuffer)));
      })
      .catch(() => {
        /* leave mask null — barbs render un-culled */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Route line + the uniform annotation point set (start/finish/maneuvers/
  // heading joints, each carrying its precomputed ETA string). The line source
  // also gains the per-leg speed label; both depend on lang (ETA/speed strings
  // are precomputed), so a language switch rebuilds them.
  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const legs = result?.legs ?? [];
    const routeData = legsToFeatureCollection(legs, lang, { motorLetter: t('route.motorLetter') });
    const pointData = routePointFeatures(legs, result?.etaMs ?? 0, lang);
    (map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined)?.setData(routeData);
    (map.getSource(MANEUVER_SOURCE) as GeoJSONSource | undefined)?.setData(pointData);
    // t() is re-derived from lang every render; only lang's identity should
    // retrigger this rebuild (the strings are language-dependent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, styleEpoch, result, lang]);

  // #324: the alt-rig overlay's line data. No labels/points depend on this
  // source (see setupLayers' comment), so — unlike the effect above — this
  // never needs `t()`. #525 made `lang` a REQUIRED positional argument to
  // `legsToFeatureCollection` (it still computes an unused `speedLabel`
  // internally), so it must be passed here too even though nothing ever
  // renders it for this source. `lang` IS listed in the deps below (PR #590
  // review): `setData` with equivalent GeoJSON is idempotent and a language
  // toggle is rare and user-initiated, so there is no real cost to avoid,
  // and the sibling effect just above already depends on `lang` for the
  // identical reason — suppressing it here only for this source would leave
  // the one tool that could catch a future label added to this source
  // already switched off.
  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const altData = legsToFeatureCollection(altResult?.legs ?? [], lang);
    (map.getSource(ROUTE_ALT_SOURCE) as GeoJSONSource | undefined)?.setData(altData);
  }, [map, styleEpoch, altResult, lang]);

  // Maneuver letter labels are language-dependent: W/H (de), T/G (en).
  useEffect(() => {
    if (!map || styleEpoch === 0 || !map.getLayer('sc-maneuver-labels')) return;
    map.setLayoutProperty('sc-maneuver-labels', 'text-field', [
      'match',
      ['get', 'kind'],
      'tack',
      t('route.maneuverLetter.tack'),
      'gybe',
      t('route.maneuverLetter.gybe'),
      '',
    ]);
    // t() is re-derived from lang every render (see i18n/index.tsx); only
    // lang's identity should retrigger this layout update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, styleEpoch, lang]);

  // Fit the map to the active route when the plan changes — not on every rig
  // switch (both rigs cover roughly the same area) or barb-slider tick.
  useEffect(() => {
    if (!map || !result || result.legs.length === 0) return;
    const bounds = new LngLatBounds();
    for (const leg of result.legs) {
      bounds.extend([leg.start.lon, leg.start.lat]);
      bounds.extend([leg.end.lon, leg.end.lat]);
    }
    // #155: `bearing` MUST be passed explicitly. cameraForBounds computes
    // `options?.bearing || 0`, and _fitInternal merges the caller's options on
    // top of that camera — so omitting it does not mean "keep the current
    // bearing", it means "rotate to north". Before the compass existed the
    // bearing was always 0 and that was invisible; now every new plan.id
    // (first plan, recalc, replanWithVias, and above all a Live-tab
    // rerouteFromFix under way) would silently un-rotate the chart and knock
    // track-up out of follow — exactly the "a boat head-to-wind must not spin
    // the chart" case the hold-last-bearing decision exists for. Passing the
    // live bearing is also what MapLibre's own fitBounds docstring recommends.
    map.fitBounds(bounds, { padding: 48, duration: 0, bearing: map.getBearing() });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit on plan identity, not the (recreated) result object
  }, [map, plan?.id]);

  // Forecast hours spanning departure->ETA — the slider's snap points.
  const hourOptions = useMemo(() => {
    if (!plan || !result) return [];
    const { departureMs } = plan.request;
    const { etaMs } = result;
    const inRange = plan.windGrid.timesMs.filter((ms) => ms >= departureMs && ms <= etaMs);
    if (inRange.length > 0) return inRange;
    // Route shorter than one forecast hour: fall back to the single nearest hour.
    return [plan.windGrid.timesMs[nearestHourIndex(plan.windGrid.timesMs, departureMs)]];
  }, [plan, result]);

  const clampedHourIdx = Math.min(hourIdx, Math.max(0, hourOptions.length - 1));
  const tMs = hourOptions[clampedHourIdx] ?? plan?.request.departureMs ?? 0;

  // Viewport-scoped adaptive barbs (#36): recomputed on debounced moveend/
  // zoomend and on slider/plan/rig/mask changes — but ONLY while visible (no
  // per-frame JS during a pan, and no work at all when the toggle is off).
  // Always sampled from plan.windGrid at the slider time — never re-fetched.
  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const source = () => map.getSource(BARB_SOURCE) as GeoJSONSource | undefined;
    if (!plan || !barbsVisible) {
      // No plan → clear stale barbs. Hidden → the layer is already invisible,
      // but clearing avoids a one-frame flash of the previous hour/zoom when
      // it's re-enabled.
      source()?.setData(EMPTY_FC);
      return;
    }
    const legs = result?.legs ?? [];
    let raf = 0;
    const rebuild = () => {
      const b = map.getBounds();
      const data = adaptiveBarbFeatures(
        plan.windGrid,
        tMs,
        {
          project: (p: LatLon) => {
            const pt = map.project([p.lon, p.lat]);
            return { x: pt.x, y: pt.y };
          },
          bounds: {
            west: b.getWest(),
            south: b.getSouth(),
            east: b.getEast(),
            north: b.getNorth(),
          },
        },
        legs,
        mask,
      );
      source()?.setData(data);
    };
    const onViewChange = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        rebuild();
      });
    };
    rebuild(); // initial paint for the current slider/plan/rig/mask/viewport
    map.on('moveend', onViewChange);
    map.on('zoomend', onViewChange);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      map.off('moveend', onViewChange);
      map.off('zoomend', onViewChange);
    };
  }, [map, styleEpoch, plan, tMs, result, barbsVisible, mask]);

  useEffect(() => {
    if (!map || styleEpoch === 0 || !map.getLayer('sc-wind-barbs')) return;
    map.setLayoutProperty('sc-wind-barbs', 'visibility', barbsVisible ? 'visible' : 'none');
  }, [map, styleEpoch, barbsVisible]);

  // "Times & speeds" toggle flips the ETA + per-leg-speed label layers
  // together (heading dots are NOT included — they stay minzoom-gated).
  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const visibility = annotationsVisible ? 'visible' : 'none';
    for (const id of ANNOTATION_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
  }, [map, styleEpoch, annotationsVisible]);

  // #324: alt-rig overlay toggle, default OFF. Gated on altToggleAvailable
  // too, not just the persisted altRigVisible flag — the checkbox's
  // `disabled` attribute alone would not retract an ALREADY-toggled-on
  // overlay: altRigVisible is independent of which rig is primary, so a user
  // who enables it while both rigs solve, then switches the primary rig tab
  // to one whose own result is null (PR #384 review), would otherwise still
  // see the dashed/reduced-opacity track with nothing solid beneath it. This
  // makes that state degrade to "overlay hidden", never "overlay usurps the
  // primary".
  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const visibility = altRigVisible && altToggleAvailable ? 'visible' : 'none';
    for (const id of ALT_ROUTE_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
  }, [map, styleEpoch, altRigVisible, altToggleAvailable]);

  // Cheap setFilter() only — no source re-set — so this stays cheap even
  // when GPS noise near a leg boundary flips activeLegIndex back and forth.
  // The effect dependency array already value-gates this to real changes.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !map.getLayer(HIGHLIGHT_LAYER)) return;
    map.setFilter(HIGHLIGHT_LAYER, ['==', ['get', 'legIndex'], activeLegIndex ?? NO_HIGHLIGHT_IDX]);
  }, [map, styleEpoch, activeLegIndex]);

  if (!plan) return null;

  return (
    <div className="route-layer-controls">
      {/* #628: ViaMarkers renders NO visible box of its own most of the time
          (maplibre Markers attach straight to the map container, outside this
          DOM subtree) — its only DOM output is the rare "draft differs from
          the committed route" status chip. That chip must stay visible
          regardless of collapse state, so it sits OUTSIDE the Disclosure
          below rather than inside its collapsible body. */}
      <ViaMarkers viaPoints={draftViaPoints} replanning={viaReplanning} onDragEnd={onViaDragEnd} />
      <Disclosure
        className="route-layer-controls-disclosure"
        defaultOpen={isWide}
        summary={t('route.controls.summary')}
      >
        <label>
          <input
            type="checkbox"
            checked={annotationsVisible}
            onChange={(e) => setAnnotationsVisible(e.target.checked)}
          />
          {t('route.annotations.toggle')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={barbsVisible}
            onChange={(e) => setBarbsVisible(e.target.checked)}
          />
          {t('route.windBarbs.toggle')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={altRigVisible}
            disabled={!altToggleAvailable}
            onChange={(e) => setAltRigVisible(e.target.checked)}
            aria-describedby={altToggleAvailable ? undefined : 'route-alt-rig-note'}
          />
          {t('route.altRig.toggle')}
        </label>
        {/* A `title` attribute is hover-only — unreachable on this app's
            primary (touch) context. A visible note, wired via
            aria-describedby, reaches both. Reused for BOTH unavailable
            causes (fock/genoa's own result null, or the complement's) — "only
            one rig found a route" is accurate either way; a `Plan` only exists
            once at least the recommended rig has solved (types.ts:
            `recommendedResult`'s invariant), so the two results can never be
            null AT THE SAME TIME. */}
        {!altToggleAvailable && (
          <p id="route-alt-rig-note" className="route-alt-rig-note">
            {t('route.altRig.unavailable')}
          </p>
        )}
        {hourOptions.length > 1 && (
          <div className="route-layer-time-slider">
            <input
              type="range"
              min={0}
              max={hourOptions.length - 1}
              step={1}
              value={clampedHourIdx}
              onChange={(e) => setHourIdx(Number(e.target.value))}
              aria-label={t('route.windBarbs.timeSlider')}
              aria-valuetext={formatDateTime(tMs, lang)}
            />
            <span>{formatSliderTime(tMs, hourOptions, lang, nowMs)}</span>
          </div>
        )}
        <RouteLegend />
      </Disclosure>
    </div>
  );
}
