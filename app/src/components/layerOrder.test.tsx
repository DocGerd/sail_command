import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AisLayer from './AisLayer';
import DataLayers from './DataLayers';
import { makeFakeMap, simulateStyleReload } from '../test/fakeMaplibre';

// #160: cross-component layer ORDER against the shared fake map's insertion-
// order model. AisLayer's documented invariant — route stack above the AIS
// stack above the seamark/harbor/depth overlays — must hold for BOTH setup
// interleavings (DataLayers additionally waits for the routing-assets fetch,
// so either component can set up first) and must be re-established by the
// #153 styledata re-add path in both listener-registration orders. Pre-#160
// both components anchored on ROUTE_STACK_BOTTOM_LAYER (or appended) at
// their own setup time, so last-setup-won and seamarks could sit above AIS
// vessels for a whole session.
//
// The expected stacks below are hand-derived literals (bottom → top), NOT
// read back from the implementation:
// - DataLayers.setupLayers adds depth (absent under jsdom — the test setup
//   stubs canvas getContext to null, so buildDepthCanvas bails), then the
//   harbor circle layer, the harbor label layer, then seamarks — same
//   relative order for any shared anchor.
// - AisLayer.setupLayers adds vectors, then vessels, then labels.
// - The documented invariant slots every overlay below every AIS layer, and
//   both stacks below the route stack when it exists.

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
      harbors: [
        {
          id: 'flensburg',
          names: { de: 'Flensburg', da: 'Flensborg', en: 'Flensburg' },
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

// Bottom → top: overlays, then the AIS stack (documented invariant).
const OVERLAYS_BELOW_AIS = [
  'sc-harbor-points',
  'sc-harbor-labels',
  'sc-seamarks',
  'sc-ais-vectors',
  'sc-ais-vessels',
  'sc-ais-labels',
];
// RouteLayer's bottom-most layer (the shallow casing) tops both stacks.
const ROUTE_BOTTOM = 'sc-route-shallow';

// DataLayers' setup is complete once the harbor source got its first paint
// (the DataLayers.test.tsx settle criterion).
async function settleDataLayers(map: ReturnType<typeof makeFakeMap>) {
  await waitFor(() => {
    expect(map.sources.get('sc-harbors')?.setData.mock.calls.length).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe('AIS/overlay layer order across setup timings (#160)', () => {
  it('assets resolve BEFORE AisLayer mounts: overlays sit below the AIS stack', async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<DataLayers onHarborPick={() => {}} />);
    await settleDataLayers(map);
    render(<AisLayer targets={[]} />);
    expect(map.layerOrder).toEqual(OVERLAYS_BELOW_AIS);
  });

  it('AisLayer mounts BEFORE assets resolve: overlays still slot in below the AIS stack', async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<AisLayer targets={[]} />);
    render(<DataLayers onHarborPick={() => {}} />);
    await settleDataLayers(map);
    expect(map.layerOrder).toEqual(OVERLAYS_BELOW_AIS);
  });

  it('with the route stack present, assets-then-AIS keeps both stacks below it', async () => {
    const map = makeFakeMap();
    map.addLayer({ id: ROUTE_BOTTOM, type: 'line' });
    hoisted.map = map;
    render(<DataLayers onHarborPick={() => {}} />);
    await settleDataLayers(map);
    render(<AisLayer targets={[]} />);
    expect(map.layerOrder).toEqual([...OVERLAYS_BELOW_AIS, ROUTE_BOTTOM]);
  });

  it('with the route stack present, AIS-then-assets keeps both stacks below it', async () => {
    const map = makeFakeMap();
    map.addLayer({ id: ROUTE_BOTTOM, type: 'line' });
    hoisted.map = map;
    render(<AisLayer targets={[]} />);
    render(<DataLayers onHarborPick={() => {}} />);
    await settleDataLayers(map);
    expect(map.layerOrder).toEqual([...OVERLAYS_BELOW_AIS, ROUTE_BOTTOM]);
  });
});

describe('fakeMaplibre addLayer beforeId parity', () => {
  it('drops a layer whose beforeId names a missing layer, like real MapLibre', () => {
    // Real MapLibre fires an ErrorEvent and skips the add — an anchor used
    // WITHOUT a getLayer guard must therefore fail presence/order pins here
    // rather than silently landing as an append.
    const map = makeFakeMap();
    map.addLayer({ id: 'orphan', type: 'line' }, 'missing-anchor');
    expect(map.layerOrder).toEqual([]);
    expect(map.layers.has('orphan')).toBe(false);
  });
});

describe('AIS/overlay layer order after a style reload (#160 x #153)', () => {
  // On 'styledata' every installStyleSetup listener re-runs in REGISTRATION
  // order (= mount order), so both mount orders are pinned.
  it('DataLayers hook registered first: the re-add restores the order', async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<DataLayers onHarborPick={() => {}} />);
    await settleDataLayers(map);
    render(<AisLayer targets={[]} />);
    act(() => {
      simulateStyleReload(map);
    });
    expect(map.layerOrder).toEqual(OVERLAYS_BELOW_AIS);
  });

  it('AisLayer hook registered first: the re-add restores the order', async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<AisLayer targets={[]} />);
    render(<DataLayers onHarborPick={() => {}} />);
    await settleDataLayers(map);
    act(() => {
      simulateStyleReload(map);
    });
    expect(map.layerOrder).toEqual(OVERLAYS_BELOW_AIS);
  });
});
