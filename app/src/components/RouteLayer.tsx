import { useEffect, useMemo, useRef, useState } from 'react';
import { LngLatBounds, Map as MaplibreMap, Marker } from 'maplibre-gl';
import type { GeoJSONSource, MapLayerMouseEvent, MapMouseEvent } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { SAVED_WAYPOINT_LAYER } from './SavedWaypointsLayer';
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
import {
  DEPTH_WARNING_COLOR,
  HALO_COLOR,
  INK_COLOR,
  MOTOR_COLOR,
  PORT_COLOR,
  POSITION_HALO_COLOR,
  STARBOARD_COLOR,
  VIA_COLOR,
} from '../lib/mapColors';
import { NavMask } from '../lib/mask';
import { requestedGateM } from '../lib/shallowExposure';
import { loadRoutingAssets } from '../services/assets';
import ViaMarkers from './ViaMarkers';
import RouteLegend from './RouteLegend';
import Disclosure from './Disclosure';
import Button from './Button';
import type { LatLon, Leg, Plan, SailId } from '../types';

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
  // #850: drag-the-route-line-to-insert-a-waypoint. Fired once, on the
  // drag's release, with the released point — never live/streaming while
  // the drag is in progress (the #571 ruling this feature would otherwise
  // collide with: a via edit is a plain synchronous draft write, no replan
  // until the next explicit Plan-route press). App.tsx wires this to the
  // SAME §2.6 nearest-chain insertion `insertViaNearestOrAppend` already
  // uses for a seamark/saved-waypoint pick — see the hover-drag effect
  // below for why the grab affordance follows the rendered route line while
  // the eventual insert index is computed against a different chain.
  onRouteLineInsert: (point: LatLon) => void;
  // #1170: true while App.tsx's "Add waypoint" pick is armed for 'via' — the
  // SAME arming SavedWaypointsLayer's `armed` prop reads. Drives BOTH the
  // invisible touch/click hit-line (ROUTE_HIT_LAYER) and the visible
  // discoverability casing (see the armed-tap effect below), independent of
  // the desktop hover-drag gesture above, which needs no arming at all.
  viaArmed: boolean;
  // #1170: fired once a tap on ROUTE_HIT_LAYER resolves while armed, with the
  // point projected onto the rendered route (same #850 nearestPointOnRoute
  // geometry the hover-drag ghost uses). Deliberately a SEPARATE callback
  // from onRouteLineInsert above rather than reusing it: this path must also
  // disarm the pick afterwards (matching handleSavedWaypointMapPick's
  // "extra step" over handleSelectSavedWaypoint), where the desktop drag
  // gesture has no arming to clear.
  onArmedRouteTapInsert: (point: LatLon) => void;
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
// #1170: the visible discoverability casing shown only while the via pick is
// armed AND a route is displayed — the spike's "widened casing while armed"
// requirement. Painted below sc-route-sail/-motor (added right after
// HIGHLIGHT_LAYER, before them), so it reads as emphasis under the existing
// line rather than a new competing one. Not exported — nothing outside this
// file anchors against it.
const ROUTE_ARMED_CASING_LAYER = 'sc-route-armed-casing';
// #1170: the invisible (line-opacity 0) hit-test line a touch or pointer tap
// resolves against while armed — exported so App.tsx can add it to
// MapView's `interactiveLayerIds`, ARMED-ONLY (#924 precedent: the route
// layers are not in INTERACTIVE_MAP_LAYER_IDS unconditionally). line-width
// 44 makes the >=44px touch-target floor a rendered fact of the hit
// geometry itself, not a separate tolerance constant to keep in sync with
// one (contrast ROUTE_DRAG_HOVER_TOLERANCE_PX below, a 12px POINTER-only
// hover slop for the unrelated #850 drag gesture).
export const ROUTE_HIT_LAYER = 'sc-route-hit';

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
        'line-color': DEPTH_WARNING_COLOR,
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
        'line-color': POSITION_HALO_COLOR,
        'line-opacity': 0.55,
        'line-blur': 1,
      },
    });
    // #1170: discoverability casing, created hidden (default OFF — matches
    // sc-route-alt-*'s creation-hidden pattern above) and toggled by the
    // armed-visibility effect below. Every leg (no filter), matching
    // ROUTE_ARMED_CASING_LAYER's job of emphasising the WHOLE displayed
    // route, not just one kind. VIA_COLOR ties it visually to the via pick
    // it belongs to, distinguishing it from ROUTE_STACK_BOTTOM_LAYER's
    // orange safety casing beneath it.
    map.addLayer({
      id: ROUTE_ARMED_CASING_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-width': 9,
        'line-color': VIA_COLOR,
        'line-opacity': 0.5,
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
        'line-color': ['case', ['==', ['get', 'board'], 'port'], PORT_COLOR, STARBOARD_COLOR],
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
        'line-color': MOTOR_COLOR,
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
        'text-color': INK_COLOR,
        'text-halo-color': HALO_COLOR,
        'text-halo-width': 1.4,
      },
    });
    // #1170: the invisible hit-test line — see ROUTE_HIT_LAYER's own doc
    // comment above. Position among siblings doesn't matter (line-opacity 0
    // paints nothing), so added last in this block. Created hidden, same
    // creation-hidden/visibility-effect pattern as ROUTE_ARMED_CASING_LAYER
    // just above.
    map.addLayer({
      id: ROUTE_HIT_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-width': 44,
        'line-opacity': 0,
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
          'line-color': ['case', ['==', ['get', 'board'], 'port'], PORT_COLOR, STARBOARD_COLOR],
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
          'line-color': MOTOR_COLOR,
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
        'circle-color': HALO_COLOR,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': INK_COLOR,
      },
    });
    map.addLayer({
      id: 'sc-maneuver-circles',
      type: 'circle',
      source: MANEUVER_SOURCE,
      filter: ['in', ['get', 'kind'], ['literal', ['tack', 'gybe']]],
      paint: {
        'circle-radius': 9,
        'circle-color': HALO_COLOR,
        'circle-stroke-width': 2,
        'circle-stroke-color': INK_COLOR,
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
      paint: { 'text-color': INK_COLOR },
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
        'text-color': INK_COLOR,
        'text-halo-color': HALO_COLOR,
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
        'text-color': INK_COLOR,
        'text-halo-color': HALO_COLOR,
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

// #297: fits the map to a set of legs, preserving the current bearing.
// SHARED by the auto-fit-on-plan-change effect below AND the manual "fit
// route to view" button — the ONLY two callers of RouteLayer's fitBounds, so
// cameraAnimationCallSites.test.ts's #253 allowlist still finds exactly ONE
// textual `.fitBounds(` call site in this file (it scans SOURCE TEXT, not
// call graph — two literal call sites would need a second entry in that
// test's expected array). No-ops on an empty leg list (a plan whose active
// rig failed to solve) rather than calling fitBounds with an empty/invalid
// bounds object.
function fitToLegs(map: MaplibreMap, legs: Leg[]) {
  if (legs.length === 0) return;
  const bounds = new LngLatBounds();
  for (const leg of legs) {
    bounds.extend([leg.start.lon, leg.start.lat]);
    bounds.extend([leg.end.lon, leg.end.lat]);
  }
  // #155: `bearing` MUST be passed explicitly. cameraForBounds computes
  // `options?.bearing || 0`, and _fitInternal merges the caller's options on
  // top of that camera — so omitting it does not mean "keep the current
  // bearing", it means "rotate to north". See the call site below for the
  // full rationale (unchanged from the pre-#297 auto-fit effect this was
  // extracted from).
  map.fitBounds(bounds, { padding: 48, duration: 0, bearing: map.getBearing() });
}

// #850: grab-handle hover tolerance for the drag-the-route-line gesture, in
// SCREEN pixels — never metres/degrees, because a geo-space tolerance would
// shrink to nothing zoomed out and balloon zoomed in. A finer tolerance than
// #860's >=44px whole-control touch-target floor: this is a LINE-grab
// slop, not a tappable control.
const ROUTE_DRAG_HOVER_TOLERANCE_PX = 12;

// #850 round-2 BLOCKER: the ghost handle would otherwise appear close
// enough to `ViaMarkers.tsx`'s own 16px `.sc-via-marker` dot to stack over
// it and steal its drag
// (dragging what looks like an existing waypoint instead inserted a
// DUPLICATE one, since the ghost's own `dragend` always calls
// `onRouteLineInsert`). Suppress the ghost within the real marker's own
// half-width of any DRAFT via point (`ViaMarkers.tsx`'s `viaElement()` is
// 16px wide), checked in `onMouseMove` BEFORE the route-line hit-test below —
// not by resizing this file's own ring, which does not touch where the OTHER
// element renders. Keying the suppression to `draftViaPoints` rather than to
// the route's own vertices is what makes this correct regardless of
// snapping: `draftViaPoints` is exactly the list `<ViaMarkers
// viaPoints={draftViaPoints} …>` below renders from, so suppression and
// marker always coincide, whatever the router did with the point.
const VIA_MARKER_HALF_WIDTH_PX = 8;

// #850: pixel-space projection of a screen point onto the nearest point of
// segment [a,b]. Returns the clamped interpolation fraction `t` (0 at `a`,
// 1 at `b`) and the pixel distance from `p` to that projected point.
// Deliberately returns `t`, never the projected PIXEL — the caller
// reuses `t` to interpolate the corresponding LNGLAT directly (see
// `nearestPointOnRoute` below), sidestepping a screen->lngLat `unproject()`
// call and keeping this helper testable against the shared test fake
// (`test/fakeMaplibre.ts`), which models `map.project()` alone.
function closestPointOnSegmentPx(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): { t: number; distPx: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t =
    lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return { t, distPx: Math.hypot(p.x - cx, p.y - cy) };
}

// #850: nearest point along the CURRENTLY DISPLAYED route (the active rig's
// solved `legs`, tack/gybe geometry included) to a screen point — drives the
// drag-to-insert grab handle's hover affordance. Deliberately NOT the same
// chain `lib/viaInsertion.ts`'s `nearestViaInsertIndex` projects onto (the
// straight origin -> viaPoints -> destination chain, which has no tack/gybe
// vertices of its own): the user sees and grabs the RENDERED line, matching
// the web-routing hover-grab convention (Google Maps/Mapbox Directions)
// that #850's design question 1 names as ONE option among several — that
// same question also asks for a survey of marine/chartplotter conventions
// specifically before choosing one, since it warns those may differ (an
// explicit insert-on-a-leg action, or an edit mode entered first, instead
// of a free drag). That survey has NOT been performed here; this is the
// web-routing pattern adopted without it — the v0.26.0 triage comment on
// #850 names "behavioural survey" as one of the design questions that
// "still stands" (the LATER 2026-09-09 retriage comment does not repeat
// that line, so attribute this specifically to the v0.26.0 comment, not
// to "the retriage comment" generically). The eventual insert INDEX is
// computed against the draft chain by that existing, unmodified primitive —
// exactly the same projection "add via from a seamark" already performs for
// a point that need not lie on the solved route at all (App.tsx's
// `insertViaNearestOrAppend`). Returns `null` only for an empty `legs`
// (defensive; every call site already guards this).
//
// Linear interpolation of `lat` below (in the point construction) is a
// disclosed APPROXIMATION, not exact: `t` is a Web-Mercator PIXEL-space
// fraction, and Mercator's y is not linear in latitude, so the interpolated
// point can miss the true point on the rendered line by more than `lon`'s
// interpolation does (which IS exact — Mercator's x is linear in longitude).
// Measured at 54.7°N: ~0.1373 m off-line error at a 0.02 degree (~1.2 nm) leg
// span, ~13.75 m at 0.20 degree (~12 nm). That 0.1373 m is NOT uniformly
// sub-pixel: using `lib/mapOrientation.test.ts`'s own `metresPerPixel()`
// formula, it is 0.80 px at zoom 18, but already 1.59 px at zoom 19 and
// 12.73 px at `MAP_MAX_ZOOM` 22 (`lib/mapOrientation.ts`) — larger than
// `ROUTE_DRAG_HOVER_TOLERANCE_PX` itself. So this stays a note rather than a
// fix here at TODAY's shorter leg span and lower zooms, not on a
// pixel-space guarantee at every zoom; the failure becomes visibly off-line,
// not silent, once either a leg grows (leg-merging) or the user zooms in
// past ~z18-19.
function nearestPointOnRoute(
  map: MaplibreMap,
  legs: readonly Leg[],
  cursorPx: { x: number; y: number },
): { point: LatLon; distPx: number } | null {
  let best: { point: LatLon; distPx: number } | null = null;
  for (const leg of legs) {
    const a = map.project([leg.start.lon, leg.start.lat]);
    const b = map.project([leg.end.lon, leg.end.lat]);
    const { t, distPx } = closestPointOnSegmentPx(cursorPx, a, b);
    if (best === null || distPx < best.distPx) {
      best = {
        distPx,
        point: {
          lat: leg.start.lat + t * (leg.end.lat - leg.start.lat),
          lon: leg.start.lon + t * (leg.end.lon - leg.start.lon),
        },
      };
    }
  }
  return best;
}

// #850: builds the ephemeral "drag here to insert a waypoint" handle the
// hover effect below reveals over the route line — a hollow dashed ring
// (never filled, unlike ViaMarkers.tsx's solid `.sc-via-marker` dot) so it
// reads as "not yet a waypoint" until dropped. Styled with plain inline
// styles (matching ViaMarkers.tsx's own `viaElement()` pattern) rather than
// an app.css class, so there is no cascade/specificity surface to verify in
// a real browser for this element. 24px, matching
// ROUTE_DRAG_HOVER_TOLERANCE_PX's 12px hover radius — a real MapLibre
// Marker's drag only starts when the mousedown TARGET is inside this
// element (`marker.ts`'s `_addDragHandler`), so a smaller ring would reveal
// over a wider radius than it actually responds to.
//
// Deliberately carries NO role/tabIndex/aria-label: this gesture is
// desktop/pointer-only. Touch has no hover phase to reveal THIS handle, and
// there is no keyboard equivalent — #1170 closes the touch gap with a
// SEPARATE armed-tap path (ROUTE_HIT_LAYER's click effect below), not by
// making this ghost handle touch-reachable; #1171 (keyboard) remains out of
// scope. `aria-hidden` keeps this transient element out of the
// accessibility tree, rather than announcing an unlabelled,
// here-one-moment-gone-the-next control to a screen-reader user who could
// not reach it anyway.
function routeDragHandleElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sc-route-drag-handle';
  el.style.width = '24px';
  el.style.height = '24px';
  el.style.borderRadius = '50%';
  el.style.background = 'transparent';
  el.style.border = `2px dashed ${VIA_COLOR}`;
  el.style.cursor = 'grab';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export default function RouteLayer({
  plan,
  rig,
  activeLegIndex,
  draftViaPoints,
  viaReplanning,
  onViaDragEnd,
  onRouteLineInsert,
  viaArmed,
  onArmedRouteTapInsert,
}: RouteLayerProps) {
  const map = useMapInstance();
  const [lang] = useLang();
  const t = useT();
  // #628 (review Major 3): default-open state for the collapsible controls
  // cluster below is layout-dependent, not persisted — wide (side-panel)
  // layouts have room to spare so the cluster starts open there; narrow
  // (map-overlay) layouts are exactly where this cluster obstructs the
  // chart, so it starts collapsed. `Disclosure`'s own `defaultOpen` is read
  // ONCE via `useState` and ignores later prop changes — so on its own it
  // would leave a cluster that opened on a wide layout still OPEN after a
  // resize/rotation down to narrow (a 320px-tall cluster covering ~27% of a
  // tabletPortrait viewport, reached with ZERO user interaction — squarely
  // in the obstruction band #628's own captures measured). The `key`+effect
  // pair below is what closes that gap: `disclosureKey` remounts `Disclosure`
  // (re-seeding `defaultOpen` from the CURRENT `isWide`) whenever `isWide`
  // changes, UNLESS the user has manually toggled the cluster since mount —
  // an explicit choice must survive any later resize, never get silently
  // reset back to the layout default.
  const isWide = useWideLayout();
  const userToggledDisclosureRef = useRef(false);
  const [disclosureKey, setDisclosureKey] = useState(() => (isWide ? 'wide' : 'narrow'));
  useEffect(() => {
    if (userToggledDisclosureRef.current) return;
    setDisclosureKey(isWide ? 'wide' : 'narrow');
  }, [isWide]);
  // `Disclosure` has no `onToggle`/controlled-open prop (its three other
  // consumers — BoatPicker, AboutDialog x2, RouteSummary — are all genuinely
  // uncontrolled, so adding one is out of THIS task's scope) — so the only
  // way to observe a user's manual toggle from here is a native DOM
  // listener on the underlying `<details>`. The native `toggle` event does
  // NOT bubble, but a CAPTURE-phase listener on an ancestor still sees it on
  // the way down to its target, so this attaches to the wrapping div rather
  // than needing a ref forwarded through Disclosure. Filtered to the outer
  // `.route-layer-controls-disclosure` element specifically — the nested
  // `RouteLegend`'s own `<details class="route-legend">` fires the same
  // event and must NOT be mistaken for a toggle of the whole cluster.
  // Setting the ref alone triggers no re-render, so a toggle never causes an
  // immediate self-defeating remount — only a LATER real `isWide` change
  // would have, and the effect above now skips re-seeding once this is true.
  //
  // #628 review wave 3 Major A: this effect's deps were `[]` (mount-only),
  // but `App.tsx` renders `RouteLayer` UNCONDITIONALLY — it returns `null`
  // (the guard above the JSX return) until a plan exists, so on the real
  // FIRST mount `controlsRef.current` is null, the effect no-ops, and
  // because `[]` never re-runs it, the listener is NEVER attached for the
  // lifetime of the component even once a plan later appears and the div
  // renders. MEASURED: the manual-toggle-survives-a-resize behaviour this
  // effect exists for was silently dead in production; only a test that
  // mounts with `plan={null}` FIRST and then supplies one can see this — a
  // fixture that starts with a plan already present (as the OTHER `#628`
  // tests in RouteLayer.test.tsx do) cannot, because that shortcut happens
  // to put the div there for the very first commit, which is exactly the
  // one case the real app never starts in. Depending on `[plan]` instead
  // makes the effect re-run whenever `plan`'s identity changes — including
  // the null -> non-null transition where the div (and so `controlsRef`)
  // first exists, which is when the listener actually needs to attach. A
  // later replan (a new plan object while already non-null) re-runs this
  // again onto the SAME still-mounted DOM node (plan changing doesn't
  // remount `.route-layer-controls` itself) — a harmless redundant
  // detach+reattach, not a correctness issue.
  const controlsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = controlsRef.current;
    // #628 review wave 4 Minor: reset on unmount (plan -> null) — this ref
    // outlives the disclosure it tracks, so without the reset a toggle
    // latches across a plan reset and blocks the NEXT plan from following
    // isWide, reproducing #628's own obstruction.
    if (!el) {
      userToggledDisclosureRef.current = false;
      return;
    }
    const onNativeToggle = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.classList.contains('route-layer-controls-disclosure')) {
        userToggledDisclosureRef.current = true;
      }
    };
    el.addEventListener('toggle', onNativeToggle, true);
    return () => el.removeEventListener('toggle', onNativeToggle, true);
  }, [plan]);
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
    // #651: mask + gateM feed legsToFeatureCollection's own render-time
    // MARGINAL-leg walk (see LegProperties.shallow's doc comment in
    // routeGeoJson.ts) — the map's sc-route-shallow casing painting for a
    // non-relaxed leg is this component's half of the same fix RouteSummary's
    // legs-table chip covers. `mask` here is the SAME NavMask instance the
    // barb land-culling effect above already loads (no second fetch); gateM
    // is undefined while `plan` is null, which legsToFeatureCollection's own
    // contract treats as NOT-YET-KNOWN (leg.shallow-only), never a false
    // all-clear.
    const gateM = plan ? requestedGateM(plan) : undefined;
    const routeData = legsToFeatureCollection(legs, lang, {
      motorLetter: t('route.motorLetter'),
      mask,
      gateM,
    });
    const pointData = routePointFeatures(legs, result?.etaMs ?? 0, lang);
    (map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined)?.setData(routeData);
    (map.getSource(MANEUVER_SOURCE) as GeoJSONSource | undefined)?.setData(pointData);
    // t() is re-derived from lang every render; only lang's identity should
    // retrigger this rebuild (the strings are language-dependent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, styleEpoch, result, lang, mask, plan]);

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
  // Bounds construction + the #155 bearing-preservation rationale now live in
  // the shared `fitToLegs` helper above (#297).
  useEffect(() => {
    if (!map || !result) return;
    fitToLegs(map, result.legs);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit on plan identity, not the (recreated) result object
  }, [map, plan?.id]);

  // #297: user-invoked "fit route to view" action — the issue's own
  // recommended alternative to a permanent overview mini-map (see the issue
  // body: "a zoom-to-fit … action answers in one tap and zero permanent
  // pixels" and "if the conclusion is 'an action, not a widget', closing
  // this issue with that finding is a perfectly good outcome" — the
  // maintainer scheduled it as a user-visible deliverable, so this ships the
  // action rather than closing with no change). Reuses the exact same
  // `fitToLegs` call the auto-fit effect above makes, so a user can always
  // get back to "the whole route" after panning/zooming away from it.
  // Disabled (never hidden independently — the whole `.route-layer-controls`
  // cluster already renders nothing until `plan` exists, see the `if
  // (!plan) return null` guard below) whenever the CURRENTLY DISPLAYED rig
  // has no route to fit — either no result at all (the active rig's own
  // solve failed) or, defensively, an empty leg list.
  const canFitRoute = result !== null && result.legs.length > 0;
  const handleFitToView = () => {
    if (!map || !result) return;
    fitToLegs(map, result.legs);
  };

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

  // #1170: sync the discoverability casing AND the invisible hit-line to
  // "armed and a route is displayed" — gated on `result`, not merely
  // `viaArmed`, so arming before a plan exists (or on a rig tab whose own
  // result is null, PR #384's #324 lesson reused here) shows neither: there
  // is no route line to tap, and a 44px hit line with nothing to project
  // onto would let a tap silently vanish rather than fall through to the
  // ordinary raw-coordinate pick.
  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const visibility = viaArmed && result ? 'visible' : 'none';
    for (const id of [ROUTE_ARMED_CASING_LAYER, ROUTE_HIT_LAYER]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
  }, [map, styleEpoch, viaArmed, result]);

  // Cheap setFilter() only — no source re-set — so this stays cheap even
  // when GPS noise near a leg boundary flips activeLegIndex back and forth.
  // The effect dependency array already value-gates this to real changes.
  useEffect(() => {
    if (!map || styleEpoch === 0 || !map.getLayer(HIGHLIGHT_LAYER)) return;
    map.setFilter(HIGHLIGHT_LAYER, ['==', ['get', 'legIndex'], activeLegIndex ?? NO_HIGHLIGHT_IDX]);
  }, [map, styleEpoch, activeLegIndex]);

  // #850: hover-reveal a draggable "insert waypoint" grab handle wherever
  // the cursor sits within ROUTE_DRAG_HOVER_TOLERANCE_PX of the currently
  // displayed route line, and let it be dragged like any other via marker.
  // Deliberately reuses MapLibre's own `Marker` drag machinery (mousedown/
  // mousemove/mouseup on the MAP, driven by the marker's own DOM element)
  // rather than hand-rolling a mousedown/mousemove/mouseup sequence on the
  // map itself — this issue's own text calls disambiguating "drag the
  // route" from "pan the map" the crux of a hand-rolled gesture, and a real
  // `Marker`'s drag handler already solves exactly that: it calls
  // `e.preventDefault()` on its OWN element's mousedown, which is what stops
  // dragPan from also panning the map underneath the drag — the identical
  // mechanism `ViaMarkers.tsx`'s existing via-point dragging already
  // depends on, reused rather than re-solved.
  //
  // No navigability check on drop, matching the "add via from a seamark"/
  // "add via from a saved waypoint" precedent (App.tsx's
  // `insertViaNearestOrAppend`) — an unnavigable drop is deferred to the
  // next Plan-route press's own warnings, not rejected here.
  //
  // #391 does NOT reach this gesture (re-derived against the installed
  // maplibre-gl 6.7.0, matching the lockfile): `map.ts` wires
  // `stopHandlers: () => this._handlers?.stop(false)`, and
  // `handler_manager.ts`'s `stop()` resets registered HANDLERS only.
  // `marker.ts`'s `_addDragHandler` registers `_onMove`/`_onUp` via
  // `this._map.on(...)` — Evented LISTENERS, never Handlers — the identical
  // mechanism `ViaMarkers.tsx`'s existing via-point dragging already relies
  // on for the same reason. So an ease's completion calling
  // `_stopHandlers()` cannot touch a live `Marker` drag, regardless of
  // whether the ease itself is `duration: 0` or genuinely animating
  // (`CompassControl.tsx`'s `easeTo` is non-zero-duration UNLESS reduced
  // motion is active — `reducedMotionRef.current ? 0 : durationMs` — and is
  // reachable while the route line is hoverable, so this absence of risk is
  // not confined to this file's own `duration: 0` `fitToLegs` calls).
  //
  // A DIFFERENT teardown is reachable, unrelated to #391: this whole
  // effect's cleanup (below) also fires whenever `result`'s identity
  // changes — `result` is `activeRigResult(plan, rig)` above, so EITHER a
  // new plan (a Live-mode reroute) OR just switching the RouteSummary rig
  // tab (same plan, different `rig`) changes it — and that cleanup's
  // `removeGhost()` calls the ghost `Marker`'s own `remove()`, which
  // unregisters ITS `mousemove`/`mouseup` listeners. Only the Live-mode
  // reroute is reachable MID-DRAG: a held mouse button cannot also click
  // the RouteSummary rig tab, so that second trigger can only land between
  // drags, never during one. Mid-drag, a Live reroute silently drops an
  // in-progress drag (no `dragend`, no insert) rather than completing or
  // rejecting it. Accepted, not fixed here — same rarity class as #391
  // itself.
  useEffect(() => {
    // #850 round-2 Minor B: the `legs.length === 0` term this guard used to
    // carry (BEFORE `!result`) was dead weight — mutation-checked by
    // removing it alone and re-running RouteLayer.test.tsx: 0 of 42 tests
    // red. `nearestPointOnRoute` below already returns `null`
    // unconditionally for an empty `legs` array (its own `best` stays
    // `null` through a zero-iteration loop), and every `onMouseMove` path
    // that reads a `null` hit just calls `removeGhost()` and returns — so
    // an empty-legs `result` produces the IDENTICAL observable behaviour
    // (no ghost, ever) whether or not this effect even registers its
    // listener. Simplified rather than pinned with a new test, per this
    // repo's rule against a compound guard whose terms aren't separately
    // load-bearing.
    if (!map || !result) return;
    const legs = result.legs;
    let ghost: Marker | null = null;
    let dragging = false;

    const removeGhost = () => {
      if (ghost) {
        ghost.remove();
        ghost = null;
      }
    };

    // #850 round-2 BLOCKER: suppress the ghost whenever the cursor is over
    // an existing via marker — checked BEFORE the route-line hit-test below
    // (see VIA_MARKER_HALF_WIDTH_PX above for why this is keyed to
    // `draftViaPoints` rather than to the route's own vertices).
    const isOverViaMarker = (cursorPx: { x: number; y: number }): boolean =>
      draftViaPoints.some((via) => {
        const p = map.project([via.lon, via.lat]);
        return Math.hypot(cursorPx.x - p.x, cursorPx.y - p.y) <= VIA_MARKER_HALF_WIDTH_PX;
      });

    const onMouseMove = (e: MapMouseEvent) => {
      if (dragging) return;
      if (isOverViaMarker({ x: e.point.x, y: e.point.y })) {
        removeGhost();
        return;
      }
      const hit = nearestPointOnRoute(map, legs, { x: e.point.x, y: e.point.y });
      if (hit === null || hit.distPx > ROUTE_DRAG_HOVER_TOLERANCE_PX) {
        removeGhost();
        return;
      }
      if (!ghost) {
        // #850 BUG FIXED HERE (found by the e2e spec, not by reading): a
        // real MapLibre `Marker.addTo()` calls `_update()` synchronously,
        // which projects `this._lngLat` to set the element's transform —
        // and that field is only ever set by `setLngLat()`. Calling
        // `addTo()` BEFORE the first `setLngLat()` (as this used to)
        // therefore positions the ghost from an unset/garbage lngLat,
        // placing the DOM element far from the cursor with no error
        // anywhere. The ORIGINAL narrow test fake could not catch this — it
        // never modelled `_update`'s projection at all — which is why this
        // shipped undetected until the e2e spec caught it; the WIDENED fake
        // this same PR ships (`RouteLayer.test.tsx`'s `addToLngLat`, which
        // snapshots `lngLat` INSIDE the fake's own `addTo()`) now pins the
        // ordering directly. `setLngLat` MUST run before `addTo`, exactly
        // like ViaMarkers.tsx's own marker-construction chain
        // (`new Marker({...}).setLngLat([...])` — not `viaElement()` itself,
        // which only builds the DOM element).
        const marker = new Marker({ element: routeDragHandleElement(), draggable: true }).setLngLat(
          [hit.point.lon, hit.point.lat],
        );
        marker.on('dragstart', () => {
          dragging = true;
        });
        marker.on('dragend', () => {
          dragging = false;
          const lngLat = marker.getLngLat();
          onRouteLineInsert({ lat: lngLat.lat, lon: lngLat.lng });
          removeGhost();
        });
        marker.addTo(map);
        ghost = marker;
      } else {
        ghost.setLngLat([hit.point.lon, hit.point.lat]);
      }
    };

    // #850 BUG FOUND BY THE E2E SPEC, NOT BY READING: a `mouseout` listener
    // here looked like the obvious way to hide the handle once the cursor
    // truly leaves the map — but inserting the ghost's own DOM element
    // UNDER the cursor (it's an absolutely-positioned sibling stacked on
    // top of the canvas, same as every MapLibre Marker) makes the browser
    // consider the CANVAS itself "left" at that instant, and MapLibre
    // relays that as its own 'mouseout' MapMouseEvent — so revealing the
    // handle immediately fired the very event that removes it again,
    // making the whole gesture silently non-functional in a real browser —
    // measured while writing `app/e2e/route-line-drag.spec.ts`: commenting
    // out this registration alone flipped the drag from inserting nothing
    // to inserting correctly, with no other change.
    // A jsdom-mocked `Marker`/fake map can't catch this: neither models a
    // native mouseout relationship between sibling DOM elements at all.
    // The distance check inside `onMouseMove` above is sole and sufficient
    // for hiding the handle again (moving the cursor away recomputes and
    // removes it); the accepted residual is a ghost that can outlive the
    // cursor leaving the map ENTIRELY (onto the side panel, say) until the
    // next mousemove over the map — cheap, and nowhere near as bad as the
    // gesture never working.
    map.on('mousemove', onMouseMove);
    return () => {
      map.off('mousemove', onMouseMove);
      removeGhost();
    };
  }, [map, result, onRouteLineInsert, draftViaPoints]);

  // #1170: click-to-insert while armed — the touch/pointer counterpart to
  // the #850 hover-drag effect above, reached by tapping ROUTE_HIT_LAYER
  // (App.tsx's generic tap handler bails onto this delegated click once
  // that layer joins `interactiveLayerIds`, armed-only) instead of dragging
  // the pointer-only ghost handle. Registered once per map/styleEpoch, like
  // SavedWaypointsLayer.tsx's own click effect, with the live values read
  // from refs so an armed/result/callback churn never re-registers the map
  // listener.
  const viaArmedRef = useRef(viaArmed);
  const armedInsertLegsRef = useRef<readonly Leg[]>(result?.legs ?? []);
  const onArmedRouteTapInsertRef = useRef(onArmedRouteTapInsert);
  useEffect(() => {
    viaArmedRef.current = viaArmed;
    armedInsertLegsRef.current = result?.legs ?? [];
    onArmedRouteTapInsertRef.current = onArmedRouteTapInsert;
  });

  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const handleClick = (e: MapLayerMouseEvent) => {
      if (!viaArmedRef.current) return;
      // Precedence: saved-waypoint ring > route hit-line > raw tap (App.tsx's
      // INTERACTIVE_MAP_LAYER_IDS comment carries the third rank).
      // SavedWaypointsLayer's own delegated click and this one both fire
      // independently on a tap that hits both layers (MapLibre's delegated
      // click model — see that component's own "Which layer wins the tap"
      // doc), so bail HERE rather than rely on registration order: a saved
      // waypoint sitting on the route line must insert exactly once.
      if (
        map.getLayer(SAVED_WAYPOINT_LAYER) &&
        map.queryRenderedFeatures(e.point, { layers: [SAVED_WAYPOINT_LAYER] }).length > 0
      ) {
        return;
      }
      const hit = nearestPointOnRoute(map, armedInsertLegsRef.current, {
        x: e.point.x,
        y: e.point.y,
      });
      if (!hit) return;
      onArmedRouteTapInsertRef.current(hit.point);
    };
    map.on('click', ROUTE_HIT_LAYER, handleClick);
    return () => {
      map.off('click', ROUTE_HIT_LAYER, handleClick);
    };
  }, [map, styleEpoch]);

  if (!plan) return null;

  return (
    <div className="route-layer-controls" ref={controlsRef}>
      {/* #628: ViaMarkers renders NO visible box of its own most of the time
          (maplibre Markers attach straight to the map container, outside this
          DOM subtree) — its only DOM output is the rare "draft differs from
          the committed route" status chip. That chip must stay visible
          regardless of collapse state, so it sits OUTSIDE the Disclosure
          below rather than inside its collapsible body. */}
      <ViaMarkers viaPoints={draftViaPoints} replanning={viaReplanning} onDragEnd={onViaDragEnd} />
      {/* #628 (review Major 3): `key={disclosureKey}` deliberately remounts
          this Disclosure on an unresponded `isWide` change (see that state's
          own comment above) — do not remove the key thinking it is inert. */}
      <Disclosure
        key={disclosureKey}
        className="route-layer-controls-disclosure"
        defaultOpen={isWide}
        summary={t('route.controls.summary')}
      >
        {/* #297: user-invoked "fit route to view" — see this component's own
            #297 comment above (near `fitToLegs`/`handleFitToView`) for why
            this ships as an action rather than a permanent overview widget.
            Placed FIRST and inside the (narrow-collapsed-by-default)
            Disclosure body rather than beside ViaMarkers above it: this
            cluster's shrink-to-fit width has almost no headroom before it
            clips against `.data-layer-controls` on the opposite corner (see
            `.route-layer-controls`'s own `9.5rem` derivation in app.css) — a
            row inside the collapsed body costs zero width at the narrow
            baseline where that margin is tightest, unlike a row rendered
            unconditionally alongside ViaMarkers. */}
        <Button type="button" variant="secondary" disabled={!canFitRoute} onClick={handleFitToView}>
          {t('route.fitToView')}
        </Button>
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
