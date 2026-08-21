import 'fake-indexeddb/auto';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataLayers, { HARBOR_CIRCLE_LAYER, SEAMARKS_LAYER } from './DataLayers';
import { makeFakeMap, simulateStyleReload } from '../test/fakeMaplibre';
import { AppStateProvider, useSettings } from '../state/AppState';
import { __resetDbForTests } from '../services/db';
import { de } from '../i18n/dict.de';
import { en } from '../i18n/dict.en';
import type { MsgKey } from '../i18n/dict.de';

// #153: DataLayers' style-reload re-add against the shared fake map (jsdom
// has no MapLibre runtime — the BoatMarker.test.tsx approach). The depth
// raster is NOT covered here: buildDepthCanvas needs a 2D canvas backend
// (test setup stubs getContext to null), so the depth source never exists
// under jsdom — its re-add rides the same setupLayers call as the harbor/
// seamark sources asserted below, and its rendering stays browser-verified.
// #492's hazard-hatch overlay shares this exact limitation (buildHatchCanvas
// has the identical `if (!ctx) return null` guard) for the same reason, so
// its RENDERED appearance is verified in app/e2e/datalayers.spec.ts instead;
// what's covered here is the SAFETY_DEPTH_M ORCHESTRATION (debounce timing,
// no crash/leak on unmount) in the '#492 navigability hatch wiring' describe
// block below — DataLayers now calls useSettings() directly (see that
// hook's own #492 comment in this file for why), so every render below is
// wrapped in AppStateProvider, which the pre-#492 tests never needed.

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

// #492: every render below needs AppStateProvider now that DataLayers calls
// useSettings() directly — wrapping it here (rather than at each call site)
// keeps the pre-#492 tests' own bodies unchanged.
function renderDataLayers() {
  return render(
    <AppStateProvider>
      <DataLayers onHarborPick={() => {}} />
    </AppStateProvider>,
  );
}

async function renderAndSettle(map: ReturnType<typeof makeFakeMap>) {
  hoisted.map = map;
  const utils = renderDataLayers();
  // Settle on the PAINTED harbor data, not bare source existence: the source
  // is created one commit before the epoch-driven data effects repaint it,
  // and a loaded CI runner can catch that window.
  await waitFor(() => {
    expect(map.sources.get(HARBOR_SOURCE)?.setData.mock.calls.length).toBeGreaterThan(0);
  });
  return utils;
}

beforeEach(async () => {
  // #492: AppStateProvider persists Settings via IndexedDB (fake-indexeddb) —
  // reset it alongside localStorage so no test observes a prior test's
  // safetyDepthM.
  await __resetDbForTests();
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
    renderDataLayers();
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

// #598: the depth-hatch legend's return JSX doesn't gate on map/styleEpoch/
// assets at all (see DataLayers.tsx's own comment on the always-mounted
// control cluster), so unlike the describe blocks above this needs no map
// and no settle wait — that absence IS the #598 requirement (reachable with
// NO active plan) made concrete. Expectations import the SHIPPED dict
// strings rather than re-typing them, so this stays a wiring/structure
// check (details exists, starts closed, the right t() keys are used) and
// does not duplicate the copy-accuracy review the PR body carries.
describe('#598 depth-hatch legend', () => {
  it('is present with no map/plan at all, and starts collapsed', () => {
    const { container, getByText } = renderDataLayers();
    const details = container.querySelector('details.depth-legend');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(getByText(de['map.depth.legend.title'])).toBeInTheDocument();
  });

  it('reveals the conservative-basis and #597 caveat copy once opened', () => {
    const { container, getByText } = renderDataLayers();
    const details = container.querySelector('details.depth-legend') as HTMLDetailsElement;
    // Native <details>/<summary> — no React state to drive, so flipping the
    // DOM property directly is the faithful equivalent of a user click
    // (RouteLegend.tsx's own uncontrolled <details> gets the same treatment
    // nowhere else in this suite, since it's plan-gated and covered by
    // its own component test instead).
    details.open = true;
    expect(getByText(de['map.depth.legend.hatchLabel'])).toBeInTheDocument();
    expect(getByText(de['map.depth.legend.basis'])).toBeInTheDocument();
    expect(getByText(de['map.depth.legend.caveat'])).toBeInTheDocument();
  });

  // PR #625 self-review Minor 2: the e2e `not.toContainText('flaches
  // Wasser')` guard (datalayers.spec.ts) is DE-only, so an EN "shallow
  // water" regression had no pin at all. Asserts against the SHIPPED dict
  // strings directly (both languages, every legend key), rather than adding
  // a second e2e language pass for the same check.
  it('never calls the hatch "shallow water" in either language (#598)', () => {
    const keys: readonly MsgKey[] = [
      'map.depth.legend.hatchLabel',
      'map.depth.legend.basis',
      'map.depth.legend.caveat',
    ];
    for (const k of keys) {
      expect(en[k].toLowerCase()).not.toContain('shallow water');
      expect(de[k].toLowerCase()).not.toContain('flaches wasser');
      expect(de[k].toLowerCase()).not.toContain('flachwasser');
    }
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

// #492: the hazard-hatch raster ITSELF is untestable here (same jsdom 2D
// canvas limitation as the depth ramp — see this file's header comment); a
// pixel-readback proof lives in app/e2e/datalayers.spec.ts. What's testable
// at this level is the ORCHESTRATION: debounced re-rendering keyed on
// safetyDepthM, and its cleanup on unmount. This local literal must be kept
// in sync BY HAND with DataLayers.tsx's own DEPTH_HATCH_DEBOUNCE_MS/
// DEPTH_HATCH_LAYER — same convention this file already uses for
// HARBOR_SOURCE/SEAMARKS_SOURCE/HARBOR_LABEL_LAYER above (re-declared
// locally rather than imported).
const DEPTH_HATCH_LAYER = 'sc-depth-hatch';
const DEPTH_HATCH_DEBOUNCE_MS = 300;

function SafetyDepthProbe() {
  const [, setSettings] = useSettings();
  return (
    <button onClick={() => setSettings({ safetyDepthM: 4.5 })}>setSafetyDepthProbeButton</button>
  );
}

describe('#492 navigability hatch wiring', () => {
  it('debounces the hazard-hatch rebuild attempt: not immediate, but fires once the debounce elapses', async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { getByText } = render(
      <AppStateProvider>
        <SafetyDepthProbe />
        <DataLayers onHarborPick={() => {}} />
      </AppStateProvider>,
    );
    await waitFor(() => {
      expect(map.sources.get(HARBOR_SOURCE)?.setData.mock.calls.length).toBeGreaterThan(0);
    });
    const getLayerSpy = vi.spyOn(map, 'getLayer');
    getLayerSpy.mockClear();
    vi.useFakeTimers();
    try {
      fireEvent.click(getByText('setSafetyDepthProbeButton'));
      // Immediately after the click: the debounce effect just re-armed a
      // FRESH timer synchronously (React's act-wrapped synchronous commit
      // cancels the earlier pending one, per the effect's own cleanup, and
      // schedules a new one) — no setTimeout-scheduled work can have run
      // yet, deterministically: nothing in a synchronous DOM-event flush
      // ever processes a macrotask, regardless of how much real wall-clock
      // time passed before this click.
      expect(getLayerSpy.mock.calls.some(([id]) => id === DEPTH_HATCH_LAYER)).toBe(false);
      act(() => {
        vi.advanceTimersByTime(DEPTH_HATCH_DEBOUNCE_MS - 1);
      });
      expect(getLayerSpy.mock.calls.some(([id]) => id === DEPTH_HATCH_LAYER)).toBe(false);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(getLayerSpy.mock.calls.some(([id]) => id === DEPTH_HATCH_LAYER)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the pending rebuild timer on unmount — no late attempt after the debounce window', async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { getByText, unmount } = render(
      <AppStateProvider>
        <SafetyDepthProbe />
        <DataLayers onHarborPick={() => {}} />
      </AppStateProvider>,
    );
    await waitFor(() => {
      expect(map.sources.get(HARBOR_SOURCE)?.setData.mock.calls.length).toBeGreaterThan(0);
    });
    const getLayerSpy = vi.spyOn(map, 'getLayer');
    getLayerSpy.mockClear();
    vi.useFakeTimers();
    try {
      fireEvent.click(getByText('setSafetyDepthProbeButton'));
      unmount();
      act(() => {
        vi.advanceTimersByTime(DEPTH_HATCH_DEBOUNCE_MS * 10); // far past the window
      });
      expect(getLayerSpy.mock.calls.some(([id]) => id === DEPTH_HATCH_LAYER)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
