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
import { DEFAULT_SETTINGS, type Leg, type Plan } from '../types';
import LiveView from './LiveView';

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
  request: {
    origin: P0,
    destination: P2,
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: T0,
    settings: DEFAULT_SETTINGS,
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
    genoa: {
      rig: 'genoa',
      legs: LEGS,
      etaMs: T0 + 2 * HOUR,
      durationMs: 2 * HOUR,
      distanceNm: 10,
      maneuverCount: 1,
      motorDistanceNm: 0,
    },
    fock: null,
    genoaReason: null,
    fockReason: 'calm-motor-off',
    recommended: 'genoa',
    snappedOrigin: P0,
    snappedDestination: P2,
  },
};

const FIX_POINT = destinationPoint(P0, 90, 2); // 2 nm into leg 0 (of 5)

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
      screen.getByText(new RegExp(formatNm(nextEvent.distNm).replace('.', '\\.'))),
    ).toBeInTheDocument();
    expect(screen.getByText(/tack/i)).toBeInTheDocument();
    expect(screen.getByText(/projected eta/i)).toBeInTheDocument();
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
});
