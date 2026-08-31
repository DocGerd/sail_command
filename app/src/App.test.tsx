import 'fake-indexeddb/auto';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import App, {
  INTERACTIVE_MAP_LAYER_IDS,
  planErrorBannerKind,
  planErrorGroup,
  planErrorRetryMayHelp,
  toPlannerStatus,
} from './App';
import * as DataLayersModule from './components/DataLayers';
import { I18nProvider } from './i18n';
import { de } from './i18n/dict.de';
import { en } from './i18n/dict.en';
import { fetchWindGrid, OpenMeteoError } from './services/openMeteo';
import { __resetDbForTests } from './services/db';
import * as db from './services/db';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from './test/fixtures';
import { formatLatLon, formatNm, toLocalInputValue } from './lib/format';
import { staleForecastGapHours } from './lib/plan';
import {
  DEFAULT_SETTINGS,
  type Harbor,
  type Leg,
  type Plan,
  type PlanRequest,
  type PlanResult,
  type PlanResultOk,
  type PolarTable,
} from './types';
import { boatSnapshot, defaultBoatSnapshot } from './types';
import { boatById, sailIdsOf } from './data/boats';
import { PLAN_SCHEMA_VERSION } from './types';

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
  // #571 redesign review (BLOCKER 1 / MAJOR 3): every ViaMarkers marker ever
  // constructed by FakeMarker below, in construction order, never spliced
  // out on remove() (only flagged `removed`) — so a rebuild is visible as a
  // NEW entry, not a mutation of an old one, exactly mirroring how a real
  // MapLibre rebuild replaces marker instances. `dragTo(lat, lon)` simulates
  // a drag gesture: sets the position imperatively (as MapLibre would during
  // the gesture) and fires the registered 'dragend' handler, same as a real
  // marker.
  viaMarkers: [] as {
    lat: number;
    lon: number;
    draggable: boolean;
    removed: boolean;
    dragendHandler: (() => void) | null;
    dragTo: (lat: number, lon: number) => void;
  }[],
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

// #551 item 3: DepthProfile itself is not under test here — App.tsx's own
// prop wiring is. DepthProfile needs a loaded mask plus real leg geometry
// to render its SVG chart at all (see its own file for why — it returns
// null on an empty legs list, and the safety-depth line renders only when
// `safetyDepthM <= axisMax`), machinery this file's fetch mock doesn't
// otherwise need to model. Swapping it for a probe that records the props
// it was called with tests exactly what item 3 is about — which VALUE
// App.tsx passes as `safetyDepthM` — without dragging in DepthProfile's own
// rendering path (covered by its own test file, which this task must not
// edit — a sibling issue, #520, owns it in this same milestone).
const depthProfileProps = vi.hoisted(() => ({
  last: null as { safetyDepthM: number } | null,
}));
vi.mock('./components/DepthProfile', () => ({
  default: (props: { safetyDepthM: number }) => {
    depthProfileProps.last = { safetyDepthM: props.safetyDepthM };
    return null;
  },
}));

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
    // #682: DataLayers.tsx now registers its seamark click/hover handler on
    // an ARRAY of layer ids (`map.on('click', [SEAMARKS_LAYER,
    // SEAMARKS_HAZARD_LAYER], handleClick)`, real MapLibre's own array form
    // of the delegated `on(type, layerIds, fn)` overload) rather than a
    // single string — this fake registers the SAME handler under each id in
    // `layerClickHandlers`. Deliberately simpler than `test/fakeMaplibre.ts`'s
    // exact-set delegated-registration model (#682 review MINOR 4): nothing
    // in this file exercises a SUBSET `off`/multi-layer `once`, so the
    // per-id form here is not a divergence this suite could catch either
    // way — see that file's own header comment for the real semantics.
    on(event: string, layerOrCb: unknown, maybeCb?: unknown) {
      if (typeof layerOrCb === 'function') {
        if (event === 'click')
          mapTestHooks.clickHandler = layerOrCb as typeof mapTestHooks.clickHandler;
        if (event === 'error')
          mapTestHooks.errorHandler = layerOrCb as typeof mapTestHooks.errorHandler;
      } else if (event === 'click' && typeof maybeCb === 'function') {
        const layerIds = Array.isArray(layerOrCb) ? layerOrCb : [layerOrCb];
        for (const id of layerIds) {
          if (typeof id !== 'string') continue;
          mapTestHooks.layerClickHandlers[id] =
            maybeCb as (typeof mapTestHooks.layerClickHandlers)[string];
        }
      }
    }
    // #682: MUST distinguish "a delegated layer-scoped off (string OR
    // array second argument)" from "the plain 2-arg off(event, fn) form" by
    // checking for a STRING/ARRAY explicitly — the old `typeof layerOrCb ===
    // 'string'` check fell through to the generic-handler branch for an
    // ARRAY (neither a string nor a function), which cleared
    // mapTestHooks.clickHandler on EVERY DataLayers seamark-effect re-run
    // and made every raw-tap-pick test in this file time out waiting for a
    // clickHandler that had just been wiped by an unrelated cleanup
    // (MEASURED: reverting this array branch back to the old string-only
    // check reproduces 18 failures across this file, all timing out on
    // `mapTestHooks.clickHandler` staying null).
    off(event: string, layerOrCb?: unknown) {
      if (typeof layerOrCb === 'string' || Array.isArray(layerOrCb)) {
        if (event === 'click') {
          const layerIds = Array.isArray(layerOrCb) ? layerOrCb : [layerOrCb];
          for (const id of layerIds) delete mapTestHooks.layerClickHandlers[id as string];
        }
        return;
      }
      if (event === 'click') mapTestHooks.clickHandler = null;
      if (event === 'error') mapTestHooks.errorHandler = null;
    }
    getCanvas() {
      // #155: ScaleBar measures its 100 px reference span from the canvas's
      // CSS box, so the fake has to report one (jsdom lays nothing out).
      return { style: {}, clientWidth: 800, clientHeight: 600 } as HTMLCanvasElement;
    }
    // #155 camera surface. The compass reads getBearing() and drives the
    // camera through easeTo(); ScaleBar unprojects two screen points and
    // haversines them. A linear equirectangular fake is enough for both: at
    // this fake's 0.001 deg/px it puts ~0.035 NM under the bar's 100 px
    // reference (the metre branch), which is a real, in-range answer — the
    // exact value is pinned in lib/mapOrientation.test.ts, not here.
    _bearing = 0;
    getBearing() {
      return this._bearing;
    }
    easeTo(options?: { bearing?: number }) {
      if (options && typeof options.bearing === 'number') this._bearing = options.bearing;
    }
    unproject(p: [number, number]) {
      return { lng: 9.9 + (p[0] - 400) * 0.001, lat: 54.85 - (p[1] - 300) * 0.001 };
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
  // #571 redesign review (BLOCKER 1 / MAJOR 3): instrumented so ViaMarkers'
  // real construct/drag/remove sequence is observable via
  // mapTestHooks.viaMarkers — every Marker() instance (BoatMarker's own
  // included, though it never sets `draggable`) is recorded, never spliced
  // out on remove(), so a rebuild reads as a new array entry rather than a
  // mutated old one.
  class FakeMarker {
    private record: (typeof mapTestHooks.viaMarkers)[number];
    constructor(opts: { draggable?: boolean } = {}) {
      const record: (typeof mapTestHooks.viaMarkers)[number] = {
        lat: 0,
        lon: 0,
        draggable: Boolean(opts.draggable),
        removed: false,
        dragendHandler: null,
        dragTo: (lat: number, lon: number) => {
          record.lat = lat;
          record.lon = lon;
          record.dragendHandler?.();
        },
      };
      this.record = record;
      mapTestHooks.viaMarkers.push(record);
    }
    setLngLat(ll: [number, number]) {
      this.record.lon = ll[0];
      this.record.lat = ll[1];
      return this;
    }
    setRotation() {
      return this;
    }
    getLngLat() {
      return { lat: this.record.lat, lng: this.record.lon };
    }
    setDraggable(v: boolean) {
      this.record.draggable = v;
      return this;
    }
    on(event: string, handler: () => void) {
      if (event === 'dragend') this.record.dragendHandler = handler;
      return this;
    }
    off() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.record.removed = true;
    }
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
    setWorkerUrl: vi.fn(),
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
    if (url.includes('salona-45-genoa.json')) return Promise.resolve(jsonResponse(TEST_POLAR));
    if (url.includes('salona-45-fock.json')) return Promise.resolve(jsonResponse(FOCK));
    // #54 spec N: the two tier-C fleet boats' four tables. AFTER the
    // salona-45 branches, which keep their distinct TEST_POLAR/FOCK fixtures.
    // loadRoutingAssets fetches every catalogue boat's polars eagerly, so a
    // new boat 404s the whole asset load without this.
    if (url.includes('/data/polars/')) return Promise.resolve(jsonResponse(TEST_POLAR));
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

// #631: a plan becoming active and App.tsx's plan-form sync effect running
// are TWO separate scheduler tasks. That effect (the `syncedPlanIdRef` one,
// keyed on plan.id + harborsLoaded) writes origin, destination, departureMs
// AND the via draft from the plan's own request, and it runs in a passive-
// effect flush that lands AFTER the commit which re-enables the Plan button.
// So `waitFor(() => expect(planButton).toBeEnabled())` observes
// `planning.phase`, NOT that effect — and under load the gap between the two
// widens far enough that a form edit made straight after that gate is
// silently overwritten by the still-pending effect. MEASURED: 1 failure in 25
// full-file runs under 48-way CPU contention, and once in CI (run
// 32365975638, `expected '2026-08-20T12:00' to be '2026-08-20T16:53'` — the
// departure reverting to the plan's own seed).
//
// There is nothing to POLL for here: on these plans the effect re-writes
// values the form already holds, so its writes are invisible in the DOM.
// (Where they ARE visible the tests gate on them directly instead — see
// 'adding a via point (a draft-only edit) does not clobber a departure the
// user edited after loading', which waits for the prefilled departure value.)
// Flushing React's pending passive effects is therefore the only
// deterministic gate available, and it is a flush rather than a sleep: it
// drains the work already scheduled, it does not wait a fixed time for it.
//
// This makes the TEST deterministic. It does NOT fix, and must not be read as
// fixing, the product race it steps around: a user who edits the Plan form
// before that effect fires still loses the edit. That is #660, still open —
// most reachably on a cold boot with a restored session, where the effect is
// parked behind `harborsLoaded` for the whole asset load.
async function flushPlanFormSync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
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
    sails: [
      {
        sailId: 'genoa',
        result: {
          sailId: 'genoa',
          legs: [],
          etaMs: Date.now() + 3_600_000,
          durationMs: 3_600_000,
          distanceNm,
          maneuverCount: 0,
          motorDistanceNm: 0,
        },
        reason: null,
      },
      { sailId: 'fock', result: null, reason: 'calm-motor-off' },
    ],
    recommended: 'genoa',
    comparisonComplete: true,
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
  depthProfileProps.last = null;
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

  // #704: the ARIA Tabs contract's association half — each tab's
  // aria-controls points at the single tabpanel's id, and the tabpanel's
  // aria-labelledby tracks whichever tab is currently selected. There is
  // exactly one `<main className="app-panel">` whose CONTENT swaps per
  // `tab`, so `getByRole('tabpanel')` must find exactly one element
  // throughout — a second panel materialising would fail that query.
  it('#704: app-shell tabs are wired to a tabpanel via aria-controls/aria-labelledby', async () => {
    renderApp();

    const planTab = await screen.findByRole('tab', { name: de['nav.plan'] });
    const routesTab = screen.getByRole('tab', { name: de['nav.routes'] });
    const panel = screen.getByRole('tabpanel');

    expect(planTab).toHaveAttribute('aria-controls', panel.id);
    expect(routesTab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', planTab.id);

    fireEvent.click(routesTab);
    expect(panel).toHaveAttribute('aria-labelledby', routesTab.id);
  });

  // #704: roving tabIndex — exactly one tab is in the natural Tab order
  // (tabIndex 0) at any time, and it must be the SELECTED one, not merely
  // the first.
  it('#704: exactly one app-shell tab has tabIndex 0, and it tracks selection', async () => {
    renderApp();

    const planTab = await screen.findByRole('tab', { name: de['nav.plan'] });
    const routesTab = screen.getByRole('tab', { name: de['nav.routes'] });
    const liveTab = screen.getByRole('tab', { name: de['nav.live'] });
    const boatTab = screen.getByRole('tab', { name: de['nav.boat'] });

    expect(planTab).toHaveAttribute('tabindex', '0');
    expect(routesTab).toHaveAttribute('tabindex', '-1');
    expect(liveTab).toHaveAttribute('tabindex', '-1');
    expect(boatTab).toHaveAttribute('tabindex', '-1');

    fireEvent.click(boatTab);
    expect(boatTab).toHaveAttribute('tabindex', '0');
    expect(planTab).toHaveAttribute('tabindex', '-1');
  });

  // #704: ArrowLeft/ArrowRight (wrapping) and Home/End on the app-shell
  // tablist — the WAI-ARIA "automatic activation" variant, so arrowing to a
  // tab also selects it and moves focus onto it.
  it('#704: ArrowLeft/ArrowRight/Home/End cycle the app-shell tablist', async () => {
    renderApp();

    const planTab = await screen.findByRole('tab', { name: de['nav.plan'] });
    const routesTab = screen.getByRole('tab', { name: de['nav.routes'] });
    const boatTab = screen.getByRole('tab', { name: de['nav.boat'] });

    fireEvent.keyDown(planTab, { key: 'ArrowRight' });
    expect(routesTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(routesTab);

    fireEvent.keyDown(routesTab, { key: 'ArrowLeft' });
    expect(planTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(planTab);

    // ArrowLeft from the FIRST tab wraps to the LAST.
    fireEvent.keyDown(planTab, { key: 'ArrowLeft' });
    expect(boatTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(boatTab);

    fireEvent.keyDown(boatTab, { key: 'Home' });
    expect(planTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(planTab);

    fireEvent.keyDown(planTab, { key: 'End' });
    expect(boatTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(boatTab);
  });

  // #704 review Minor: the tested wrap above is ArrowLeft-from-first only —
  // this covers the other direction, ArrowRight-from-LAST wrapping to FIRST.
  it('#704: ArrowRight from the last app-shell tab wraps to the first', async () => {
    renderApp();

    const planTab = await screen.findByRole('tab', { name: de['nav.plan'] });
    const boatTab = screen.getByRole('tab', { name: de['nav.boat'] });

    fireEvent.click(boatTab);
    fireEvent.keyDown(boatTab, { key: 'ArrowRight' });
    expect(planTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(planTab);
  });

  // #299: the fourth "Boot"/"Boat" tab renders SettingsPanel's grouped
  // content — a peer content tab like the other three, not a modal.
  it('adds a fourth Boot tab that renders the grouped Boat-settings content (#299)', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    expect(screen.getByRole('tab', { name: de['nav.boat'] })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    fireEvent.click(screen.getByRole('tab', { name: de['nav.boat'] }));
    expect(screen.getByRole('tab', { name: de['nav.boat'] })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('heading', { name: de['settings.section.boatSafety'] }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: de['settings.section.propulsion'] }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: de['settings.section.liveAis'] }),
    ).toBeInTheDocument();
    // #299 correction (coordinator, after PR #486 review): safety depth
    // DOES also appear here now — its canonical home, per issue #299's own
    // design question 2 — alongside the inline PlannerPanel quick-access
    // copy (single-sourced; see the dedicated single-source-of-truth test
    // below).
    expect(screen.getByLabelText(de['options.safetyDepth.label'])).toBeInTheDocument();
  });

  // #299: the safety-depth field's discoverable route to the Boat tab.
  it('the safety-depth boat-settings link switches to the Boat tab (#299)', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // Plain string, not `new RegExp(dictString)`: the DE copy now contains
    // literal `(`/`)`/`.` (regex metacharacters), and wrapping an unescaped
    // dict string in `new RegExp()` is fragile in general, not just for this
    // string — measured while writing this fix, `new RegExp('X(a. b)').test`
    // against its OWN source can return `false` (a `.` wildcard inside a
    // capture group after a non-empty prefix). A plain string arg to
    // `getByRole`'s `name` does an exact accessible-name match with no
    // regex parsing at all, sidestepping the whole class.
    fireEvent.click(screen.getByRole('button', { name: de['planner.safetyDepth.boatLink'] }));
    expect(screen.getByRole('tab', { name: de['nav.boat'] })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('heading', { name: de['settings.section.boatSafety'] }),
    ).toBeInTheDocument();
  });

  // #299 (coordinator correction after PR #486 review): safety depth now
  // renders on BOTH surfaces — PlannerPanel's inline compact-row field and
  // SettingsPanel's Boat-tab "Boat & safety" Card — sharing ONE
  // `settings.safetyDepthM` value (App.tsx's own `useSettings()`), never two
  // copies. Pins the single-source-of-truth property directly: an edit made
  // on ONE surface must be visible on the OTHER the next time it mounts, in
  // BOTH directions.
  it('safety depth is single-sourced between the Plan-tab inline field and the Boat-tab SettingsPanel field, in both directions (#299)', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // Plan tab is the default — edit the inline field there.
    const inlineInput = screen.getByLabelText(de['options.safetyDepth.label']);
    fireEvent.change(inlineInput, { target: { value: '5.5' } });
    fireEvent.blur(inlineInput);
    expect(inlineInput).toHaveValue(5.5);

    // Switch to the Boat tab — its OWN safety-depth field must already show
    // the value just committed on the Plan tab.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.boat'] }));
    const boatInput = screen.getByLabelText(de['options.safetyDepth.label']);
    expect(boatInput).toHaveValue(5.5);

    // Edit it from the Boat tab this time.
    fireEvent.change(boatInput, { target: { value: '4.0' } });
    fireEvent.blur(boatInput);
    expect(boatInput).toHaveValue(4);

    // Back to the Plan tab — the inline field must reflect the Boat-tab edit.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    expect(screen.getByLabelText(de['options.safetyDepth.label'])).toHaveValue(4);
  });

  // #551 item 3: DepthProfile must render against the PLAN's OWN safety
  // depth (plan.request.settings.safetyDepthM), mirroring LiveView.tsx's
  // existing `plan.request.settings.safetyDepthM` pattern — never the
  // live/current settings, which the test above just proved is a SEPARATE,
  // freely-editable value that can diverge from what a saved plan was
  // actually solved under. Loads a plan whose stored safety depth (5.5)
  // differs from the live default (DEFAULT_SETTINGS.safetyDepthM, 3.0,
  // never touched by this test) and confirms the prop DepthProfile receives
  // is the plan's, not the live one. DepthProfile is mocked to a prop probe
  // (module-level vi.mock above) — its own real rendering (mask loading,
  // SVG chart) is exercised elsewhere and is not what this bug is about.
  it("DepthProfile receives the loaded plan's own safety depth, not the live Boat-tab setting (#551)", async () => {
    const plan: Plan = {
      id: 'depth-profile-plan',
      name: 'Depth Profile Plan',
      createdAtMs: Date.now(),
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: ORIGIN_A,
        destination: DEST_A,
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now(),
        settings: { ...DEFAULT_SETTINGS, safetyDepthM: 5.5 },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: Date.now(), hours: 24 }),
      result: okPlanResult(33),
    };
    await db.savePlan(plan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(plan.name) }));

    await waitFor(() => expect(depthProfileProps.last).not.toBeNull());
    expect(depthProfileProps.last?.safetyDepthM).toBe(5.5);
  });

  // #551 review MAJOR 1: `migratePlan.ts` never validates `request.settings`
  // at all (grep confirms zero occurrences of the string 'settings' in that
  // file), so a stored record with no `request.settings` migrates non-null.
  // A bare `plan.request.settings.safetyDepthM` at the item-3 fix's call
  // site would throw `TypeError: Cannot read properties of undefined` on
  // exactly this shape — and with no error boundary anywhere in app/src,
  // that unmounts the whole React root, not just the depth profile. This
  // record is reachable via a future importer (#3) or foreign writer, the
  // same latent class #551's other two items are about.
  it('does not crash on a plan whose stored request has no settings at all, and falls back to DEFAULT_SETTINGS (#551 MAJOR 1)', async () => {
    const noSettingsPlan: Record<string, unknown> = {
      id: 'no-settings-plan',
      name: 'No Settings Plan',
      createdAtMs: Date.now(),
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: ORIGIN_A,
        destination: DEST_A,
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now(),
        // settings DELIBERATELY ABSENT.
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: Date.now(), hours: 24 }),
      result: okPlanResult(33),
    };
    await db.savePlan(noSettingsPlan as unknown as Plan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(noSettingsPlan.name as string) }),
    );

    await waitFor(() => expect(depthProfileProps.last).not.toBeNull());
    // The DEFAULT_SETTINGS fallback, not a thrown error.
    expect(depthProfileProps.last?.safetyDepthM).toBe(DEFAULT_SETTINGS.safetyDepthM);
    // The tell for "blanked the whole app": the shell heading is still
    // mounted, not just the depth profile probe.
    expect(screen.getByRole('heading', { name: 'SailCommand' })).toBeInTheDocument();
  });

  // #551 review round 3, Minor 5: an object SPREAD (`{ ...DEFAULT_SETTINGS,
  // ...plan.request.settings }`, the fix this test's sibling above measured
  // as correct for every OTHER degenerate shape) does not default an
  // EXPLICITLY-present `safetyDepthM: undefined` — object spread copies an
  // own key whose value is `undefined` and overwrites the default with it,
  // `??` semantics do not apply. Structured clone preserves `undefined`
  // object values into IndexedDB, so this shape is genuinely storable.
  it('falls back to DEFAULT_SETTINGS when the stored settings object explicitly carries safetyDepthM: undefined (#551 review round 3 Minor 5)', async () => {
    const undefinedDepthPlan: Record<string, unknown> = {
      id: 'undefined-depth-plan',
      name: 'Undefined Depth Plan',
      createdAtMs: Date.now(),
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: ORIGIN_A,
        destination: DEST_A,
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now(),
        settings: { ...DEFAULT_SETTINGS, safetyDepthM: undefined },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: Date.now(), hours: 24 }),
      result: okPlanResult(33),
    };
    await db.savePlan(undefinedDepthPlan as unknown as Plan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: new RegExp(undefinedDepthPlan.name as string),
      }),
    );

    await waitFor(() => expect(depthProfileProps.last).not.toBeNull());
    expect(depthProfileProps.last?.safetyDepthM).toBe(DEFAULT_SETTINGS.safetyDepthM);
  });

  // #551 review round 3 follow-up: `typeof x === 'number'` (the prior
  // guard) is ALSO true for `Infinity` — the damaging degenerate value,
  // since `DepthProfile` shades every sample whose depth is LESS than the
  // safety depth (`s.depthM < Infinity` is always true) while ALSO omitting
  // the safety line that would explain why (`Infinity <= axisMax` is
  // false) — a whole-route false alarm with no referent. This is the one
  // failure mode a real user would actually see, which is why it gets its
  // own dedicated test rather than folding into the undefined case above.
  it('falls back to DEFAULT_SETTINGS when the stored settings object carries safetyDepthM: Infinity (#551 review round 3 follow-up)', async () => {
    const infiniteDepthPlan: Record<string, unknown> = {
      id: 'infinite-depth-plan',
      name: 'Infinite Depth Plan',
      createdAtMs: Date.now(),
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: ORIGIN_A,
        destination: DEST_A,
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now(),
        settings: { ...DEFAULT_SETTINGS, safetyDepthM: Infinity },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: Date.now(), hours: 24 }),
      result: okPlanResult(33),
    };
    await db.savePlan(infiniteDepthPlan as unknown as Plan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: new RegExp(infiniteDepthPlan.name as string),
      }),
    );

    await waitFor(() => expect(depthProfileProps.last).not.toBeNull());
    expect(depthProfileProps.last?.safetyDepthM).toBe(DEFAULT_SETTINGS.safetyDepthM);
  });

  // #299 fix (PR #486 review, Major 1): the boat-settings link lives inside
  // PlannerPanel, which UNMOUNTS the instant the tab switches away from
  // 'plan' — without an explicit focus move, activating it drops keyboard
  // focus to document.body (measured in review). Pins that focus lands on
  // the Boat tab's first Card heading instead, mirroring "Details ansehen"'s
  // routeResultHeadingRef precedent exactly.
  it('the safety-depth boat-settings link moves focus to the Boat tab heading, not document.body (#299 fix, PR #486 Major 1)', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // Plain string — see the sibling test above for why `new RegExp` on this
    // dict string is unsafe.
    const link = screen.getByRole('button', {
      name: de['planner.safetyDepth.boatLink'],
    });
    link.focus();
    expect(document.activeElement).toBe(link);

    fireEvent.click(link);

    const heading = screen.getByRole('heading', { name: de['settings.section.boatSafety'] });
    expect(document.activeElement).toBe(heading);
    expect(document.activeElement?.tagName).not.toBe('BODY');
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

  // #696 (remaining scope after PR #759): four of the five app-shell
  // siblings that must go inert while AboutDialog is open are ALWAYS
  // mounted, regardless of layout width — the fifth, PanelResizer, only
  // mounts on the wide layout (isWide is false by default in jsdom, since
  // window.matchMedia is not globally stubbed — see useWideLayout.ts's own
  // comment). `PanelResizer.test.tsx` pins the COMPONENT's own forwarding
  // of `inert` to its rendered separator div; that says nothing about
  // whether App.tsx's call site ever PASSES the prop — the next test below
  // stubs `window.matchMedia` to mount PanelResizer here and covers exactly
  // that call site (PR #777 review, Major 1).
  // Asserted across an open -> close TRANSITION on the SAME rendered
  // elements, not two fresh mounts — a fresh-mount-only check would pass
  // even against a `useState`-seeded-once bug (the exact #763 shape this
  // repo has already shipped once for a sibling seeding hazard).
  it('#696: app-shell siblings are inert while About is open, and un-inert on close', async () => {
    const { container } = renderApp();
    const siblingSelectors = ['.map-area', '.app-header', '.banner-area', '.app-bottom-sheet'];

    const siblings = siblingSelectors.map((selector) => {
      const el = container.querySelector(selector);
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    for (const el of siblings) {
      expect(el).not.toHaveAttribute('inert');
    }

    fireEvent.click(await screen.findByRole('button', { name: de['about.open'] }));
    await screen.findByRole('dialog');
    for (const el of siblings) {
      expect(el).toHaveAttribute('inert');
    }

    fireEvent.click(screen.getByRole('button', { name: de['about.close'] }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    for (const el of siblings) {
      expect(el).not.toHaveAttribute('inert');
    }
  });

  it('#696: PanelResizer carries inert on the wide layout, and drops it on close', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      renderApp();
      const sep = await screen.findByRole('separator');
      expect(sep).not.toHaveAttribute('inert');
      fireEvent.click(await screen.findByRole('button', { name: de['about.open'] }));
      await screen.findByRole('dialog');
      expect(sep).toHaveAttribute('inert');
      fireEvent.click(screen.getByRole('button', { name: de['about.close'] }));
      expect(sep).not.toHaveAttribute('inert');
    } finally {
      // @ts-expect-error -- restore the untouched jsdom default
      delete window.matchMedia;
    }
  });

  it('#427: About button carries its accessible name via aria-label, not the (now-removed) glyph', async () => {
    renderApp();
    const aboutButton = await screen.findByRole('button', { name: de['about.open'] });

    // The old U+24D8 CIRCLED LATIN SMALL LETTER I glyph rendered as tofu on
    // some platforms (#427) and is replaced by a decorative inline SVG — it
    // must be gone from the button's content, and the accessible name above
    // must still resolve (this assertion is the mutation check: dropping
    // aria-label would make the button unnamed and findByRole would throw
    // instead of finding it — verified by temporarily removing aria-label
    // from App.tsx and re-running this test, which reds with "Unable to
    // find role=button and name ...", then restoring it).
    expect(aboutButton.textContent).not.toContain('ⓘ');
    expect(aboutButton.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
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

// #571 redesign (maintainer ruling: a via edit "is kind of a new route and
// hence should only calculate once clicked on calculate" — no auto-replan on
// add/remove/reorder). Replaces the pre-redesign "via-replan clobber guard
// (Phase E gate fix)" describe block, which drove the OLD auto-replan-on-
// edit behavior end to end — that behavior no longer exists (a via edit
// never dispatches a routing call at all), so its exact scenario (a pending
// replan racing a plan switch) is moot. The first test below is this
// redesign's own core regression test (brief requirement: assert the
// routing client was NOT called); the second preserves the ORIGINAL test's
// spirit — editing vias on one plan must not corrupt a later-loaded
// different plan — under the new trigger (draftViaPoints resetting on
// plan.id change), which is what now provides that guarantee.
describe('via edits are draft-only and never auto-replan (#571 redesign)', () => {
  it('adding then removing a via point dispatches NO routing call — only the Plan-route button does', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    pickOriginAndDestination();
    const planButton = screen.getByRole('button', { name: de['planner.plan'] });
    fireEvent.click(planButton);

    // The initial run() — the only routing call this test expects, ever.
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() => expect(planButton).toBeEnabled()); // back to idle — the plan is now active
    await flushPlanFormSync(); // #631 — see the helper; the via add below is a sync-effect-written field
    const callsAfterInitialPlan = routingMock.calls.length;

    // Add a via — it appears in the panel list immediately (plain draft
    // state), with no worker call.
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(VIA_A.lat, VIA_A.lon);
    expect(within(viaSection).getAllByRole('listitem')).toHaveLength(1);
    expect(routingMock.calls.length).toBe(callsAfterInitialPlan);

    // Remove it again — likewise no worker call.
    fireEvent.click(
      within(viaSection).getByRole('button', {
        name: de['planner.via.remove'].replace('{index}', '1'),
      }),
    );
    expect(within(viaSection).queryAllByRole('listitem')).toHaveLength(0);

    // Give any (buggy) dispatch every chance to land before asserting it
    // didn't — the actual behaviour change #571 exists for.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(routingMock.calls.length).toBe(callsAfterInitialPlan);
  });

  // App.tsx's `viaDraftStale` — the MAP-side counterpart of the panel's own
  // Chip/live-region fold (both driven by `formDirty`, which now includes
  // the via list too). ViaMarkers.tsx's own header notes it is otherwise
  // jsdom-untestable (no real MapLibre/WebGL runtime) — but the CHIP itself
  // is a plain React return value, not an imperative Marker, so it renders
  // through the shared fake map exactly like any other component here and
  // is directly assertable. Queried by class rather than role="status",
  // since the panel's own persistent live region also carries that role.
  it('the map-side staleness chip (ViaMarkers) appears once a via edit diverges from the committed plan, and disappears once it matches again', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    pickOriginAndDestination();
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeEnabled(),
    );
    await flushPlanFormSync(); // #631 — see the helper; the via add below is a sync-effect-written field

    // No pending edit yet — the map-side chip is absent.
    expect(document.querySelector('.via-markers-spinner-chip')).toBeNull();

    // Add a via — draftViaPoints now diverges from plan.request.viaPoints.
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(VIA_A.lat, VIA_A.lon);

    const chip = document.querySelector('.via-markers-spinner-chip');
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent(de['planner.result.stale']);

    // Review fix (Minor): the chip must NOT duplicate PlannerPanel's own
    // sr-only live-region announcement of the same sentence — measured in a
    // real browser BEFORE this fix, both `role="status"` elements fired at
    // once. Assert by ROLE, not just by class: a second `role="status"`
    // element carrying the same text is exactly what caused the duplicate
    // announcement.
    expect(chip).not.toHaveAttribute('role', 'status');
    const staleStatusRegions = screen
      .getAllByRole('status')
      .filter((el) => el.textContent?.includes(de['planner.result.stale']));
    expect(staleStatusRegions).toHaveLength(1);

    // Remove it again — the draft matches the committed list once more, so
    // the chip goes away.
    fireEvent.click(
      within(viaSection).getByRole('button', {
        name: de['planner.via.remove'].replace('{index}', '1'),
      }),
    );
    expect(document.querySelector('.via-markers-spinner-chip')).toBeNull();
  });

  // Review follow-up (Minor 2, four-combination check): the single-
  // announcement guarantee above must ALSO hold when a via edit combines
  // with a SEPARATE dirty input (departure) — formDirty goes true for two
  // independent reasons at once, but the panel still owns exactly one
  // role="status" announcement of the stale copy; the map chip stays a
  // silent visual disclosure regardless of what else is dirty. The other
  // two combinations (via CLEAN, other dirty/clean) never reach the chip at
  // all — it renders only when viaDraftStale is true — so they carry no
  // duplication risk by construction and are covered by the plan-run/
  // settings-dirty banner tests elsewhere in this file.
  it('a via edit combined with a separately-dirty input still surfaces exactly one stale announcement', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    pickOriginAndDestination();
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeEnabled(),
    );
    await flushPlanFormSync(); // #631 — this is the site the flake was observed on

    // Dirty the departure first — a non-via reason formDirty goes true.
    const departureInput = screen.getByLabelText(de['planner.departure.label']) as HTMLInputElement;
    const editedMs = Date.now() + 5 * 3_600_000;
    fireEvent.change(departureInput, { target: { value: toLocalInputValue(editedMs) } });
    expect(departureInput.value).toBe(toLocalInputValue(editedMs));

    // Now ALSO add a via — draftViaPoints diverges too, so both terms of
    // formDirty are true simultaneously.
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(VIA_A.lat, VIA_A.lon);

    const chip = document.querySelector('.via-markers-spinner-chip');
    expect(chip).not.toBeNull();
    expect(chip).not.toHaveAttribute('role', 'status');
    const staleStatusRegions = screen
      .getAllByRole('status')
      .filter((el) => el.textContent?.includes(de['planner.result.stale']));
    expect(staleStatusRegions).toHaveLength(1);
  });

  // BLOCKER 1 / MAJOR 3 (review): map markers must track the DRAFT via list,
  // not the committed one — an add/remove must show/hide a marker
  // immediately, and dragging the SAME marker a SECOND time must still
  // apply (the reference-equality `indexOf` lookup the old wiring used
  // silently discarded every drag after the first, since the dragged
  // element had already been replaced by a new object). Uses
  // mapTestHooks.viaMarkers (FakeMarker, above) to observe the real
  // construct/drag/remove sequence RouteLayer -> ViaMarkers drives.
  it('map markers track the draft: an add/remove shows/hides a marker, and a SECOND drag of the same marker still applies', async () => {
    const plan: Plan = {
      id: 'plan-with-via',
      name: 'Flensburg -> Marstal',
      createdAtMs: Date.now() - 60_000,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: ORIGIN_A,
        destination: DEST_A,
        viaPoints: [VIA_A],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now() + 3_600_000,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: Date.now() - 3_600_000, hours: 48 }),
      result: okPlanResult(50),
    };
    await db.savePlan(plan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(plan.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(50, 'de'))).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));

    const alive = () => mapTestHooks.viaMarkers.filter((m) => m.draggable && !m.removed);

    // The plan's own committed via already shows one marker.
    await waitFor(() => expect(alive()).toHaveLength(1));

    // Add a second via — a draft-only edit — and the marker count follows
    // immediately, with NO Plan-route press.
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(54.83, 9.95);
    await waitFor(() => expect(alive()).toHaveLength(2));

    // Remove the ORIGINAL via — the marker count follows back down.
    fireEvent.click(
      within(viaSection).getByRole('button', {
        name: de['planner.via.remove'].replace('{index}', '1'),
      }),
    );
    await waitFor(() => expect(alive()).toHaveLength(1));

    // Drag the ONE remaining marker twice in a row.
    await act(async () => {
      alive()[0].dragTo(54.9, 10.0);
    });
    let viaSectionRow = within(viaSection).getAllByRole('listitem')[0];
    expect(viaSectionRow).toHaveTextContent(formatLatLon({ lat: 54.9, lon: 10.0 }));

    await act(async () => {
      alive()[0].dragTo(54.95, 10.05);
    });
    viaSectionRow = within(viaSection).getAllByRole('listitem')[0];
    // The row this test exists to pin: under the pre-fix reference-equality
    // lookup, this second drag was silently discarded and the panel stayed
    // at the FIRST dragged position.
    expect(viaSectionRow).toHaveTextContent(formatLatLon({ lat: 54.95, lon: 10.05 }));
  });

  it('switching to a different plan while a via edit is pending discards the pending edit — the newly active plan shows its OWN committed via list', async () => {
    const planB: Plan = {
      id: 'plan-b-preseeded',
      name: 'Preseeded Plan B',
      createdAtMs: Date.now() - 60_000,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: { lat: 54.95, lon: 10.6 },
        destination: { lat: 55.05, lon: 10.9 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now() + 3_600_000,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: Date.now() - 3_600_000, hours: 48 }),
      result: okPlanResult(77),
    };
    await db.savePlan(planB);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    pickOriginAndDestination();
    const planButton = screen.getByRole('button', { name: de['planner.plan'] });
    fireEvent.click(planButton);
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() => expect(planButton).toBeEnabled());
    await flushPlanFormSync(); // #631 — see the helper; the via add below is a sync-effect-written field

    // Add a via to the now-active plan — a pending, UNAPPLIED draft edit
    // (never persisted, never routed — see draftViaPoints's own comment).
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(VIA_A.lat, VIA_A.lon);
    expect(within(viaSection).getAllByRole('listitem')).toHaveLength(1);
    expect(routingMock.calls.length).toBe(1); // still just the initial run()

    // Switch to Plan B (its own committed via list is empty). PlansList
    // populates asynchronously (its own mount effect awaits listPlans()),
    // hence findByRole rather than a synchronous getByRole.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(planB.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(77, 'de'))).toBeInTheDocument()); // Plan B now active

    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    const viaSectionB = screen.getByRole('region', { name: de['planner.via.label'] });
    // The pending via added to the FIRST plan is gone — Plan B shows its
    // own (empty) committed via list, never the abandoned draft.
    await waitFor(() => expect(within(viaSectionB).queryAllByRole('listitem')).toHaveLength(0));
  });

  // MAJOR 4 (review): every via edit on an EXISTING plan now reaches run()
  // (there is no more replan-side disclosure to lean on — see
  // droppedViaCount's own comment above handlePlan), so a too-close waypoint
  // dropped there must still surface a banner, exactly like it did on the
  // pre-#571 replan path. Without the App.tsx pre-check this reds: run()'s
  // own internal dedupe silently drops the via with zero banner.
  it('a too-close waypoint dropped by the Plan-route press surfaces a banner (MAJOR 4)', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    pickOriginAndDestination();
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeEnabled(),
    );
    await flushPlanFormSync(); // #631 — see the helper; the via add below is a sync-effect-written field

    // Add a via ~15 m from ORIGIN_A — inside the 60 m dedupe threshold.
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(ORIGIN_A.lat + 0.0001, ORIGIN_A.lon + 0.0001);
    expect(within(viaSection).getAllByRole('listitem')).toHaveLength(1);

    // Press Plan route — run() will dedupe this via away internally.
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    expect(await screen.findByText(de['banner.viaTooClose'])).toBeInTheDocument();

    await waitFor(() => expect(routingMock.calls.length).toBe(2));
    routingMock.calls[1].resolve(okPlanResult(10));

    fireEvent.click(screen.getByRole('button', { name: de['banner.dismiss'] }));
    expect(screen.queryByText(de['banner.viaTooClose'])).not.toBeInTheDocument();
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
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: { lat: 54.95, lon: 10.6 },
        destination: { lat: 55.05, lon: 10.9 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now() + 3_600_000,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
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
    await waitFor(() => expect(screen.getByText(formatNm(88, 'de'))).toBeInTheDocument());

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
    expect(screen.queryByText(formatNm(88, 'de'))).not.toBeInTheDocument();

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

  // #299: a solver-affecting settings change (routing-relevant per
  // lib/planForm.ts's ROUTING_RELEVANT_SETTINGS_KEYS) marks the displayed
  // plan stale on this App-level, tab-independent banner surface too — not
  // only via PlannerPanel's own Chip, which mounts ONLY on the Plan tab. The
  // risk this pins: before #299, a settings change made from a tab other
  // than Plan (now including the new Boat tab) left NO on-screen indication
  // that the displayed route no longer matched the form.
  it('a solver-affecting Boat-tab settings change surfaces a tab-independent stale-route banner, visible on the Routes tab (#299)', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    pickOriginAndDestination();

    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeEnabled(),
    );

    // No banner yet — the form still matches the displayed plan.
    expect(screen.queryByText(de['planner.result.stale'])).not.toBeInTheDocument();

    // Edit a ROUTING-RELEVANT setting (motorEnabled) from the new Boat tab.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.boat'] }));
    fireEvent.click(screen.getByLabelText(de['options.motorEnabled.label']));

    // Visible immediately while still on the Boat tab...
    expect(await screen.findByText(de['planner.result.stale'])).toBeInTheDocument();
    // ...and still visible after switching to Routes — the exact surface the
    // #299 risk named as silently uninformed before this fix.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    expect(screen.getByText(de['planner.result.stale'])).toBeInTheDocument();
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
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: ORIGIN_A,
        destination: DEST_A,
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now(),
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
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
    // #748: interpolated against the ACTUAL computed gap (staleForecastGapHours
    // on this fixture's own plan, not a hardcoded "20") — a raw literal match
    // against de['route.staleForecast'] would break the moment that value
    // carries an unreplaced {hours} placeholder.
    // Minor 3 (review): the line above alone derives its expected string
    // from the SAME helper under test, so it cannot catch a wrong helper —
    // mutating staleForecastGapHours to a wrong constant would move both
    // sides together. This fixture's gap is deterministic (fetchedAtMs is
    // the grid's t0Ms and departureMs is a later Date.now(), the two set
    // sub-ms apart, so the gap is 20 h + a negligible delta — 30 minutes
    // from the nearest Math.round boundary at 20.5 h), so pin it as an
    // independent literal too.
    const stalePlanGapHours = staleForecastGapHours(stalePlan);
    expect(stalePlanGapHours).toBe(20);
    const bannerArea = document.querySelector('.banner-area');
    if (!bannerArea) throw new Error('expected .banner-area to be present');
    expect(
      await within(bannerArea as HTMLElement).findByText(
        de['route.staleForecast'].replace('{hours}', String(stalePlanGapHours)),
      ),
    ).toBeInTheDocument();
  });

  // #571 redesign REMOVED two tests that used to live here ('a viaReplan
  // error banner renders...', 'a droppedCount === 1 banner...'): both drove
  // the OLD auto-replan-on-via-edit path (`viaReplan.state.error`/
  // `droppedCount`), which no longer exists — a via edit never dispatches a
  // routing call, so neither banner can fire from an edit any more. The
  // no-route-banner case is redundant with the plain plan-run-error tests
  // elsewhere in this file (states & motion, below); the singular
  // droppedCount===1 case is superseded by the MAJOR 4 test above (via
  // edits are draft-only...), which covers it through the new mechanism.
  // The THIRD old test ('droppedCount > 1 shows the pluralized...') is kept
  // — PORTED to the new mechanism just below, not dropped, since nothing
  // else in this file exercises the plural banner copy. See 'via edits are
  // draft-only and never auto-replan (#571 redesign)' above for this
  // redesign's own regression coverage, and state/replan.test.ts for
  // replanWithVias'/useViaReplan's own still-valid unit coverage (kept,
  // UI-orphaned — see that file's and state/replan.ts's own comments).
  it('TWO too-close waypoints dropped by the Plan-route press surface the pluralized banner copy (MAJOR 4)', async () => {
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
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: ORIGIN_A,
        destination: DEST_A,
        viaPoints: [nearOrigin1, nearOrigin2],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: Date.now() + 3_600_000,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: Date.now() - 3_600_000, hours: 48 }),
      result: okPlanResult(66),
    };
    await db.savePlan(preseeded);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(preseeded.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(66, 'de'))).toBeInTheDocument());

    // #571 redesign: loading the plan seeds the DRAFT with its own two
    // too-close committed vias (no reorder needed to "re-trigger" a replan
    // the way the pre-redesign test did — every Plan-route press reaches
    // run()'s dedupe now, not just an edit-triggered one).
    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    await waitFor(() => expect(within(viaSection).getAllByRole('listitem')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    expect(
      await screen.findByText(de['banner.viaTooClose.plural'].replace('{count}', '2')),
    ).toBeInTheDocument();
    expect(screen.queryByText(de['banner.viaTooClose'])).not.toBeInTheDocument();

    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(66));
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

// #682: DataLayers.tsx split the single `sc-seamarks` layer into a routine
// layer and a `sc-seamarks-hazard` overlay (cardinal/isolated-danger marks,
// stacked above so they paint over routine marks at z>=12 — see
// seamarkGeoJson.ts's SEAMARKS_LAYOUT doc comment for the full mechanism).
// Both layers register DataLayers' own click handler (it opens the seamark
// popover), but MapView.tsx's generic tap handler ALSO owns any click that
// does NOT land on a layer named in App.tsx's `INTERACTIVE_MAP_LAYER_IDS` —
// so a hazard mark living ONLY on the new layer would, if that array forgot
// it, be hit by BOTH: the popover opens AND the SAME native click silently
// sets that tap point as origin/destination (MapView.tsx's own `handleClick`
// comment describes this exact race). Nothing anywhere pinned that array
// before this test — a repo-wide grep for INTERACTIVE_MAP_LAYER_IDS /
// interactiveLayerIds across app/src/**/*.test.ts(x) and app/e2e found zero
// hits.
//
// Deliberately a structural pin, not a full behavioural simulation of the
// tap race: it asserts the PROPERTY ("every seamark layer id DataLayers
// exports is in the gate array"), derived by REFLECTING over DataLayers'
// own module exports rather than hardcoding the two current layer id
// strings a second time here — so a THIRD `SEAMARKS_*_LAYER` export added
// later (following the naming convention `SEAMARKS_LAYER`/
// `SEAMARKS_HAZARD_LAYER` already set) is covered automatically, with no
// edit to this test, exactly the "fails closed" property a two-element
// hardcoded list would not have.
describe('#682 tap-safety: every seamark layer must gate the raw tap-pick', () => {
  it('INTERACTIVE_MAP_LAYER_IDS lists every SEAMARKS*_LAYER id DataLayers exports', () => {
    const seamarkLayerIds = Object.entries(DataLayersModule)
      .filter(([name, value]) => typeof value === 'string' && /^SEAMARKS.*LAYER$/.test(name))
      .map(([, value]) => value as string);
    // Non-vacuity: a renamed export or a broken reflection must not pass
    // trivially by iterating zero times (CLAUDE.md's "ask of every guard
    // what it does when the problem is fixed / stubbed to []" lesson).
    expect(seamarkLayerIds.length).toBeGreaterThanOrEqual(2);
    for (const id of seamarkLayerIds) {
      expect(INTERACTIVE_MAP_LAYER_IDS).toContain(id);
    }
  });
});

describe('#707: structural semantics', () => {
  it('exposes exactly one <main> landmark wrapping the tab-specific panel content', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    // Before #707 the app had zero `<main>`/role="main" elements at all —
    // getByRole('main') throws "Unable to find an accessible element" on the
    // pre-fix tree, so this fails RED with no <main> present. The class
    // assertion pins WHICH div became the landmark (.app-panel, the
    // tab-specific content), not just that some <main> exists somewhere.
    const main = screen.getByRole('main');
    expect(main).toHaveClass('app-panel');
    // Exactly one landmark: getByRole throws on >1 match too, so a second
    // <main> (e.g. wrapping .map-area as well) would also fail this line.
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });
});

describe('toPlannerStatus (#53: relaxed-depth probe phase mapping)', () => {
  // The adapter only uses `t` on the error branch (t(messageKey)); an identity
  // stub is enough to pin the passthrough there.
  const t = ((key: string) => key) as unknown as Parameters<typeof toPlannerStatus>[1];

  it("maps usePlanFlow's 'probing-depth' to the panel's { phase: 'probing' }", () => {
    expect(toPlannerStatus({ phase: 'probing-depth' }, t)).toEqual({ phase: 'probing' });
  });

  // Guard the sibling branches too, so the probing mapping isn't a lone case a
  // typo could silently collapse into another phase.
  it('maps the sibling planning phases to their own panel phases', () => {
    expect(toPlannerStatus({ phase: 'idle' }, t)).toEqual({ phase: 'idle' });
    expect(toPlannerStatus({ phase: 'fetching-wind' }, t)).toEqual({ phase: 'fetching' });
    expect(toPlannerStatus({ phase: 'error', messageKey: 'error.internal' }, t)).toEqual({
      phase: 'error',
      message: 'error.internal',
    });
  });

  // #340/#54: `sailId`/`index`/`total` must pass through unchanged — this is
  // the only progress signal left, so a typo here would silently break the
  // "sail N of 2" phase readout for one or both sails.
  it("passes 'routing' through with its sailId/index/total unchanged (#340: not a percentage)", () => {
    expect(toPlannerStatus({ phase: 'routing', sailId: 'genoa', index: 1, total: 2 }, t)).toEqual({
      phase: 'routing',
      sailId: 'genoa',
      index: 1,
      total: 2,
    });
    expect(toPlannerStatus({ phase: 'routing', sailId: 'fock', index: 2, total: 2 }, t)).toEqual({
      phase: 'routing',
      sailId: 'fock',
      index: 2,
      total: 2,
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

  // #433: the eight causes that used to collapse onto error.internal all
  // still classify as 'unexpected' (assertive paint) for banner PRESENTATION
  // purposes — a separate question from whether "Try again" can help
  // (planErrorRetryMayHelp, tested below). Literal list, not derived from
  // ROUTING_FAILURE_MESSAGE_KEY, per this file's own mutation-check note.
  it('classifies every new #433 routing-failure key as an unexpected failure too', () => {
    for (const key of [
      'error.workerInit',
      'error.routingTimeout',
      'error.routingFailed',
      'error.routingCrashed',
      'error.routingMessageError',
      'error.routingInterrupted',
      'error.planSaveFailed',
      'error.windUnknown',
    ] as const) {
      expect(planErrorGroup(key)).toBe('unexpected');
      expect(planErrorBannerKind(key)).toBe('error');
    }
  });
});

// #433: separate from planErrorGroup/planErrorBannerKind above — whether a
// "Try again" retry can plausibly change the outcome. Literals pinned by
// hand (mutation-check, #50) — NOT read back from RETRY_MAY_HELP_KEYS under
// test, so a mutation dropping/adding a key from that set is actually
// caught rather than trivially agreeing with itself.
describe('planErrorRetryMayHelp (#433: per-cause retry eligibility)', () => {
  it('retry helps: the three pre-existing network causes, unchanged, plus every #433 cause a fresh worker or a re-fetch can fix', () => {
    for (const key of [
      'error.offline',
      'error.rateLimited',
      'error.windService',
      'error.windUnknown',
      'error.routingCrashed',
      'error.routingMessageError',
      'error.routingInterrupted',
      'error.planSaveFailed',
    ] as const) {
      expect(planErrorRetryMayHelp(key), `expected retry to help for ${key}`).toBe(true);
    }
  });

  it('retry does NOT help: no-route copy already states the next step, and the input-deterministic / reload-only #433 causes reproduce the identical failure', () => {
    for (const key of [
      'error.internal',
      'error.workerInit',
      'error.routingTimeout',
      'error.routingFailed',
      'error.noRoute.unreachable',
      'error.noRoute.beyondHorizon',
      'error.noRoute.calmMotorOff',
      'error.noRoute.snapOrigin',
      'error.noRoute.snapDestination',
      'error.noRoute.snapVia',
    ] as const) {
      expect(planErrorRetryMayHelp(key), `expected retry NOT to help for ${key}`).toBe(false);
    }
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

// #113: full-wiring session restore through the real AppShell — the focused
// snapshot/restore matrix lives in useSessionRestore.test.tsx and
// sessionSnapshot.test.ts; these two pin the app-level ACs a harness can't:
// the real tab strip activating from the snapshot with zero wind fetch, and
// LiveView mounting GPS-silent on a live-tab restore.
describe('session restore (#113)', () => {
  // A leg-bearing plan: LiveView's watch effect is gated on `active &&
  // legs.length > 0`, so the GPS-safety test below must present the one state
  // where a mount COULD subscribe — an empty-legs fixture would pass vacuously.
  function savedPlan(id: string): Plan {
    const now = Date.now();
    const sailLeg: Leg = {
      kind: 'sail',
      board: 'starboard',
      twaDeg: 50,
      maneuverAtStart: null,
      start: ORIGIN_A,
      end: DEST_A,
      startTimeMs: now + 3_600_000,
      endTimeMs: now + 2 * 3_600_000,
      headingDeg: 90,
      twsKn: 10,
      speedKn: 6,
      distanceNm: 20,
    };
    const result = okPlanResult(55);
    const genoa = result.sails.find((s) => s.sailId === 'genoa')?.result;
    if (!genoa) throw new Error('fixture invariant: okPlanResult carries a genoa result');
    return {
      id,
      name: 'Restored Passage',
      createdAtMs: now - 60_000,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: ORIGIN_A,
        destination: DEST_A,
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: now + 3_600_000,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: now - 3_600_000, hours: 48 }),
      result: {
        ...result,
        sails: result.sails.map((s) =>
          s.sailId === 'genoa' ? { ...s, result: { ...genoa, legs: [sailLeg] } } : s,
        ),
      },
    };
  }

  it('boot-restores the saved plan onto the saved tab from IndexedDB alone — no wind fetch', async () => {
    vi.mocked(fetchWindGrid).mockClear();
    await db.savePlan(savedPlan('restore-me'));
    localStorage.setItem(
      'sc-session',
      '{"v":1,"planId":"restore-me","tab":"routes","rig":"genoa"}',
    );

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // The Routes tab activates and the rig-comparison tablist appears without
    // ANY user interaction — the snapshot alone drove it.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: de['nav.routes'] })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(await screen.findByRole('tablist', { name: de['route.rigTabs'] })).toBeInTheDocument();
    // Pure local replay: the plan rendered from its STORED wind grid — the
    // (module-mocked) Open-Meteo entry point was never invoked. fetchMock()
    // (beforeEach) additionally rejects any non-asset URL loudly, so a
    // sneaked-in direct fetch could not pass either.
    expect(fetchWindGrid).not.toHaveBeenCalled();
  });

  // #299: 'boat' is a real, persistable Tab value (the write-back effect
  // saves it like any other), but a fresh boot must never restore INTO it —
  // a sailor reopening the PWA on deck should land on a content tab, not the
  // settings form. Unit-pinned at the parse boundary in
  // lib/sessionSnapshot.test.ts; this is the integration-level twin,
  // exercising the real restore path end to end.
  it("#299: a persisted 'boat' tab never restores into the Boat tab — lands on Plan instead", async () => {
    await db.savePlan(savedPlan('restore-boat'));
    localStorage.setItem(
      'sc-session',
      '{"v":1,"planId":"restore-boat","tab":"boat","rig":"genoa"}',
    );

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: de['nav.plan'] })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(screen.getByRole('tab', { name: de['nav.boat'] })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('restoring into the Live tab never starts a GPS watch — tracking stays opt-in', async () => {
    const geoWatch = vi.fn(() => 1);
    Object.defineProperty(window.navigator, 'geolocation', {
      value: { watchPosition: geoWatch, clearWatch: vi.fn() },
      configurable: true,
    });
    try {
      await db.savePlan(savedPlan('live-restore'));
      localStorage.setItem(
        'sc-session',
        '{"v":1,"planId":"live-restore","tab":"live","rig":"genoa"}',
      );

      renderApp();
      await waitFor(() =>
        expect(screen.getByRole('tab', { name: de['nav.live'] })).toHaveAttribute(
          'aria-selected',
          'true',
        ),
      );

      // LiveView is mounted with a leg-bearing plan — the one state where its
      // watch effect could subscribe — yet tracking is off and geolocation was
      // never touched: GPS starts only via the explicit toggle.
      expect(screen.getByRole('button', { name: de['live.toggle'] })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(geoWatch).not.toHaveBeenCalled();
    } finally {
      delete (window.navigator as { geolocation?: unknown }).geolocation;
    }
  });
});

// #301: prefills the Plan-view form from whatever plan just became active —
// one derivation keyed on plan.id (+ harborsLoaded), covering every setPlan
// caller (PlansList's Load here; session restore below) rather than patching
// call sites individually. FLENSBURG (defined near the top of this file) is
// the curated harbor these tests snap the plan's origin to, so a successful
// sync shows its NAME, not a raw lat/lon.
describe('plan-form sync (#301)', () => {
  const PREFILL_ORIGIN = FLENSBURG.snap;
  const PREFILL_DEST = { lat: 55.05, lon: 10.9 }; // no curated harbor there — stays a tap point

  function prefillPlan(id: string, overrides: Partial<PlanRequest> = {}): Plan {
    const now = Date.now();
    return {
      id,
      name: 'Prefill Plan',
      createdAtMs: now - 60_000,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: PREFILL_ORIGIN,
        destination: PREFILL_DEST,
        viaPoints: [],
        originHarborId: FLENSBURG.id,
        destinationHarborId: null,
        departureMs: now + 3_600_000,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
        ...overrides,
      },
      windGrid: uniformWindGrid(10, 250, { t0Ms: now - 3_600_000, hours: 48 }),
      result: okPlanResult(99),
    };
  }

  it('loading a plan from PlansList prefills the Plan-view form (origin/destination/departure)', async () => {
    const plan = prefillPlan('prefill-basic');
    await db.savePlan(plan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(plan.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(99, 'de'))).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
    await waitFor(() => expect(within(originSection).getByText('Flensburg')).toBeInTheDocument());

    const destSection = screen.getByRole('region', { name: de['planner.destination.label'] });
    expect(
      within(destSection).getByText(formatLatLon(PREFILL_DEST), { selector: 'p' }),
    ).toBeInTheDocument();

    const departureInput = screen.getByLabelText(de['planner.departure.label']) as HTMLInputElement;
    expect(departureInput.value).toBe(toLocalInputValue(plan.request.departureMs));
  });

  // #571 redesign: this used to trigger a via-replan (same plan id, new
  // plan object) to prove the plan-id-keyed sync effect doesn't re-fire and
  // clobber a manually-edited departure. That trigger no longer exists — a
  // via edit never calls setPlan any more, so there is no same-id-new-object
  // event to race in the first place (this test's own new assertion,
  // `routingMock.calls.length` staying at 0, is the direct proof of that).
  // Kept as a regression pin under the new mechanism: a future change that
  // wires via edits back through setPlan must not silently reintroduce the
  // clobber.
  it('adding a via point (a draft-only edit) does not clobber a departure the user edited after loading', async () => {
    const plan = prefillPlan('prefill-via-clobber', { originHarborId: null });
    await db.savePlan(plan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(plan.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(99, 'de'))).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    const departureInput = screen.getByLabelText(de['planner.departure.label']) as HTMLInputElement;
    await waitFor(() =>
      expect(departureInput.value).toBe(toLocalInputValue(plan.request.departureMs)),
    );

    // The user edits the departure by hand, after the prefill.
    const editedMs = Date.now() + 5 * 3_600_000;
    fireEvent.change(departureInput, { target: { value: toLocalInputValue(editedMs) } });
    expect(departureInput.value).toBe(toLocalInputValue(editedMs));

    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(VIA_A.lat, VIA_A.lon);
    expect(within(viaSection).getAllByRole('listitem')).toHaveLength(1);

    expect(departureInput.value).toBe(toLocalInputValue(editedMs));
    expect(routingMock.calls.length).toBe(0);
  });

  it('GPX import (setPlan(null) + a fresh draft) is not clobbered by the plan-form sync effect', async () => {
    const plan = prefillPlan('prefill-gpx-clobber');
    await db.savePlan(plan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(plan.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(99, 'de'))).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
    // Precondition, proven not assumed: the sync DID prefill from `plan` first.
    await waitFor(() => expect(within(originSection).getByText('Flensburg')).toBeInTheDocument());

    const importOrigin = { lat: 54.79, lon: 9.43 };
    const importDest = { lat: 54.9, lon: 10.5 };
    const gpx =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
      `<rtept lat="${importOrigin.lat}" lon="${importOrigin.lon}"/>` +
      `<rtept lat="${importDest.lat}" lon="${importDest.lon}"/>` +
      '</rte></gpx>';
    const fileInput = document.querySelector('input[type="file"]');
    if (!(fileInput instanceof HTMLInputElement)) throw new Error('import file input not found');

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File([gpx], 'route.gpx', { type: 'application/gpx+xml' })] },
      });
    });

    await waitFor(() =>
      expect(
        within(originSection).getByText(formatLatLon(importOrigin), { selector: 'p' }),
      ).toBeInTheDocument(),
    );
    // Not reverted back to the (now-cleared) plan's origin — the sync effect
    // correctly no-ops on plan === null instead of re-firing on the id
    // transition to `undefined`.
    expect(within(originSection).queryByText('Flensburg')).not.toBeInTheDocument();
  });

  // PR #443 review (MAJOR): handleImportRoute's setPlan(null) must also reset
  // syncedPlanIdRef, or re-loading the SAME plan id later finds the ref
  // already advanced to that id from the earlier load and silently skips the
  // sync — leaving the form on the stale GPX-draft values while planFormDirty
  // reads the freshly (re-)loaded plan as dirty, backwards from reality.
  it('#443: re-loading the same plan id after a GPX import re-syncs the form (does not stay on the GPX draft)', async () => {
    const plan = prefillPlan('prefill-reload-after-gpx');
    await db.savePlan(plan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // Step 1: load plan A — the sync fires, advancing syncedPlanIdRef to A's id.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(plan.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(99, 'de'))).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: de['planner.origin.label'] })).getByText(
          'Flensburg',
        ),
      ).toBeInTheDocument(),
    );

    // Step 2: GPX import — setPlan(null) plus a fresh draft, same shape as
    // the sibling "no-clobber" test above.
    const importOrigin = { lat: 54.79, lon: 9.43 };
    const importDest = { lat: 54.9, lon: 10.5 };
    const gpx =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
      `<rtept lat="${importOrigin.lat}" lon="${importOrigin.lon}"/>` +
      `<rtept lat="${importDest.lat}" lon="${importDest.lon}"/>` +
      '</rte></gpx>';
    const fileInput = document.querySelector('input[type="file"]');
    if (!(fileInput instanceof HTMLInputElement)) throw new Error('import file input not found');

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File([gpx], 'route.gpx', { type: 'application/gpx+xml' })] },
      });
    });

    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: de['planner.origin.label'] })).getByText(
          formatLatLon(importOrigin),
          { selector: 'p' },
        ),
      ).toBeInTheDocument(),
    );

    // Step 3: load plan A again — the SAME id as step 1. Without the #443
    // fix, syncedPlanIdRef.current is still 'prefill-reload-after-gpx' from
    // step 1, so the sync effect's guard (`syncedPlanIdRef.current ===
    // plan.id`) short-circuits and the form is left showing the GPX import's
    // origin instead of plan A's real request.
    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(plan.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(99, 'de'))).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
    await waitFor(() => expect(within(originSection).getByText('Flensburg')).toBeInTheDocument());
    expect(
      within(originSection).queryByText(formatLatLon(importOrigin), { selector: 'p' }),
    ).not.toBeInTheDocument();

    const destSection = screen.getByRole('region', { name: de['planner.destination.label'] });
    await waitFor(() =>
      expect(
        within(destSection).getByText(formatLatLon(PREFILL_DEST), { selector: 'p' }),
      ).toBeInTheDocument(),
    );
    expect(
      within(destSection).queryByText(formatLatLon(importDest), { selector: 'p' }),
    ).not.toBeInTheDocument();

    const departureInput = screen.getByLabelText(de['planner.departure.label']) as HTMLInputElement;
    expect(departureInput.value).toBe(toLocalInputValue(plan.request.departureMs));
  });

  // #654: an absent `request.viaPoints` cannot happen for a legitimate
  // stored plan — services/db.ts (the only IndexedDB writer this app has
  // ever shipped) was created ~3 hours AFTER eb2d7ee, the commit that added
  // the field, and both predate v0.1.0 (git-verified 2026-08-25; full dated
  // argument in migratePlan.ts's normaliseViaPoints). `db.savePlan` writes
  // the raw record straight into IndexedDB with no validation, so deleting
  // the key here instead reproduces a HAND-EDITED or otherwise corrupted
  // record — the same class of defense
  // docs/adr/0002-pre-1.0-db-migration-low-priority.md requires ("does NOT
  // waive defensive reads"). Loading it drives the REAL path —
  // services/db.ts's getPlan -> migratePlan -> App.tsx's syncedPlanIdRef
  // sync effect (setDraftViaPoints) -> planFormDirty (lib/planForm.ts).
  // Before this fix, the sync effect wrote `undefined` into draftViaPoints
  // and the next formDirty computation threw reading `.length` off it,
  // unmounting the whole React root with no error boundary to catch it —
  // the app just goes blank.
  it('loading a plan with the viaPoints key absent (hand-edited/corrupted record) does not blank the app', async () => {
    const plan = prefillPlan('prefill-no-viapoints-key');
    const rawRequest = plan.request as Partial<PlanRequest>;
    delete rawRequest.viaPoints;
    await db.savePlan(plan);

    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(plan.name) }));
    await waitFor(() => expect(screen.getByText(formatNm(99, 'de'))).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
    // The app is still alive (heading present, tabs still respond) rather
    // than a blank root — the observable symptom of the unguarded crash.
    expect(screen.getByRole('heading', { name: 'SailCommand' })).toBeInTheDocument();
    const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
    await waitFor(() => expect(within(originSection).getByText('Flensburg')).toBeInTheDocument());
    // The via list synced from the absent field renders as genuinely empty,
    // not merely "did not throw".
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    expect(within(viaSection).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('harbors landing AFTER the plan becomes active still prefills labels once they resolve', async () => {
    // A harbors.json fetch this test controls the resolution of — everything
    // else answers immediately, same as the shared fetchMock() helper.
    let resolveHarbors!: (r: Response) => void;
    const harborsPromise = new Promise<Response>((res) => {
      resolveHarbors = res;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('mask.meta.json')) return Promise.resolve(jsonResponse(TEST_MASK_META));
        if (url.includes('mask.bin')) {
          const buf = new ArrayBuffer(TEST_MASK_META.rows * TEST_MASK_META.cols);
          return Promise.resolve(new Response(buf, { status: 200 }));
        }
        if (url.includes('salona-45-genoa.json')) return Promise.resolve(jsonResponse(TEST_POLAR));
        if (url.includes('salona-45-fock.json'))
          return Promise.resolve(jsonResponse({ ...TEST_POLAR, rig: 'fock' }));
        // #54 spec N: the tier-C fleet boats' tables — see the note on the
        // module-level mock above.
        if (url.includes('/data/polars/')) return Promise.resolve(jsonResponse(TEST_POLAR));
        if (url.includes('harbors.json')) return harborsPromise;
        if (url.includes('seamarks.json'))
          return Promise.resolve(jsonResponse({ type: 'FeatureCollection', features: [] }));
        if (url.includes('basemap.pmtiles.png')) {
          return Promise.resolve(
            new Response(Uint8Array.from([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]), {
              status: 206,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    const plan = prefillPlan('prefill-late-harbors');
    await db.savePlan(plan);
    localStorage.setItem('sc-session', `{"v":1,"planId":"${plan.id}","tab":"plan","rig":"genoa"}`);

    // services/assets.ts module-caches loadRoutingAssets()'s result "for the
    // lifetime of the page" — by this point in the file, every earlier test's
    // renderApp() has already resolved and cached it, so the harborsPromise
    // stub above would never even be reached through the statically-imported
    // App. vi.resetModules() + a fresh dynamic import gets a genuinely new
    // module graph (a fresh services/assets.ts `cached` singleton included)
    // while every vi.mock'd module (workerClient/openMeteo/maplibre-gl,
    // still bound to the same hoisted mapTestHooks/routingMock) stays mocked
    // — the standard Vitest pattern for isolating a module-level singleton.
    vi.resetModules();
    const { default: FreshApp } = await import('./App');

    render(
      <I18nProvider>
        <FreshApp />
      </I18nProvider>,
    );
    await screen.findByRole('heading', { name: 'SailCommand' });

    // The plan restores (its 99.0 nm Ergebnis total appears) while
    // harbors.json is still pending — the sync effect must NOT yet have
    // written a harbor-labeled origin (harborsLoaded is still false).
    await waitFor(() => expect(screen.getByText(formatNm(99, 'de'))).toBeInTheDocument());
    const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
    expect(within(originSection).queryByText('Flensburg')).not.toBeInTheDocument();

    // Harbors resolve now — the effect re-fires for the SAME (still
    // unsynced) plan id, and the origin label resolves correctly this time.
    await act(async () => {
      resolveHarbors(jsonResponse(HARBORS));
      await Promise.resolve();
    });
    await waitFor(() => expect(within(originSection).getByText('Flensburg')).toBeInTheDocument());

    // #572: close the FRESH module graph's own IndexedDB connection.
    // `vi.resetModules()` above gave this test's dynamically-imported App its
    // own `services/db.ts` instance, with its own `dbPromise` cache. The
    // file-level beforeEach calls the STATICALLY imported
    // `__resetDbForTests()`, which can only close the ORIGINAL instance's
    // connection — so the fresh one is left open and the `deleteDB(...)`
    // inside that helper blocks on it indefinitely, timing out the next
    // test's hook after 10 s.
    //
    // Pre-existing and latent, not introduced by #572: this was the last
    // test in the file, so nothing had ever run after it. MEASURED — a
    // trivial `expect(1).toBe(1)` appended after it fails with the identical
    // `Hook timed out in 10000ms`, and passes with this cleanup in place.
    //
    // The import resolves from the post-reset registry, so it IS the fresh
    // instance rather than a third one.
    //
    // `cleanup()` FIRST as hygiene, not as the fix: unmounting FreshApp before
    // closing its database removes any chance of an effect re-opening the
    // connection between the close and the delete. MEASURED as NOT load-bearing
    // on its own — removing this line alone leaves the file green (8 runs,
    // durations unchanged). What IS load-bearing is the `Promise.all` over BOTH
    // module instances below; dropping either one reproduces the hang. The
    // file-level afterEach calls `cleanup()` again, which is a no-op.
    cleanup();
    const freshDb = await import('./services/db');
    // BOTH instances, concurrently. This test opened the ORIGINAL instance's
    // connection itself with the `db.savePlan(plan)` above, so resetting only
    // the fresh one leaves that second connection to block the same
    // `deleteDB` (measured — the hang simply moves). Each helper closes its
    // own connection before awaiting the delete, so running them together
    // gets both closed before either delete has to make progress.
    await Promise.all([db.__resetDbForTests(), freshDb.__resetDbForTests()]);
  });

  // #660: shared setup for the four field-guard regression tests below — same
  // deferred-harbors.json technique as 'harbors landing AFTER the plan
  // becomes active…' above (a session-restored plan + a FRESH module graph,
  // since services/assets.ts module-caches loadRoutingAssets()'s result for
  // the lifetime of the page — without vi.resetModules() the harborsPromise
  // stub below would never even be reached). Returns `resolveHarbors` so each
  // test can edit a field WHILE the window is open, plus `originSection` (the
  // shared per-field control target: origin is never the field under test's
  // OWN edit in the destination/departure/via tests, so it doubles as proof
  // the OTHER three fields still sync normally) and a `cleanupFresh` that
  // must run before the test ends (mirrors the sibling test's own DB-cleanup
  // comment above).
  async function renderFreshAppWithDeferredHarbors(plan: Plan): Promise<{
    resolveHarbors: (r: Response) => void;
    originSection: HTMLElement;
    cleanupFresh: () => Promise<void>;
  }> {
    let resolveHarbors!: (r: Response) => void;
    const harborsPromise = new Promise<Response>((res) => {
      resolveHarbors = res;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('mask.meta.json')) return Promise.resolve(jsonResponse(TEST_MASK_META));
        if (url.includes('mask.bin')) {
          const buf = new ArrayBuffer(TEST_MASK_META.rows * TEST_MASK_META.cols);
          return Promise.resolve(new Response(buf, { status: 200 }));
        }
        if (url.includes('salona-45-genoa.json')) return Promise.resolve(jsonResponse(TEST_POLAR));
        if (url.includes('salona-45-fock.json'))
          return Promise.resolve(jsonResponse({ ...TEST_POLAR, rig: 'fock' }));
        if (url.includes('/data/polars/')) return Promise.resolve(jsonResponse(TEST_POLAR));
        if (url.includes('harbors.json')) return harborsPromise;
        if (url.includes('seamarks.json'))
          return Promise.resolve(jsonResponse({ type: 'FeatureCollection', features: [] }));
        if (url.includes('basemap.pmtiles.png')) {
          return Promise.resolve(
            new Response(Uint8Array.from([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]), {
              status: 206,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    await db.savePlan(plan);
    localStorage.setItem('sc-session', `{"v":1,"planId":"${plan.id}","tab":"plan","rig":"genoa"}`);

    vi.resetModules();
    const { default: FreshApp } = await import('./App');

    render(
      <I18nProvider>
        <FreshApp />
      </I18nProvider>,
    );
    await screen.findByRole('heading', { name: 'SailCommand' });
    await waitFor(() => expect(screen.getByText(formatNm(99, 'de'))).toBeInTheDocument());

    const originSection = screen.getByRole('region', { name: de['planner.origin.label'] });
    // Window control (shared with the sibling deferred-harbors test above):
    // origin must not already show the harbor label, or the pending window
    // was never open and an edit made "during" it would prove nothing.
    expect(within(originSection).queryByText('Flensburg')).not.toBeInTheDocument();

    async function cleanupFresh(): Promise<void> {
      cleanup();
      const freshDb = await import('./services/db');
      await Promise.all([db.__resetDbForTests(), freshDb.__resetDbForTests()]);
    }

    return { resolveHarbors, originSection, cleanupFresh };
  }

  // Per-field coverage (not one joint test): each of the four writes the sync
  // effect makes gets its OWN edit-during-the-window + resolve + assert-
  // preserved test, so a guard that works for one field but not another reds
  // exactly the one row it should — the per-term rule (a joint test can pass
  // on a partial fix).
  it('#660: origin edited during the harborsLoaded-pending window is not reverted once harbors resolve', async () => {
    const plan = prefillPlan('prefill-660-origin');
    const { resolveHarbors, originSection, cleanupFresh } =
      await renderFreshAppWithDeferredHarbors(plan);

    fireEvent.click(within(originSection).getByRole('button', { name: de['planner.pickOnMap'] }));
    simulateMapClick(ORIGIN_A.lat, ORIGIN_A.lon);
    expect(
      within(originSection).getByText(formatLatLon(ORIGIN_A), { selector: 'p' }),
    ).toBeInTheDocument();

    await act(async () => {
      resolveHarbors(jsonResponse(HARBORS));
      await Promise.resolve();
    });
    await flushPlanFormSync();

    // The edit survives — not reverted to the plan's own 'Flensburg' origin.
    expect(
      within(originSection).getByText(formatLatLon(ORIGIN_A), { selector: 'p' }),
    ).toBeInTheDocument();
    expect(within(originSection).queryByText('Flensburg')).not.toBeInTheDocument();

    // Per-field control: departure (untouched) DOES get synced from the plan
    // — proving the guard is per-field, not "any edit blocks every write".
    const departureInput = screen.getByLabelText(de['planner.departure.label']) as HTMLInputElement;
    await waitFor(() =>
      expect(departureInput.value).toBe(toLocalInputValue(plan.request.departureMs)),
    );

    await cleanupFresh();
  });

  it('#660: destination edited during the harborsLoaded-pending window is not reverted once harbors resolve', async () => {
    const plan = prefillPlan('prefill-660-destination');
    const { resolveHarbors, originSection, cleanupFresh } =
      await renderFreshAppWithDeferredHarbors(plan);

    const destSection = screen.getByRole('region', { name: de['planner.destination.label'] });
    fireEvent.click(within(destSection).getByRole('button', { name: de['planner.pickOnMap'] }));
    simulateMapClick(DEST_A.lat, DEST_A.lon);
    expect(
      within(destSection).getByText(formatLatLon(DEST_A), { selector: 'p' }),
    ).toBeInTheDocument();

    await act(async () => {
      resolveHarbors(jsonResponse(HARBORS));
      await Promise.resolve();
    });
    await flushPlanFormSync();

    // The edit survives — not reverted to the plan's own tap-point destination.
    expect(
      within(destSection).getByText(formatLatLon(DEST_A), { selector: 'p' }),
    ).toBeInTheDocument();
    expect(
      within(destSection).queryByText(formatLatLon(PREFILL_DEST), { selector: 'p' }),
    ).not.toBeInTheDocument();

    // Per-field control: origin (untouched) DOES get synced from the plan.
    await waitFor(() => expect(within(originSection).getByText('Flensburg')).toBeInTheDocument());

    await cleanupFresh();
  });

  it('#660: departure edited during the harborsLoaded-pending window is not reverted once harbors resolve', async () => {
    const plan = prefillPlan('prefill-660-departure');
    const { resolveHarbors, originSection, cleanupFresh } =
      await renderFreshAppWithDeferredHarbors(plan);

    const departureInput = screen.getByLabelText(de['planner.departure.label']) as HTMLInputElement;
    const editedMs = Date.now() + 5 * 3_600_000;
    fireEvent.change(departureInput, { target: { value: toLocalInputValue(editedMs) } });
    expect(departureInput.value).toBe(toLocalInputValue(editedMs));

    await act(async () => {
      resolveHarbors(jsonResponse(HARBORS));
      await Promise.resolve();
    });
    await flushPlanFormSync();

    // The edit survives — not reverted to the plan's own departure.
    expect(departureInput.value).toBe(toLocalInputValue(editedMs));

    // Per-field control: origin (untouched) DOES get synced from the plan.
    await waitFor(() => expect(within(originSection).getByText('Flensburg')).toBeInTheDocument());

    await cleanupFresh();
  });

  it('#660: a via added during the harborsLoaded-pending window is not reverted once harbors resolve', async () => {
    const plan = prefillPlan('prefill-660-via');
    const { resolveHarbors, originSection, cleanupFresh } =
      await renderFreshAppWithDeferredHarbors(plan);

    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(VIA_A.lat, VIA_A.lon);
    expect(within(viaSection).getAllByRole('listitem')).toHaveLength(1);

    await act(async () => {
      resolveHarbors(jsonResponse(HARBORS));
      await Promise.resolve();
    });
    await flushPlanFormSync();

    // The added via survives — not reverted to the plan's own empty via list
    // (prefillPlan's default `viaPoints: []`).
    expect(within(viaSection).getAllByRole('listitem')).toHaveLength(1);

    // Per-field control: origin (untouched) DOES get synced from the plan.
    await waitFor(() => expect(within(originSection).getByText('Flensburg')).toBeInTheDocument());

    await cleanupFresh();
  });
});
// #572: the selection → request span. Nothing asserted this before: the
// multi-boat suites cover the catalogue, the picker's own rendering, the
// clamp, and the routing layer's handling of a boat it is HANDED — but no
// test connected the picker to what `handlePlan` actually puts on the wire,
// which is exactly the gap the defect lived in. `App.tsx` built its request
// with `boat: defaultBoatSnapshot()`, so every new plan was solved as a
// Salona 45 whatever the picker showed.
//
// MUTATION REACHABILITY — the point of picking the Elan rather than the
// default. With `salona-45` selected the fixed and the broken code emit a
// BYTE-IDENTICAL request (`boatSnapshot(boatById('salona-45'))` IS
// `defaultBoatSnapshot()`), so a test written against the default boat is
// green either way and carries zero information. Selecting a NON-default
// boat is what makes the mutation reach the assertion: reverting
// `handlePlan` to `defaultBoatSnapshot()` reds the `boat.id` and
// `boat.draftM` rows below with `salona-45` / `2.1`.
describe('#572: a new plan is solved with the SELECTED boat', () => {
  // Selects a catalogue boat through the real picker UI — the whole point is
  // to span selection → request, so this drives the radio a user clicks
  // rather than seeding BOAT_ID_STORAGE_KEY behind the app's back.
  function selectBoat(nameMatch: RegExp) {
    fireEvent.click(screen.getByRole('tab', { name: de['nav.boat'] }));
    fireEvent.click(screen.getByRole('radio', { name: nameMatch }));
    expect(screen.getByRole('radio', { name: nameMatch })).toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: de['nav.plan'] }));
  }

  it('puts the selected boat, by value, on the request handed to the router', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    selectBoat(/PIRANJA/);
    pickOriginAndDestination();
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));

    const { request } = routingMock.calls[0];
    const elan = boatById('elan-444-piranja');

    // The discriminating rows. `request.boat.id` is what workerClient.ts
    // resolves BOTH the polar tables and the spec C.4(a) relaxation floor
    // from, so these two are the whole safety content of the fix.
    expect(request.boat.id).toBe('elan-444-piranja');
    expect(request.boat.draftM).toBe(1.9);
    expect(request.boat.name).toBe(elan.name);

    // By VALUE, not by reference (spec I.3) — the saved plan must not share
    // mutable state with the catalogue constant.
    expect(request.boat).toEqual(boatSnapshot(elan));
    expect(request.boat).not.toBe(elan);
    expect(request.boat.sails[0]).not.toBe(elan.sails[0]);

    // NOT DISCRIMINATING FOR #572 TODAY, and recorded as such rather than
    // presented as coverage: all three catalogue boats currently carry the
    // sail ids `genoa` then `fock`, so `sailIdsOf(boat)` and the old
    // `DEFAULT_SAIL_IDS` are equal in VALUE and this row is green against
    // the broken code too. It is worth pinning anyway — it is the row that
    // reds on the first boat whose inventory differs, which is precisely
    // when a `DEFAULT_SAIL_IDS` here would start choosing the wrong sails.
    expect(request.sailIds).toEqual(sailIdsOf(elan));
  });

  // #571 redesign RETIRED the "does NOT re-boat an existing plan" half of
  // this test that used to live here: it drove a via-add to trigger
  // replanWithVias (state/replan.ts), the ONE in-place-replan path that
  // deliberately preserves the ORIGINAL plan's boat rather than following
  // the picker — spec I.3's over-fix guard. App.tsx no longer calls
  // replanWithVias at all (a via edit only ever writes to `draftViaPoints`),
  // so that specific wiring assurance is now unreachable from the UI.
  // replanWithVias's own boat-preservation guarantee remains directly,
  // mutation-checked in state/replan.test.ts ("replans with the saved
  // plan's OWN boat snapshot, not the catalogue default") — still fully
  // valid, just UI-orphaned (see that file's and state/replan.ts's own
  // comments on why it was kept rather than deleted). state/reroute.ts's
  // rerouteFromFix (Live reroute) is a SEPARATE, still-live in-place-replan
  // path with the identical boat-preservation contract, unaffected by and
  // out of scope for this redesign.
  //
  // What replaces it below is the property that's actually NEW and load-
  // bearing under the redesign: a pending via edit does NOT pin the plan to
  // whatever boat was selected when the edit was made — pressing Plan route
  // always solves against the picker's CURRENT selection, exactly like any
  // other draft form field (origin/destination/departure/settings).
  it('a pending via edit does not pin a genuinely new plan to a stale boat — the Plan-route press always uses the CURRENT picker selection', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });

    // Plan under the Elan.
    selectBoat(/PIRANJA/);
    pickOriginAndDestination();
    const planButton = screen.getByRole('button', { name: de['planner.plan'] });
    fireEvent.click(planButton);
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    expect(routingMock.calls[0].request.boat.id).toBe('elan-444-piranja');
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() => expect(planButton).toBeEnabled());
    await flushPlanFormSync(); // #631 — see the helper; the via add below is a sync-effect-written field

    // Add a via WHILE the Elan is still selected — a pending draft edit,
    // never dispatched to the router (see 'via edits are draft-only and
    // never auto-replan (#571 redesign)' above).
    const viaSection = screen.getByRole('region', { name: de['planner.via.label'] });
    fireEvent.click(within(viaSection).getByRole('button', { name: de['planner.via.add'] }));
    simulateMapClick(VIA_A.lat, VIA_A.lon);
    expect(routingMock.calls.length).toBe(1);

    // NOW switch boats, with that via edit still pending/unapplied.
    selectBoat(/Salona 45/);

    // Pressing Plan route builds a genuinely new plan (the via edit's own
    // effect applies here too) against the boat selected NOW, not the Elan
    // that was active when the via was added.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(2));
    expect(routingMock.calls[1].request.boat.id).toBe('salona-45');
    expect(routingMock.calls[1].request.viaPoints).toEqual([VIA_A]);
  });
});
