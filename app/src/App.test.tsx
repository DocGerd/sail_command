import 'fake-indexeddb/auto';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import App from './App';
import { de } from './i18n/dict.de';
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

function renderApp() {
  return render(<App />);
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
