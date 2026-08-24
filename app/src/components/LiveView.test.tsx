import 'fake-indexeddb/auto';
import { useEffect, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStateProvider, useActivePlan } from '../state/AppState';
import { I18nProvider } from '../i18n';
import { __resetDbForTests } from '../services/db';
import { destinationPoint } from '../lib/geo';
import { distanceToNextManeuverNm, headingToSteerDeg } from '../lib/live';
import { formatHeading, formatNm } from '../lib/format';
import type { GpsErrorKind, GpsFix } from '../services/geolocation';
import { DEFAULT_SETTINGS, type Leg, type MaskMeta, type Plan } from '../types';
import LiveView from './LiveView';
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
        <LiveView watchPosition={watchPosition} />
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
    expect(screen.queryByRole('button', { name: 'Live view' })).not.toBeInTheDocument();
  });

  it('toggling on subscribes to watchPosition, and a fix renders HTS/COG/SOG, next maneuver, and projected ETA', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);

    const toggle = await screen.findByRole('button', { name: 'Live view' });
    fireEvent.click(toggle);
    expect(wp).toHaveBeenCalledTimes(1);

    const expectedHts = formatHeading(headingToSteerDeg(LEGS, 0, FIX_POINT));
    const nextEvent = distanceToNextManeuverNm(LEGS, 0, FIX_POINT);
    if (!nextEvent) throw new Error('test fixture expected a next maneuver');

    act(() => {
      emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
    });

    expect(screen.getByText(expectedHts)).toBeInTheDocument();
    expect(screen.getByText(formatHeading(91.4))).toBeInTheDocument(); // COG
    expect(screen.getByText('6.3 kn')).toBeInTheDocument(); // SOG
    expect(
      screen.getByText(new RegExp(formatNm(nextEvent.distNm, 'en').replace('.', '\\.'))),
    ).toBeInTheDocument();
    expect(screen.getByText(/tack/i)).toBeInTheDocument();
    expect(screen.getByText(/projected eta/i)).toBeInTheDocument();
  });

  it('#25: never renders BoatMarker itself, even fully active with a steerable fix — the standalone OwnshipMarker is the ONLY marker render site, so this is what keeps Live View + the ownship toggle from ever showing two markers', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));

    act(() => emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 }));

    // Sanity: the readout DID render off this fix (steerable is non-null) —
    // otherwise "BoatMarker not called" would be true for the trivial wrong
    // reason (nothing rendered at all).
    expect(screen.getByText(formatHeading(91.4))).toBeInTheDocument();
    expect(BoatMarker).not.toHaveBeenCalled();
  });

  it('shows en dash placeholders for COG/SOG when the device does not report them', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));

    act(() => emitFix({ point: FIX_POINT, cogDeg: null, sogKn: null, accuracyM: 9 }));

    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('renders the COG placeholder — not "NaN°" — for a stationary fix (geolocation.ts maps NaN heading to null; SOG 0 still renders as 0.0 kn)', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));

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
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));

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
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));

    expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('none');

    act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

    expect(screen.getByTestId('shared-active-leg')).toHaveTextContent('0');
  });

  it('#142: advances the active leg as successive fixes move the boat — shared index 0 -> 1 and the next-event readout flips from the tack to "no more maneuvers"', async () => {
    const { wp, emitFix } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN, <ActiveLegProbe />);
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));

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
          {withLive && <LiveView watchPosition={wp} />}
        </AppStateProvider>
      </I18nProvider>
    );
    const { rerender } = render(ui(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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
    const toggle = await screen.findByRole('button', { name: 'Live view' });
    fireEvent.click(toggle); // on

    const expectedHts = formatHeading(headingToSteerDeg(LEGS, 0, FIX_POINT));
    // COG 123.4, not 90: HTS on this due-east track is 090° and an identical
    // COG would render a second '090°', breaking the single-element query.
    act(() => emitFix({ point: FIX_POINT, cogDeg: 123.4, sogKn: 5, accuracyM: 9 }));
    expect(screen.getByText(expectedHts)).toBeInTheDocument();
    expect(screen.getByText(/projected eta/i)).toBeInTheDocument();

    fireEvent.click(toggle); // off — fix cleared, data block unrendered
    expect(screen.queryByText(expectedHts)).not.toBeInTheDocument();
    expect(screen.queryByText(/projected eta/i)).not.toBeInTheDocument();
  });

  it('a denied GPS error shows a one-time hint, recorded in localStorage, that does not reappear across remounts', async () => {
    const { wp: wp1, emitError: emitError1 } = fakeWatchPosition();
    const { unmount } = renderLive(wp1, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));

    act(() => emitError1('denied'));
    expect(await screen.findByText(/location access/i)).toBeInTheDocument();
    expect(localStorage.getItem('sc-gps-hint-shown')).toBe('1');

    unmount();
    cleanup();

    const { wp: wp2, emitError: emitError2 } = fakeWatchPosition();
    renderLive(wp2, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
    act(() => emitError2('denied'));

    expect(screen.queryByText(/location access/i)).not.toBeInTheDocument();
  });

  it("#142: an 'unavailable' GPS error shows the same one-time hint as 'denied' (spec §4: identical treatment)", async () => {
    const { wp, emitError } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));

    act(() => emitError('unavailable'));

    expect(await screen.findByText(/location access/i)).toBeInTheDocument();
    expect(localStorage.getItem('sc-gps-hint-shown')).toBe('1');
  });

  it('the hint can be dismissed, and the app (the toggle) remains usable while GPS is denied', async () => {
    const { wp, emitError } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);
    fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));

    act(() => emitError('denied'));
    fireEvent.click(await screen.findByRole('button', { name: /got it/i }));

    expect(screen.queryByText(/location access/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Live view' })).toBeEnabled();
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
          <LiveView watchPosition={wp} panelSlot={slot} />
        </AppStateProvider>
      </I18nProvider>,
    );

    const toggle = await within(slot).findByRole('button', { name: 'Live view' });
    expect(within(container).queryByRole('button', { name: 'Live view' })).toBeNull();

    fireEvent.click(toggle);
    act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

    expect(within(slot).getByText('5.0 kn')).toBeInTheDocument(); // SOG, inside the slot
    slot.remove();
  });

  it('toggling off unsubscribes from watchPosition', async () => {
    const { wp, unsubscribe } = fakeWatchPosition();
    renderLive(wp, TEST_PLAN);

    const toggle = await screen.findByRole('button', { name: 'Live view' });
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
            <LiveView watchPosition={wp} />
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

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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

    it('shows no depth note when the bearing is clear', async () => {
      vi.mocked(loadRoutingAssets).mockResolvedValue({
        maskMeta: MASK_META,
        maskBuffer: fullyDeepMaskBuffer(),
      } as never);
      vi.spyOn(NavMaskModule.NavMask.prototype, 'segmentShallowestBelow').mockReturnValue(null);

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
      act(() => {
        emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 });
      });

      await screen.findByText(formatHeading(headingToSteerDeg(LEGS, 0, FIX_POINT)));
      expect(screen.queryByText(/Bearing crosses/)).not.toBeInTheDocument();
      expect(screen.queryByText('Depth not checked')).not.toBeInTheDocument();
    });

    it('shows "Depth not checked" while the mask is unavailable', async () => {
      vi.mocked(loadRoutingAssets).mockRejectedValue(new Error('offline'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { wp, emitFix } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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
        screen.getByText(formatHeading(headingToSteerDeg(LEGS, 0, FIX_POINT))),
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

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 }));
      await screen.findByText('Depth not checked');

      swapPlan(REROUTED_PLAN);

      expect(depthAnnotation()).toBe('Depth not checked');
      expect(
        screen.getByText(formatHeading(headingToSteerDeg(LEGS, 0, FIX_POINT))),
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

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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
            <LiveView watchPosition={wp} reroute={controls} />
          </AppStateProvider>
        </I18nProvider>,
      );
    }

    it('renders no reroute action at all when the controls prop is absent', async () => {
      const { wp } = fakeWatchPosition();
      renderLive(wp, TEST_PLAN);
      await screen.findByRole('button', { name: 'Live view' });
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

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
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

      const toggle = await screen.findByRole('button', { name: 'Live view' });
      fireEvent.click(toggle); // on
      act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));
      expect(screen.getByRole('button', { name: REROUTE_NAME })).toBeEnabled();

      fireEvent.click(toggle); // off — fix cleared
      const button = screen.getByRole('button', { name: REROUTE_NAME });
      expect(button).toBeDisabled();
      expect(screen.getByText(/needs an active gps fix/i)).toBeInTheDocument();
    });

    it('is disabled while ANY solver run is busy, and shows the in-flight label for its own solve', async () => {
      const { wp, emitFix } = fakeWatchPosition();
      const onReroute = vi.fn();
      renderWithReroute(wp, { busy: true, rerouting: true, onReroute });

      fireEvent.click(await screen.findByRole('button', { name: 'Live view' }));
      act(() => emitFix({ point: FIX_POINT, cogDeg: 90, sogKn: 5, accuracyM: 9 }));

      const button = screen.getByRole('button', {
        name: 'Replanning route from current position…',
      });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(onReroute).not.toHaveBeenCalled();
    });
  });
});
