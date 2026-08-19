import 'fake-indexeddb/auto';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AisLayer from './AisLayer';
import DataLayers from './DataLayers';
import { makeFakeMap, simulateStyleReload } from '../test/fakeMaplibre';
import { AppStateProvider } from '../state/AppState';
import { __resetDbForTests } from '../services/db';

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
// - DataLayers.setupLayers adds the absolute depth ramp, then the #492
//   hazard-hatch overlay, then the harbor circle layer, the harbor label
//   layer, then seamarks — same relative order for any shared anchor.
// - AisLayer.setupLayers adds vectors, then vessels, then labels.
// - The documented invariant slots every overlay below every AIS layer, and
//   both stacks below the route stack when it exists.
//
// #492 review M4: the depth/hatch pair used to be ABSENT from every
// assertion below, not merely untested — the shared jsdom setup
// (test/setup.ts) stubs `HTMLCanvasElement.prototype.getContext` to return
// null globally (RouteLayer/App.test.tsx need that to suppress a noisy
// "Not implemented" warning), so buildDepthCanvas/buildHatchCanvas always
// bailed and neither layer's #160 stack POSITION was pinned by anything —
// the exact "verification method structurally cannot see a regression
// class" shape CLAUDE.md documents elsewhere. The fake below restores just
// enough of the 2D context (createImageData/putImageData — everything
// either build function actually calls) for THIS FILE to exercise both
// layers; no pixel content is checked here, only presence and ORDER — real
// rendering stays app/e2e/datalayers.spec.ts's job.
//
// CORRECTION to the reviewer-supplied form: the review's suggested stub
// returns the same fake for EVERY canvas unconditionally. This file's
// DataLayers render ALSO drives seamarkGlyphs.ts's registerSeamarkImages,
// which creates its OWN canvas (a square glyph raster, BASE_CANVAS_SIZE=64
// at the default scale) and calls `ctx.clearRect(...)` — a method the
// minimal fake doesn't have, so an unconditional stub crashes with
// `ctx.clearRect is not a function` (MEASURED: all 6 tests in this file
// failed that way on the first attempt). registerSeamarkImages already
// handles a NULL context gracefully (`if (!ctx) continue;`,
// seamarkGlyphs.ts), so the fix is to answer null for anything that ISN'T
// the depth/hatch canvas — discriminated by SIZE, since only
// buildDepthCanvas/buildHatchCanvas produce a canvas matching this file's
// own maskMeta fixture (`cols: 4, rows: 4`, hoisted.assets above), which a
// 64x64 glyph raster can never collide with.
HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement): unknown {
  if (this.width !== 4 || this.height !== 4) return null; // e.g. a seamark glyph raster
  return {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
  };
}) as unknown as HTMLCanvasElement['getContext'];

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
      // #54: keys spelled out because this literal lives inside a
      // vi.hoisted() block, which runs BEFORE the imports — calling
      // polarKey() here throws "Cannot access before initialization".
      polars: { 'salona-45/genoa': polar, 'salona-45/fock': polar },
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
// 'sc-depth' and 'sc-depth-hatch' (#492) lead the stack — DataLayers.tsx's
// setupLayers adds the absolute ramp, then the hazard-hatch overlay, BEFORE
// the harbor/seamark layers that follow, all sharing the same beforeId
// anchor (insertion order = bottom-to-top for same-anchor additions).
const OVERLAYS_BELOW_AIS = [
  'sc-depth',
  'sc-depth-hatch',
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

// #492: DataLayers now calls useSettings() directly (see that hook's own
// #492 comment in DataLayers.tsx for why), so every render of it below is
// wrapped in AppStateProvider — same fix as DataLayers.test.tsx's own
// renderDataLayers() helper, applied here because this file ALSO renders
// DataLayers directly (a cross-file consequence of that architecture
// choice: it broke this file too, not only DataLayers.test.tsx).
function renderDataLayers() {
  return render(
    <AppStateProvider>
      <DataLayers onHarborPick={() => {}} />
    </AppStateProvider>,
  );
}

beforeEach(async () => {
  await __resetDbForTests();
  localStorage.clear();
});

describe('AIS/overlay layer order across setup timings (#160)', () => {
  it('assets resolve BEFORE AisLayer mounts: overlays sit below the AIS stack', async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    renderDataLayers();
    await settleDataLayers(map);
    render(<AisLayer targets={[]} />);
    expect(map.layerOrder).toEqual(OVERLAYS_BELOW_AIS);
  });

  it('AisLayer mounts BEFORE assets resolve: overlays still slot in below the AIS stack', async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<AisLayer targets={[]} />);
    renderDataLayers();
    await settleDataLayers(map);
    expect(map.layerOrder).toEqual(OVERLAYS_BELOW_AIS);
  });

  it('with the route stack present, assets-then-AIS keeps both stacks below it', async () => {
    const map = makeFakeMap();
    map.addLayer({ id: ROUTE_BOTTOM, type: 'line' });
    hoisted.map = map;
    renderDataLayers();
    await settleDataLayers(map);
    render(<AisLayer targets={[]} />);
    expect(map.layerOrder).toEqual([...OVERLAYS_BELOW_AIS, ROUTE_BOTTOM]);
  });

  it('with the route stack present, AIS-then-assets keeps both stacks below it', async () => {
    const map = makeFakeMap();
    map.addLayer({ id: ROUTE_BOTTOM, type: 'line' });
    hoisted.map = map;
    render(<AisLayer targets={[]} />);
    renderDataLayers();
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
    renderDataLayers();
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
    renderDataLayers();
    await settleDataLayers(map);
    act(() => {
      simulateStyleReload(map);
    });
    expect(map.layerOrder).toEqual(OVERLAYS_BELOW_AIS);
  });
});
