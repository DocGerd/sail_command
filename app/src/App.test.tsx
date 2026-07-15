import 'fake-indexeddb/auto';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import App from './App';
import { I18nProvider } from './i18n';
import { de } from './i18n/dict.de';
import { en } from './i18n/dict.en';
import { __resetDbForTests } from './services/db';
import * as db from './services/db';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from './test/fixtures';
import { formatNm } from './lib/format';
import { DEFAULT_SETTINGS, type Harbor, type Plan, type PlanRequest, type PlanResult, type PlanResultOk, type PolarTable } from './types';

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
  // WebGL/MapLibre runtime, which jsdom doesn't have.
  clickHandler: null as ((e: { lngLat: { lat: number; lng: number } }) => void) | null,
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
      uniformWindGrid(10, 250, { t0Ms: Date.now() - 3_600_000, hours: 24 * (actual.FORECAST_DAYS + 2) }),
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
    on(event: string, cb: (e: { lngLat: { lat: number; lng: number } }) => void) {
      if (event === 'click') mapTestHooks.clickHandler = cb;
    }
    off(event: string) {
      if (event === 'click') mapTestHooks.clickHandler = null;
    }
    once(event: string, cb: () => void) {
      if (event === 'load') cb();
    }
    remove() {}
    addControl() {}
    addSource() {}
    addLayer() {}
    getSource() {
      return undefined;
    }
    getLayer() {
      return undefined;
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
  return {
    Map: FakeMap,
    Marker: FakeMarker,
    AttributionControl: FakeAttributionControl,
    LngLatBounds: FakeLngLatBounds,
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
const HARBORS: Harbor[] = [FLENSBURG];

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
// which never actually resolve a coordinate.
function simulateMapClick(lat: number, lon: number) {
  act(() => {
    mapTestHooks.clickHandler?.({ lngLat: { lat, lng: lon } });
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('App', () => {
  it('renders the app shell with the SailCommand title', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'SailCommand', level: 1 })).toBeInTheDocument();
  });

  it('defaults to the Planen tab, and switching tabs shows Routen and Live panel content', async () => {
    renderApp();

    expect(await screen.findByRole('tab', { name: de['nav.plan'] })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: de['nav.routes'] }));
    expect(screen.getByRole('tab', { name: de['nav.routes'] })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(de['plansList.empty'])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: de['nav.live'] }));
    expect(screen.getByRole('tab', { name: de['nav.live'] })).toHaveAttribute('aria-selected', 'true');
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

    const tapPickMessage = (targetLabel: string) => de['banner.tapPick'].replace('{target}', targetLabel);

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

      fireEvent.click(within(originSection).getByRole('button', { name: FLENSBURG.names.de }));

      expect(screen.queryByText(message)).not.toBeInTheDocument();
      expect(within(originSection).getByText(FLENSBURG.names.de, { selector: 'p' })).toBeInTheDocument();
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
      expect(await screen.findByText(tapPickMessage(de['planner.origin.label']))).toBeInTheDocument();

      armVia();
      expect(screen.queryByText(tapPickMessage(de['planner.origin.label']))).not.toBeInTheDocument();
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
    expect(screen.getByRole('tab', { name: de['nav.routes'] })).toHaveAttribute('aria-selected', 'true');
  });

  it('the stale-forecast banner renders through the real App tree for a loaded plan whose windGrid predates departure by >12h', async () => {
    const staleWindGrid = uniformWindGrid(10, 250, { t0Ms: Date.now() - 20 * 3_600_000, hours: 48 });
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
    expect(await within(bannerArea as HTMLElement).findByText(de['route.staleForecast'])).toBeInTheDocument();
  });

  it('a viaReplan error banner renders through the real App tree', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'SailCommand' });
    pickOriginAndDestination();
    fireEvent.click(screen.getByRole('button', { name: de['planner.plan'] }));
    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(10));
    await waitFor(() => expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeEnabled());

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
    await waitFor(() => expect(screen.getByRole('button', { name: de['planner.plan'] })).toBeEnabled());

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
    fireEvent.click(screen.getByRole('button', { name: de['planner.via.moveDown'].replace('{index}', '1') }));

    await waitFor(() => expect(routingMock.calls.length).toBe(1));
    routingMock.calls[0].resolve(okPlanResult(66));

    expect(await screen.findByText(de['banner.viaTooClose.plural'].replace('{count}', '2'))).toBeInTheDocument();
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

  it('the language-toggle button label goes through the i18n dict (shows the target language\'s code)', async () => {
    renderApp();
    const toggle = await screen.findByRole('button', { name: de['nav.langToggle'] });
    // Starts in German — the button offers to switch to English.
    expect(toggle).toHaveTextContent(de['nav.langToggle.en']);

    fireEvent.click(toggle);
    expect(await screen.findByRole('button', { name: en['nav.langToggle'] })).toHaveTextContent(de['nav.langToggle.de']);
  });
});
