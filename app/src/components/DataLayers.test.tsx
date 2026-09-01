import 'fake-indexeddb/auto';
import { useEffect } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataLayers, { HARBOR_CIRCLE_LAYER, SEAMARKS_LAYER } from './DataLayers';
import RouteLegend from './RouteLegend';
import { makeFakeMap, simulateStyleReload } from '../test/fakeMaplibre';
import { AppStateProvider, useActivePlan, useSettings } from '../state/AppState';
import { __resetDbForTests } from '../services/db';
import { de } from '../i18n/dict.de';
import { en } from '../i18n/dict.en';
import type { MsgKey } from '../i18n/dict.de';
import { DEFAULT_SETTINGS, PLAN_SCHEMA_VERSION, defaultBoatSnapshot, type Plan } from '../types';
import { uniformWindGrid } from '../test/fixtures';

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

// #232 items 3-4: the seamark click handler's popup is a real maplibre-gl
// `Popup` (mocked above/below for jsdom), so pinning WHERE it anchors and
// WHAT it renders needs the mock to record its constructor calls rather than
// just no-op through them. `popupCalls` records only the LAST popup's
// setLngLat argument and setDOMContent container — sufficient because every
// test below fires exactly one click.
const popupCalls = vi.hoisted(() => ({
  lastLngLat: undefined as unknown,
  lastContainer: undefined as HTMLElement | undefined,
}));

vi.mock('maplibre-gl', () => ({
  Popup: class {
    setLngLat(lngLat: unknown) {
      popupCalls.lastLngLat = lngLat;
      return this;
    }
    setDOMContent(container: HTMLElement) {
      popupCalls.lastContainer = container;
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
  // #232: no test relies on a stale popup call surviving into it (every test
  // that asserts on popupCalls fires its own click first), but reset it
  // anyway so a future test can't silently inherit a previous one's popup.
  popupCalls.lastLngLat = undefined;
  popupCalls.lastContainer = undefined;
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

// #813: DataLayers.tsx's own `.depth-legend` must be suppressed the instant a
// plan exists — RouteLegend.tsx's `.route-legend` becomes the sole
// "Legende"/"Legend" disclosure at that point, folding this exact copy in
// under its own sub-heading (RouteLegend.test.tsx pins THAT half). Without
// this suppression the app would show two disclosures sharing one
// accessible name again, the defect #813 exists to fix.
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);
const ETA_MS = DEPARTURE_MS + 3_600_000;

function minimalPlan(): Plan {
  const origin = { lat: 54.79, lon: 9.43 };
  const destination = { lat: 54.8, lon: 9.9 };
  const leg = {
    kind: 'sail' as const,
    board: 'starboard' as const,
    twaDeg: 60,
    maneuverAtStart: null,
    start: origin,
    end: destination,
    startTimeMs: DEPARTURE_MS,
    endTimeMs: ETA_MS,
    headingDeg: 90,
    twsKn: 12,
    speedKn: 6,
    distanceNm: 10,
  };
  return {
    id: 'plan-813',
    name: 'Test plan',
    createdAtMs: DEPARTURE_MS,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin,
      destination,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: uniformWindGrid(12, 225, { t0Ms: DEPARTURE_MS, hours: 6 }),
    result: {
      status: 'ok',
      sails: [
        {
          sailId: 'genoa',
          result: {
            sailId: 'genoa',
            legs: [leg],
            etaMs: ETA_MS,
            durationMs: 3_600_000,
            distanceNm: 10,
            maneuverCount: 0,
            motorDistanceNm: 0,
          },
          reason: null,
        },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: origin,
      snappedDestination: destination,
    },
  };
}

function TestSetPlan({ plan }: { plan: Plan | null }) {
  const { setPlan } = useActivePlan();
  useEffect(() => {
    setPlan(plan);
  }, [plan, setPlan]);
  return null;
}

describe('#813 legend consolidation: DataLayers suppresses .depth-legend once a plan exists', () => {
  it('renders .depth-legend with no plan, and removes it once a plan is set', () => {
    const plan = minimalPlan();
    const { container, rerender } = render(
      <AppStateProvider>
        <TestSetPlan plan={null} />
        <DataLayers onHarborPick={() => {}} />
      </AppStateProvider>,
    );
    expect(container.querySelector('details.depth-legend')).not.toBeNull();

    rerender(
      <AppStateProvider>
        <TestSetPlan plan={plan} />
        <DataLayers onHarborPick={() => {}} />
      </AppStateProvider>,
    );
    expect(container.querySelector('details.depth-legend')).toBeNull();
  });

  it('brings .depth-legend back once the plan is cleared again — the two are complementary, never both absent', () => {
    const plan = minimalPlan();
    const { container, rerender } = render(
      <AppStateProvider>
        <TestSetPlan plan={plan} />
        <DataLayers onHarborPick={() => {}} />
      </AppStateProvider>,
    );
    expect(container.querySelector('details.depth-legend')).toBeNull();

    rerender(
      <AppStateProvider>
        <TestSetPlan plan={null} />
        <DataLayers onHarborPick={() => {}} />
      </AppStateProvider>,
    );
    expect(container.querySelector('details.depth-legend')).not.toBeNull();
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
// #681: re-declared locally for the same reason as DEPTH_HATCH_LAYER above —
// DataLayers.tsx keeps this module-private.
const DEPTH_LAYER = 'sc-depth';

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

// #681: independent hazard-hatch toggle. Every test in this block needs the
// hatch layer to ACTUALLY exist (unlike the "#492 navigability hatch wiring"
// debounce tests above, which only assert `getLayer` was CALLED with the
// hatch id, not that the layer is present) — a `setLayoutProperty` assertion
// against a layer setupLayers never created records zero calls and passes
// with the whole toggle deleted (CLAUDE.md's own documented vacuity trap:
// test/setup.ts stubs `HTMLCanvasElement.prototype.getContext` to `null`
// globally, so buildDepthCanvas/buildHatchCanvas always bail under the
// describe blocks above). Restores just enough of the 2D context — the
// SAME size-discriminated fake `layerOrder.test.tsx` already uses, matched
// to this FILE's own 4x4 maskMeta fixture — scoped to ONLY this describe
// block via beforeEach/afterEach, so the vacuous-by-default behavior the
// rest of this file relies on (e.g. the debounce tests' `getLayer`-call-only
// assertions) is untouched outside it.
describe('#681 independent hazard-hatch toggle', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement): unknown {
      if (this.width !== 4 || this.height !== 4) return null; // e.g. a seamark glyph raster
      return {
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      };
    }) as unknown as HTMLCanvasElement['getContext'];
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  // Mutation: reverting `usePersistedToggle('sc-depth-hatch-visible', true)`
  // to a `false` default reds BOTH assertions below — the checkbox starts
  // unchecked and the layer starts hidden.
  it('defaults ON for a fresh profile, and both layers render', async () => {
    const map = makeFakeMap();
    const { getByRole } = await renderAndSettle(map);
    expect(getByRole('checkbox', { name: 'Schraffur anzeigen' })).toBeChecked();
    expect(map.layers.get(DEPTH_LAYER)?.layout?.visibility).toBe('visible');
    expect(map.layers.get(DEPTH_HATCH_LAYER)?.layout?.visibility).toBe('visible');
  });

  // Mutation: deleting `disabled={!depthVisible}` from the checkbox in
  // DataLayers.tsx's return JSX reds this test alone — every other test in
  // this block passes either way, since none of them asserts `.disabled`.
  it('disables the hatch checkbox while the base depth toggle is off, and re-enables it once depthVisible returns (#384 defect class)', async () => {
    const map = makeFakeMap();
    const { getByRole } = await renderAndSettle(map);
    const depthToggle = getByRole('checkbox', { name: 'Wassertiefen' });
    const hatchToggle = getByRole('checkbox', { name: 'Schraffur anzeigen' });
    expect(hatchToggle).not.toBeDisabled();
    fireEvent.click(depthToggle);
    expect(depthToggle).not.toBeChecked();
    expect(hatchToggle).toBeDisabled();
    fireEvent.click(depthToggle);
    expect(depthToggle).toBeChecked();
    expect(hatchToggle).not.toBeDisabled();
  });

  // Mutation: reverting the depthVisible-sync effect's hatch line back to
  // `depthVisible ? 'visible' : 'none'` (dropping `&& hatchVisible`) reds
  // this test — the hatch layer would stay 'visible' after the click.
  it('unchecking the hatch toggle hides ONLY the hatch layer; the base ramp keeps rendering', async () => {
    const map = makeFakeMap();
    const { getByRole } = await renderAndSettle(map);
    const hatchToggle = getByRole('checkbox', { name: 'Schraffur anzeigen' });
    fireEvent.click(hatchToggle);
    expect(hatchToggle).not.toBeChecked();
    expect(map.layers.get(DEPTH_HATCH_LAYER)?.layout?.visibility).toBe('none');
    expect(map.layers.get(DEPTH_LAYER)?.layout?.visibility).toBe('visible');
  });

  // The complementary term of the SAME `depthVisible && hatchVisible`
  // condition as the previous test — deliberately a SEPARATE test rather
  // than folded into it, because a mutation dropping EITHER term alone must
  // be caught by exactly ONE of the pair (CLAUDE.md's "ask per TERM, not per
  // guard" vacuity rule). Mutation: narrowing the condition to `hatchVisible`
  // alone (dropping `depthVisible &&`) reds THIS test only — with the hatch
  // checkbox left checked, the hatch layer would incorrectly stay 'visible'
  // while depthVisible is off, and would never need to come back once
  // depthVisible returns (it would already read 'visible'). The previous
  // test's mutant (dropping `&& hatchVisible`) does NOT touch this one,
  // because it never unchecks the hatch toggle at all.
  it('unchecking the base depth toggle hides the hatch layer too, even though the persisted hatch flag stays on', async () => {
    const map = makeFakeMap();
    const { getByRole } = await renderAndSettle(map);
    const depthToggle = getByRole('checkbox', { name: 'Wassertiefen' });
    const hatchToggle = getByRole('checkbox', { name: 'Schraffur anzeigen' });
    fireEvent.click(depthToggle);
    expect(hatchToggle).toBeChecked(); // untouched — the persisted flag itself never flipped
    expect(map.layers.get(DEPTH_HATCH_LAYER)?.layout?.visibility).toBe('none');
    expect(map.layers.get(DEPTH_LAYER)?.layout?.visibility).toBe('none');
    fireEvent.click(depthToggle);
    expect(map.layers.get(DEPTH_HATCH_LAYER)?.layout?.visibility).toBe('visible');
  });

  // Mutation: dropping `|| !hatchVisible` from the rebuild effect's early
  // return (leaving only `!depthVisible`) reds this test — the debounced
  // timer would still fire and call `getLayer(DEPTH_HATCH_LAYER)` even
  // though the hatch toggle is off.
  it('skips the debounced hazard-hatch rebuild while the hatch toggle is off, even though depthVisible stays on', async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { getByRole, getByText } = render(
      <AppStateProvider>
        <SafetyDepthProbe />
        <DataLayers onHarborPick={() => {}} />
      </AppStateProvider>,
    );
    await waitFor(() => {
      expect(map.sources.get(HARBOR_SOURCE)?.setData.mock.calls.length).toBeGreaterThan(0);
    });
    fireEvent.click(getByRole('checkbox', { name: 'Schraffur anzeigen' }));
    const getLayerSpy = vi.spyOn(map, 'getLayer');
    getLayerSpy.mockClear();
    vi.useFakeTimers();
    try {
      fireEvent.click(getByText('setSafetyDepthProbeButton'));
      act(() => {
        vi.advanceTimersByTime(DEPTH_HATCH_DEBOUNCE_MS * 10); // far past the window
      });
      expect(getLayerSpy.mock.calls.some(([id]) => id === DEPTH_HATCH_LAYER)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// #681 x #813 Blocker fix: RouteLegend.tsx's folded-in checkbox and
// DataLayers.tsx's own `.depth-legend` checkbox read the SAME
// `usePersistedToggle` keys, which now cross-instance-syncs (usePersistedToggle's
// own #681 x #813 comment — the boolean sibling of #353 PR2's mechanism for
// usePersistedNumber). Production is BELIEVED to never mount both surfaces at
// once: `useActivePlan()` types `plan` as `Plan | null` with no `undefined`,
// so DataLayers' `plan === null` and RouteLayer's `!plan`
// (`RouteLayer.tsx:897`) are exact complements. Only HALF of that is pinned
// **directly** by a test — the '#813 legend consolidation' describe block
// above asserts the DataLayers half (`.depth-legend` present/absent as
// `plan` changes);
// the RouteLayer half (`if (!plan) return null`, which is what stops
// RouteLegend mounting pre-plan) is pinned only indirectly —
// `App.test.tsx`'s `renders the always-mounted depth toggle (ON by
// default, #63) with no plan active` asserts the plan-gated cluster is
// absent without a plan, and two `RouteLayer.test.tsx` `#628` tests mount
// with `plan={null}`; no test names `RouteLegend` itself.
// (`RouteLegend.test.tsx` renders `<RouteLegend />` directly, with no plan
// gate.) This block renders both
// UNCONDITIONALLY, on purpose, to isolate the SYNC wiring from that mounting
// decision (which is why it does not need that mounting invariant to be
// pinned at all to be trustworthy):
// the composition bug the review caught was that ticking the
// checkbox on ONE surface left DataLayers.tsx's own React state (the one its
// layer-visibility effect actually reads) stale until a future remount,
// which a mounting-gate test alone can never see, since it never has both
// checkboxes live at once to compare.
describe('#681 x #813: hazard-hatch toggle stays synced across BOTH legend surfaces', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(function (
      this: HTMLCanvasElement,
    ): unknown {
      if (this.width !== 4 || this.height !== 4) return null; // e.g. a seamark glyph raster
      return {
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      };
    }) as unknown as HTMLCanvasElement['getContext'];
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  // Mutation: reverting usePersistedToggle.ts to its pre-#681 form (no
  // listenersByKey registry, `set()` only calls its own `setValue`) reds
  // this test — `dataLayersCheckbox.checked` stays `true` and the layer
  // stays `'visible'` after clicking the RouteLegend checkbox, because
  // DataLayers.tsx's OWN hook instance never learns of the change.
  it('ticking the RouteLegend checkbox updates the map layer that DataLayers itself owns', async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { container } = render(
      <AppStateProvider>
        <DataLayers onHarborPick={() => {}} />
        <RouteLegend />
      </AppStateProvider>,
    );
    await waitFor(() => {
      expect(map.sources.get(HARBOR_SOURCE)?.setData.mock.calls.length).toBeGreaterThan(0);
    });
    const routeLegendCheckbox = container.querySelector(
      '.route-legend-depth input[type="checkbox"]',
    ) as HTMLInputElement;
    const dataLayersCheckbox = container.querySelector(
      '.depth-legend-body input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(routeLegendCheckbox.checked).toBe(true);
    expect(dataLayersCheckbox.checked).toBe(true);
    expect(map.layers.get(DEPTH_HATCH_LAYER)?.layout?.visibility).toBe('visible');

    fireEvent.click(routeLegendCheckbox);

    expect(dataLayersCheckbox.checked).toBe(false);
    expect(map.layers.get(DEPTH_HATCH_LAYER)?.layout?.visibility).toBe('none');
    // The base ramp must stay unaffected — this is still the composite
    // depthVisible && hatchVisible condition, not a shared flag.
    expect(map.layers.get(DEPTH_LAYER)?.layout?.visibility).toBe('visible');
  });

  // Same mutation as above reds this test too — sync is not directional.
  it("ticking DataLayers' own checkbox updates RouteLegend's checkbox", async () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { container } = render(
      <AppStateProvider>
        <DataLayers onHarborPick={() => {}} />
        <RouteLegend />
      </AppStateProvider>,
    );
    await waitFor(() => {
      expect(map.sources.get(HARBOR_SOURCE)?.setData.mock.calls.length).toBeGreaterThan(0);
    });
    const routeLegendCheckbox = container.querySelector(
      '.route-legend-depth input[type="checkbox"]',
    ) as HTMLInputElement;
    const dataLayersCheckbox = container.querySelector(
      '.depth-legend-body input[type="checkbox"]',
    ) as HTMLInputElement;

    fireEvent.click(dataLayersCheckbox);

    expect(routeLegendCheckbox.checked).toBe(false);
  });
});

// #232 items 3-4: pin that DataLayers' SEAMARKS_LAYER click handler actually
// USES pickSeamarkByPriority (rather than e.features[0]) and anchors the
// popup at the picked feature's own coordinates when the pick differs from
// the topmost one. Neither was pinned before #232 — `pickSeamarkByPriority`
// itself was unit-tested (seamarkGeoJson.test.ts), but nothing exercised
// DataLayers.tsx's click handler at all, so a revert to e.features[0] would
// have stayed green everywhere.
//
// A topmost feature (`e.features[0]`) is what queryRenderedFeatures/MapLibre
// hands over FIRST at z>=12 (#200's paint-order inversion, #232 item 1 —
// the least significant of an overlapping group is painted, and reported,
// on top). `buoy_special_purpose` (priority 12) as the topmost, over a
// `buoy_cardinal` (priority 2) underneath it, is exactly that shape.
describe('SEAMARKS_LAYER click handler (#232 items 3-4)', () => {
  const overlappingTopmost = {
    properties: { seamarkType: 'buoy_special_purpose', priority: 12 },
    geometry: { type: 'Point', coordinates: [10.9, 54.9] },
  };
  const overlappingCardinal = {
    properties: { seamarkType: 'buoy_cardinal', priority: 2 },
    geometry: { type: 'Point', coordinates: [10.1, 54.1] },
  };
  const TAP_LNGLAT = { lng: 10.5, lat: 54.5 };

  it('resolves an overlapping click to the PRIORITY pick, not e.features[0] (#232 item 3)', async () => {
    const map = makeFakeMap();
    await renderAndSettle(map);
    act(() => {
      map.fireLayerEvent('click', SEAMARKS_LAYER, {
        features: [overlappingTopmost, overlappingCardinal],
        lngLat: TAP_LNGLAT,
      });
    });
    const text = popupCalls.lastContainer?.textContent ?? '';
    // The popover must describe the CARDINAL (the priority pick) …
    expect(text).toContain(de['seamark.value.type.buoy_cardinal']);
    // … never the special-purpose buoy that MapLibre reported first.
    expect(text).not.toContain(de['seamark.value.type.buoy_special_purpose']);
  });

  it('anchors the popup at the picked feature’s own coordinates when the pick differs from the topmost (#232 item 4)', async () => {
    const map = makeFakeMap();
    await renderAndSettle(map);
    act(() => {
      map.fireLayerEvent('click', SEAMARKS_LAYER, {
        features: [overlappingTopmost, overlappingCardinal],
        lngLat: TAP_LNGLAT,
      });
    });
    expect(popupCalls.lastLngLat).toEqual([10.1, 54.1]); // the cardinal's own geometry
    expect(popupCalls.lastLngLat).not.toEqual(TAP_LNGLAT);
  });

  it('keeps the tap-point anchor for an ordinary, non-overlapping click (#232 item 4)', async () => {
    const map = makeFakeMap();
    await renderAndSettle(map);
    const solo = {
      properties: { seamarkType: 'buoy_lateral', category: 'port', colour: 'red', priority: 8 },
      geometry: { type: 'Point', coordinates: [9.9, 54.8] },
    };
    act(() => {
      map.fireLayerEvent('click', SEAMARKS_LAYER, { features: [solo], lngLat: TAP_LNGLAT });
    });
    // The single feature IS the pick AND the topmost, so the tap point is
    // preserved verbatim — not silently replaced by the feature's own
    // (different) coordinates.
    expect(popupCalls.lastLngLat).toBe(TAP_LNGLAT);
    expect(popupCalls.lastContainer?.textContent).toContain(de['seamark.value.type.buoy_lateral']);
  });
});
