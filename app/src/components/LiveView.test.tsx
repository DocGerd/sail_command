import 'fake-indexeddb/auto';
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStateProvider, useActivePlan } from '../state/AppState';
import { I18nProvider } from '../i18n';
import { __resetDbForTests } from '../services/db';
import { destinationPoint } from '../lib/geo';
import { distanceToNextManeuverNm, headingToSteerDeg } from '../lib/live';
import { formatLatLon, formatNm } from '../lib/format';
import { formatTrueHeading } from '../lib/liveMetrics';
import type { GpsErrorKind, GpsFix } from '../services/geolocation';
import { DEFAULT_SETTINGS, type Leg, type MaskMeta, type Plan } from '../types';
import { withHarborHandover } from '../lib/harborHandover';
import LiveView, { XTE_SIDE_DEADBAND_NM } from './LiveView';
import { useOwnshipGps } from '../state/useOwnshipGps';
import type { watchPosition as realWatchPosition } from '../services/geolocation';
// #25 addendum: LiveView no longer renders BoatMarker at all (that moved to
// the standalone OwnshipMarker) — mocked here purely so the dedupe test
// below can prove the import was actually removed, not just that this test
// file happens not to exercise it.
vi.mock('./BoatMarker', () => ({ default: vi.fn(() => null) }));
import BoatMarker from './BoatMarker';
// #251: the heading-to-steer depth check needs the routing assets (for the
// NavMask) on the main thread. Mocked the same way as BoatMarker above so
// each depth-check test controls exactly what the mask resolves to, rather
// than relying on jsdom's real (failing) fetch — every OTHER test in this
// file gets a never-resolving default (set in beforeEach below), which
// renders the same as an unmocked jsdom fetch (mask stays null) without the
// console.warn noise a rejection would add to every one of them.
vi.mock('../services/assets', () => ({ loadRoutingAssets: vi.fn() }));
import { loadRoutingAssets } from '../services/assets';
// #143: `isLiveSimRequested` mocked (defaulting to false, matching the
// gate-open-but-no-query-param state jsdom's default URL is in) so the
// simulator-active tests below don't depend on manipulating jsdom's real
// location — every other export (the real controller, scenario list, etc.)
// passes through unmocked, so LiveSimulatorControls still renders for real.
vi.mock('../dev/liveSimulator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dev/liveSimulator')>();
  return { ...actual, isLiveSimRequested: vi.fn(() => false) };
});
import { getLiveSimController, isLiveSimRequested } from '../dev/liveSimulator';
import * as NavMaskModule from '../lib/mask';
import { defaultBoatSnapshot } from '../types';
import { PLAN_SCHEMA_VERSION } from '../types';

const ORIGIN = { lat: 54.7, lon: 9.5 };
const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);
const HOUR = 3_600_000;
const P0 = ORIGIN;
const P1 = destinationPoint(P0, 90, 5);
const P2 = destinationPoint(P0, 90, 10);

const LEGS: Leg[] = [
  {
    kind: 'sail',
    start: P0,
    end: P1,
    startTimeMs: T0,
    endTimeMs: T0 + HOUR,
    headingDeg: 90,
    twsKn: 12,
    speedKn: 5,
    distanceNm: 5,
    board: 'starboard',
    twaDeg: 45,
    maneuverAtStart: null,
  },
  {
    kind: 'sail',
    start: P1,
    end: P2,
    startTimeMs: T0 + HOUR,
    endTimeMs: T0 + 2 * HOUR,
    headingDeg: 90,
    twsKn: 12,
    speedKn: 5,
    distanceNm: 5,
    board: 'port',
    twaDeg: -45,
    maneuverAtStart: 'tack',
  },
];

const TEST_PLAN: Plan = {
  id: 'live-plan-1',
  name: 'Live Test Plan',
  createdAtMs: T0,
  schemaVersion: PLAN_SCHEMA_VERSION,
  request: {
    origin: P0,
    destination: P2,
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: T0,
    settings: DEFAULT_SETTINGS,
    sailIds: ['genoa', 'fock'],
    boat: defaultBoatSnapshot(),
  },
  windGrid: {
    lats: [54.7],
    lons: [9.5],
    timesMs: [T0],
    speedKn: new Float32Array([12]),
    dirFromDeg: new Float32Array([270]),
    gustKn: new Float32Array([15]),
    fetchedAtMs: T0,
    model: 'test',
  },
  result: {
    status: 'ok',
    sails: [
      {
        sailId: 'genoa',
        result: {
          sailId: 'genoa',
          legs: LEGS,
          etaMs: T0 + 2 * HOUR,
          durationMs: 2 * HOUR,
          distanceNm: 10,
          maneuverCount: 1,
          motorDistanceNm: 0,
        },
        reason: null,
      },
      { sailId: 'fock', result: null, reason: 'calm-motor-off' },
    ],
    recommended: 'genoa',
    comparisonComplete: true,
    snappedOrigin: P0,
    snappedDestination: P2,
  },
};

// #251 review F1: a distinct plan.id with IDENTICAL legs. Identical geometry
// is the point — the readout keeps rendering the same heading, so the test
// isolates "what happened to the depth annotation" from "did the readout
// survive the plan swap at all".
const REROUTED_PLAN: Plan = { ...TEST_PLAN, id: 'live-plan-2', name: 'Live Test Plan (rerouted)' };

const FIX_POINT = destinationPoint(P0, 90, 2); // 2 nm into leg 0 (of 5)

// #251: generous mask coverage that actually CONTAINS the fixture points —
// ORIGIN (P0), FIX_POINT, and both leg endpoints P1/P2 (legs run 10 nm due
// east of ORIGIN, ~0.29° of longitude at this latitude). checkHeadingDepth's
// coverage pre-check reports 'unavailable' for any endpoint outside this
// rectangle, so a too-small META would collapse every depth-check test to
// 'unavailable' regardless of what segmentShallowestBelow is mocked to
// return — proving nothing.
const MASK_META: MaskMeta = { west: 9.0, south: 54.5, east: 10.0, north: 55.0, cols: 10, rows: 10 };

// The mask BUFFER content is irrelevant in the depth-check tests below: they
// spy on NavMask.prototype.segmentShallowestBelow directly, so this all-deep
// (byte 255) fill is only here to satisfy NavMask's constructor length check.
function fullyDeepMaskBuffer(): ArrayBuffer {
  return new Uint8Array(MASK_META.rows * MASK_META.cols).fill(255).buffer;
}

// #632 review Important: unlike the buffer above, THIS content is
// load-bearing — byte 0 is charted LAND, and the one test using it
// deliberately does NOT spy on segmentShallowestBelow (a mocked return
// ignores the threshold entirely, which is exactly the vacuity the
// reviewer's supplied test setup exists to avoid). Real NavMask, real
// checkHeadingDepth, a real `depthM < thresholdM` comparison against a
// threshold of 0.
function fullyLandMaskBuffer(): ArrayBuffer {
  return new Uint8Array(MASK_META.rows * MASK_META.cols).fill(0).buffer;
}

function TestSetPlan({ plan }: { plan: Plan }) {
  const { setPlan } = useActivePlan();
  useEffect(() => {
    setPlan(plan);
  }, [plan, setPlan]);
  return null;
}

function ActiveLegProbe() {
  const { activeLegIndex } = useActivePlan();
  return <span data-testid="shared-active-leg">{activeLegIndex ?? 'none'}</span>;
}

// Mirrors App.tsx's wiring: one shared GPS source, tracking reported up.
function LiveViewHost({
  watchPosition,
  showOwnship = false,
  ...props
}: { watchPosition: typeof realWatchPosition; showOwnship?: boolean } & Omit<
  ComponentProps<typeof LiveView>,
  'gps' | 'onTrackingChange'
>) {
  const [tracking, setTracking] = useState(false);
  const gps = useOwnshipGps(showOwnship, tracking, watchPosition);
  return <LiveView gps={gps} onTrackingChange={setTracking} {...props} />;
}

function fakeWatchPosition() {
  let onFixCb: ((fix: GpsFix) => void) | null = null;
  let onErrorCb: ((kind: GpsErrorKind) => void) | null = null;
  const unsubscribe = vi.fn();
  const wp = vi.fn((onFix: (fix: GpsFix) => void, onError: (kind: GpsErrorKind) => void) => {
    onFixCb = onFix;
    onErrorCb = onError;
    return unsubscribe;
  });
  return {
    wp,
    unsubscribe,
    emitFix: (fix: GpsFix) => {
      if (!onFixCb) throw new Error('watchPosition was never subscribed');
      onFixCb(fix);
    },
    emitError: (kind: GpsErrorKind) => {
      if (!onErrorCb) throw new Error('watchPosition was never subscribed');
      onErrorCb(kind);
    },
  };
}

function renderLive(
  watchPosition: ReturnType<typeof fakeWatchPosition>['wp'],
  plan?: Plan,
  extra?: ReactNode,
) {
  localStorage.setItem('sc-lang', 'en');
  return render(
    <I18nProvider>
      <AppStateProvider>
        {plan && <TestSetPlan plan={plan} />}
        <LiveViewHost watchPosition={watchPosition} />
        {extra}
      </AppStateProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('LiveView', () => {
  beforeEach(async () => {
    await __resetDbForTests();
    // #251: default for every test that doesn't care about the depth check —
    // a promise that never settles, so the mask stays null (same rendered
    // result as jsdom's real failing fetch: 'unavailable'), quietly (no
    // console.warn, since neither resolve nor reject ever fires). The three
    // depth-check tests below override this with their own
    // mockResolvedValue/mockRejectedValue before rendering.
    vi.mocked(loadRoutingAssets).mockReturnValue(new Promise(() => {}));
  });

  it('shows a prompt to load/plan a route, and no toggle, when there is no active plan', async () => {
    const { wp } = fakeWatchPosition();
    renderLive(wp);

    expect(await screen.findByText(/load or plan a route/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start live view' })).not.toBeInTheDocument();
  });

  it('toggling on subscribes to watchPosition, and a fix renders HTS/COG/SOG, next maneuver, and projected ETA', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);

    const toggle = await screen.findByRole('button', { name: 'Start live view' });
    fireEvent.click(toggle);
    expect(wp).toHaveBeenCalledTimes(1);

    const expectedHts = formatTrueHeading(headingToSteerDeg(LEGS, 0, FIX_POINT));
    const nextEvent = distanceToNextManeuverNm(LEGS, 0, FIX_POINT);
    if (!nextEvent) throw new Error('test fixture expected a next maneuver');

    act(() => {
      emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
    });

    expect(screen.getByText(expectedHts)).toBeInTheDocument();
    expect(screen.getByText(formatTrueHeading(91.4))).toBeInTheDocument(); // COG
    expect(screen.getByText('6.3 kn')).toBeInTheDocument(); // SOG
    expect(document.querySelector('.live-view-next-event')).toHaveTextContent(
      `Next in ${formatNm(nextEvent.distNm, 'en')} Tack`,
    );
    expect(screen.getByText(/tack/i)).toBeInTheDocument();
    expect(screen.getByText(/projected eta/i)).toBeInTheDocument();
  });

  it('#25: never renders BoatMarker itself, even fully active with a steerable fix — the standalone OwnshipMarker is the ONLY marker render site, so this is what keeps Live View + the ownship toggle from ever showing two markers', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));

    act(() => emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 }));

    // Sanity: the readout DID render off this fix (steerable is non-null) —
    // otherwise "BoatMarker not called" would be true for the trivial wrong
    // reason (nothing rendered at all).
    expect(screen.getByText(formatTrueHeading(91.4))).toBeInTheDocument();
    expect(BoatMarker).not.toHaveBeenCalled();
  });

  it('shows en dash placeholders for COG/SOG when the device does not report them', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));

    act(() => emitFix({ point: FIX_POINT, cogDeg: null, sogKn: null, accuracyM: 9 }));

    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('renders the COG placeholder — not "NaN°" — for a stationary fix (geolocation.ts maps NaN heading to null; SOG 0 still renders as 0.0 kn)', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));

    // What geolocation.ts's watchPosition now emits for a stationary device
    // (heading: NaN -> cogDeg: null; speed: 0 is a real reading, not NaN).
    act(() => emitFix({ point: FIX_POINT, cogDeg: null, sogKn: 0, accuracyM: 9 }));

    expect(screen.getByText('—')).toBeInTheDocument(); // COG placeholder
    expect(screen.getByText('0.0 kn')).toBeInTheDocument(); // SOG still a real reading
    expect(screen.queryByText(/nan/i)).not.toBeInTheDocument();
  });

  it('projects a later ETA (positive drift) when the fix arrives behind schedule (mocked clock)', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));

    // LiveView reads Date.now() at render time to compute projectedEtaMs;
    // mirrors usePlanFlow.test.tsx's vi.spyOn(Date, 'now') pattern rather
    // than vi.useFakeTimers(), which hangs RTL's findBy polling and
    // fake-indexeddb's internal scheduling in this suite.
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 0.4 * HOUR + 12 * 60_000); // 12 min behind the on-schedule time at FIX_POINT

    act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

    expect(screen.getByText(/\+12 min/)).toBeInTheDocument();
  });

  it('publishes the projected active leg index to shared AppState for RouteLayer highlighting', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN, <ActiveLegProbe />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));

    expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('none');

    act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

    expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('0');
  });

  it('#142: advances the active leg as successive fixes move the boat — shared index 0 -> 1 and the next-event readout flips from the tack to "no more maneuvers"', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN, <ActiveLegProbe />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));

    // Fix 1: 2 nm into leg 0 (spans 0-5 nm east of P0) — leg 0 is active and
    // the tack at leg 1's start is the next event ahead.
    act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));
    expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('0');
    expect(screen.getByText(/tack/i)).toBeInTheDocument();

    // Fix 2: 7 nm east of P0 = 2 nm into leg 1 (spans 5-10 nm) — by hand the
    // nearest leg is now leg 1, and with no legs after it there is no flagged
    // event ahead any more.
    const legOneFix = destinationPoint(P0, 90, 7);
    act(() => emitFix({ point: legOneFix, cogDeg: 90, sogKn: 5, accuracyM: 9 }));
    expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('1');
    expect(screen.getByText(/no more maneuvers/i)).toBeInTheDocument();
    expect(screen.queryByText(/tack/i)).not.toBeInTheDocument();
  });

  it('#142: unmounting LiveView resets the shared active leg index to null, so a stale highlight cannot outlive the Live tab', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    localStorage.setItem('sc-lang', 'en');
    const ui = (withLive: boolean) => (
      <I18nProvider>
        <AppStateProvider>
          <TestSetPlan plan={TEST_PLAN} />
          <ActiveLegProbe />
          {withLive && <LiveViewHost watchPosition={wp} />}
        </AppStateProvider>
      </I18nProvider>
    );
    const { rerender } = render(ui(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
    act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));
    expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('0');

    // Same provider tree, LiveView child removed (what leaving the Live tab
    // does in App.tsx) — the unmount-only effect must clear the shared index.
    rerender(ui(false));
    expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('none');
  });

  it('#142: toggling tracking off clears the readout data block (no stale HTS/ETA lingers)', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);
    const toggle = await screen.findByRole('button', { name: 'Start live view' });
    fireEvent.click(toggle); // on

    const expectedHts = formatTrueHeading(headingToSteerDeg(LEGS, 0, FIX_POINT));
    // COG 123.4, not 90: HTS on this due-east track is 090° and an identical
    // COG would render a second '090°', breaking the single-element query.
    act(() => emitFix({ point: FIX_POINT, cogDeg: 123.4, sogKn: 5, accuracyM: 9 }));
    expect(screen.getByText(expectedHts)).toBeInTheDocument();
    expect(screen.getByText(/projected eta/i)).toBeInTheDocument();

    fireEvent.click(toggle); // off — fix cleared, data block unrendered
    expect(screen.queryByText(expectedHts)).not.toBeInTheDocument();
    expect(screen.queryByText(/projected eta/i)).not.toBeInTheDocument();
  });

  describe('resume prompt (#1802)', () => {
    const WAS_TRACKING = 'sc-live-was-tracking';

    it('is absent on a first visit', async () => {
      const { wp } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);
      await screen.findByRole('button', { name: 'Start live view' });
      expect(screen.queryByText('Tracking stopped')).not.toBeInTheDocument();
    });

    it('appears after a reload with the was-tracking flag, starts no GPS until the tap, and Resume starts it', async () => {
      localStorage.setItem(WAS_TRACKING, '1');
      const { wp } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      expect(await screen.findByText('Tracking stopped')).toBeInTheDocument();
      expect(wp).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      expect(wp).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Tracking stopped')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop live view' })).toBeInTheDocument();
    });

    it('returning to the Live tab (remount) shows it again after tracking was running', async () => {
      const first = fakeWatchPosition();
      const { unmount } = renderLive(first.wp, TEST_PLAN);
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      expect(localStorage.getItem(WAS_TRACKING)).toBe('1');
      unmount();
      cleanup();

      const second = fakeWatchPosition();
      renderLive(second.wp, TEST_PLAN);
      expect(await screen.findByText('Tracking stopped')).toBeInTheDocument();
      expect(second.wp).not.toHaveBeenCalled();
    });

    it('an explicit Stop clears the flag, so the prompt does not return', async () => {
      const first = fakeWatchPosition();
      const { unmount } = renderLive(first.wp, TEST_PLAN);
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      fireEvent.click(screen.getByRole('button', { name: 'Stop live view' }));
      expect(localStorage.getItem(WAS_TRACKING)).toBe('0');
      expect(screen.queryByText('Tracking stopped')).not.toBeInTheDocument();
      unmount();
      cleanup();

      const second = fakeWatchPosition();
      renderLive(second.wp, TEST_PLAN);
      await screen.findByRole('button', { name: 'Start live view' });
      expect(screen.queryByText('Tracking stopped')).not.toBeInTheDocument();
    });
  });

  describe('wake lock (#1801)', () => {
    class FakeSentinel extends EventTarget {
      release = vi.fn(async () => {
        this.dispatchEvent(new Event('release'));
      });
    }
    let sentinels: FakeSentinel[];
    let request: ReturnType<typeof vi.fn>;

    function installWakeLock() {
      request = vi.fn(async () => {
        const s = new FakeSentinel();
        sentinels.push(s);
        return s;
      });
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    }

    beforeEach(() => {
      sentinels = [];
      installWakeLock();
    });
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'wakeLock');
    });

    const flush = () => act(async () => {});
    const checkbox = () => screen.getByRole('checkbox', { name: 'Keep screen on while tracking' });

    it('is requested by default while tracking and the indicator says so', async () => {
      const { wp } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);
      await screen.findByRole('button', { name: 'Start live view' });
      expect(request).not.toHaveBeenCalled();
      expect(checkbox()).toBeChecked();

      fireEvent.click(screen.getByRole('button', { name: 'Start live view' }));
      await flush();
      expect(request).toHaveBeenCalledExactlyOnceWith('screen');
      expect(screen.getByText('Screen is kept awake')).toBeInTheDocument();
    });

    it("follows the sentinel's release event, not only the request", async () => {
      const { wp } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      await flush();
      expect(screen.getByText('Screen is kept awake')).toBeInTheDocument();

      act(() => void sentinels[0].dispatchEvent(new Event('release')));
      expect(screen.getByText('Screen may sleep — keep-awake is not active')).toBeInTheDocument();
      expect(screen.queryByText('Screen is kept awake')).not.toBeInTheDocument();
    });

    it('the toggle releases the lock, is remembered across a remount, and keeps the lock off', async () => {
      const first = fakeWatchPosition();
      const { unmount } = renderLive(first.wp, TEST_PLAN);
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      await flush();

      fireEvent.click(checkbox());
      await flush();
      expect(sentinels[0].release).toHaveBeenCalled();
      expect(screen.getByText('Screen may sleep — keep-awake is off')).toBeInTheDocument();
      expect(localStorage.getItem('sc-live-wake-lock')).toBe('0');
      unmount();
      cleanup();

      request.mockClear();
      const second = fakeWatchPosition();
      renderLive(second.wp, TEST_PLAN);
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      await flush();
      expect(checkbox()).not.toBeChecked();
      expect(request).not.toHaveBeenCalled();
    });

    it('releases on Stop and when Live is left', async () => {
      const first = fakeWatchPosition();
      const { unmount } = renderLive(first.wp, TEST_PLAN);
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Stop live view' }));
      await flush();
      expect(sentinels[0].release).toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Start live view' }));
      await flush();
      expect(sentinels).toHaveLength(2);
      unmount();
      await flush();
      expect(sentinels[1].release).toHaveBeenCalled();
    });

    it('says so when the API is unsupported, with no toggle', async () => {
      Reflect.deleteProperty(navigator, 'wakeLock');
      const { wp } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);
      await screen.findByRole('button', { name: 'Start live view' });
      expect(
        screen.getByText('Screen may sleep — not supported on this browser'),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('checkbox', { name: 'Keep screen on while tracking' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('harbour handover notice (#1721)', () => {
    it('shows live.handover only for a plan routed from/to a handover point', async () => {
      if (TEST_PLAN.result.status !== 'ok') throw new Error('fixture must be ok');
      const handoverPlan: Plan = {
        ...TEST_PLAN,
        result: withHarborHandover(TEST_PLAN.result, { origin: true }),
      };
      const { wp } = fakeWatchPosition();
      const { unmount } = renderLive(wp, handoverPlan);
      expect(await screen.findByText(/the route is not computed/)).toBeInTheDocument();
      unmount();
      cleanup();

      renderLive(wp, TEST_PLAN);
      await screen.findByRole('button', { name: 'Start live view' });
      expect(screen.queryByText(/the route is not computed/)).not.toBeInTheDocument();
    });
  });

  describe('docking above the bottom sheet (narrow layout)', () => {
    let sheet: HTMLElement;
    let sheetHeight = 123;
    let resize: (() => void) | null = null;
    const disconnect = vi.fn();

    beforeEach(() => {
      sheetHeight = 123;
      resize = null;
      sheet = document.createElement('div');
      sheet.className = 'app-bottom-sheet';
      Object.defineProperty(sheet, 'offsetHeight', { get: () => sheetHeight });
      document.body.appendChild(sheet);
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            resize = cb;
          }
          observe() {}
          disconnect = disconnect;
        },
      );
    });
    afterEach(() => {
      sheet.remove();
      vi.unstubAllGlobals();
      disconnect.mockClear();
    });

    const card = () => document.querySelector<HTMLElement>('.live-view');

    it('publishes the measured sheet height on the card and follows later resizes', async () => {
      const { wp } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);
      await screen.findByRole('button', { name: 'Start live view' });
      expect(card()?.style.getPropertyValue('--live-sheet-h')).toBe('123px');
      sheetHeight = 200;
      act(() => resize?.());
      expect(card()?.style.getPropertyValue('--live-sheet-h')).toBe('200px');
    });

    it('stops observing on unmount', async () => {
      const { wp } = fakeWatchPosition();
      const { unmount } = renderLive(wp, TEST_PLAN);
      await screen.findByRole('button', { name: 'Start live view' });
      unmount();
      expect(disconnect).toHaveBeenCalled();
    });

    it('does not measure when the readout is portaled into the wide panel column', async () => {
      const slot = document.createElement('div');
      document.body.appendChild(slot);
      localStorage.setItem('sc-lang', 'en');
      const { wp } = fakeWatchPosition();
      render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={TEST_PLAN} />
            <LiveViewHost watchPosition={wp} panelSlot={slot} />
          </AppStateProvider>
        </I18nProvider>,
      );
      await screen.findByRole('button', { name: 'Start live view' });
      expect(
        slot.querySelector<HTMLElement>('.live-view')?.style.getPropertyValue('--live-sheet-h'),
      ).toBe('');
      slot.remove();
    });
  });

  describe('GPS states (#1802)', () => {
    const REROUTE_NAME = 'Replan route from here';
    const goodFix = (accuracyM = 9): GpsFix => ({
      point: FIX_POINT,
      cogDeg: 123.4,
      sogKn: 5,
      accuracyM,
    });
    const HTS = () => formatTrueHeading(headingToSteerDeg(LEGS, 0, FIX_POINT));

    afterEach(() => vi.useRealTimers());

    // Fake timers go on AFTER the async plan/toggle lookup (findBy polls on
    // real timers) and BEFORE tracking starts, so the hook's receipt clock is
    // the faked one.
    async function startTracking() {
      const w = fakeWatchPosition();
      localStorage.setItem('sc-lang', 'en');
      const view = render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={TEST_PLAN} />
            <LiveViewHost
              watchPosition={w.wp}
              reroute={{ busy: false, rerouting: false, onReroute: vi.fn() }}
            />
          </AppStateProvider>
        </I18nProvider>,
      );
      const toggle = await screen.findByRole('button', { name: 'Start live view' });
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance', 'Date'] });
      fireEvent.click(toggle);
      return { ...w, view };
    }
    const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

    it('waiting: shows the waiting status and a waiting reason on the disabled reroute button', async () => {
      await startTracking();
      expect(screen.getByText('Waiting for GPS fix…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeDisabled();
      expect(screen.getByText('Waiting for a GPS fix.')).toBeInTheDocument();
    });

    it('fresh: no stale badge, readouts at full strength', async () => {
      const { emitFix } = await startTracking();
      act(() => emitFix(goodFix()));
      expect(screen.getByText(HTS())).toBeInTheDocument();
      expect(screen.queryByText(/^Stale,/)).not.toBeInTheDocument();
      expect(document.querySelector('.live-view-data--stale')).toBeNull();
      expect(screen.queryByText('Waiting for GPS fix…')).not.toBeInTheDocument();
    });

    it('stale: shows the age badge and dims the readout, HTS included, while values stay visible', async () => {
      const { emitFix } = await startTracking();
      act(() => emitFix(goodFix()));
      advance(10_000);
      expect(screen.getByText('Stale, 10 s old')).toBeInTheDocument();
      const data = document.querySelector('.live-view-data--stale');
      expect(data).not.toBeNull();
      expect(data).toContainElement(screen.getByText(HTS()));
      expect(screen.getByText(/projected eta/i)).toBeInTheDocument();
      advance(5_000);
      expect(screen.getByText('Stale, 15 s old')).toBeInTheDocument();
    });

    it('stale: the depth caution is dimmed together with the heading', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(2.1);
      const { emitFix } = await startTracking();
      act(() => emitFix(goodFix()));
      await act(async () => {
        await Promise.resolve();
      });
      advance(10_000);
      const note = screen.getByText(/Bearing crosses 2\.1 m/);
      expect(document.querySelector('.live-view-data--stale')).toContainElement(note);
    });

    it('lost: hides heading, its caution, COG, SOG, ETA and next event; shows the last fix time and position', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(2.1);
      const { emitFix } = await startTracking();
      act(() => emitFix(goodFix()));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(/Bearing crosses 2\.1 m/)).toBeInTheDocument();
      advance(30_000);

      expect(screen.getByText('GPS signal lost')).toBeInTheDocument();
      expect(screen.queryByText(HTS())).not.toBeInTheDocument();
      expect(document.querySelector('.live-view-hts')).toBeNull();
      expect(document.querySelector('.live-view-hts-note')).toBeNull();
      expect(screen.queryByText('HTS')).not.toBeInTheDocument();
      expect(screen.queryByText('COG')).not.toBeInTheDocument();
      expect(screen.queryByText('SOG')).not.toBeInTheDocument();
      expect(screen.queryByText(/projected eta/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/next in/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Stale,/)).not.toBeInTheDocument();
      expect(
        screen.getByText(new RegExp(`Last fix .* at ${formatLatLon(FIX_POINT)}`)),
      ).toBeInTheDocument();
    });

    it('#1803: the distance, leg and cross-track rows are dimmed with the readout while stale', async () => {
      const { emitFix } = await startTracking();
      act(() => emitFix(goodFix()));
      const progress = document.querySelector('.live-view-progress');
      expect(progress?.closest('.live-view-data')).not.toHaveClass('live-view-data--stale');
      advance(10_000);
      expect(progress?.closest('.live-view-data')).toHaveClass('live-view-data--stale');
      expect(within(progress as HTMLElement).getByText('To go, route')).toBeInTheDocument();
    });

    it('#1803: the new rows are hidden while lost, with the data block still mounted', async () => {
      const { emitFix } = await startTracking();
      act(() => emitFix(goodFix()));
      expect(document.querySelector('.live-view-progress')).not.toBeNull();
      advance(30_000);
      expect(screen.getByText('GPS signal lost')).toBeInTheDocument();
      expect(document.querySelector('.live-view-progress')).toBeNull();
      expect(document.querySelector('.live-view-data')).not.toBeNull();
    });

    it('lost then fresh keeps the same readout element mounted (RouteLayer reads its presence as Live active)', async () => {
      const { emitFix } = await startTracking();
      act(() => emitFix(goodFix()));
      const data = document.querySelector('.live-view-data');
      expect(data).not.toBeNull();
      advance(30_000);
      expect(screen.getByText('GPS signal lost')).toBeInTheDocument();
      expect(data?.isConnected).toBe(true);
      expect(document.querySelector('.live-view-data')).toBe(data);
      act(() => emitFix(goodFix()));
      expect(document.querySelector('.live-view-data')).toBe(data);
      expect(screen.getByText(HTS())).toBeInTheDocument();
    });

    it('does not mount the readout element before the first fix', async () => {
      await startTracking();
      expect(document.querySelector('.live-view-data')).toBeNull();
    });

    it('the stale badge is a status region announcing a static message, with the ticking age hidden from it', async () => {
      const { emitFix } = await startTracking();
      act(() => emitFix(goodFix()));
      advance(10_000);
      const badge = document.querySelector('.live-view-gps-stale');
      expect(badge).toHaveAttribute('role', 'status');
      expect(badge?.querySelector('[aria-hidden="true"]')).toHaveTextContent('Stale, 10 s old');
      expect(badge?.querySelector('.sr-only')).toHaveTextContent('GPS position is stale');
    });

    it('lost: reroute is disabled with the lost reason; a fresh fix restores readouts and clears the state', async () => {
      const { emitFix } = await startTracking();
      act(() => emitFix(goodFix()));
      advance(30_000);
      expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeDisabled();
      expect(
        screen.getByText(/replanning is unavailable until a new fix arrives/),
      ).toBeInTheDocument();

      act(() => emitFix(goodFix()));
      expect(screen.queryByText('GPS signal lost')).not.toBeInTheDocument();
      expect(screen.getByText(HTS())).toBeInTheDocument();
      expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeEnabled();
    });

    it('denied: shows recovery copy distinct from loss, hides readouts, and disables reroute with a denied reason', async () => {
      const { emitFix, emitError } = await startTracking();
      act(() => emitFix(goodFix()));
      act(() => emitError('denied'));
      expect(screen.getByText('Location access is blocked')).toBeInTheDocument();
      expect(screen.getByText(/Allow location for this site/)).toBeInTheDocument();
      expect(screen.queryByText('GPS signal lost')).not.toBeInTheDocument();
      expect(screen.queryByText(HTS())).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeDisabled();
      expect(screen.getByText(/Location access is blocked — replanning/)).toBeInTheDocument();
    });

    it('denied shows every time, not once ever (a remount after a prior denial shows it again)', async () => {
      const first = await startTracking();
      act(() => first.emitError('denied'));
      expect(screen.getByText('Location access is blocked')).toBeInTheDocument();
      first.view.unmount();
      cleanup();
      vi.useRealTimers();

      const second = await startTracking();
      act(() => second.emitError('denied'));
      expect(screen.getByText('Location access is blocked')).toBeInTheDocument();
    });

    it('timeout and unavailable errors never change what the card shows', async () => {
      const { emitFix, emitError } = await startTracking();
      act(() => emitFix(goodFix()));
      act(() => emitError('timeout'));
      act(() => emitError('unavailable'));
      expect(screen.getByText(HTS())).toBeInTheDocument();
      expect(screen.queryByText('Location access is blocked')).not.toBeInTheDocument();
      expect(screen.queryByText('GPS signal lost')).not.toBeInTheDocument();
    });

    it('accuracy: the disabled reroute button states the current accuracy and the threshold; a good fix enables it', async () => {
      const { emitFix } = await startTracking();
      act(() => emitFix(goodFix(150.4)));
      expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeDisabled();
      expect(
        screen.getByText('GPS accuracy of 150 m is worse than the 100 m limit for replanning.'),
      ).toBeInTheDocument();
      act(() => emitFix(goodFix(50)));
      expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeEnabled();
      expect(screen.queryByText(/worse than the/)).not.toBeInTheDocument();
    });

    it('the reroute button is described by its reason text', async () => {
      await startTracking();
      const button = screen.getByRole('button', { name: REROUTE_NAME });
      const reason = document.getElementById(button.getAttribute('aria-describedby') ?? '');
      expect(reason).toHaveTextContent('Waiting for a GPS fix.');
    });

    it('does not show GPS states while tracking is off', async () => {
      const w = fakeWatchPosition();
      renderLive(w.wp, TEST_PLAN);
      await screen.findByRole('button', { name: 'Start live view' });
      expect(screen.queryByText('Waiting for GPS fix…')).not.toBeInTheDocument();
    });
  });

  it('renders its readout into the provided panel slot via a portal, with no map instance required', async () => {
    // #31: the wide layout passes a panel-column DOM node; the textual readout
    // must render into it (not inline in MapView's subtree, the base
    // bottom-sheet-region card), and the branch needs no MapView/map context —
    // only BoatMarker would, and it renders null without a map. Proving the
    // toggle+fix land inside `slot` and NOT in the render container is the split
    // contract this task hangs on.
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    localStorage.setItem('sc-lang', 'en');
    const { wp, emitFix } = fakeWatchPosition();

    const { container } = render(
      <I18nProvider>
        <AppStateProvider>
          <TestSetPlan plan={TEST_PLAN} />
          <LiveViewHost watchPosition={wp} panelSlot={slot} />
        </AppStateProvider>
      </I18nProvider>,
    );

    const toggle = await within(slot).findByRole('button', { name: 'Start live view' });
    expect(within(container).queryByRole('button', { name: 'Start live view' })).toBeNull();

    fireEvent.click(toggle);
    act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

    expect(within(slot).getByText('5.0 kn')).toBeInTheDocument(); // SOG, inside the slot
    slot.remove();
  });

  it('toggling off unsubscribes from watchPosition', async () => {
    const { wp, unsubscribe } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);

    const toggle = await screen.findByRole('button', { name: 'Start live view' });
    fireEvent.click(toggle); // on
    expect(wp).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    fireEvent.click(toggle); // off
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  describe('heading depth check (#251)', () => {
    // The #251 invariant is STRUCTURAL, not any particular string: whenever
    // the heading-to-steer renders it must carry a depth annotation. Absence
    // is the failure mode, because a bare heading is DOM-identical to a
    // checked-and-clear one — so the user reads "checked, and clear" when
    // nothing was checked. Returns null exactly when no note is rendered.
    const depthAnnotation = () =>
      document.querySelector('.live-view-hts-note')?.textContent?.trim() ?? null;

    // A plan swap needs the provider tree kept mounted across the change, so
    // the GPS fix and the depth hold survive it — that is the state the two
    // reset tests below are about.
    function renderSwappable(wp: ReturnType<typeof fakeWatchPosition>['wp']) {
      localStorage.setItem('sc-lang', 'en');
      const ui = (plan: Plan) => (
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={plan} />
            <LiveViewHost watchPosition={wp} />
          </AppStateProvider>
        </I18nProvider>
      );
      const { rerender } = render(ui(TEST_PLAN));
      return { swapPlan: (plan: Plan) => rerender(ui(plan)) };
    }

    it('shows the depth caution with the measured depth when the bearing crosses shallow water', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(2.1);

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => {
        emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
      });

      // The literal measured depth (2.1) can only appear in the DOM if the
      // mocked mask actually loaded AND the probe actually ran — proving
      // this isn't a vacuous pass (e.g. a null mask collapsing to
      // 'unavailable', which renders a different, depth-free string).
      await screen.findByText(/Bearing crosses 2\.1 m/);
      expect(screen.getByText(/shallower than your safety depth \(3\.0 m\)/)).toBeInTheDocument();
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    });

    // #596: the SAME fixture as the English row above (mask/mocked-shallowest/
    // safety-depth all unchanged), rendered in German instead — `renderLive`
    // hardcodes 'en', so this bypasses it and builds the tree directly. Both
    // interpolated numbers (the measured 2.1 and the safety-depth 3.0) must
    // read with a decimal COMMA, matching every other depth figure this PR
    // fixed — a regression back to a bare `toFixed(1)` here would still pass
    // the English row above and only red in this one.
    it('#596: shows the depth caution with a German COMMA in both numbers', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(2.1);

      localStorage.setItem('sc-lang', 'de');
      const { wp, emitFix } = fakeWatchPosition();
      render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={TEST_PLAN} />
            <LiveViewHost watchPosition={wp} />
          </AppStateProvider>
        </I18nProvider>,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Live-Ansicht starten' }));
      act(() => {
        emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
      });

      await screen.findByText(/Peilung kreuzt 2,1 m/);
      expect(screen.getByText(/flacher als deine Sicherheitstiefe \(3,0 m\)/)).toBeInTheDocument();
      // The English-formatted numbers must never appear alongside the German
      // sentence — the mixed-convention shape #596 exists to close.
      expect(screen.queryByText(/2\.1 m/)).not.toBeInTheDocument();
      expect(screen.queryByText(/3\.0 m/)).not.toBeInTheDocument();
    });

    it('shows no depth note when the bearing is clear', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(null);

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => {
        emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
      });

      await screen.findByText(formatTrueHeading(headingToSteerDeg(LEGS, 0, FIX_POINT)));
      expect(screen.queryByText(/Bearing crosses/)).not.toBeInTheDocument();
      expect(screen.queryByText('Depth not checked')).not.toBeInTheDocument();
    });

    it('shows "Depth not checked" while the mask is unavailable', async () => {
      vi.mocked(loadRoutingAssets).mockRejectedValue(new Error('offline'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => {
        emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
      });

      await screen.findByText('Depth not checked');
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
    });

    it("#251 F1: a plan change re-probes the NEW route from the held fix — the heading is never left unannotated, and never keeps the superseded route's depth", async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      const probe = vi
        .spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow')
        .mockReturnValue(2.1);

      const { wp, emitFix } = fakeWatchPosition();
      const { swapPlan } = renderSwappable(wp);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 }));
      await screen.findByText(/Bearing crosses 2\.1 m/);

      // The rerouted plan's bearing measures a DIFFERENT depth. Two distinct
      // values are what let this test tell a fresh probe from a surviving
      // stale one at all — with the same number, both outcomes render
      // identical DOM and the assertion would prove nothing.
      probe.mockReturnValue(1.4);

      // A reroute supersedes the route the caution was measured against, so
      // the hysteresis resets (spec §3.2). NO new fix follows: the held fix
      // plus the loaded mask are enough to answer the new route's bearing, and
      // needing a fix that may never come is what left this stale.
      swapPlan(REROUTED_PLAN);

      // The invariant, at every point it can be observed.
      expect(depthAnnotation()).not.toBeNull();

      await screen.findByText(/Bearing crosses 1\.4 m/);
      expect(screen.queryByText(/Bearing crosses 2\.1 m/)).not.toBeInTheDocument();
      // Settles on a real measurement, not on the honest-but-stale fallback.
      expect(screen.queryByText('Depth not checked')).not.toBeInTheDocument();
      // The heading is still on screen: the requirement is that it is
      // ANNOTATED, not that the readout vanishes.
      expect(
        screen.getByText(formatTrueHeading(headingToSteerDeg(LEGS, 0, FIX_POINT))),
      ).toBeInTheDocument();
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    });

    it('#251 F1: a plan change with NO mask keeps the heading annotated with "Depth not checked" — the hold-key reset fallback', async () => {
      // The re-probe cannot run here (no mask), so this is the one path that
      // still exercises the hold-key reset itself. It must land on a rendered
      // state; before F1 it rendered no note at all.
      vi.mocked(loadRoutingAssets).mockRejectedValue(new Error('offline'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { wp, emitFix } = fakeWatchPosition();
      const { swapPlan } = renderSwappable(wp);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 }));
      await screen.findByText('Depth not checked');

      swapPlan(REROUTED_PLAN);

      expect(depthAnnotation()).toBe('Depth not checked');
      expect(
        screen.getByText(formatTrueHeading(headingToSteerDeg(LEGS, 0, FIX_POINT))),
      ).toBeInTheDocument();
      expect(warn).toHaveBeenCalled();
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    });

    it('#251: a fix outside mask coverage reports "Depth not checked" — never clear', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      // Deliberately NOT stubbed: checkHeadingDepth's coverage pre-check must
      // reject the fix before the grid walk is ever reached, so a never-called
      // spy is the assertion. An out-of-coverage walk returns null, which is
      // indistinguishable from "nothing shallow" — that is why the pre-check
      // exists rather than trusting the walk.
      const probe = vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow');

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      // MASK_META covers 54.5–55.0 N / 9.0–10.0 E; this is well south-west.
      act(() => emitFix({ point: { lat: 53.0, lon: 8.0 }, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

      await screen.findByText('Depth not checked');
      expect(probe).not.toHaveBeenCalled();
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    });

    it('#251 F2: a mask that resolves AFTER the last fix re-probes on arrival — no further fix required', async () => {
      // `never` for the same reason the sibling tests cast their resolved
      // value `as never`: the assets module is vi.mock'd, so its real
      // RoutingAssets type is not what this fixture needs to satisfy.
      let resolveAssets: (v: never) => void = () => {};
      vi.mocked(loadRoutingAssets).mockReturnValue(
        new Promise<never>((res) => {
          resolveAssets = res;
        }),
      );
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(2.1);

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 }));

      // Pre-condition: the ONLY fix this test ever emits landed while the mask
      // was still pending, so the readout is honestly "not checked".
      await screen.findByText('Depth not checked');

      await act(async () => {
        resolveAssets({ maskMeta: MASK_META, maskBuffer: fullyDeepMaskBuffer() } as never);
      });

      await screen.findByText(/Bearing crosses 2\.1 m/);
      expect(screen.queryByText('Depth not checked')).not.toBeInTheDocument();
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    });

    it('#251 F6: a bearing across charted land is reported as land, not as a 0.0 m sounding', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      // NavMask maps the LAND byte (0) to 0.0 m, so this is exactly what a
      // land crossing looks like coming out of segmentShallowestBelow.
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(0);

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 }));

      await screen.findByText('Bearing crosses charted land');
      expect(screen.queryByText(/crosses 0\.0 m/)).not.toBeInTheDocument();
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    });

    // #632: migratePlan.ts's migrateRequest never validates a stored plan's
    // `settings` field, so a record saved before it existed migrates with
    // the field simply MISSING rather than rejected — and a bare unguarded
    // read used to throw the instant the component evaluated, blanking the
    // whole app (no error boundary anywhere in app/src).
    //
    // THE VACUITY TRAP: 'Depth not checked' is produced by TWO independent
    // conditions — a null safetyDepthM (what this test is FOR) and a
    // null/failed mask (checkHeadingDepth's own 'unavailable' path). Using
    // the mask-unavailable setup here (mockRejectedValue) would pass even
    // with a `DEFAULT_SETTINGS.safetyDepthM` fail-open fallback shipped —
    // exactly the defect this row exists to catch. So this uses the SAME
    // healthy-mask setup as 'shows the depth caution...' above (a resolved
    // mask + segmentShallowestBelow spied to 2.1, well below any plausible
    // default safety depth): if the settings guard ever regressed to a
    // fabricated default, THIS setup would render the caution, not silently
    // stay clear.
    it('#632: a plan whose stored request is missing `settings` shows "Depth not checked" — never a fabricated caution — even with a healthy mask reporting shallow water on the exact bearing', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(2.1);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { settings: _dropped, ...requestWithoutSettings } = TEST_PLAN.request;
      const plan = {
        ...TEST_PLAN,
        id: 'live-plan-no-settings',
        request: requestWithoutSettings,
      } as unknown as Plan;

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, plan);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => {
        emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
      });

      // (a) Reaching this line already proves no throw — the earlier
      // render()/click()/act() calls above would have failed first. Kept
      // only for a readable failure message; per the brief this is a
      // theorem given (b) and (c), not independent evidence on its own.
      // (b) the honest degraded state renders...
      await screen.findByText('Depth not checked');
      // (c) ...and NOT a fabricated caution against a depth nobody chose —
      // this is the assertion the vacuity trap above is about, and the one
      // the required mutation check (swap the `safetyDepthM` guard's `null`
      // fallback, ~:171, for a default) must turn red.
      expect(screen.queryByText(/Bearing crosses/)).not.toBeInTheDocument();
    });

    // Discriminating control for the row above (required, not optional —
    // see its comment): the IDENTICAL healthy-mask setup, but with
    // `settings` present, must still show the depth caution. Without this,
    // a green result above could be proving the mask path rather than the
    // settings path — this is also exactly what 'shows the depth caution
    // with the measured depth...' above already demonstrates, restated here
    // explicitly so the pairing with the row above is undeniable rather than
    // merely implied by file order.
    it('#632 discriminating control: the identical healthy-mask setup WITH `settings` present still shows the depth caution', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(2.1);

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => {
        emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
      });

      await screen.findByText(/Bearing crosses 2\.1 m/);
    });

    // #632 review Important: Number.isFinite ALONE admits 0, -0 and any
    // negative number — and NavMask.segmentShallowestBelow compares
    // `depthM < thresholdM`, so at a non-positive threshold NOTHING is ever
    // shallower, charted LAND included. That collapses to `{state:'clear'}`,
    // which renders NO NOTE AT ALL — a note-less false all-clear, strictly
    // worse than the NaN crash the guard already caught (a crash is loud; a
    // silent all-clear on the on-water hazard path is not).
    //
    // Deliberately does NOT spy on segmentShallowestBelow (unlike every
    // sibling depth-check test above): a mocked return value ignores the
    // threshold argument entirely, which would make this test pass even
    // with the pre-fix `Number.isFinite`-only guard (0 is finite) — the
    // exact vacuity the reviewer flagged. Real mask, real NavMask, real
    // checkHeadingDepth, an all-LAND buffer, so the `depthM < thresholdM`
    // comparison the hazard depends on is genuinely exercised.
    it('#632 review: a stored safetyDepthM of 0 shows "Depth not checked" — never a silent no-note all-clear, even crossing charted land', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyLandMaskBuffer(),
      } as never);

      const plan: Plan = {
        ...TEST_PLAN,
        id: 'live-plan-zero-safety-depth',
        request: { ...TEST_PLAN.request, settings: { ...DEFAULT_SETTINGS, safetyDepthM: 0 } },
      };

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, plan);

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => {
        emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
      });

      // The honest degraded state renders...
      await screen.findByText('Depth not checked');
      // ...and — the assertion that actually discriminates the defect —
      // some depth-annotation element exists at all. `depthAnnotation()`
      // (defined above) returns null ONLY when no `.live-view-hts-note`
      // element is in the DOM, which is exactly the note-less 'clear' state
      // this row exists to rule out.
      expect(depthAnnotation()).not.toBeNull();
      expect(screen.queryByText(/Bearing crosses/)).not.toBeInTheDocument();
    });
  });

  // #115 manual "reroute from here" — only rendered when App wires the
  // controls prop; enabled exactly when a current GPS fix exists and no
  // solver run is in flight; the action itself never starts GPS.
  describe('reroute from here (#115)', () => {
    const REROUTE_NAME = 'Replan route from here';

    function renderWithReroute(
      wp: ReturnType<typeof fakeWatchPosition>['wp'],
      controls: { busy: boolean; rerouting: boolean; onReroute: (p: unknown) => void },
    ) {
      localStorage.setItem('sc-lang', 'en');
      return render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={TEST_PLAN} />
            <LiveViewHost watchPosition={wp} reroute={controls} />
          </AppStateProvider>
        </I18nProvider>,
      );
    }

    it('renders no reroute action at all when the controls prop is absent', async () => {
      const { wp } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);
      await screen.findByRole('button', { name: 'Start live view' });
      expect(screen.queryByRole('button', { name: REROUTE_NAME })).not.toBeInTheDocument();
    });

    it('is disabled with a needs-a-fix hint while there is no GPS fix (tracking off), and never auto-starts GPS', async () => {
      const { wp } = fakeWatchPosition();
      const onReroute = vi.fn();
      renderWithReroute(wp, { busy: false, rerouting: false, onReroute });

      const button = await screen.findByRole('button', { name: REROUTE_NAME });
      expect(button).toBeDisabled();
      expect(screen.getByText(/needs an active gps fix/i)).toBeInTheDocument();
      // Rendering the disabled action must not have subscribed to GPS.
      expect(wp).not.toHaveBeenCalled();

      fireEvent.click(button);
      expect(onReroute).not.toHaveBeenCalled();
    });

    it('enables once a fix arrives, switches the hint to planning-aid copy, and passes the exact fix point on click', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      const onReroute = vi.fn();
      renderWithReroute(wp, { busy: false, rerouting: false, onReroute });

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

      const button = screen.getByRole('button', { name: REROUTE_NAME });
      expect(button).toBeEnabled();
      expect(screen.queryByText(/needs an active gps fix/i)).not.toBeInTheDocument();
      expect(screen.getByText(/planning aid, not navigation guidance/i)).toBeInTheDocument();

      fireEvent.click(button);
      expect(onReroute).toHaveBeenCalledTimes(1);
      expect(onReroute).toHaveBeenCalledWith(FIX_POINT);
    });

    it('a stale fix cannot fire a reroute: toggling tracking off clears the fix and disables the action again', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      const onReroute = vi.fn();
      renderWithReroute(wp, { busy: false, rerouting: false, onReroute });

      const toggle = await screen.findByRole('button', { name: 'Start live view' });
      fireEvent.click(toggle); // on
      act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));
      expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeEnabled();

      fireEvent.click(toggle); // off — fix cleared
      const button = screen.getByRole('button', { name: REROUTE_NAME });
      expect(button).toBeDisabled();
      expect(screen.getByText(/needs an active gps fix/i)).toBeInTheDocument();
    });

    it('is disabled when the fix accuracy is worse than the threshold, enabled at the threshold', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      const onReroute = vi.fn();
      renderWithReroute(wp, { busy: false, rerouting: false, onReroute });

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 100.5 }));
      expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeDisabled();

      act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 100 }));
      expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeEnabled();
    });

    it('a lost fix (30 s without a new one) hides the readout and disables reroute; a new fix restores both', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      const onReroute = vi.fn();
      renderWithReroute(wp, { busy: false, rerouting: false, onReroute });

      const toggle = await screen.findByRole('button', { name: 'Start live view' });
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance', 'Date'] });
      try {
        fireEvent.click(toggle);
        act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));
        expect(document.querySelector('.live-view-hts')).not.toBeNull();

        act(() => void vi.advanceTimersByTime(15_000));
        expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeEnabled();
        expect(document.querySelector('.live-view-hts')).not.toBeNull();

        act(() => void vi.advanceTimersByTime(15_000));
        expect(document.querySelector('.live-view-hts')).toBeNull();
        expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeDisabled();

        act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));
        expect(document.querySelector('.live-view-hts')).not.toBeNull();
        expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a fix already held by the ownship watch is not shown as live before tracking starts', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      localStorage.setItem('sc-lang', 'en');
      render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={TEST_PLAN} />
            <LiveViewHost watchPosition={wp} showOwnship />
          </AppStateProvider>
        </I18nProvider>,
      );
      await screen.findByRole('button', { name: 'Start live view' });
      act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));
      expect(document.querySelector('.live-view-hts')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Start live view' }));
      expect(document.querySelector('.live-view-hts')).not.toBeNull();
      expect(wp).toHaveBeenCalledTimes(1);
    });

    it('is disabled while ANY solver run is busy, and shows the in-flight label for its own solve', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      const onReroute = vi.fn();
      renderWithReroute(wp, { busy: true, rerouting: true, onReroute });

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

      const button = screen.getByRole('button', {
        name: 'Replanning route from current position…',
      });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(onReroute).not.toHaveBeenCalled();
    });
  });

  // #143: the Live-view simulator must never open a path to savePlan (spike
  // docs/spikes/749-live-view-demo-mode.md §7.2 precondition 2, shape 1) —
  // the reroute action is disabled outright while the simulator drives this
  // session's fix, with a distinct hint explaining why, regardless of
  // whether a fix is present.
  describe('#143 Live simulator disables the reroute action', () => {
    it("has no effect when the gate is open but '?liveSim' is absent from the URL (the default test URL)", async () => {
      const { wp, emitFix } = fakeWatchPosition();
      const onReroute = vi.fn();
      localStorage.setItem('sc-lang', 'en');
      render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={TEST_PLAN} />
            <LiveViewHost
              watchPosition={wp}
              reroute={{ busy: false, rerouting: false, onReroute }}
            />
          </AppStateProvider>
        </I18nProvider>,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

      expect(screen.getByRole('button', { name: 'Replan route from here' })).toBeEnabled();
      expect(document.querySelector('.live-sim-controls')).toBeNull();
    });

    it("disables the action and renders the simulator panel when '?liveSim' IS requested — even with a real fix present", async () => {
      vi.mocked(isLiveSimRequested).mockReturnValue(true);
      const { wp, emitFix } = fakeWatchPosition();
      const onReroute = vi.fn();
      localStorage.setItem('sc-lang', 'en');
      render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={TEST_PLAN} />
            <LiveViewHost
              watchPosition={wp}
              reroute={{ busy: false, rerouting: false, onReroute }}
            />
          </AppStateProvider>
        </I18nProvider>,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

      const button = screen.getByRole('button', { name: 'Replan route from here' });
      expect(button).toBeDisabled();
      expect(screen.getByText(/live simulator is running/i)).toBeInTheDocument();
      fireEvent.click(button);
      expect(onReroute).not.toHaveBeenCalled();
      expect(document.querySelector('.live-sim-controls')).not.toBeNull();
    });

    it('#1486 review, wave 2: wires the active plan’s legs into the controller as a route (mount and unmount)', async () => {
      vi.mocked(isLiveSimRequested).mockReturnValue(true);
      const controller = getLiveSimController();
      const setRoute = vi.spyOn(controller, 'setRoute');
      const { wp } = fakeWatchPosition();
      localStorage.setItem('sc-lang', 'en');
      render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={TEST_PLAN} />
            <LiveViewHost watchPosition={wp} />
          </AppStateProvider>
        </I18nProvider>,
      );

      await screen.findByRole('button', { name: 'Start live view' });
      expect(setRoute).toHaveBeenCalledWith([P0, P1, P2]);

      cleanup();
      expect(setRoute).toHaveBeenLastCalledWith(null);
    });
  });

  // #697: the visual fix for the depth-caution note is deliberately CSS-only
  // — this asserts on the CAUTION NOTE ELEMENT itself (not a document-wide
  // query, unlike the seven pre-existing `[role="alert"]` toHaveLength(0)
  // assertions above), so it would still catch a role="alert" added ONLY to
  // this one element.
  describe('#697: caution note stays visual-only (no role="alert")', () => {
    it('the rendered .live-view-hts-note--caution element carries no role attribute', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(2.1);

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => {
        emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
      });

      await screen.findByText(/Bearing crosses 2\.1 m/);
      const note = document.querySelector('.live-view-hts-note--caution');
      expect(note).not.toBeNull();
      expect(note).not.toHaveAttribute('role');
    });
  });

  // #700: the toggle's visible label AND appearance must both track tracking
  // state — aria-pressed alone is invisible to a sighted user. Checks the
  // Button-primitive variant class directly (not just the label text) so a
  // fix that only swapped the string, and left `variant` fixed, would still
  // red this row.
  describe('GPS toggle visible state (#700)', () => {
    it('shows the off/"start" label and the secondary (outline) variant before tracking starts, then the on/"stop" label and the primary (filled) variant once toggled', async () => {
      const { wp } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      const toggle = await screen.findByRole('button', { name: 'Start live view' });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      expect(toggle).toHaveClass('sc-btn-secondary');
      expect(toggle).not.toHaveClass('sc-btn-primary');

      fireEvent.click(toggle);

      const toggledOn = screen.getByRole('button', { name: 'Stop live view' });
      expect(toggledOn).toBe(toggle); // same element, not a re-render swap
      expect(toggledOn).toHaveAttribute('aria-pressed', 'true');
      expect(toggledOn).toHaveClass('sc-btn-primary');
      expect(toggledOn).not.toHaveClass('sc-btn-secondary');
      // The neutral pre-#700 label must not survive under EITHER state.
      expect(screen.queryByRole('button', { name: 'Live view' })).not.toBeInTheDocument();
    });
  });

  // #713: HTS/COG/SOG/ETA are the readout a sailor glances at once a second;
  // digits must not shift width across updates, and 'HTS' needs a
  // screen-reader expansion since (unlike COG/SOG) it isn't a near-universal
  // abbreviation.
  describe('numeric readout formatting (#713)', () => {
    it('applies tabular-nums to the HTS value, both COG/SOG dds, and the ETA line', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 }));

      expect(document.querySelector('.live-view-hts-value')).toHaveClass('tabular-nums');
      const dds = Array.from(document.querySelectorAll('.live-view-cogsog dd'));
      expect(dds).toHaveLength(2);
      for (const dd of dds) expect(dd).toHaveClass('tabular-nums');
      expect(document.querySelector('.live-view-eta')).toHaveClass('tabular-nums');
    });

    it('gives an English screen reader an expansion of "HTS"; German needs none since its visible label is already the full word', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN); // renderLive hardcodes 'en'
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 }));

      const label = document.querySelector('.live-view-label');
      expect(label?.textContent?.trim()).toBe('HTS Heading to steer');
      expect(label?.querySelector('.sr-only')).not.toBeNull();

      cleanup();
      localStorage.setItem('sc-lang', 'de');
      const { wp: wpDe, emitFix: emitFixDe } = fakeWatchPosition();
      render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={TEST_PLAN} />
            <LiveViewHost watchPosition={wpDe} />
          </AppStateProvider>
        </I18nProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Live-Ansicht starten' }));
      act(() => emitFixDe({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 }));

      const deLabel = document.querySelector('.live-view-label');
      expect(deLabel?.textContent?.trim()).toBe('Steuerkurs');
      expect(deLabel?.querySelector('.sr-only')).toBeNull();
    });
  });
  describe('readouts: distance to go, leg N of M, cross-track error (#1803)', () => {
    const emit = (emitFix: (f: GpsFix) => void, point: GpsFix['point']) =>
      act(() => emitFix({ point, cogDeg: 91.4, sogKn: 5, accuracyM: 9 }));
    const progress = () => document.querySelector<HTMLElement>('.live-view-progress');
    const rowOf = (label: string) => {
      const dt = within(progress()!).getByText(label);
      return dt.nextElementSibling as HTMLElement;
    };

    async function start() {
      const w = fakeWatchPosition();
      renderLive(w.wp, TEST_PLAN, <ActiveLegProbe />);
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      return w;
    }

    it('renders leg position, leg and route distance to go and the cross-track side from a hand-checkable fix', async () => {
      const { emitFix } = await start();
      // 2 nm into leg 0 (of 5), 0.12 nm north of it: port when travelling east.
      emit(emitFix, destinationPoint(FIX_POINT, 0, 0.12));
      expect(rowOf('Leg')).toHaveTextContent('1 of 2');
      expect(rowOf('To go, leg')).toHaveTextContent('3.00 nm');
      expect(rowOf('To go, route')).toHaveTextContent('8.0 nm');
      expect(rowOf('Off track')).toHaveTextContent('0.12 nm port of track');
    });

    it('names the starboard side for a fix south of the track', async () => {
      const { emitFix } = await start();
      emit(emitFix, destinationPoint(FIX_POINT, 180, 0.12));
      expect(rowOf('Off track')).toHaveTextContent('0.12 nm starboard of track');
    });

    it('German labels, decimal comma and side words', async () => {
      localStorage.setItem('sc-lang', 'de');
      const { wp, emitFix } = fakeWatchPosition();
      render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={TEST_PLAN} />
            <LiveViewHost watchPosition={wp} />
          </AppStateProvider>
        </I18nProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Live-Ansicht starten' }));
      emit(emitFix, destinationPoint(FIX_POINT, 0, 0.12));
      expect(rowOf('Etappe')).toHaveTextContent('1 von 2');
      expect(rowOf('Rest, Etappe')).toHaveTextContent('3,00 nm');
      expect(rowOf('Rest, Route')).toHaveTextContent('8,0 nm');
      expect(rowOf('Querablage')).toHaveTextContent('0,12 nm Backbord der Route');
    });

    it('labels the heading-to-steer and COG readouts as true', async () => {
      const { emitFix } = await start();
      emit(emitFix, FIX_POINT);
      expect(document.querySelector('.live-view-hts-value')).toHaveTextContent(/^090°T$/);
      expect(document.querySelector('.live-view-cogsog dd')).toHaveTextContent(/^091°T$/);
    });

    it('shows the distance with no side inside the deadband, and the side again just outside it', async () => {
      const { emitFix } = await start();
      emit(emitFix, destinationPoint(FIX_POINT, 0, XTE_SIDE_DEADBAND_NM * 0.9));
      expect(rowOf('Off track').textContent).toBe('0.01 nm');
      emit(emitFix, destinationPoint(FIX_POINT, 0, 0.02));
      expect(rowOf('Off track').textContent).toBe('0.02 nm port of track');
    });

    it('shows a dash, never a side or an endpoint distance, when the fix is beyond the end of the last leg', async () => {
      const { emitFix } = await start();
      emit(emitFix, destinationPoint(P0, 90, 11));
      expect(rowOf('Off track').textContent).toBe('—');
      emit(emitFix, destinationPoint(P0, 90, -1));
      expect(rowOf('Off track').textContent).toBe('—');
    });

    it('hysteresis: noise around a joint keeps the leg, for the readout and the shared highlight alike', async () => {
      const { emitFix } = await start();
      emit(emitFix, destinationPoint(P0, 90, 7));
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('1');
      expect(rowOf('Leg')).toHaveTextContent('2 of 2');
      // 0.01 nm short of the joint: leg 0 is nearer, but not by the margin.
      emit(emitFix, destinationPoint(P0, 90, 4.99));
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('1');
      expect(rowOf('Leg')).toHaveTextContent('2 of 2');
      // Clearly back on leg 0.
      emit(emitFix, destinationPoint(P0, 90, 4));
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('0');
      expect(rowOf('Leg')).toHaveTextContent('1 of 2');
    });

    it('a plan change resets the hysteresis and republishes the highlight', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      localStorage.setItem('sc-lang', 'en');
      const ui = (plan: Plan) => (
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={plan} />
            <ActiveLegProbe />
            <LiveViewHost watchPosition={wp} />
          </AppStateProvider>
        </I18nProvider>
      );
      const { rerender } = render(ui(TEST_PLAN));
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      emit(emitFix, destinationPoint(P0, 90, 7));
      emit(emitFix, destinationPoint(P0, 90, 4.99));
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('1');

      rerender(ui(REROUTED_PLAN));
      // Nearest leg for the held fix, not the stale index.
      expect(await screen.findByText('1 of 2')).toBeInTheDocument();
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('0');
    });

    it('a recalculation that keeps the plan id but changes createdAtMs resets the hysteresis', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      localStorage.setItem('sc-lang', 'en');
      const ui = (plan: Plan) => (
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={plan} />
            <ActiveLegProbe />
            <LiveViewHost watchPosition={wp} />
          </AppStateProvider>
        </I18nProvider>
      );
      const { rerender } = render(ui(TEST_PLAN));
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      emit(emitFix, destinationPoint(P0, 90, 7));
      emit(emitFix, destinationPoint(P0, 90, 4.99));
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('1');

      rerender(ui({ ...TEST_PLAN, createdAtMs: TEST_PLAN.createdAtMs + 1 }));
      expect(await screen.findByText('1 of 2')).toBeInTheDocument();
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('0');
    });

    it('switching the rig resets the hysteresis', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      localStorage.setItem('sc-lang', 'en');
      const genoa = TEST_PLAN.result.sails[0];
      const bothRigs: Plan = {
        ...TEST_PLAN,
        result: {
          ...TEST_PLAN.result,
          sails: [
            genoa,
            { ...genoa, sailId: 'fock', result: { ...genoa.result!, sailId: 'fock' } },
          ],
        },
      };
      function SwitchRig() {
        const { setRig } = useActivePlan();
        return <button onClick={() => setRig('fock')}>switch rig</button>;
      }
      render(
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={bothRigs} />
            <ActiveLegProbe />
            <SwitchRig />
            <LiveViewHost watchPosition={wp} />
          </AppStateProvider>
        </I18nProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      emit(emitFix, destinationPoint(P0, 90, 7));
      emit(emitFix, destinationPoint(P0, 90, 4.99));
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('1');

      fireEvent.click(screen.getByRole('button', { name: 'switch rig' }));
      expect(await screen.findByText('1 of 2')).toBeInTheDocument();
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('0');
    });

    it('republishes the highlight after a plan change even when the active leg index is unchanged', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      localStorage.setItem('sc-lang', 'en');
      const ui = (plan: Plan) => (
        <I18nProvider>
          <AppStateProvider>
            <TestSetPlan plan={plan} />
            <ActiveLegProbe />
            <LiveViewHost watchPosition={wp} />
          </AppStateProvider>
        </I18nProvider>
      );
      const { rerender } = render(ui(TEST_PLAN));
      fireEvent.click(await screen.findByRole('button', { name: 'Start live view' }));
      emit(emitFix, FIX_POINT);
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('0');
      rerender(ui(REROUTED_PLAN));
      await act(async () => {});
      expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('0');
    });
  });
});
