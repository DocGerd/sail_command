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

function makeFakeMap() {
  const sources = new Map<string, FakeSource>();
  const layers = new Map<string, FakeLayer>();
  return {
    sources,
    layers,
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
