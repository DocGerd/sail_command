import 'fake-indexeddb/auto';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeMap, simulateStyleReload, type FakeMap } from '../test/fakeMaplibre';
import { __resetDbForTests, saveWaypoint, type SavedWaypoint } from '../services/db';
import { notifySavedWaypointsChanged } from '../lib/useSavedWaypoints';
import { HARBOR_CIRCLE_LAYER } from './DataLayers';
import SavedWaypointsLayer, {
  SAVED_WAYPOINT_LABEL_LAYER,
  SAVED_WAYPOINT_LAYER,
  SAVED_WAYPOINT_SOURCE,
} from './SavedWaypointsLayer';

// DataLayers (imported for HARBOR_CIRCLE_LAYER, the anchor identity — never
// re-spelled as a literal here, so a rename in that module reds this file
// instead of silently un-anchoring the layer) imports maplibre-gl's Popup at
// module scope. Same stub layerOrder.test.tsx uses.
vi.mock('maplibre-gl', () => ({
  Popup: class {
    setLngLat() {
      return this;
    }
    setDOMContent() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  },
}));

const hoisted = vi.hoisted(() => ({ map: null as unknown }));
vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));

/** The anchor DataLayers would have added. Deliberately a bare stand-in: the
 * assertions below are about ORDER relative to it, not about its paint. */
function addAnchor(map: FakeMap): void {
  map.addLayer({ id: HARBOR_CIRCLE_LAYER, type: 'circle', source: 'sc-harbors' });
}

function waypoint(
  id: string,
  lat: number,
  lon: number,
  name: string,
  createdAtMs = 1,
): SavedWaypoint {
  return { id, name, lat, lon, createdAtMs };
}

function renderLayer(props: { armed?: boolean; onPick?: (w: unknown) => void } = {}) {
  const onPick = props.onPick ?? vi.fn();
  const utils = render(<SavedWaypointsLayer armed={props.armed ?? false} onPick={onPick} />);
  return { onPick, ...utils };
}

let map: FakeMap;

beforeEach(async () => {
  await __resetDbForTests();
  map = makeFakeMap();
  hoisted.map = map;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SavedWaypointsLayer (#924)', () => {
  it('adds NOTHING while the harbour anchor is absent, then adds both layers when it appears', async () => {
    // THE NULL-RENDER PHASE, rendered deliberately. Production mounts this
    // component unconditionally, and it produces no source, no layer and no
    // click target until DataLayers' harbour layer exists — so a fixture
    // that always supplies the anchor makes that whole phase (and any defect
    // in leaving it) structurally unreachable, the exact gap that shipped
    // dead code under a green suite in PR #688.
    await saveWaypoint(waypoint('w1', 54.8, 9.9, 'Ankerplatz'));
    renderLayer();

    // #1015: a `waitFor` on an ALREADY-satisfied negative resolves on its
    // first tick and cannot distinguish "never becomes true" from "was
    // already false right now" — it is an assertion wearing a wait's
    // clothes. The mount effect's own setup() call has already run
    // synchronously by this point (no anchor -> early return, no
    // addSource), so the old `waitFor` form here proved nothing about
    // anything arriving LATER. Flush real pending async work first — the
    // `useSavedWaypoints()` IndexedDB read is still in flight and its
    // resolution triggers a re-render — THEN assert once, synchronously, so
    // a hypothetical addSource call on a later microtask/macrotask would be
    // caught rather than raced.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(map.addSource).not.toHaveBeenCalled();
    expect(map.getSource(SAVED_WAYPOINT_SOURCE)).toBeUndefined();
    expect(map.getLayer(SAVED_WAYPOINT_LAYER)).toBeUndefined();
    expect(map.getLayer(SAVED_WAYPOINT_LABEL_LAYER)).toBeUndefined();

    // THE TRANSITION: DataLayers' setup lands, which in real MapLibre fires
    // 'styledata' — the event installStyleSetup re-runs this setup on.
    act(() => {
      addAnchor(map);
      map.fire('styledata');
    });

    expect(map.getLayer(SAVED_WAYPOINT_LAYER)?.beforeId).toBe(HARBOR_CIRCLE_LAYER);
    expect(map.getLayer(SAVED_WAYPOINT_LABEL_LAYER)?.beforeId).toBe(HARBOR_CIRCLE_LAYER);
    // Bottom-to-top: ring, then label, then the anchor. The label must paint
    // above its own ring, and BOTH below every DataLayers marker — the
    // #160 ordering claim, asserted rather than assumed.
    expect(map.layerOrder).toEqual([
      SAVED_WAYPOINT_LAYER,
      SAVED_WAYPOINT_LABEL_LAYER,
      HARBOR_CIRCLE_LAYER,
    ]);
  });

  it('publishes the saved list once the layers exist, and again when the picker announces a change', async () => {
    renderLayer();
    act(() => {
      addAnchor(map);
      map.fire('styledata');
    });
    const source = map.getSource(SAVED_WAYPOINT_SOURCE);
    // Created EMPTY — nothing is saved yet. The transition below is what
    // proves the data path runs at all.
    await waitFor(() => expect(source?.setData).toHaveBeenCalled());
    expect(source?.setData.mock.calls.at(-1)?.[0]).toEqual({
      type: 'FeatureCollection',
      features: [],
    });

    // Distinct createdAtMs: listWaypoints reads the `by-createdAt` index and
    // REVERSES it (newest first, matching listPlans), so this also pins that
    // the layer publishes the store's own order rather than re-sorting it.
    await saveWaypoint(waypoint('w1', 54.8, 9.9, 'Ankerplatz', 1));
    await saveWaypoint(waypoint('w2', 54.9, 10.1, 'Tonne 3', 2));
    await act(async () => {
      notifySavedWaypointsChanged();
      await Promise.resolve();
    });

    await waitFor(() => {
      const last = source?.setData.mock.calls.at(-1)?.[0] as {
        features: {
          geometry: { coordinates: number[] };
          properties: { id: string; name: string };
        }[];
      };
      expect(last.features).toHaveLength(2);
      expect(last.features.map((f) => f.properties.name)).toEqual(['Tonne 3', 'Ankerplatz']);
      // lon,lat order — a transposition here would put every waypoint in the
      // wrong hemisphere while every count assertion above still passed.
      expect(last.features[0].geometry.coordinates).toEqual([10.1, 54.9]);
      expect(last.features[1].geometry.coordinates).toEqual([9.9, 54.8]);
    });
  });

  it('pins the collision policy: the label yields, and de-conflicts with its own kind', async () => {
    renderLayer();
    act(() => {
      addAnchor(map);
      map.fire('styledata');
    });
    const layout = map.getLayer(SAVED_WAYPOINT_LABEL_LAYER)?.layout ?? {};
    // BOTH knobs false. allow-overlap false is the yield; ignore-placement
    // false is what makes the layer's own labels de-conflict with EACH
    // OTHER — `true` routes every box to collision_index.ts's `ignoredGrid`,
    // which placement never queries, so several waypoints saved in one
    // anchorage all place and overprint. Entering the index costs no other
    // family anything because these are the lowest symbol layers and
    // placement runs top-to-bottom, so everyone else is placed first.
    expect(layout['text-allow-overlap']).toBe(false);
    expect(layout['text-ignore-placement']).toBe(false);
    // A symbol layer with a text-field and no text-font falls back SILENTLY
    // to a fontstack this app does not ship (#288/#320).
    expect(layout['text-font']).toEqual(['Noto Sans Regular']);
    // The ring is a CIRCLE layer, not a symbol: that is what keeps it out of
    // the collision index entirely, so it can neither cull nor be culled.
    expect(map.getLayer(SAVED_WAYPOINT_LAYER)?.type).toBe('circle');
  });

  it('re-adds both layers at the same anchor after a style reload (#153)', async () => {
    renderLayer();
    act(() => {
      addAnchor(map);
      map.fire('styledata');
    });
    expect(map.getLayer(SAVED_WAYPOINT_LAYER)).toBeDefined();

    // A mid-session map.setStyle() drops every component-added source and
    // layer, DataLayers' anchor included. The re-add must wait for the
    // anchor to come back, exactly as the first install did.
    act(() => {
      simulateStyleReload(map);
    });
    expect(map.getLayer(SAVED_WAYPOINT_LAYER)).toBeUndefined();

    act(() => {
      addAnchor(map);
      map.fire('styledata');
    });
    expect(map.getLayer(SAVED_WAYPOINT_LAYER)?.beforeId).toBe(HARBOR_CIRCLE_LAYER);
    expect(map.layerOrder).toEqual([
      SAVED_WAYPOINT_LAYER,
      SAVED_WAYPOINT_LABEL_LAYER,
      HARBOR_CIRCLE_LAYER,
    ]);
  });

  it('picks the tapped waypoint only while the via pick is armed', async () => {
    await saveWaypoint(waypoint('w1', 54.8, 9.9, 'Ankerplatz'));
    const onPick = vi.fn();
    const { rerender } = render(<SavedWaypointsLayer armed={false} onPick={onPick} />);
    act(() => {
      addAnchor(map);
      map.fire('styledata');
    });
    await waitFor(() => expect(map.getSource(SAVED_WAYPOINT_SOURCE)?.setData).toHaveBeenCalled());

    const event = { features: [{ properties: { id: 'w1' } }] };
    // Disarmed: the harbour layer owns this arming (and the disarmed case),
    // so a click here must do nothing at all.
    act(() => {
      map.fireLayerEvent('click', SAVED_WAYPOINT_LAYER, event);
    });
    expect(onPick).not.toHaveBeenCalled();

    rerender(<SavedWaypointsLayer armed onPick={onPick} />);
    act(() => {
      map.fireLayerEvent('click', SAVED_WAYPOINT_LAYER, event);
    });
    // Resolved back through the STORED record, not read off the feature —
    // coordinates and name come from IndexedDB.
    expect(onPick).toHaveBeenCalledWith({ lat: 54.8, lon: 9.9, name: 'Ankerplatz' });
  });

  it('#1015: mouseleave clears the cursor only while armed, never a harbour handler’s cursor', async () => {
    // DataLayers registers its own enter/leave pair on sc-harbor-points, so
    // an overlapping saved waypoint's DISARMED mouseleave must not clear a
    // cursor that handler set while the pointer is still over the harbour
    // marker. Simulate that by pre-setting the canvas cursor to a sentinel
    // no code path here would ever write.
    await saveWaypoint(waypoint('w1', 54.8, 9.9, 'Ankerplatz'));
    const { rerender } = renderLayer({ armed: false });
    act(() => {
      addAnchor(map);
      map.fire('styledata');
    });
    await waitFor(() => expect(map.getSource(SAVED_WAYPOINT_SOURCE)?.setData).toHaveBeenCalled());

    map.getCanvas().style.cursor = 'grab';
    act(() => {
      map.fireLayerEvent('mouseleave', SAVED_WAYPOINT_LAYER, {});
    });
    expect(map.getCanvas().style.cursor).toBe('grab');

    // Armed: this layer now owns the affordance itself, so enter sets the
    // pointer and leave must clear it again.
    rerender(<SavedWaypointsLayer armed onPick={vi.fn()} />);
    act(() => {
      map.fireLayerEvent('mouseenter', SAVED_WAYPOINT_LAYER, {});
    });
    expect(map.getCanvas().style.cursor).toBe('pointer');
    act(() => {
      map.fireLayerEvent('mouseleave', SAVED_WAYPOINT_LAYER, {});
    });
    expect(map.getCanvas().style.cursor).toBe('');
  });

  it('#1015 (round 2): a click that disarms while the pointer stays on the marker still clears the cursor on leave', async () => {
    // The TRANSITION the round-1 fix missed: App.tsx's onPick
    // (`handleSavedWaypointMapPick`) calls `setTapTarget(null)` INSIDE the
    // click handler this layer fires, so the common click-to-pick path
    // disarms while the pointer is still over the marker. No further
    // mouseenter/mouseleave fires until the pointer physically moves, and
    // by the time it does, `armed` has already flipped to false — a guard
    // that re-checks arming AT LEAVE TIME (rather than tracking that THIS
    // handler owns the cursor it set) no-ops and leaves the pointer cursor
    // stuck. A fresh-mount test cannot see this: it needs the ENTER (armed)
    // -> DISARM -> LEAVE sequence, with no mouseenter/mouseleave in between
    // the disarm and the leave.
    await saveWaypoint(waypoint('w1', 54.8, 9.9, 'Ankerplatz'));
    const { rerender } = renderLayer({ armed: true });
    act(() => {
      addAnchor(map);
      map.fire('styledata');
    });
    await waitFor(() => expect(map.getSource(SAVED_WAYPOINT_SOURCE)?.setData).toHaveBeenCalled());

    act(() => {
      map.fireLayerEvent('mouseenter', SAVED_WAYPOINT_LAYER, {});
    });
    expect(map.getCanvas().style.cursor).toBe('pointer');

    // Models the click's own onPick disarming — the prop transition
    // App.tsx's tapTarget state change produces — with NO intervening
    // mouseleave/mouseenter, because the pointer has not moved.
    rerender(<SavedWaypointsLayer armed={false} onPick={vi.fn()} />);

    act(() => {
      map.fireLayerEvent('mouseleave', SAVED_WAYPOINT_LAYER, {});
    });
    expect(map.getCanvas().style.cursor).toBe('');
  });

  it('ignores a click whose feature id is not in the current list', async () => {
    await saveWaypoint(waypoint('w1', 54.8, 9.9, 'Ankerplatz'));
    const { onPick } = renderLayer({ armed: true });
    act(() => {
      addAnchor(map);
      map.fire('styledata');
    });
    await waitFor(() => expect(map.getSource(SAVED_WAYPOINT_SOURCE)?.setData).toHaveBeenCalled());

    act(() => {
      map.fireLayerEvent('click', SAVED_WAYPOINT_LAYER, {
        features: [{ properties: { id: 'deleted-since' } }],
      });
    });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('removes its delegated listeners on unmount, matching the exact layer set', async () => {
    const { unmount, onPick } = renderLayer({ armed: true });
    act(() => {
      addAnchor(map);
      map.fire('styledata');
    });
    unmount();

    // MapLibre matches a delegated `off` on the EXACT layer set it was given
    // — a mismatched set silently no-ops and leaves an ownerless handler
    // able to fire against an unmounted component.
    act(() => {
      map.fireLayerEvent('click', SAVED_WAYPOINT_LAYER, {
        features: [{ properties: { id: 'w1' } }],
      });
    });
    expect(onPick).not.toHaveBeenCalled();
  });
});
