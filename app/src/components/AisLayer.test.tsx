import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AisLayer, {
  AIS_LABEL_LAYER,
  AIS_SOURCE,
  AIS_VECTOR_LAYER,
  AIS_VESSEL_LAYER,
} from './AisLayer';
import { makeFakeMap, simulateStyleReload } from '../test/fakeMaplibre';
import type { AisTargetSnapshot } from '../lib/aisTargets';

// #153: AisLayer's source/layer wiring against the shared fake map (jsdom has
// no MapLibre runtime — the BoatMarker.test.tsx approach). registerAisImages
// is a no-op here (test setup stubs canvas getContext to null); what IS
// pinned is the setup gating, the style-RELOAD re-add with the CURRENT
// targets, idempotence on routine 'styledata', and unmount disarming.

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

// Moving target with a course: aisFeatureCollection emits a vessel Point AND
// a COG-vector LineString for it (2 features).
const MOVING: AisTargetSnapshot = {
  mmsi: '211000001',
  position: { lat: 54.8, lon: 9.5 },
  sogKn: 5,
  cogDeg: 90,
  lastUpdateMs: 0,
  tier: 'fresh',
};

// No course, no SOG: exactly ONE vessel Point feature, no vector.
const DRIFTING: AisTargetSnapshot = {
  mmsi: '219000002',
  position: { lat: 54.9, lon: 10.1 },
  lastUpdateMs: 0,
  tier: 'fresh',
};

// Latest AIS-source content: the last setData payload if any update ran, else
// the data the source was created with (BoatMarker.test.tsx's vectorData).
function aisData(map: ReturnType<typeof makeFakeMap>): GeoJSON.FeatureCollection {
  const src = map.sources.get(AIS_SOURCE);
  if (!src) throw new Error('AIS source not added');
  const calls = src.setData.mock.calls;
  return calls.length > 0
    ? (calls[calls.length - 1][0] as GeoJSON.FeatureCollection)
    : (src.def.data as GeoJSON.FeatureCollection);
}

describe('AisLayer setup', () => {
  it('adds the AIS source and its three layers once the style is ready', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<AisLayer targets={[]} />);
    expect(map.sources.has(AIS_SOURCE)).toBe(true);
    expect(map.layers.get(AIS_VECTOR_LAYER)?.type).toBe('line');
    expect(map.layers.get(AIS_VESSEL_LAYER)?.type).toBe('symbol');
    expect(map.layers.get(AIS_LABEL_LAYER)?.type).toBe('symbol');
    for (const id of [AIS_VECTOR_LAYER, AIS_VESSEL_LAYER, AIS_LABEL_LAYER]) {
      expect(map.layers.get(id)?.source).toBe(AIS_SOURCE);
    }
  });

  it('paints targets that arrived before the style finished', () => {
    const map = makeFakeMap({ styleLoaded: false });
    hoisted.map = map;
    render(<AisLayer targets={[MOVING]} />);
    expect(map.sources.size).toBe(0);
    map.setStyleLoaded(true);
    map.fire('load');
    // Vessel Point + COG vector for the moving target, at its position.
    const data = aisData(map);
    expect(data.features).toHaveLength(2);
    expect((data.features[0].geometry as GeoJSON.Point).coordinates).toEqual([9.5, 54.8]);
  });
});

describe('AisLayer style reload (#153)', () => {
  it('re-adds the source and all three layers after a style reload', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<AisLayer targets={[]} />);
    simulateStyleReload(map);
    expect(map.sources.has(AIS_SOURCE)).toBe(true);
    expect(map.layers.has(AIS_VECTOR_LAYER)).toBe(true);
    expect(map.layers.has(AIS_VESSEL_LAYER)).toBe(true);
    expect(map.layers.has(AIS_LABEL_LAYER)).toBe(true);
  });

  it('re-adds with the LATEST targets, not the mount-time ones', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { rerender } = render(<AisLayer targets={[MOVING]} />);
    rerender(<AisLayer targets={[DRIFTING]} />);
    simulateStyleReload(map);
    // DRIFTING has no course and no SOG: exactly one vessel Point at ITS
    // position — a mount-closure re-add would repaint MOVING's two features.
    const data = aisData(map);
    expect(data.features).toHaveLength(1);
    expect((data.features[0].geometry as GeoJSON.Point).coordinates).toEqual([10.1, 54.9]);
    expect(data.features[0].properties?.mmsi).toBe('219000002');
  });

  it('keeps painting new snapshots on the re-added source', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { rerender } = render(<AisLayer targets={[DRIFTING]} />);
    simulateStyleReload(map);
    rerender(<AisLayer targets={[MOVING]} />);
    const data = aisData(map);
    expect(data.features).toHaveLength(2);
    expect(data.features[0].properties?.mmsi).toBe('211000001');
  });

  it('routine styledata firings neither re-create nor repaint anything', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<AisLayer targets={[MOVING]} />);
    const addSourceCalls = map.addSource.mock.calls.length;
    const setDataCalls = map.sources.get(AIS_SOURCE)?.setData.mock.calls.length;
    map.fire('styledata');
    expect(map.addSource.mock.calls.length).toBe(addSourceCalls);
    expect(map.sources.get(AIS_SOURCE)?.setData.mock.calls.length).toBe(setDataCalls);
  });

  it('unmount removes the re-add hook: a later style reload cannot resurrect the layers', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { unmount } = render(<AisLayer targets={[MOVING]} />);
    unmount();
    simulateStyleReload(map);
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });
});
