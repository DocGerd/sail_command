import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BoatMarker from './BoatMarker';

// #141: BoatMarker's marker/accuracy-circle behavior stays "not unit-tested"
// (jsdom has no MapLibre/WebGL runtime — see the component's own note). What
// IS tested here is the NEW ownship projection-vector wiring, against a small
// fake map object: source/layer setup, per-fix setData updates (rendered vs.
// suppressed collections, geometry via the real lib/ownshipVector.ts — pinned
// endpoint literals are hand-derived there, not read off the implementation),
// and teardown. The maplibre Marker is stubbed to an inert chainable object.

vi.mock('maplibre-gl', () => ({
  Marker: class {
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    setRotation() {
      return this;
    }
    remove() {}
  },
}));

const hoisted = vi.hoisted(() => ({ map: null as unknown }));
vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));

const ACCURACY_SOURCE = 'sc-boat-accuracy';
const ACCURACY_LAYER = 'sc-boat-accuracy-fill';
const VECTOR_SOURCE = 'sc-boat-vector';
const VECTOR_LAYER = 'sc-boat-vector-line';

interface FakeSource {
  setData: ReturnType<typeof vi.fn>;
  def: { type: string; data: GeoJSON.FeatureCollection };
}
interface FakeLayer {
  id: string;
  type: string;
  source: string;
  paint?: Record<string, unknown>;
}

type Handler = () => void;

function makeFakeMap({ styleLoaded = true }: { styleLoaded?: boolean } = {}) {
  const sources = new Map<string, FakeSource>();
  const layers = new Map<string, FakeLayer>();
  // Minimal Evented model (#150): plain on() listeners plus once() listeners
  // (drained on fire). MapLibre's Evented.off removes a listener regardless of
  // whether it was registered via on() or once() — BoatMarker's unmount
  // cleanup relies on exactly that for the pending whenStyleReady one-shot.
  const listeners = new Map<string, Set<Handler>>();
  const onceListeners = new Map<string, Set<Handler>>();
  const state = { styleLoaded };
  const bucket = (store: Map<string, Set<Handler>>, type: string): Set<Handler> => {
    let set = store.get(type);
    if (!set) {
      set = new Set();
      store.set(type, set);
    }
    return set;
  };
  return {
    sources,
    layers,
    setStyleLoaded: (v: boolean) => {
      state.styleLoaded = v;
    },
    fire: (type: string) => {
      for (const fn of [...bucket(listeners, type)]) fn();
      const pending = [...bucket(onceListeners, type)];
      bucket(onceListeners, type).clear();
      for (const fn of pending) fn();
    },
    isStyleLoaded: () => state.styleLoaded,
    on: vi.fn((type: string, fn: Handler) => {
      bucket(listeners, type).add(fn);
    }),
    once: vi.fn((type: string, fn: Handler) => {
      bucket(onceListeners, type).add(fn);
    }),
    off: vi.fn((type: string, fn: Handler) => {
      listeners.get(type)?.delete(fn);
      onceListeners.get(type)?.delete(fn);
    }),
    addSource: vi.fn((id: string, def: FakeSource['def']) => {
      sources.set(id, { setData: vi.fn(), def });
    }),
    getSource: (id: string) => sources.get(id),
    addLayer: vi.fn((layer: FakeLayer) => {
      layers.set(layer.id, layer);
    }),
    getLayer: (id: string) => layers.get(id),
    removeLayer: vi.fn((id: string) => {
      layers.delete(id);
    }),
    removeSource: vi.fn((id: string) => {
      sources.delete(id);
    }),
  };
}

// What a mid-session map.setStyle() does to component-added content (#150):
// every custom source/layer is dropped with the old style, then MapLibre
// fires 'styledata' once the replacement style is in place.
function simulateStyleReload(map: ReturnType<typeof makeFakeMap>): void {
  map.sources.clear();
  map.layers.clear();
  map.fire('styledata');
}

// Latest vector-source content: the last setData payload if any update effect
// ran, else the data the source was created with.
function vectorData(map: ReturnType<typeof makeFakeMap>): GeoJSON.FeatureCollection {
  const src = map.sources.get(VECTOR_SOURCE);
  if (!src) throw new Error('vector source not added');
  const calls = src.setData.mock.calls;
  return calls.length > 0
    ? (calls[calls.length - 1][0] as GeoJSON.FeatureCollection)
    : src.def.data;
}

const MOVING = {
  point: { lat: 54.8, lon: 9.5 },
  cogDeg: 45,
  sogKn: 6,
  headingToSteerDeg: 45,
  accuracyM: 12,
};

describe('BoatMarker ownship projection vector (#141)', () => {
  it('adds a vector source and an ownship-colored line layer in the AIS line-style family', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<BoatMarker {...MOVING} />);
    expect(map.sources.has(VECTOR_SOURCE)).toBe(true);
    const layer = map.layers.get(VECTOR_LAYER);
    expect(layer).toBeDefined();
    expect(layer?.type).toBe('line');
    expect(layer?.source).toBe(VECTOR_SOURCE);
    // Same family as AisLayer's COG vectors (width 1.5, fresh opacity 0.85)
    // but the ownship blue, so it can't read as a traffic vector.
    expect(layer?.paint).toEqual({
      'line-color': '#0072B2',
      'line-width': 1.5,
      'line-opacity': 0.85,
    });
  });

  it('renders the 6-min projection for a moving fix (endpoint literals from lib test)', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<BoatMarker {...MOVING} />);
    const data = vectorData(map);
    expect(data.features).toHaveLength(1);
    const geom = data.features[0].geometry as GeoJSON.LineString;
    expect(geom.coordinates[0]).toEqual([9.5, 54.8]);
    expect(geom.coordinates[1][0]).toBeCloseTo(9.512261, 6);
    expect(geom.coordinates[1][1]).toBeCloseTo(54.807066, 6);
  });

  it('suppresses the vector when SOG drops below the noise floor', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { rerender } = render(<BoatMarker {...MOVING} />);
    rerender(<BoatMarker {...MOVING} sogKn={0.3} />);
    expect(vectorData(map).features).toHaveLength(0);
  });

  it('suppresses the vector when the device reports no COG or no SOG', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { rerender } = render(<BoatMarker {...MOVING} />);
    rerender(<BoatMarker {...MOVING} cogDeg={null} />);
    expect(vectorData(map).features).toHaveLength(0);
    rerender(<BoatMarker {...MOVING} sogKn={null} />);
    expect(vectorData(map).features).toHaveLength(0);
  });

  it('re-renders the vector when a suppressed fix starts moving again', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { rerender } = render(<BoatMarker {...MOVING} sogKn={null} />);
    expect(vectorData(map).features).toHaveLength(0);
    rerender(<BoatMarker {...MOVING} />);
    expect(vectorData(map).features).toHaveLength(1);
  });

  it('removes the vector layer and source on unmount', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { unmount } = render(<BoatMarker {...MOVING} />);
    unmount();
    expect(map.layers.has(VECTOR_LAYER)).toBe(false);
    expect(map.sources.has(VECTOR_SOURCE)).toBe(false);
  });
});

describe('BoatMarker style reload (#150)', () => {
  it('re-adds the accuracy and vector sources/layers after a style reload', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<BoatMarker {...MOVING} />);
    simulateStyleReload(map);
    expect(map.sources.has(ACCURACY_SOURCE)).toBe(true);
    expect(map.sources.has(VECTOR_SOURCE)).toBe(true);
    // Re-added with the SAME ids/types/styling as the original mount (paint
    // literals pinned from the pre-#150 mount effect): the reload path must
    // not restyle anything.
    const fill = map.layers.get(ACCURACY_LAYER);
    expect(fill?.type).toBe('fill');
    expect(fill?.source).toBe(ACCURACY_SOURCE);
    expect(fill?.paint).toEqual({ 'fill-color': '#0072B2', 'fill-opacity': 0.15 });
    const line = map.layers.get(VECTOR_LAYER);
    expect(line?.type).toBe('line');
    expect(line?.source).toBe(VECTOR_SOURCE);
    expect(line?.paint).toEqual({
      'line-color': '#0072B2',
      'line-width': 1.5,
      'line-opacity': 0.85,
    });
  });

  it('re-adds with the latest fix, not the mount-time one', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { rerender } = render(<BoatMarker {...MOVING} />);
    // Latest fix before the reload: new position, SOG below the 0.5 kn floor.
    rerender(<BoatMarker {...MOVING} point={{ lat: 54.9, lon: 9.6 }} sogKn={0.3} />);
    simulateStyleReload(map);
    // Vector: suppressed at the LATEST fix — a mount-closure re-add would
    // wrongly repaint the original moving fix's one-feature line.
    expect(vectorData(map).features).toHaveLength(0);
    // Accuracy circle: centered on the LATEST point. Ring point 0 sits 12 m
    // due north of the center: 12 m = 12 / 1852 / 60 ° ≈ 0.000108°, so
    // lat ≈ 54.900108 with lon unchanged (hand-derived, not read off the
    // implementation).
    const accuracy = map.sources.get(ACCURACY_SOURCE);
    if (!accuracy) throw new Error('accuracy source not re-added');
    const ring = (accuracy.def.data.features[0].geometry as GeoJSON.Polygon).coordinates[0];
    expect(ring[0][0]).toBeCloseTo(9.6, 6);
    expect(ring[0][1]).toBeCloseTo(54.900108, 4);
  });

  it('unmount removes the re-add hook: a later style reload cannot resurrect the layers', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { unmount } = render(<BoatMarker {...MOVING} />);
    unmount();
    simulateStyleReload(map);
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });

  it('defers setup until the style is ready when the map is still loading (AisLayer gating)', () => {
    const map = makeFakeMap({ styleLoaded: false });
    hoisted.map = map;
    render(<BoatMarker {...MOVING} />);
    expect(map.sources.size).toBe(0);
    map.setStyleLoaded(true);
    map.fire('load');
    expect(map.sources.has(ACCURACY_SOURCE)).toBe(true);
    expect(map.sources.has(VECTOR_SOURCE)).toBe(true);
    expect(map.layers.has(ACCURACY_LAYER)).toBe(true);
    expect(map.layers.has(VECTOR_LAYER)).toBe(true);
  });

  it('unmount before the style is ready cancels the pending one-shot setup', () => {
    const map = makeFakeMap({ styleLoaded: false });
    hoisted.map = map;
    const { unmount } = render(<BoatMarker {...MOVING} />);
    unmount();
    map.setStyleLoaded(true);
    map.fire('load');
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });
});
