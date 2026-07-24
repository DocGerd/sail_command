import { vi } from 'vitest';

// Shared minimal MapLibre `Map` fake for layer-component tests (#153),
// modeled on BoatMarker.test.tsx's local fake — the #150/#151 spec, which
// keeps its own copy so those tests stay untouched. jsdom has no MapLibre/
// WebGL runtime, so components are exercised against this object via a
// mocked useMapInstance().
//
// Evented model: plain on() listeners plus once() listeners (drained on
// fire). MapLibre's Evented.off removes a listener regardless of whether it
// was registered via on() or once() — the unmount cleanup of the shared
// installStyleSetup hook (lib/styleReload.ts) relies on exactly that for a
// still-pending 'load' one-shot. Delegated `(type, layerId, fn)`
// registrations (popup/hover handlers) are stored under a separate key so
// `fire('styledata')`/`fire('load')` can never reach them.

export interface FakeSource {
  setData: ReturnType<typeof vi.fn>;
  def: { type: string; data?: GeoJSON.FeatureCollection; [k: string]: unknown };
}

export interface FakeLayer {
  id: string;
  type: string;
  source?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  filter?: unknown;
  minzoom?: number;
  // Recorded from addLayer's second argument, so tests can assert anchoring
  // (e.g. AisLayer inserting below ROUTE_STACK_BOTTOM_LAYER when it exists).
  beforeId?: string;
}

type Handler = (...args: unknown[]) => void;

export type FakeMap = ReturnType<typeof makeFakeMap>;

export function makeFakeMap({ styleLoaded = true }: { styleLoaded?: boolean } = {}) {
  const sources = new Map<string, FakeSource>();
  const layers = new Map<string, FakeLayer>();
  // #160: insertion-order model of the style's layer array, bottom → top.
  // MapLibre's addLayer(layer, beforeId) inserts the layer immediately BELOW
  // beforeId; with no beforeId it appends on top. The `layers` Map alone only
  // records each layer's beforeId at add time — ordering tests pin the exact
  // final stack against this array instead.
  const layerOrder: string[] = [];
  const images = new Set<string>();
  const listeners = new Map<string, Set<Handler>>();
  const onceListeners = new Map<string, Set<Handler>>();
  const state = { styleLoaded };
  const canvas = { style: {} as Record<string, string> };
  const bucket = (store: Map<string, Set<Handler>>, type: string): Set<Handler> => {
    let set = store.get(type);
    if (!set) {
      set = new Set();
      store.set(type, set);
    }
    return set;
  };
  const key = (type: string, layerOrFn: unknown): string =>
    typeof layerOrFn === 'string' ? `${type}\u0000${layerOrFn}` : type;
  return {
    sources,
    layers,
    layerOrder,
    images,
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
    on: vi.fn((type: string, layerOrFn: string | Handler, maybeFn?: Handler) => {
      bucket(listeners, key(type, layerOrFn)).add(maybeFn ?? (layerOrFn as Handler));
    }),
    once: vi.fn((type: string, layerOrFn: string | Handler, maybeFn?: Handler) => {
      bucket(onceListeners, key(type, layerOrFn)).add(maybeFn ?? (layerOrFn as Handler));
    }),
    off: vi.fn((type: string, layerOrFn: string | Handler, maybeFn?: Handler) => {
      const k = key(type, layerOrFn);
      const fn = maybeFn ?? (layerOrFn as Handler);
      listeners.get(k)?.delete(fn);
      onceListeners.get(k)?.delete(fn);
    }),
    addSource: vi.fn((id: string, def: FakeSource['def']) => {
      sources.set(id, { setData: vi.fn(), def });
    }),
    getSource: (id: string) => sources.get(id),
    addLayer: vi.fn((layer: FakeLayer, beforeId?: string) => {
      layers.set(layer.id, beforeId === undefined ? layer : { ...layer, beforeId });
      const at = beforeId === undefined ? -1 : layerOrder.indexOf(beforeId);
      if (at === -1) layerOrder.push(layer.id);
      else layerOrder.splice(at, 0, layer.id);
    }),
    getLayer: (id: string) => layers.get(id),
    removeLayer: vi.fn((id: string) => {
      layers.delete(id);
      const at = layerOrder.indexOf(id);
      if (at !== -1) layerOrder.splice(at, 1);
    }),
    removeSource: vi.fn((id: string) => {
      sources.delete(id);
    }),
    hasImage: (id: string) => images.has(id),
    addImage: vi.fn((id: string) => {
      images.add(id);
    }),
    setLayoutProperty: vi.fn((id: string, prop: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.layout = { ...layer.layout, [prop]: value };
    }),
    setFilter: vi.fn((id: string, filter: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.filter = filter;
    }),
    fitBounds: vi.fn(),
    getCanvas: () => canvas,
    // Fixed app-region viewport + linear projection (the App.test.tsx stubs):
    // keeps RouteLayer's barb rebuild effect deterministic under jsdom; barb
    // OUTPUT is never asserted against these (that's a real-browser concern).
    getBounds: () => ({
      getWest: () => 9.4,
      getSouth: () => 54.3,
      getEast: () => 11.0,
      getNorth: () => 55.3,
    }),
    project: (lngLat: [number, number]) => ({
      x: (lngLat[0] - 9.4) * 500,
      y: (55.3 - lngLat[1]) * 500,
    }),
  };
}

// What a mid-session map.setStyle() does to component-added content (#150):
// every custom source/layer/image is dropped with the old style, then
// MapLibre fires 'styledata' once the replacement style is in place.
export function simulateStyleReload(map: FakeMap): void {
  map.sources.clear();
  map.layers.clear();
  map.layerOrder.length = 0;
  map.images.clear();
  map.fire('styledata');
}
