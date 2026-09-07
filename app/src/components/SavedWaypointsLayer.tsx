import { useEffect, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MaplibreMap, MapLayerMouseEvent } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { HARBOR_CIRCLE_LAYER } from './DataLayers';
import { installStyleSetup } from '../lib/styleReload';
import { savedWaypointFeatureCollection } from '../lib/savedWaypointGeoJson';
import { useSavedWaypoints } from '../lib/useSavedWaypoints';
import { HALO_COLOR, INK_COLOR, VIA_COLOR } from '../lib/mapColors';
import type { SavedWaypoint } from '../services/db';
import type { ViaPoint } from '../types';

/** GeoJSON source backing both layers below. */
export const SAVED_WAYPOINT_SOURCE = 'sc-saved-waypoints';
/** The circle layer — the marker a user sees AND the only tap target. */
export const SAVED_WAYPOINT_LAYER = 'sc-saved-waypoints';
/** The name label, a separate symbol layer (the harbour idiom). */
export const SAVED_WAYPOINT_LABEL_LAYER = 'sc-saved-waypoint-labels';

/**
 * Below this the map is small-scale enough that a handful of waypoint names
 * is clutter rather than information; the circles still render at every
 * zoom. Deliberately unlike harbour labels, which have no minzoom because 33
 * curated ports ARE the low-zoom orientation aid, whereas a personal
 * waypoint is only useful once you are working that area.
 */
const LABEL_MIN_ZOOM = 11;

const EMPTY = { type: 'FeatureCollection' as const, features: [] };

/**
 * #924: saved named waypoints as a real map symbol layer — the follow-up
 * #848 deliberately deferred (that release shipped the panel picker only).
 *
 * ## Why a circle plus a label rather than an icon symbol
 *
 * This is the HARBOUR idiom (DataLayers.tsx's HARBOR_CIRCLE_LAYER +
 * HARBOR_LABEL_LAYER), not the seamark one. Two reasons, the first being the
 * load-bearing one:
 *
 * 1. A circle layer is not a symbol layer, so it takes NO part in MapLibre's
 *    symbol collision index at all — it can neither be culled by a harbour
 *    marker or seamark glyph nor cull one. The whole of #924's stated risk
 *    (the z12 collision budget, #191/#192/#378) therefore reduces to the ONE
 *    label layer below, whose policy is spelled out at its own layout block.
 * 2. An icon symbol needs a raster registered through `map.addImage`, which
 *    in this repo means a canvas — and `app/src/test/setup.ts` stubs
 *    `HTMLCanvasElement.prototype.getContext` to return null for EVERY jsdom
 *    test, so a canvas-icon path silently produces no image and no layer in
 *    unit tests (the measured DataLayers depth/hatch trap, recorded in
 *    layerOrder.test.tsx's own #492 comment). A circle needs no image, so
 *    its presence and stack position are testable without a per-file canvas
 *    fake.
 *
 * ## Stack position, and why the anchor has no fallback
 *
 * Both layers are added with `beforeId: HARBOR_CIRCLE_LAYER`, and the setup
 * DEFERS — does nothing at all — until that layer exists. That is deliberate
 * and it is the only deterministic option available (#160: cross-component
 * order must be anchored explicitly, never left to setup timing):
 *
 * - The obvious chain, `AIS_STACK_BOTTOM_LAYER ?? ROUTE_STACK_BOTTOM_LAYER ??
 *   undefined`, is exactly the anchor DataLayers itself uses. Two components
 *   sharing one anchor are ordered by INSERTION order (each addLayer inserts
 *   immediately below beforeId, so the later call lands above), and
 *   DataLayers waits on a network fetch while this component waits only on
 *   IndexedDB — so whichever set up last would win, differently on a fast
 *   and on a slow connection. On the losing draw these markers would sit
 *   under the depth raster.
 * - Anchoring on HARBOR_CIRCLE_LAYER removes the draw entirely: the anchor
 *   IS a DataLayers layer, so the order is fixed by construction whenever
 *   these layers exist at all.
 *
 * Deferring costs nothing, because `installStyleSetup` re-runs this setup on
 * every 'styledata' and DataLayers' own `addLayer` calls fire that event —
 * so the layers appear as soon as the anchor does, and the same mechanism
 * re-creates them after a mid-session `map.setStyle()` (#153). Before that
 * moment the component is in a genuine null phase: no source, no layers, no
 * click target. Failing that way round is the safe direction — the shared
 * fake map and real MapLibre both DROP a layer whose beforeId names a
 * missing layer (#163), so an unguarded anchor would not append, it would
 * silently vanish.
 *
 * Resulting stack, bottom to top: depth ramp, depth hatch, THESE TWO,
 * harbour circles, harbour labels, seamarks, AIS stack, route stack. Saved
 * waypoints therefore paint above the general navigability shading and below
 * every curated or safety-bearing marker — the same ranking DataLayers' own
 * #492 comment applies to the hatch ("a general navigability cue should
 * never outrank a specific, already-computed safety warning"), read one tier
 * up: a personal convenience marker should never outrank a charted hazard, a
 * curated harbour, live AIS traffic or a plotted route.
 *
 * ## Which layer wins the tap
 *
 * Nothing arbitrates by paint order here, and it would be a mistake to
 * assume otherwise: MapLibre's delegated `map.on('click', layerId, fn)`
 * registrations each re-query their OWN layers, so two components' handlers
 * both fire on a click that hits both layers, in registration order. The
 * partition is by ARMED TARGET instead, and it already exists in shipped
 * code:
 *
 * - `resolveHarborPickTarget` (lib/harborGeoJson.ts) returns null for the
 *   'via' arming — "a via-armed tap on a marker is deliberately a no-op", in
 *   its own words. So the harbour layer owns origin/destination-armed and
 *   disarmed taps, and explicitly declines via-armed ones.
 * - This layer owns exactly the arming harbours decline: it acts only while
 *   the user has armed the via pick, and is inert otherwise.
 *
 * The result is a total partition with no `queryRenderedFeatures` yield
 * needed on either side, and it makes this layer the via pick's SNAP TARGET
 * in precisely the way the harbour layer is the origin/destination pick's:
 * tapping a saved waypoint inserts that waypoint's stored coordinate and
 * NAME, where the same tap on open water inserts a raw coordinate. App.tsx
 * completes the partition by adding SAVED_WAYPOINT_LAYER to MapView's
 * `interactiveLayerIds` only while the via pick is armed, so the generic tap
 * handler yields this click to us and no dead zone is created for the other
 * two armings.
 *
 * A seamark click opens an informational popover regardless of arming, so a
 * via-armed tap on a waypoint that sits on a seamark both inserts and opens
 * that popover. That is not a state race (one mutates the draft, the other
 * only displays), and yielding instead would make a waypoint unpickable
 * wherever a seamark happens to sit under it — strictly worse. Seamarks are
 * off by default (#7) either way.
 *
 * ## Keyboard access
 *
 * DELIBERATELY no second list — a considered deviation from #830's
 * SeamarksInView pattern, not an omission. #830 exists because seamarks are
 * map-ONLY features with no panel representation, so the rendered glyph
 * (which has no DOM node and can never be focused) was the only way to reach
 * them at all. Every saved waypoint, by contrast, is ALREADY a native
 * `<button>` in SavedWaypoints.tsx invoking the IDENTICAL handler this
 * layer's click invokes (App.tsx's `handleSelectSavedWaypoint`, i.e.
 * `insertViaNearestOrAppend`) — and the panel path needs no arming, so it is
 * strictly more available than the map path rather than merely equivalent.
 * This layer adds no function that lacks a keyboard route, which is what
 * WCAG 2.1.1 asks. A second list would put two buttons carrying the same
 * accessible name for the same object into the tree, breaking #7's
 * one-anchor-per-accessible-name rule and creating exactly the `getByRole`
 * substring collisions this area has already paid for.
 */
export interface SavedWaypointsLayerProps {
  /**
   * True while App.tsx's tap-to-pick is armed for 'via'. The layer is inert
   * otherwise — see "Which layer wins the tap" above.
   */
  armed: boolean;
  /**
   * Invoked with the tapped waypoint, flattened to the `ViaPoint` shape the
   * panel picker's own `onSelect` produces. App.tsx routes both to the same
   * insertion helper; keeping them identical is what makes the panel the
   * keyboard equivalent of this layer.
   */
  onPick: (w: ViaPoint) => void;
}

function setupLayers(map: MaplibreMap): void {
  // Anchor absent -> do nothing at all. 'styledata' brings us back the
  // moment DataLayers adds it. See the anchor discussion above.
  if (!map.getLayer(HARBOR_CIRCLE_LAYER)) return;
  if (map.getSource(SAVED_WAYPOINT_SOURCE)) return;
  map.addSource(SAVED_WAYPOINT_SOURCE, { type: 'geojson', data: EMPTY });
  map.addLayer(
    {
      id: SAVED_WAYPOINT_LAYER,
      type: 'circle',
      source: SAVED_WAYPOINT_SOURCE,
      paint: {
        // A HOLLOW ring in the via colour, against the harbour marker's
        // FILLED black disc with a white ring: the same family of shape,
        // read apart at a glance without relying on hue alone (the harbour
        // pair is achromatic by #38/#39's own colour-blindness argument, so
        // a coloured ring cannot collide with it under any deficiency).
        // Hollow is the semantic half: a saved waypoint is a candidate, not
        // yet part of the route, where ViaMarkers' filled VIA_COLOR pin
        // marks a point that IS in the draft.
        'circle-radius': 5,
        'circle-color': HALO_COLOR,
        'circle-stroke-width': 2.5,
        'circle-stroke-color': VIA_COLOR,
      },
    },
    HARBOR_CIRCLE_LAYER,
  );
  // Added AFTER the ring with the SAME beforeId: MapLibre stacks
  // same-beforeId additions in insertion order (each call inserts
  // immediately below beforeId, so a later call ends up ABOVE an earlier
  // one), so the label paints above its own ring and both stay below the
  // harbour anchor. Same mechanism DataLayers' #492/#682 comments rely on.
  map.addLayer(
    {
      id: SAVED_WAYPOINT_LABEL_LAYER,
      type: 'symbol',
      source: SAVED_WAYPOINT_SOURCE,
      minzoom: LABEL_MIN_ZOOM,
      layout: {
        'text-field': ['get', 'name'],
        // Explicit stack: MapLibre's implicit default
        // ("Open Sans Regular,Arial Unicode MS Regular") does NOT exist
        // under basemap-assets/fonts/, and a missing stack fails SILENTLY to
        // a locally-drawn TinySDF glyph with no error event (#288/#320).
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-anchor': 'top',
        'text-offset': [0, 0.8],
        // THE COLLISION POLICY, and the whole of this feature's collision
        // budget (the ring layer above takes no part in the index at all).
        // BOTH knobs are false, which is two separate statements:
        //   text-allow-overlap: false -> I yield. A waypoint label that
        //     collides with anything already placed is culled.
        //   text-ignore-placement: false -> my boxes DO enter the shared
        //     collision index, so my labels de-conflict with EACH OTHER.
        //     `true` here would route every box to collision_index.ts's
        //     `ignoredGrid`, which placement never queries, and several
        //     waypoints saved in one anchorage would then all place and
        //     overprint into an unreadable stack (measured in review at
        //     z11.5: nine labels inside an 82.4 x 143.1 px span at ~110 px
        //     per string).
        // Entering the index does NOT put any other family at risk, and the
        // reason is the stack position rather than the knob: MapLibre places
        // TOP-TO-BOTTOM (`pauseable_placement.ts` starts at
        // `order.length - 1` and walks down) and these are the LOWEST symbol
        // layers in the style, so every harbour, seamark, AIS and route
        // symbol is placed BEFORE them and none can be evicted by a box of
        // theirs. app/e2e/saved-waypoints.spec.ts measures that outcome on
        // both sides of the z12 icon-overlap threshold; it asserts a
        // positive control (THIS layer returns features inside the measured
        // box) first, because "unchanged" is otherwise the answer an empty
        // layer would also give.
        'text-allow-overlap': false,
        'text-ignore-placement': false,
      },
      paint: {
        // Ink on a white halo, like every other label on this map: the ring
        // below carries the identity, so the label is optimised for
        // legibility over a raster depth ramp rather than repeating the hue
        // (VIA_COLOR on a white halo measures about 2.4:1, well under any
        // text contrast floor).
        'text-color': INK_COLOR,
        'text-halo-color': HALO_COLOR,
        'text-halo-width': 1.2,
      },
    },
    HARBOR_CIRCLE_LAYER,
  );
}

export default function SavedWaypointsLayer({ armed, onPick }: SavedWaypointsLayerProps) {
  const map = useMapInstance();
  const items = useSavedWaypoints();
  // Same pattern and rationale as DataLayers'/RouteLayer's styleEpoch: 0 =
  // this component's source and layers do not exist yet; 1 once the style
  // AND the anchor are first ready; +1 after every style-reload re-add
  // (#153). The data effect depends on it so a freshly re-created source is
  // repopulated rather than left empty.
  const [styleEpoch, setStyleEpoch] = useState(0);

  const armedRef = useRef(armed);
  const onPickRef = useRef(onPick);
  const itemsRef = useRef<readonly SavedWaypoint[]>(items);
  useEffect(() => {
    armedRef.current = armed;
    onPickRef.current = onPick;
    itemsRef.current = items;
  });

  // Style-setup arming, installed exactly once per map instance per mount
  // (the installStyleSetup contract, #159). Unlike DataLayers there is no
  // second "data arrived" call-back-in path: the anchor this setup waits for
  // is itself a style mutation, so 'styledata' already covers it.
  useEffect(() => {
    if (!map) return;
    const setup = () => {
      const missing = !map.getSource(SAVED_WAYPOINT_SOURCE);
      setupLayers(map);
      // Bump only once the source actually exists. A 'styledata' that fires
      // before the anchor is added must leave the epoch at 0, so the data
      // effect below never writes to a source that is not there.
      if (!map.getSource(SAVED_WAYPOINT_SOURCE)) return;
      setStyleEpoch((e) => (missing || e === 0 ? e + 1 : e));
    };
    return installStyleSetup(map, setup);
  }, [map]);

  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    (map.getSource(SAVED_WAYPOINT_SOURCE) as GeoJSONSource | undefined)?.setData(
      savedWaypointFeatureCollection(items),
    );
  }, [map, styleEpoch, items]);

  // Click-to-pick plus a hover cursor on the ring layer. Registered once per
  // map instance per mount; the callbacks live in refs so an App re-render
  // (a new onPick identity, a change of arming) never re-registers a map
  // listener — MapLibre matches a delegated `off` on the EXACT layer set it
  // was given, so registration churn is a place removals silently no-op.
  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const handleClick = (e: MapLayerMouseEvent) => {
      if (!armedRef.current) return;
      const id: unknown = e.features?.[0]?.properties?.id;
      // Resolved back to the stored record rather than read off the feature:
      // the insertion must carry exactly what IndexedDB holds, which is why
      // the id is the only coordinate-bearing field this layer publishes.
      const w = itemsRef.current.find((x) => x.id === id);
      if (!w) return;
      onPickRef.current({ lat: w.lat, lon: w.lon, name: w.name });
    };
    const handleEnter = () => {
      // Only while armed — a pointer cursor over a marker that does nothing
      // when clicked is worse than no affordance at all.
      if (armedRef.current) map.getCanvas().style.cursor = 'pointer';
    };
    const handleLeave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', SAVED_WAYPOINT_LAYER, handleClick);
    map.on('mouseenter', SAVED_WAYPOINT_LAYER, handleEnter);
    map.on('mouseleave', SAVED_WAYPOINT_LAYER, handleLeave);
    return () => {
      map.off('click', SAVED_WAYPOINT_LAYER, handleClick);
      map.off('mouseenter', SAVED_WAYPOINT_LAYER, handleEnter);
      map.off('mouseleave', SAVED_WAYPOINT_LAYER, handleLeave);
    };
  }, [map, styleEpoch]);

  return null;
}
