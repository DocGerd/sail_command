import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import AisTraffic, { AisStatusChip } from './AisTraffic';
import type { AisStatus } from '../state/useAisTraffic';
import type { AisSocketHandlers } from '../services/aisStream';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Leg, type Plan } from '../types';

// ---- #158 integration rig ----------------------------------------------------
// The corridor-resubscription tests run the REAL component wiring (settle gate,
// corridor memo, useAisTraffic effect) and the REAL AisStreamClient (including
// its resend value gate) over a fake socket factory — the pinned counts below
// are actual wire sends, not React-side call counts.

const ais = vi.hoisted(() => {
  const sockets: { handlers: AisSocketHandlers; sent: string[]; closed: number }[] = [];
  return { sockets };
});

vi.mock('../services/aisStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aisStream')>();
  const fakeFactory: typeof actual.browserAisSocket = (_url, handlers) => {
    const rec = { handlers, sent: [] as string[], closed: 0 };
    ais.sockets.push(rec);
    return { send: (d: string) => rec.sent.push(d), close: () => (rec.closed += 1) };
  };
  return { ...actual, browserAisSocket: fakeFactory };
});

const mapHoist = vi.hoisted(() => ({ map: null as unknown }));
vi.mock('./MapView', () => ({ useMapInstance: () => mapHoist.map }));
// AisLayer needs a MapLibre runtime jsdom does not have; its rendering is
// covered elsewhere — here it is inert.
vi.mock('./AisLayer', () => ({ default: () => null }));

// Tiny fixed viewport in the region's SW corner: padded 20 % it stays lon-
// disjoint from every corridor box (corridor lonMin ≈ 9.857), so the merged
// subscription list is 1 viewport box + one box per included leg.
function makeAisFakeMap() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getBounds: () => ({
      getWest: () => 9.4,
      getSouth: () => 54.3,
      getEast: () => 9.42,
      getNorth: () => 54.32,
    }),
  };
}

const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

function sailLeg(lat: number, hour: number): Leg {
  return {
    kind: 'sail',
    board: 'starboard',
    twaDeg: 60,
    maneuverAtStart: null,
    start: { lat, lon: 10.0 },
    end: { lat, lon: 10.1 },
    startTimeMs: DEPARTURE_MS + hour * 3_600_000,
    endTimeMs: DEPARTURE_MS + (hour + 1) * 3_600_000,
    headingDeg: 90,
    twsKn: 12,
    speedKn: 6,
    distanceNm: 3.5,
  };
}

// Four disjoint legs ≈12 nm apart in lat — the 5 nm corridor padding (≈0.083°)
// never merges them, so each included leg is its own corridor box (the astern-
// boundary geometry from routeCorridor.test.ts).
const LEGS: Leg[] = [sailLeg(54.4, 0), sailLeg(54.6, 1), sailLeg(54.8, 2), sailLeg(55.0, 3)];

// One stable Plan instance: the corridor memo keys on plan identity, and the
// churn under test must come from activeLegIndex alone.
const PLAN: Plan = {
  id: 'plan-158',
  name: 'Jitter plan',
  createdAtMs: DEPARTURE_MS - 3_600_000,
  request: {
    origin: LEGS[0].start,
    destination: LEGS[3].end,
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: DEPARTURE_MS,
    settings: DEFAULT_SETTINGS,
  },
  windGrid: uniformWindGrid(12, 225, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 6 }),
  result: {
    status: 'ok',
    genoa: {
      rig: 'genoa',
      legs: LEGS,
      etaMs: DEPARTURE_MS + 4 * 3_600_000,
      durationMs: 4 * 3_600_000,
      distanceNm: 14,
      maneuverCount: 0,
      motorDistanceNm: 0,
    },
    fock: null,
    genoaReason: null,
    fockReason: 'calm-motor-off',
    recommended: 'genoa',
    snappedOrigin: LEGS[0].start,
    snappedDestination: LEGS[3].end,
  },
};

function traffic(activeLegIndex: number | null) {
  return (
    <I18nProvider>
      <AisTraffic
        apiKey="KEY"
        ownMmsi={undefined}
        plan={PLAN}
        rig="genoa"
        activeLegIndex={activeLegIndex}
      />
    </I18nProvider>
  );
}

const boxesOf = (raw: string) => (JSON.parse(raw) as { BoundingBoxes: unknown[] }).BoundingBoxes;

function renderChip(
  status: AisStatus,
  opts: {
    targetCount?: number;
    routeActive?: boolean;
    routeCount?: number;
    lang?: 'en' | 'de';
  } = {},
) {
  const { targetCount = 0, routeActive = false, routeCount = 0, lang = 'en' } = opts;
  localStorage.setItem('sc-lang', lang);
  render(
    <I18nProvider>
      <AisStatusChip
        status={status}
        targetCount={targetCount}
        routeActive={routeActive}
        routeCount={routeCount}
      />
    </I18nProvider>,
  );
}

describe('AisStatusChip', () => {
  it('renders the off state with the enable hint', () => {
    renderChip('off');
    expect(screen.getByText('AIS off — add a key in Options')).toBeInTheDocument();
  });

  it('renders the connecting state', () => {
    renderChip('connecting');
    expect(screen.getByText('AIS connecting…')).toBeInTheDocument();
  });

  it('renders the live state with the target count', () => {
    renderChip('live', { targetCount: 7 });
    expect(screen.getByText('AIS live · 7 vessels')).toBeInTheDocument();
  });

  it('renders the offline state', () => {
    renderChip('offline');
    expect(screen.getByText('AIS offline')).toBeInTheDocument();
  });

  it('renders the key-error state', () => {
    renderChip('keyError');
    expect(screen.getByText('AIS: check your API key')).toBeInTheDocument();
  });

  it('carries a status-specific class for styling', () => {
    renderChip('live', { targetCount: 3 });
    expect(screen.getByText('AIS live · 3 vessels')).toHaveClass('ais-status-live');
  });

  it('splits the live count while a route is active (en)', () => {
    renderChip('live', { targetCount: 7, routeActive: true, routeCount: 3 });
    // Full literal pinned against the dict string, not a re-interpolation of
    // the code under test — the "vessels" noun is test-enforced (#146 OQ1).
    expect(screen.getByText('AIS live · 7 vessels (3 along route)')).toBeInTheDocument();
  });

  it('splits the live count while a route is active (de)', () => {
    renderChip('live', { targetCount: 7, routeActive: true, routeCount: 3, lang: 'de' });
    expect(screen.getByText('AIS live · 7 Schiffe (3 entlang Route)')).toBeInTheDocument();
  });

  it('shows the plain count without a route (en)', () => {
    renderChip('live', { targetCount: 7, routeActive: false });
    const chip = screen.getByText('AIS live · 7 vessels');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).not.toContain('along route');
  });

  it('shows the plain count without a route (de)', () => {
    renderChip('live', { targetCount: 7, routeActive: false, lang: 'de' });
    const chip = screen.getByText('AIS live · 7 Schiffe');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).not.toContain('entlang Route');
  });
});

describe('AisTraffic corridor resubscription (#158)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mapHoist.map = makeAisFakeMap();
    ais.sockets.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds subscription sends under sustained adjacent-index jitter (12 flips ⇒ zero resends)', () => {
    // Pinned derivation (from the settle-gate spec, hand-derived BEFORE the
    // implementation): the corridor consumes activeLegIndex through a 2000 ms
    // settle gate — a changed index is adopted only after holding
    // UNINTERRUPTED for 2000 ms. Flips spaced 1000 ms apart cap the dwell at
    // 1000 ms < 2000 ms ⇒ 0 adoptions ⇒ 0 corridor recomputes ⇒ 0 resends.
    // Expected wire traffic: exactly the 1 initial onOpen subscription, with
    // 1 viewport box + 4 corridor boxes (index 1 ⇒ startIdx max(0,0)=0 ⇒
    // legs L0..L3, mutually disjoint).
    const view = render(traffic(1));
    expect(ais.sockets).toHaveLength(1);
    act(() => ais.sockets[0].handlers.onOpen());
    expect(ais.sockets[0].sent).toHaveLength(1);
    expect(boxesOf(ais.sockets[0].sent[0])).toHaveLength(5);
    for (let k = 1; k <= 12; k++) {
      act(() => vi.advanceTimersByTime(1000));
      view.rerender(traffic(k % 2 === 1 ? 2 : 1)); // 2,1,2,1,… at 1 Hz
    }
    // The 12th flip returned to the settled index ⇒ nothing is pending:
    act(() => vi.advanceTimersByTime(5000));
    expect(ais.sockets).toHaveLength(1); // no reconnect churn either
    expect(ais.sockets[0].closed).toBe(0);
    expect(ais.sockets[0].sent).toHaveLength(1); // ZERO fix-rate resends
  });

  it('resends promptly on the OPEN socket after a genuine leg advance (no reconnect)', () => {
    // Pinned derivation: index 1→2 held ⇒ adopted exactly at +2000 ms (the
    // settle window; not 1999 ms). Corridor startIdx moves max(0,0)=0 →
    // max(0,1)=1 ⇒ L0's box drops ⇒ merged list shrinks 5 → 4 boxes ⇒
    // exactly one resend, on the same socket.
    const view = render(traffic(1));
    act(() => ais.sockets[0].handlers.onOpen());
    expect(ais.sockets[0].sent).toHaveLength(1);
    view.rerender(traffic(2));
    act(() => vi.advanceTimersByTime(1999));
    expect(ais.sockets[0].sent).toHaveLength(1); // settle window still open
    act(() => vi.advanceTimersByTime(1));
    expect(ais.sockets[0].sent).toHaveLength(2); // prompt: 2 s, not 30 s
    expect(boxesOf(ais.sockets[0].sent[1])).toHaveLength(4);
    expect(ais.sockets).toHaveLength(1); // resend, not reconnect
    expect(ais.sockets[0].closed).toBe(0);
  });

  it('does not resend when a settled index change recomputes a deep-equal corridor', () => {
    // Pinned derivation: startIdx(1) = max(0,0) = 0 and startIdx(0) =
    // max(0,−1) = 0 ⇒ identical leg slice ⇒ value-identical boxes under a
    // NEW array identity. The client's value gate keeps that off the wire.
    const view = render(traffic(1));
    act(() => ais.sockets[0].handlers.onOpen());
    expect(ais.sockets[0].sent).toHaveLength(1);
    view.rerender(traffic(0));
    act(() => vi.advanceTimersByTime(2000)); // adopted — but content unchanged
    expect(ais.sockets[0].sent).toHaveLength(1);
    expect(ais.sockets).toHaveLength(1);
  });
});
