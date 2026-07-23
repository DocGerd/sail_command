import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataLayers, { HARBOR_CIRCLE_LAYER, SEAMARKS_LAYER } from './DataLayers';
import { makeFakeMap, simulateStyleReload } from '../test/fakeMaplibre';

// #153: DataLayers' style-reload re-add against the shared fake map (jsdom
// has no MapLibre runtime — the BoatMarker.test.tsx approach). The depth
// raster is NOT covered here: buildDepthCanvas needs a 2D canvas backend
// (test setup stubs getContext to null), so the depth source never exists
// under jsdom — its re-add rides the same setupLayers call as the harbor/
// seamark sources asserted below, and its rendering stays browser-verified.

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

const hoisted = vi.hoisted(() => {
  const polar = {
    rig: 'genoa',
    boat: 'test',
    tws: [10],
    twa: [90],
    speeds: [[5]],
    beat: { tws: [10], angle: [45] },
    gybe: { tws: [10], angle: [170] },
    source: 'synthetic test fixture',
  };
  return {
    map: null as unknown,
    assets: {
      maskMeta: { west: 9.4, south: 54.3, east: 11.0, north: 55.3, cols: 4, rows: 4 },
      maskBuffer: new ArrayBuffer(16),
      polarGenoa: polar,
      polarFock: polar,
      // de/en names differ so a painted feature pins WHICH language was
      // current when the (re-)add ran (default context lang: de).
      harbors: [
        {
          id: 'flensburg',
          names: { de: 'Flensburg (DE)', da: 'Flensborg', en: 'Flensburg (EN)' },
          country: 'DE',
          snap: { lat: 54.796, lon: 9.43 },
        },
      ],
      seamarks: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [9.9, 54.8] },
            properties: { seamarkType: 'buoy_lateral', category: 'port', colour: 'red' },
          },
        ],
      },
    },
  };
});
vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));
vi.mock('../services/assets', () => ({
  loadRoutingAssets: vi.fn(() => Promise.resolve(hoisted.assets)),
}));

const HARBOR_SOURCE = 'sc-harbors';
const SEAMARKS_SOURCE = 'sc-seamarks';
const HARBOR_LABEL_LAYER = 'sc-harbor-labels';

// Latest content of a GeoJSON fake source: last setData payload, else the
// creation data (BoatMarker.test.tsx's vectorData helper).
function sourceData(map: ReturnType<typeof makeFakeMap>, id: string): GeoJSON.FeatureCollection {
  const src = map.sources.get(id);
  if (!src) throw new Error(`source ${id} not added`);
  const calls = src.setData.mock.calls;
  return calls.length > 0
    ? (calls[calls.length - 1][0] as GeoJSON.FeatureCollection)
    : (src.def.data as GeoJSON.FeatureCollection);
}

async function renderAndSettle(map: ReturnType<typeof makeFakeMap>) {
  hoisted.map = map;
  const utils = render(<DataLayers onHarborPick={() => {}} />);
  // Settle on the PAINTED harbor data, not bare source existence: the source
  // is created one commit before the epoch-driven data effects repaint it,
  // and a loaded CI runner can catch that window.
  await waitFor(() => {
    expect(map.sources.get(HARBOR_SOURCE)?.setData.mock.calls.length).toBeGreaterThan(0);
  });
  return utils;
}

beforeEach(() => {
  localStorage.clear();
});

describe('DataLayers setup', () => {
  it('adds the harbor and seamark sources/layers once style and assets are ready', async () => {
    localStorage.setItem('sc-seamarks-visible', '1');
    const map = makeFakeMap();
    await renderAndSettle(map);
    expect(map.sources.has(SEAMARKS_SOURCE)).toBe(true);
    expect(map.layers.get(HARBOR_CIRCLE_LAYER)?.type).toBe('circle');
    expect(map.layers.get(HARBOR_LABEL_LAYER)?.type).toBe('symbol');
    expect(map.layers.get(SEAMARKS_LAYER)?.type).toBe('symbol');
    // Painted with the current (de) names at the snap position.
    const harbors = sourceData(map, HARBOR_SOURCE);
    expect(harbors.features).toHaveLength(1);
    expect((harbors.features[0].geometry as GeoJSON.Point).coordinates).toEqual([9.43, 54.796]);
    expect(harbors.features[0].properties?.name).toBe('Flensburg (DE)');
    // Persisted opt-in applied over the hidden-at-creation default.
    expect(map.layers.get(SEAMARKS_LAYER)?.layout?.visibility).toBe('visible');
  });

  it('holds off until a late style becomes ready, even with assets already loaded', async () => {
    const map = makeFakeMap({ styleLoaded: false });
    hoisted.map = map;
    render(<DataLayers onHarborPick={() => {}} />);
    // Let the assets fetch settle: still nothing — the style isn't ready.
    await act(async () => {});
    expect(map.sources.size).toBe(0);
    act(() => {
      map.setStyleLoaded(true);
      map.fire('load');
    });
    expect(map.sources.has(HARBOR_SOURCE)).toBe(true);
    expect(sourceData(map, HARBOR_SOURCE).features).toHaveLength(1);
  });
});

describe('DataLayers style reload (#153)', () => {
  it('re-adds sources/layers and repaints current data and visibility', async () => {
    localStorage.setItem('sc-seamarks-visible', '1');
    const map = makeFakeMap();
    await renderAndSettle(map);
    act(() => {
      simulateStyleReload(map);
    });
    expect(map.sources.has(HARBOR_SOURCE)).toBe(true);
    expect(map.sources.has(SEAMARKS_SOURCE)).toBe(true);
    expect(map.layers.has(HARBOR_CIRCLE_LAYER)).toBe(true);
    expect(map.layers.has(HARBOR_LABEL_LAYER)).toBe(true);
    expect(map.layers.has(SEAMARKS_LAYER)).toBe(true);
    // Repainted with current-language data, not left at the empty creation
    // collections.
    const harbors = sourceData(map, HARBOR_SOURCE);
    expect(harbors.features).toHaveLength(1);
    expect(harbors.features[0].properties?.name).toBe('Flensburg (DE)');
    const seamarks = sourceData(map, SEAMARKS_SOURCE);
    expect(seamarks.features).toHaveLength(1);
    expect((seamarks.features[0].geometry as GeoJSON.Point).coordinates).toEqual([9.9, 54.8]);
    expect(typeof seamarks.features[0].properties?.icon).toBe('string');
    // The #144 declutter layout travels with the re-add …
    expect(map.layers.get(SEAMARKS_LAYER)?.layout?.['symbol-sort-key']).toEqual([
      'get',
      'priority',
    ]);
    // … and the persisted opt-in is re-applied over the hidden default.
    expect(map.layers.get(SEAMARKS_LAYER)?.layout?.visibility).toBe('visible');
  });

  it('routine styledata firings neither re-create nor repaint anything', async () => {
    const map = makeFakeMap();
    await renderAndSettle(map);
    const addSourceCalls = map.addSource.mock.calls.length;
    const setDataCalls = map.sources.get(HARBOR_SOURCE)?.setData.mock.calls.length;
    act(() => {
      map.fire('styledata');
    });
    expect(map.addSource.mock.calls.length).toBe(addSourceCalls);
    expect(map.sources.get(HARBOR_SOURCE)?.setData.mock.calls.length).toBe(setDataCalls);
  });

  it('unmount removes the re-add hook: a later style reload cannot resurrect the layers', async () => {
    const map = makeFakeMap();
    const { unmount } = await renderAndSettle(map);
    unmount();
    simulateStyleReload(map);
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });
});
