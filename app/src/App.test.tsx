import 'fake-indexeddb/auto';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import App, { planErrorBannerKind, planErrorGroup, toPlannerStatus } from './App';
import { I18nProvider } from './i18n';
import { de } from './i18n/dict.de';
import { en } from './i18n/dict.en';
import { fetchWindGrid, OpenMeteoError } from './services/openMeteo';
import { __resetDbForTests } from './services/db';
import * as db from './services/db';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from './test/fixtures';
import { formatLatLon, formatNm } from './lib/format';
import {
  DEFAULT_SETTINGS,
  type Harbor,
  type Plan,
  type PlanRequest,
  type PlanResult,
  type PlanResultOk,
  type PolarTable,
} from './types';

// jsdom has no WebGL/canvas backend, so MapLibre GL is mocked wholesale here
// (mirrors the "not unit-tested" notes in RouteLayer.tsx/BoatMarker.tsx —
// this is the first suite to mount MapView, so it's the one that needs the
// stand-in). Every method MapView/RouteLayer/BoatMarker call on a map or
// marker instance is a no-op; App-level tests exercise tabs/banners/dialog
// logic, not actual map rendering (covered by the Playwright browser pass).
// Shared with the maplibre-gl mock below via vi.hoisted (not a plain
// module-scope `let`): vi.mock factories run at module-evaluation time,
// before this file's own top-level statements — a `let` declared after the
// vi.mock call would still be in its temporal dead zone if the factory read
// it eagerly. vi.hoisted's own callback is hoisted the same way vi.mock is,
// so `mapTestHooks` exists by the time either factory runs.
const mapTestHooks = vi.hoisted(() => ({
  // The most recently registered 'click' handler from MapView's
  // `instance.on('click', handleClick)` — one FakeMap per App mount, so
  // "most recent" is unambiguous within a single test. Lets tests simulate
  // a resolved map tap (origin/destination/via pick) without a real
  // WebGL/MapLibre runtime, which jsdom doesn't have. Carries `point` too
  // (the screen pixel MapLibre reports): MapView's harbor-hit gate feeds it
  // to queryRenderedFeatures.
  clickHandler: null as
    ((e: { lngLat: { lat: number; lng: number }; point: { x: number; y: number } }) => void) | null,
  // Same idea for MapView's `instance.on('error', handleError)' — lets tests
  // simulate a MapLibre runtime error (e.g. a failed tile/style fetch)
  // without a real map, to drive the project-gate map-error banner.
  errorHandler: null as ((e: { error: unknown }) => void) | null,
  // LAYER-scoped click handlers (`map.on('click', layerId, cb)` — DataLayers'
  // harbor markers), keyed by layer id. Kept apart from clickHandler above:
  // the 3-arg registration must never clobber MapView's generic 2-arg one.
  layerClickHandlers: {} as Record<
    string,
    (e: { features?: { properties?: Record<string, unknown> }[] }) => void
  >,
  // Harbor features MapView's gate should report at a given click point,
  // keyed by "x,y" — i.e. where a marker is rendered. Lets a test place a
  // marker under a specific tap so the generic-tap gate (queryRenderedFeatures)
  // engages exactly as it would in the browser; empty means open water.
  harborHitFeatures: {} as Record<string, { properties?: Record<string, unknown> }[]>,
  // Latest setData payload per source id (FakeMap.getSource returns a spy for
  // added sources). Lets tests observe the language-relabel rebuild wiring,
  // which previously no-opped because getSource returned undefined.
  sourceSetData: {} as Record<string, unknown>,
}));

// Fake plan()-call queue for the RoutingClient mock below, shared the same
// way (vi.hoisted — see comment above).
const routingMock = vi.hoisted(() => ({
  calls: [] as { request: PlanRequest; resolve: (r: PlanResult) => void }[],
}));

// Controllable-resolution-timing fake for the E8 gate fix wave's clobber-
// guard test below: a real RoutingClient talks to a Worker (no jsdom
// runtime); this fake instead queues every plan() call in routingMock.calls
// for the test to resolve on its own schedule, so a replan can be left
// pending while the test drives an unrelated "load a different plan" action
// in between.
vi.mock('./routing/workerClient', () => ({
  RoutingClient: class {
    async init() {}
    plan(request: PlanRequest): Promise<PlanResult> {
      return new Promise<PlanResult>((resolve) => {
        routingMock.calls.push({ request, resolve });
      });
    }
    dispose() {}
  },
}));

// fetchWindGrid talks to the real Open-Meteo API by default; mocked here
// (rather than added to fetchMock() below) so tests don't need to fabricate
// a 187-point Open-Meteo response body just to drive a plan through
// usePlanFlow.run(). OpenMeteoError is re-exported from the real module
// (importOriginal) — usePlanFlow.ts's mapWindError does an `instanceof`
// check against it, which would break if this mock provided its own,
// unrelated class instead.
vi.mock('./services/openMeteo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/openMeteo')>();
  return {
    ...actual,
    fetchWindGrid: vi.fn(async () =>
      uniformWindGrid(10, 250, {
        t0Ms: Date.now() - 3_600_000,
        hours: 24 * (actual.FORECAST_DAYS + 2),
      }),
    ),
  };
});

// jsdom has no WebGL/canvas backend, so MapLibre GL is mocked wholesale here
// (mirrors the "not unit-tested" notes in RouteLayer.tsx/BoatMarker.tsx —
// this is the first suite to mount MapView, so it's the one that needs the
// stand-in). Every method MapView/RouteLayer/BoatMarker call on a map or
// marker instance is a no-op; App-level tests exercise tabs/banners/dialog
// logic, not actual map rendering (covered by the Playwright browser pass).
vi.mock('maplibre-gl', () => {
  class FakeMap {
    // Two registration shapes, mirroring MapLibre: generic `on(event, cb)`
    // (MapView's click/error) and layer-scoped `on(event, layerId, cb)`
    // (DataLayers' harbor-marker click/hover) — the layer-scoped form must
    // not overwrite the generic hooks.
    on(event: string, layerOrCb: unknown, maybeCb?: unknown) {
      if (typeof layerOrCb === 'function') {
        if (event === 'click')
          mapTestHooks.clickHandler = layerOrCb as typeof mapTestHooks.clickHandler;
        if (event === 'error')
          mapTestHooks.errorHandler = layerOrCb as typeof mapTestHooks.errorHandler;
      } else if (
        event === 'click' &&
        typeof layerOrCb === 'string' &&
        typeof maybeCb === 'function'
      ) {
        mapTestHooks.layerClickHandlers[layerOrCb] =
          maybeCb as (typeof mapTestHooks.layerClickHandlers)[string];
      }
    }
    off(event: string, layerOrCb?: unknown) {
      if (typeof layerOrCb === 'string') {
        if (event === 'click') delete mapTestHooks.layerClickHandlers[layerOrCb];
        return;
      }
      if (event === 'click') mapTestHooks.clickHandler = null;
      if (event === 'error') mapTestHooks.errorHandler = null;
    }
    getCanvas() {
      return { style: {} } as HTMLCanvasElement;
    }
    once(event: string, cb: () => void) {
      if (event === 'load') cb();
    }
    remove() {}
    addControl() {}
    getContainer() {
      // A detached, control-less div: collapseAttributionAtLoad
      // (MapView.tsx, #33) finds no attribution element in it and no-ops.
      return document.createElement('div');
    }
    // Track added source ids and expose a setData spy, so the language-relabel
    // wiring (DataLayers rebuilds the harbor source on a lang switch) is
    // observable — getSource returned undefined before, so that setData no-opped
    // in every test. Sources never added still return undefined (unchanged).
    _sources = new Map<string, { setData: (data: unknown) => void }>();
    addSource(id?: string) {
      if (typeof id === 'string' && !this._sources.has(id)) {
        this._sources.set(id, {
          setData: (data: unknown) => {
            mapTestHooks.sourceSetData[id] = data;
          },
        });
      }
    }
    // Track added layer ids so getLayer() reflects reality: MapView's
    // harbor-hit gate calls getLayer(id) before queryRenderedFeatures, and
    // must see the harbor layer once DataLayers has added it.
    _addedLayers = new Set<string>();
    addLayer(layer?: { id?: string }) {
      if (layer && typeof layer.id === 'string') this._addedLayers.add(layer.id);
    }
    getSource(id?: string) {
      return typeof id === 'string' ? this._sources.get(id) : undefined;
    }
    getLayer(id?: string) {
      return typeof id === 'string' && this._addedLayers.has(id) ? { id } : undefined;
    }
    // Faithful stand-in for MapView.handleClick's harbor-hit gate: reports the
    // harbor feature only when the click point matches a marker the test placed
    // there (mapTestHooks.harborHitFeatures) AND the harbor layer is the one
    // queried — otherwise open water, so a plain tap-pick proceeds.
    queryRenderedFeatures(point: { x: number; y: number }, options?: { layers?: string[] }) {
      const layers = options?.layers ?? [];
      if (!layers.includes('sc-harbor-points')) return [];
      return mapTestHooks.harborHitFeatures[`${point.x},${point.y}`] ?? [];
    }
    removeLayer() {}
    removeSource() {}
    isStyleLoaded() {
      return true;
    }
    setLayoutProperty() {}
    setFilter() {}
    setPaintProperty() {}
    fitBounds() {}
    // #63: barbs default ON, so RouteLayer's barb rebuild effect now runs in
    // every plan-bearing test (before, barbsVisible=false early-returned it).
    // A fixed app-region viewport with a linear projection keeps
    // adaptiveBarbFeatures deterministic and small; the barb OUTPUT is not
    // asserted here (that's annotations.spec.ts against a real browser) —
    // these stubs only keep the effect from crashing the tree.
    getBounds() {
      return {
        getWest: () => 9.4,
        getSouth: () => 54.3,
        getEast: () => 11.0,
        getNorth: () => 55.3,
      };
    }
    project(lngLat: [number, number]) {
      return { x: (lngLat[0] - 9.4) * 500, y: (55.3 - lngLat[1]) * 500 };
    }
    hasImage() {
      return false;
    }
    addImage() {}
  }
  class FakeMarker {
    setLngLat() {
      return this;
    }
    setRotation() {
      return this;
    }
    getLngLat() {
      return { lat: 0, lng: 0 };
    }
    setDraggable() {
      return this;
    }
    on() {
      return this;
    }
    off() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  }
  class FakeAttributionControl {}
  class FakeLngLatBounds {
    extend() {
      return this;
    }
  }
  // #7: DataLayers opens a seamark info popover via `new Popup()` on a
  // sc-seamarks click — no test here drives that click path (covered by the
  // real-browser verify pass), but the stub keeps the module import itself
  // from throwing if that ever changes.
  class FakePopup {
    setLngLat() {
      return this;
    }
    setDOMContent() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      return this;
    }
  }
  return {
    Map: FakeMap,
    Marker: FakeMarker,
    AttributionControl: FakeAttributionControl,
    LngLatBounds: FakeLngLatBounds,
    Popup: FakePopup,
    addProtocol: vi.fn(),
  };
});

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };
const FLENSBURG: Harbor = {
  id: 'flensburg',
  names: { de: 'Flensburg', da: 'Flensborg', en: 'Flensburg' },
  country: 'DE',
  snap: { lat: 54.795, lon: 9.435 },
};
// Deliberately distinct de/en names (real harbors here mostly share a name) so
// the language-relabel test can prove the harbor source rebuilt into English.
const RELABEL_HARBOR: Harbor = {
  id: 'relabel-town',
  names: { de: 'Relabelburg', da: 'Relabelby', en: 'Relabel Harbour' },
  country: 'DK',
  snap: { lat: 54.9, lon: 10.5 },
};
const HARBORS: Harbor[] = [FLENSBURG, RELABEL_HARBOR];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function fetchMock() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('mask.meta.json')) return Promise.resolve(jsonResponse(TEST_MASK_META));
    if (url.includes('mask.bin')) {
      const buf = new ArrayBuffer(TEST_MASK_META.rows * TEST_MASK_META.cols);
      return Promise.resolve(new Response(buf, { status: 200 }));
    }
    if (url.includes('polar-genoa.json')) return Promise.resolve(jsonResponse(TEST_POLAR));
    if (url.includes('polar-fock.json')) return Promise.resolve(jsonResponse(FOCK));
    if (url.includes('harbors.json')) return Promise.resolve(jsonResponse(HARBORS));
    if (url.includes('seamarks.json'))
      return Promise.resolve(jsonResponse({ type: 'FeatureCollection', features: [] }));
    if (url.includes('basemap.pmtiles.png')) {
      // #118: MapView's uncontrolled-page preflight (Range bytes=0-15) runs
      // on every mount now — answer like an honest ranged origin (true 206,
      // body starting with the PMTiles magic 'PM') so the app tree takes the
      // normal 'range-ok' path and never triggers the Blob fallback here.
      return Promise.resolve(
        new Response(Uint8Array.from([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]), {
          status: 206,
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

// I18nProvider lives in main.tsx (outside App.tsx itself — see App.tsx's own
// composition), so rendering the bare <App /> component leaves useLang()'s
// setLang wired to the context's default no-op stub. Every existing test
// only ever *reads* the current language (default 'de' matches the
// context's own default), but the language-toggle test below needs a real,
// working setLang — so this wraps the same way main.tsx does.
function renderApp() {
  return render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
}

// Simulates a resolved MapView tap (see the maplibre-gl mock's FakeMap.on
// above) — the counterpart to the tap-to-pick tests' arm-only helpers below,
// which never actually resolve a coordinate. `point` is the screen pixel
// MapLibre reports; the default lands on open water (no harbor feature there,
// so MapView's harbor-hit gate lets the tap through to onTap).
function simulateMapClick(
  lat: number,
  lon: number,
  point: { x: number; y: number } = { x: 5, y: 5 },
) {
  act(() => {
    mapTestHooks.clickHandler?.({ lngLat: { lat, lng: lon }, point });
  });
}

// Simulates MapLibre firing a runtime 'error' event (see the maplibre-gl
// mock's FakeMap.on above) — used to drive the project-gate map-error
// banner without a real WebGL/MapLibre runtime.
function simulateMapError(error: unknown = new Error('style load failed')) {
  act(() => {
    mapTestHooks.errorHandler?.({ error });
  });
}

function okPlanResult(distanceNm: number): PlanResultOk {
  return {
    status: 'ok',
    genoa: {
      rig: 'genoa',
      legs: [],
      etaMs: Date.now() + 3_600_000,
      durationMs: 3_600_000,
      distanceNm,
      maneuverCount: 0,
      motorDistanceNm: 0,
    },
    fock: null,
    genoaReason: null,
    fockReason: 'calm-motor-off',
    recommended: 'genoa',
    snappedOrigin: { lat: 54.7, lon: 9.5 },
    snappedDestination: { lat: 54.9, lon: 10.5 },
  };
}

// Shared by the clobber-guard describe block below and the banner-matrix
// tests: picking a real origin/destination via simulated map taps is the
// only way to drive a real routingMock.calls entry through the app tree.
const ORIGIN_A = { lat: 54.79, lon: 9.43 };
const DEST_A = { lat: 54.85, lon: 10.35 };
const VIA_A = { lat: 54.82, lon: 9.9 };

function pickOriginAndDestination() {
  const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
  fireEvent.click(within(originSection).getByRole('button', { name: de['planner.pickOnMap'] }));
  simulateMapClick(ORIGIN_A.lat, ORIGIN_A.lon);

  const destSection = screen.getByRole('region', { name: de['planner.destination.label'] });
  fireEvent.click(within(destSection).getByRole('button', { name: de['planner.pickOnMap'] }));
  simulateMapClick(DEST_A.lat, DEST_A.lon);
}

beforeEach(async () => {
  await __resetDbForTests();
  vi.stubGlobal('fetch', fetchMock());
  routingMock.calls.length = 0;
  for (const key of Object.keys(mapTestHooks.layerClickHandlers))
    delete mapTestHooks.layerClickHandlers[key];
  for (const key of Object.keys(mapTestHooks.harborHitFeatures))
    delete mapTestHooks.harborHitFeatures[key];
  for (const key of Object.keys(mapTestHooks.sourceSetData)) delete mapTestHooks.sourceSetData[key];
});

// Screen pixel a harbor marker sits at for these tests, and a raw click
// coordinate distinct from every harbor snap — if it ever leaked through the
// gate into origin/destination, the DOM would show these coords instead of the
// harbor name.
const HARBOR_MARKER_POINT = { x: 300, y: 200 };
const RAW_TAP_ON_MARKER = { lat: 54.6, lon: 10.2 };

// Simulates a real single click on a harbor marker. In the browser one native
// click fires MapView's generic tap handler FIRST and DataLayers' layer-scoped
// harbor handler SECOND — so this fires BOTH, with the marker registered under
// the tap point (mapTestHooks.harborHitFeatures) so MapView's harbor-hit gate
// engages exactly as it would live: while armed, the generic tap sees a harbor
// feature at the point and bails, leaving the harbor handler the sole owner of
// the click. Firing only the layer handler (the earlier version) hid the
// armed-pick race entirely. Waits for both handlers' registration first —
// DataLayers registers its layer handler only once the (mocked) assets resolve.
async function simulateHarborMarkerClick(
  harborId: string,
  point: { x: number; y: number } = HARBOR_MARKER_POINT,
) {
  await waitFor(() => expect(mapTestHooks.layerClickHandlers['sc-harbor-points']).toBeTruthy());
  await waitFor(() => expect(mapTestHooks.clickHandler).toBeTruthy());
  const features = [{ properties: { id: harborId } }];
  mapTestHooks.harborHitFeatures[`${point.x},${point.y}`] = features;
  act(() => {
    mapTestHooks.clickHandler?.({
      lngLat: { lat: RAW_TAP_ON_MARKER.lat, lng: RAW_TAP_ON_MARKER.lon },
      point,
    });
    mapTestHooks.layerClickHandlers['sc-harbor-points']?.({ features });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('App', () => {
  it('renders the app shell with the SailCommand title', async () => {
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'SailCommand', level: 1 }),
    ).toBeInTheDocument();
    // #107: vitest sees the non-UAT define (`__SC_UAT__` is false, like a
    // production build), so the REAL import-site gate in the header must
    // render no UAT environment badge. (The heading-name assertion above
    // already implies it — a rendered badge would make the accessible name
    // "SailCommand UAT" — but pin it explicitly.)
    expect(screen.queryByText('UAT')).toBeNull();
  });

  it('defaults to the Planen tab, and switching tabs shows Routen and Live panel content', async () => {
    renderApp();

    expect(await screen.findByRole('tab', { name: de['nav.plan'] })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    expect(screen.getByRole('tab', { name: de['nav.routes'] })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText(de['plansList.empty'])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: de['nav.live'] }));
    expect(screen.getByRole('tab', { name: de['nav.live'] })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText(de['live.noPlan'])).toBeInTheDocument();
  });

  it('shows the offline banner when the browser goes offline, and it clears when back online', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    expect(screen.queryByText(de['banner.offline'])).not.toBeInTheDocument();

    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    fireEvent(window, new Event('offline'));
    expect(await screen.findByText(de['banner.offline'])).toBeInTheDocument();

    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    fireEvent(window, new Event('online'));
    await waitFor(() => {
      expect(screen.queryByText(de['banner.offline'])).not.toBeInTheDocument();
    });
  });

  it('opens About via the header button and shows the A2 disclaimer string in the current (German) language', async () => {
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: de['about.open'] }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(de['app.disclaimer'])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: de['about.close'] }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a dismissible settings-persistence-failure banner when a settings save fails', async () => {
    renderApp();
    const safetyDepthInput = await screen.findByLabelText(de['options.safetyDepth.label']);

    // Let the mount-time settings load settle first, then arm the failure —
    // this exercises the direct setSettings->saveSettings path, not the
    // pre-load flush path (covered in AppState.test.tsx).
    await waitFor(() => expect(safetyDepthInput).toHaveValue(3));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'saveSettings').mockRejectedValue(new Error('save boom'));

    fireEvent.change(safetyDepthInput, { target: { value: '3.5' } });
    fireEvent.blur(safetyDepthInput);

    expect(await screen.findByText(de['banner.persistenceError'])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: de['banner.dismiss'] }));
    expect(screen.queryByText(de['banner.persistenceError'])).not.toBeInTheDocument();
  });

  it('a persistence-failure banner clears on the next successful save, without an explicit dismiss', async () => {
    renderApp();
    const safetyDepthInput = await screen.findByLabelText(de['options.safetyDepth.label']);
    await waitFor(() => expect(safetyDepthInput).toHaveValue(3));

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'saveSettings').mockRejectedValueOnce(new Error('save boom'));

    fireEvent.change(safetyDepthInput, { target: { value: '3.5' } });
    fireEvent.blur(safetyDepthInput);
    expect(await screen.findByText(de['banner.persistenceError'])).toBeInTheDocument();

    // mockRejectedValueOnce only overrides the next call; this one falls
    // through to the real saveSettings and should succeed.
    fireEvent.change(safetyDepthInput, { target: { value: '4' } });
    fireEvent.blur(safetyDepthInput);

    await waitFor(() => {
      expect(screen.queryByText(de['banner.persistenceError'])).not.toBeInTheDocument();
    });
  });

  describe('tap-to-pick', () => {
    function armOrigin() {
      const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
      fireEvent.click(within(originSection).getByRole('button', { name: de['planner.pickOnMap'] }));
      return originSection;
    }

    // E8: 'via' extends the same tapTarget machinery (arming/disarming) as
    // origin/destination — armed from the panel's "Add waypoint" button
    // instead of a harbor section's "Pick on map" button, since via points
    // have no harbor picker of their own.
    function armVia() {
      const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
      fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
      return viaSection;
    }

    const tapPickMessage = (targetLabel: string) =>
      de['banner.tapPick'].replace('{target}', targetLabel);

    it('arms tap-to-pick with a cancel banner, and switching tabs away from Plan disarms it', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armOrigin();
      const message = tapPickMessage(de['planner.origin.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      // The banner and MapView's tapActive prop are both driven by the same
      // tapTarget state, so the banner clearing is equivalent to tapActive
      // going false — this is the only tap-armed indicator surfaced to a
      // screen reader/DOM query; MapLibre itself is mocked in this suite.
      fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('picking a harbor for the armed field disarms tap-to-pick', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      const originSection = armOrigin();
      const message = tapPickMessage(de['planner.origin.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.change(within(originSection).getByRole('combobox'), {
        target: { value: FLENSBURG.names.de },
      });
      fireEvent.click(within(originSection).getByRole('option', { name: FLENSBURG.names.de }));

      expect(screen.queryByText(message)).not.toBeInTheDocument();
      expect(
        within(originSection).getByText(FLENSBURG.names.de, { selector: 'p' }),
      ).toBeInTheDocument();
    });

    it('the banner cancel button disarms tap-to-pick', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armOrigin();
      const message = tapPickMessage(de['planner.origin.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: de['banner.tapPick.cancel'] }));
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('pressing Escape disarms tap-to-pick', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armOrigin();
      const message = tapPickMessage(de['planner.origin.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('pressing Escape while About is open only closes the dialog, leaving tap-to-pick armed (phase-gate fix 4)', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armOrigin();
      const message = tapPickMessage(de['planner.origin.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: de['about.open'] }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByText(message)).toBeInTheDocument(); // tap-to-pick untouched by that Escape
    });

    it('arms tap-to-pick for "via" from the panel\'s Add waypoint button, and switching tabs disarms it', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armVia();
      const message = tapPickMessage(de['planner.via.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('the banner cancel button disarms via tap-to-pick', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armVia();
      const message = tapPickMessage(de['planner.via.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: de['banner.tapPick.cancel'] }));
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('pressing Escape disarms via tap-to-pick', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armVia();
      const message = tapPickMessage(de['planner.via.label']);
      expect(await screen.findByText(message)).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });

    it('arming origin then arming via re-arms for the new target (only one can be armed at a time)', async () => {
      renderApp();
      await screen.findByRole('heading', { name: 'SailCommand' });

      armOrigin();
      expect(
        await screen.findByText(tapPickMessage(de['planner.origin.label'])),
      ).toBeInTheDocument();

      armVia();
      expect(
        screen.queryByText(tapPickMessage(de['planner.origin.label'])),
      ).not.toBeInTheDocument();
      expect(await screen.findByText(tapPickMessage(de['planner.via.label']))).toBeInTheDocument();
    });
  });
});

// Phase E gate fix wave: fixes 1 (stale via-replan clobber guard) and 6
// (canPlan false while a replan is in flight) both hinge on the same
// scenario — a via-replan left pending while the user does something else —
// so they're covered together here rather than in two separate, mostly-
// duplicate setups. Drives a real plan through usePlanFlow.run()/
// state/replan.ts's useViaReplan with the routing worker and Open-Meteo
// fetch faked (see the vi.mock calls and helpers up top) so the actual
// resolution-order race can be reproduced, not just asserted about in the
// abstract.
describe('via-replan clobber guard (Phase E gate fix)', () => {
  it('a via-replan that resolves after the user loaded a different plan does not clobber it, and the Plan button is disabled while the replan is in flight', async () => {
    const planB: Plan = {
      id: 'plan-b-preseeded',
      name: 'Preseeded Plan B',
      createdAtMs: Date.now() - 60_000,
      request: {
        origin: { lat: 54.95, lon: 10.6 },
        destination: { lat: 55.05, lon: 10.9 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now() + 3_600_000,
        settings: DEFAULT_SETTINGS,
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: Date.now() - 3_600_000, hours: 48 }),
      result: okPlanResult(77),
    };
    await db.savePlan(planB);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    pickOriginAndDestination();
    const planButton = screen.getByRole('button', { name: de['planner.plan'] });
    expect(planButton).toBeEnabled();
    fireEvent.click(planButton);

    // Plan A's initial run().
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() => expect(planButton).toBeEnabled()); // back to 'idle' — Plan A is now active

    // Start a via-replan on Plan A and leave it unresolved.
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(VIA_A.lat, VIA_A.lon);
    await waitFor(() => expect(routingMock.calls.length).toBe(2));

    // Fix 6: canPlan is false while that replan is in flight.
    expect(planButton).toBeDisabled();

    // The user switches to a *different*, already-saved plan while the
    // replan above is still pending. PlansList populates asynchronously
    // (its own mount effect awaits listPlans()), hence findByRole rather
    // than a synchronous getByRole.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(planB.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(77))).toBeInTheDocument()); // Plan B now active

    // Now let Plan A's replan resolve, with a result distinguishable from
    // both Plan A's original (10 nm) and Plan B's (77 nm) totals.
    routingMock.calls[1].resolve(okPlanResult(55));

    // Give the (guarded-out) update every chance to land before asserting
    // it didn't: without the fix, this resolution would call setPlan and
    // RouteSummary would flip to showing 55.0 nm.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText(formatNm(77))).toBeInTheDocument();
    expect(screen.queryByText(formatNm(55))).not.toBeInTheDocument();
  });
});

// PR self-review fix (#3 Major): GPX import is prefill-only (design §7). When a
// plan is already active, import must seed a FRESH draft (imported endpoints +
// cleared plan), NOT route the imported vias through handleViaPointsChange,
// which would replan the active plan with those vias but its OLD
// origin/destination/windGrid and persist the incoherent result. Drives the
// real App tree through the hidden file input (the actual handleImportFile ->
// handleImportRoute path).
describe('GPX import while a plan is active (#3 self-review: prefill-only)', () => {
  it('seeds a fresh draft from the imported endpoints and does NOT replan the active plan', async () => {
    const activePlan: Plan = {
      id: 'active-before-import',
      name: 'Active Before Import',
      createdAtMs: Date.now() - 60_000,
      request: {
        origin: { lat: 54.95, lon: 10.6 },
        destination: { lat: 55.05, lon: 10.9 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now() + 3_600_000,
        settings: DEFAULT_SETTINGS,
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: Date.now() - 3_600_000, hours: 48 }),
      result: okPlanResult(88),
    };
    await db.savePlan(activePlan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // Load the saved plan so a plan is active (its 88.0 nm total is on screen).
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(activePlan.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(88))).toBeInTheDocument());

    // Import a GPX (rte with one via) whose endpoints are inside the data-area
    // but DISTINCT from the active plan's — so the assertions prove the IMPORTED
    // endpoints are shown, not the old plan's.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    const importOrigin = { lat: 54.79, lon: 9.43 };
    const importVia = { lat: 54.85, lon: 10.0 };
    const importDest = { lat: 54.9, lon: 10.5 };
    const gpx =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
      `<rtept lat="${importOrigin.lat}" lon="${importOrigin.lon}"/>` +
      `<rtept lat="${importVia.lat}" lon="${importVia.lon}"/>` +
      `<rtept lat="${importDest.lat}" lon="${importDest.lon}"/>` +
      '</rte></gpx>';
    const fileInput = document.querySelector('input[type="file"]');
    if (!(fileInput instanceof HTMLInputElement)) throw new Error('import file input not found');
    // 0 — loading a saved plan dispatches no routing call; captured so the
    // "no replan" assertion is robust to any incidental prior calls.
    const routingCallsBefore = routingMock.calls.length;

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File([gpx], 'route.gpx', { type: 'application/gpx+xml' })] },
      });
    });

    // Success notice, and the imported endpoints prefill the draft inputs.
    expect(await screen.findByText(de['planner.import.success'])).toBeInTheDocument();
    const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
    const destSection = screen.getByRole('region', { name: de['planner.destination.label'] });
    await waitFor(() =>
      expect(
        within(originSection).getByText(formatLatLon(importOrigin), { selector: 'p' }),
      ).toBeInTheDocument(),
    );
    expect(
      within(destSection).getByText(formatLatLon(importDest), { selector: 'p' }),
    ).toBeInTheDocument();

    // The active plan was CLEARED (prefill-only) — its 88.0 nm summary is gone.
    expect(screen.queryByText(formatNm(88))).not.toBeInTheDocument();

    // Deterministic teeth: no replan was dispatched. Under the pre-fix code,
    // handleImportRoute -> handleViaPointsChange(vias) with an active plan would
    // queue a viaReplan routing call here. Give any such (buggy) dispatch every
    // chance to land before asserting it didn't.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(routingMock.calls.length).toBe(routingCallsBefore);
  });
});

// PR self-review fix wave: banner matrix. Each banner already has its own
// unit-level coverage elsewhere (usePlanFlow.test.tsx, replan.test.ts); these
// drive the real App tree end-to-end to prove the wiring itself — tab
// independence, dismiss behavior, and that multiple banners can be visible
// at once without one clobbering another's DOM.
describe('banner surfacing (PR self-review fix wave)', () => {
  it('a plan-run error surfaces as a tab-independent banner even while a different tab is active', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    pickOriginAndDestination();

    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));

    // Switch away from the Plan tab before the result actually lands —
    // PlannerPanel's own inline alert isn't even mounted once this happens.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    routingMock.calls[0].resolve({ status: 'error', reason: 'unreachable' });

    expect(await screen.findByText(de['error.noRoute.unreachable'])).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: de['nav.routes'] })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('the stale-forecast banner renders through the real App tree for a loaded plan whose windGrid predates departure by >12h', async () => {
    const staleWindGrid = uniformWindGrid(10, 250, {
      t0Ms: Date.now() - 20 * 3_600_000,
      hours: 48,
    });
    const stalePlan: Plan = {
      id: 'stale-plan',
      name: 'Stale Plan',
      createdAtMs: Date.now() - 20 * 3_600_000,
      request: {
        origin: ORIGIN_A,
        destination: DEST_A,
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now(),
        settings: DEFAULT_SETTINGS,
      },
      windGrid: staleWindGrid,
      result: okPlanResult(33),
    };
    await db.savePlan(stalePlan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(stalePlan.name) }));

    // Scoped to .banner-area: RouteSummary (also visible on the Routes tab)
    // shows its own pre-existing inline stale-forecast alert too, so the
    // same text is legitimately on the page twice once a stale plan is
    // active here — this assertion is specifically about the App-level
    // banner-area surface, not a claim that it's the only place stale
    // forecasts are ever shown.
    const bannerArea = document.querySelector('.banner-area');
    if (!bannerArea) throw new Error('expected .banner-area to be present');
    expect(
      await within(bannerArea as HTMLElement).findByText(de['route.staleForecast']),
    ).toBeInTheDocument();
  });

  it('a viaReplan error banner renders through the real App tree', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    pickOriginAndDestination();
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeEnabled(),
    );

    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(VIA_A.lat, VIA_A.lon);
    await waitFor(() => expect(routingMock.calls.length).toBe(2));
    routingMock.calls[1].resolve({ status: 'error', reason: 'unreachable' });

    expect(await screen.findByText(de['error.noRoute.unreachable'])).toBeInTheDocument();
  });

  it('a droppedCount === 1 banner (singular copy) renders through the real App tree, and is dismissible', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    pickOriginAndDestination();
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeEnabled(),
    );

    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    // ~15 m from ORIGIN_A — within the 60 m dedupe threshold, so
    // replanWithVias's own dedupe drops it (droppedCount === 1).
    simulateMapClick(ORIGIN_A.lat + 0.0001, ORIGIN_A.lon + 0.0001);
    await waitFor(() => expect(routingMock.calls.length).toBe(2));
    routingMock.calls[1].resolve(okPlanResult(10));

    expect(await screen.findByText(de['banner.viaTooClose'])).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: de['banner.dismiss'] }));
    expect(screen.queryByText(de['banner.viaTooClose'])).not.toBeInTheDocument();
  });

  it('droppedCount > 1 shows the pluralized "waypoints…skipped" copy, not the singular one', async () => {
    // Both within ~15-30 m of ORIGIN_A — dedupeViaPoints measures each
    // against the last *kept* waypoint starting at origin; since the first
    // is dropped, `previous` stays origin for the second too, so both drop
    // in the same dedupe pass (droppedCount === 2), independent of order.
    const nearOrigin1 = { lat: ORIGIN_A.lat + 0.0001, lon: ORIGIN_A.lon + 0.0001 };
    const nearOrigin2 = { lat: ORIGIN_A.lat + 0.0002, lon: ORIGIN_A.lon + 0.0002 };
    const preseeded: Plan = {
      id: 'plural-drop-plan',
      name: 'Plural Drop Plan',
      createdAtMs: Date.now() - 60_000,
      request: {
        origin: ORIGIN_A,
        destination: DEST_A,
        viaPoints: [nearOrigin1, nearOrigin2],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now() + 3_600_000,
        settings: DEFAULT_SETTINGS,
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: Date.now() - 3_600_000, hours: 48 }),
      result: okPlanResult(66),
    };
    await db.savePlan(preseeded);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(preseeded.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(66))).toBeInTheDocument());

    // Reordering re-submits the same two-via list unchanged (content-wise)
    // to a fresh replan, which is enough to re-trigger the dedupe drop —
    // no need to add a third via through tap-to-pick.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    fireEvent.click(
      screen.getByRole('button', { name: de['planner.via.moveDown'].replace('{index}', '1') }),
    );

    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(66));

    expect(
      await screen.findByText(de['banner.viaTooClose.plural'].replace('{count}', '2')),
    ).toBeInTheDocument();
    expect(screen.queryByText(de['banner.viaTooClose'])).not.toBeInTheDocument();
  });

  it('offline and settings-persistence-error banners stack simultaneously, without one hiding the other', async () => {
    renderApp();
    const safetyDepthInput = await screen.findByLabelText(de['options.safetyDepth.label']);
    await waitFor(() => expect(safetyDepthInput).toHaveValue(3));

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'saveSettings').mockRejectedValue(new Error('save boom'));
    fireEvent.change(safetyDepthInput, { target: { value: '3.5' } });
    fireEvent.blur(safetyDepthInput);
    expect(await screen.findByText(de['banner.persistenceError'])).toBeInTheDocument();

    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    fireEvent(window, new Event('offline'));

    expect(await screen.findByText(de['banner.offline'])).toBeInTheDocument();
    expect(screen.getByText(de['banner.persistenceError'])).toBeInTheDocument();
  });

  it('shows a dismissible map-error banner on the first MapLibre error, logs it, and ignores further errors from the same mount', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(screen.queryByText(de['banner.mapError'])).not.toBeInTheDocument();

    const firstError = new Error('style load failed');
    simulateMapError(firstError);
    expect(await screen.findByText(de['banner.mapError'])).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith('MapLibre error', firstError);

    // MapLibre can fire many errors in a row (MapView.tsx's own comment) —
    // only the first should have surfaced the banner; a second one must
    // still be logged but not re-trigger anything banner-visible.
    const callsAfterFirst = consoleError.mock.calls.length;
    simulateMapError(new Error('second, unrelated failure'));
    expect(consoleError.mock.calls.length).toBe(callsAfterFirst + 1);
    expect(screen.getByText(de['banner.mapError'])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: de['banner.dismiss'] }));
    expect(screen.queryByText(de['banner.mapError'])).not.toBeInTheDocument();
  });

  it("the language-toggle button label goes through the i18n dict (shows the target language's code)", async () => {
    renderApp();
    const toggle = await screen.findByRole('button', { name: de['nav.langToggle'] });
    // Starts in German — the button offers to switch to English.
    expect(toggle).toHaveTextContent(de['nav.langToggle.en']);

    fireEvent.click(toggle);
    expect(await screen.findByRole('button', { name: en['nav.langToggle'] })).toHaveTextContent(
      de['nav.langToggle.de'],
    );
  });
});

describe('Details ansehen → Routes focus (#64 phase 3)', () => {
  it('jumps to the Routes tab AND moves focus to the Ergebnis card heading', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    pickOriginAndDestination();
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeEnabled(),
    );

    // The compact Ergebnis strip appears in the Plan tab; its "Details ansehen"
    // action switches to Routes AND focuses the full Ergebnis card heading
    // (end-to-end: handleViewDetails -> setTab + the tab-keyed focus effect
    // firing on routeResultHeadingRef, forwarded via Card titleRef).
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(de['planner.result.details']) }),
    );

    expect(screen.getByRole('tab', { name: de['nav.routes'] })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => {
      const heading = document.querySelector('.route-ergebnis > .sc-card-title');
      expect(heading).not.toBeNull();
      expect(document.activeElement).toBe(heading);
    });
  });
});

describe('harbor marker click-to-pick (#38)', () => {
  it('fills origin first, then destination, with the same endpoint shape as the search picker', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // First click: origin is empty -> harbor becomes the origin, shown by
    // its localized label (the { selector: 'p' } pins the section's picked-
    // label line, not the HarborPicker result button of the same name).
    await simulateHarborMarkerClick('flensburg');
    const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
    await waitFor(() =>
      expect(within(originSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument(),
    );

    // Second click: origin already set -> destination gets (re)filled.
    await simulateHarborMarkerClick('flensburg');
    const destSection = screen.getByRole('region', { name: de['planner.destination.label'] });
    await waitFor(() =>
      expect(within(destSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument(),
    );
  });

  it('while tap-to-pick is armed for destination, a harbor click fills destination (not the empty origin) and disarms', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    const destSection = screen.getByRole('region', { name: de['planner.destination.label'] });
    fireEvent.click(within(destSection).getByRole('button', { name: de['planner.pickOnMap'] }));
    const message = de['banner.tapPick'].replace('{target}', de['planner.destination.label']);
    expect(await screen.findByText(message)).toBeInTheDocument();

    await simulateHarborMarkerClick('flensburg');
    await waitFor(() =>
      expect(within(destSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument(),
    );
    // Origin stays untouched; the tap-pick banner is gone (disarmed). An unset
    // endpoint shows its search combobox rather than a collapsed selection row.
    const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
    expect(within(originSection).getByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it('while armed for origin, a tap on a harbor marker is gated to the harbor handler — the generic tap never sets a raw-coordinate origin (#38 armed-pick regression)', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // Arm origin-pick, then place a harbor marker under the tap point.
    const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
    fireEvent.click(within(originSection).getByRole('button', { name: de['planner.pickOnMap'] }));
    const armedMessage = de['banner.tapPick'].replace('{target}', de['planner.origin.label']);
    expect(await screen.findByText(armedMessage)).toBeInTheDocument();
    await waitFor(() => expect(mapTestHooks.layerClickHandlers['sc-harbor-points']).toBeTruthy());
    const markerPoint = { x: 300, y: 200 };
    mapTestHooks.harborHitFeatures[`${markerPoint.x},${markerPoint.y}`] = [
      { properties: { id: 'flensburg' } },
    ];

    // MapLibre fires the generic map tap FIRST for this click. MapView's
    // harbor-hit gate must swallow it — the query finds a harbor feature at the
    // point, so no raw-coordinate origin is set and tap-to-pick stays armed.
    // This is the deterministic teeth of the fix: fired alone (no harbor
    // handler yet to mask the result), without the gate onTap would set origin
    // to the raw tap coordinate here and disarm.
    simulateMapClick(RAW_TAP_ON_MARKER.lat, RAW_TAP_ON_MARKER.lon, markerPoint);
    // Origin unset (still its search combobox, not a collapsed selection row).
    expect(within(originSection).getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByText(armedMessage)).toBeInTheDocument();

    // MapLibre fires the harbor layer handler SECOND — it alone resolves the
    // click, to Flensburg's curated snap (shown by the harbor NAME, whose
    // PickedPoint carries harbor.snap), and disarms.
    act(() => {
      mapTestHooks.layerClickHandlers['sc-harbor-points']?.({
        features: [{ properties: { id: 'flensburg' } }],
      });
    });
    await waitFor(() =>
      expect(within(originSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument(),
    );
    expect(
      within(originSection).queryByText(formatLatLon(RAW_TAP_ON_MARKER), { selector: 'p' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(armedMessage)).not.toBeInTheDocument();
  });

  it('a marker click while armed for a via waypoint is a deliberate no-op: no via is appended and arming stays active', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // Arm tap-to-pick for a via waypoint (the panel's "Add waypoint" button —
    // via has no harbor picker of its own), then click a harbor marker.
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    const viaArmedMessage = de['banner.tapPick'].replace('{target}', de['planner.via.label']);
    expect(await screen.findByText(viaArmedMessage)).toBeInTheDocument();

    // simulateHarborMarkerClick fires both handlers (browser fan-out): the
    // generic tap is gated out on the harbor hit (so no via is appended), and
    // resolveHarborPickTarget returns null for a via-armed marker click (so it
    // is not hijacked into an origin/destination fill). Net: a no-op.
    await simulateHarborMarkerClick('flensburg');

    // No via row was added (each via renders as a listitem in the Waypoints
    // region), and arming is still active — the documented fail-safe.
    expect(within(viaSection).queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText(viaArmedMessage)).toBeInTheDocument();
  });

  it('rebuilds the harbor source with localized names when the UI language switches (#38 relabel wiring)', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // Initial (German) harbor source data lands once map+style+assets resolve.
    const harborNames = () =>
      (
        mapTestHooks.sourceSetData['sc-harbors'] as
          { features: { properties: { name: string } }[] } | undefined
      )?.features.map((f) => f.properties.name) ?? [];
    await waitFor(() => expect(harborNames()).toContain(RELABEL_HARBOR.names.de));
    expect(harborNames()).not.toContain(RELABEL_HARBOR.names.en);

    // Toggling the language must rebuild the source and setData the en names —
    // wiring that no-opped in every prior test (getSource returned undefined).
    fireEvent.click(await screen.findByRole('button', { name: de['nav.langToggle'] }));
    await waitFor(() => expect(harborNames()).toContain(RELABEL_HARBOR.names.en));
    expect(harborNames()).not.toContain(RELABEL_HARBOR.names.de);
  });

  it('renders the always-mounted depth toggle (ON by default, #63) with no plan active', async () => {
    renderApp();
    const toggle = await screen.findByRole('checkbox', { name: de['map.depth.toggle'] });
    // Fresh profile (afterEach cleared localStorage): #63 flipped the default
    // from OFF to ON — depth must be visible with zero clicks.
    expect(toggle).toBeChecked();
    // The plan-gated route-layer cluster (wind barbs) must NOT be hosting it:
    // no plan exists, so the barb toggle is absent while depth is present.
    expect(
      screen.queryByRole('checkbox', { name: de['route.windBarbs.toggle'] }),
    ).not.toBeInTheDocument();
  });

  it("a persisted explicit 'off' (sc-depth-visible = '0') overrides the ON default (#63)", async () => {
    localStorage.setItem('sc-depth-visible', '0');
    renderApp();
    const toggle = await screen.findByRole('checkbox', { name: de['map.depth.toggle'] });
    expect(toggle).not.toBeChecked();
  });
});

describe('toPlannerStatus (#53: relaxed-depth probe phase mapping)', () => {
  // The adapter only uses `t` on the error branch (t(messageKey)); an identity
  // stub is enough to pin the passthrough there.
  const t = ((key: string) => key) as unknown as Parameters<typeof toPlannerStatus>[2];

  it("maps usePlanFlow's 'probing-depth' to the panel's { phase: 'probing' }", () => {
    expect(toPlannerStatus({ phase: 'probing-depth' }, 0, t)).toEqual({ phase: 'probing' });
  });

  // Guard the sibling branches too, so the probing mapping isn't a lone case a
  // typo could silently collapse into another phase.
  it('maps the sibling planning phases to their own panel phases', () => {
    expect(toPlannerStatus({ phase: 'idle' }, 0, t)).toEqual({ phase: 'idle' });
    expect(toPlannerStatus({ phase: 'fetching-wind' }, 0, t)).toEqual({ phase: 'fetching' });
    expect(toPlannerStatus({ phase: 'error', messageKey: 'error.internal' }, 0, t)).toEqual({
      phase: 'error',
      message: 'error.internal',
    });
  });
});

// #64 phase 4 (§3.5): the plan-run error banner classifies an already-existing
// MsgKey into a group for presentation. Literals below are pinned by hand
// (mutation-check, #50) — NOT read back from the classifier under test.
describe('planErrorGroup / planErrorBannerKind (§3.5 error presentation)', () => {
  it('classifies network keys as retryable warnings', () => {
    for (const key of ['error.offline', 'error.rateLimited', 'error.windService'] as const) {
      expect(planErrorGroup(key)).toBe('network');
      expect(planErrorBannerKind(key)).toBe('warning');
    }
  });

  it('classifies every no-route key as a (non-retryable) warning', () => {
    for (const key of [
      'error.noRoute.unreachable',
      'error.noRoute.beyondHorizon',
      'error.noRoute.calmMotorOff',
      'error.noRoute.snapOrigin',
      'error.noRoute.snapDestination',
      'error.noRoute.snapVia',
    ] as const) {
      expect(planErrorGroup(key)).toBe('noRoute');
      expect(planErrorBannerKind(key)).toBe('warning');
    }
  });

  it('classifies error.internal as an unexpected failure with the assertive error paint', () => {
    expect(planErrorGroup('error.internal')).toBe('unexpected');
    expect(planErrorBannerKind('error.internal')).toBe('error');
  });
});

describe('states & motion (§3.5, App tree)', () => {
  it('shows the onboarding line on first load and hides it once both endpoints are set', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // Empty trip, online: the friendly guidance stands in for a bare form.
    expect(await screen.findByText(de['planner.onboarding'])).toBeInTheDocument();

    pickOriginAndDestination();
    expect(screen.queryByText(de['planner.onboarding'])).not.toBeInTheDocument();
  });

  it('shows a no-route error as a warning banner with NO retry action', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    pickOriginAndDestination();

    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve({ status: 'error', reason: 'unreachable' });

    const message = await screen.findByText(de['error.noRoute.unreachable']);
    // Warning paint (still role="alert"); no "Try again" — the copy already
    // states the next step, so a retry would just repeat the failure.
    expect(message.closest('.banner')).toHaveClass('banner-warning');
    expect(screen.queryByRole('button', { name: de['banner.retry'] })).not.toBeInTheDocument();
  });

  it('shows a network error as a warning banner whose "Try again" re-runs the plan', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    pickOriginAndDestination();

    // Fail the wind fetch once → usePlanFlow maps http to error.windService.
    vi.mocked(fetchWindGrid).mockRejectedValueOnce(new OpenMeteoError('http', 'HTTP 500'));
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));

    const message = await screen.findByText(de['error.windService']);
    expect(message.closest('.banner')).toHaveClass('banner-warning');
    // The first attempt failed before routing, so no routing call yet.
    expect(routingMock.calls.length).toBe(0);

    // Retry re-invokes the same plan path; the wind mock now resolves, so the
    // run reaches the router — proving the action re-drove the flow.
    fireEvent.click(screen.getByRole('button', { name: de['banner.retry'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
  });
});
