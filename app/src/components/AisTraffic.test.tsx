import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import AisTraffic, { AisStatusChip, AisVesselsInView } from './AisTraffic';
import type { AisStatus } from '../state/useAisTraffic';
import type { AisSocketHandlers } from '../services/aisStream';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Leg, type Plan, type RigResult } from '../types';
import { defaultBoatSnapshot } from '../types';
import { PLAN_SCHEMA_VERSION } from '../types';
import type { AisTargetSnapshot } from '../lib/aisTargets';

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
// covered elsewhere — here it is inert. openAisPopup is stubbed to a
// call-recording fake (#831) so AisVesselsInView's activation path can be
// asserted without a real MapLibre Popup.
const aisLayerHoist = vi.hoisted(() => ({
  openAisPopupCalls: [] as unknown[][],
}));
vi.mock('./AisLayer', () => ({
  default: () => null,
  openAisPopup: (...args: unknown[]) => {
    aisLayerHoist.openAisPopupCalls.push(args);
    return { remove: () => {} };
  },
}));

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

const GENOA_RESULT = {
  sailId: 'genoa',
  legs: LEGS,
  etaMs: DEPARTURE_MS + 4 * 3_600_000,
  durationMs: 4 * 3_600_000,
  distanceNm: 14,
  maneuverCount: 0,
  motorDistanceNm: 0,
} satisfies RigResult;

// One stable Plan instance: the corridor memo keys on plan identity, and the
// churn under test must come from activeLegIndex alone.
const PLAN: Plan = {
  id: 'plan-158',
  name: 'Jitter plan',
  createdAtMs: DEPARTURE_MS - 3_600_000,
  schemaVersion: PLAN_SCHEMA_VERSION,
  request: {
    origin: LEGS[0].start,
    destination: LEGS[3].end,
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: DEPARTURE_MS,
    settings: DEFAULT_SETTINGS,
    sailIds: ['genoa', 'fock'],
    boat: defaultBoatSnapshot(),
  },
  windGrid: uniformWindGrid(12, 225, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 6 }),
  result: {
    status: 'ok',
    sails: [
      { sailId: 'genoa', result: GENOA_RESULT, reason: null },
      { sailId: 'fock', result: null, reason: 'calm-motor-off' },
    ],
    recommended: 'genoa',
    comparisonComplete: true,
    snappedOrigin: LEGS[0].start,
    snappedDestination: LEGS[3].end,
  },
};

// Second plan for the plan-change test (#162 review): TWO disjoint legs. With
// a stale settled index 2 its corridor would slice from max(0,1)=1 ⇒ 1 box;
// the correct null index yields the full route ⇒ 2 boxes — the counts
// distinguish stale-index from reset-to-raw behavior.
const B_LEGS: Leg[] = [sailLeg(54.45, 0), sailLeg(54.65, 1)];
const PLAN_B: Plan = {
  ...PLAN,
  id: 'plan-158b',
  name: 'Replacement plan',
  result: {
    ...PLAN.result,
    sails: PLAN.result.sails.map((s) =>
      s.sailId === 'genoa'
        ? {
            sailId: 'genoa' as const,
            result: { ...GENOA_RESULT, legs: B_LEGS, distanceNm: 7 },
            reason: null,
          }
        : s,
    ),
    snappedOrigin: { lat: 54.45, lon: 10.0 },
    snappedDestination: { lat: 54.65, lon: 10.1 },
  },
};

// Plan with BOTH rig results for the rig-change test: genoa sails PLAN's four
// legs, fock the two B_LEGS — a genoa→fock switch swaps the leg set without
// touching plan identity, so it isolates the rig part of the reset key.
const PLAN_C: Plan = {
  ...PLAN,
  id: 'plan-158c',
  name: 'Two-rig plan',
  result: {
    ...PLAN.result,
    sails: PLAN.result.sails.map((s) =>
      s.sailId === 'fock'
        ? {
            sailId: 'fock' as const,
            result: {
              sailId: 'fock' as const,
              legs: B_LEGS,
              etaMs: DEPARTURE_MS + 2 * 3_600_000,
              durationMs: 2 * 3_600_000,
              distanceNm: 7,
              maneuverCount: 0,
              motorDistanceNm: 0,
            },
            reason: null,
          }
        : s,
    ),
  },
};

function traffic(
  activeLegIndex: number | null,
  plan: Plan = PLAN,
  rig: 'genoa' | 'fock' = 'genoa',
) {
  return (
    <I18nProvider>
      <AisTraffic
        apiKey="KEY"
        ownMmsi={undefined}
        plan={plan}
        rig={rig}
        activeLegIndex={activeLegIndex}
        panelSlot={null}
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
    // #804: the string used to say "in Options", a surface with no label
    // anywhere in the app. It now names the tab and card the AIS key control
    // really renders in.
    expect(screen.getByText('AIS off — add a key under Boat › Live & AIS')).toBeInTheDocument();
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

  // #162 review r3642154768: setPlan batches plan + activeLegIndex→null into
  // ONE render — the settle gate must NOT hold the old plan's index against
  // the new plan's legs (a mis-placed slice, or [] past the end) for 2 s.
  it('gives a new plan its full-route corridor in the same render (stale settled index bypassed)', () => {
    // Pinned derivation: send #1 = onOpen with PLAN at index 2 ⇒ startIdx
    // max(0,1)=1 ⇒ L1..L3 ⇒ 3 corridor boxes + viewport = 4. The plan change
    // resets the settle gate to the raw index in the same render: null ⇒
    // PLAN_B's full route (2 boxes) ⇒ send #2 carries 1 + 2 = 3 boxes with
    // ZERO timer advance. A stale settled index 2 would instead slice PLAN_B
    // from max(0,1)=1 ⇒ 1 box ⇒ 2 total — the pin below rejects it.
    const view = render(traffic(2));
    act(() => ais.sockets[0].handlers.onOpen());
    expect(ais.sockets[0].sent).toHaveLength(1);
    expect(boxesOf(ais.sockets[0].sent[0])).toHaveLength(4);
    view.rerender(traffic(null, PLAN_B)); // batched plan swap + index reset
    expect(ais.sockets[0].sent).toHaveLength(2); // immediate — zero timers ran
    expect(boxesOf(ais.sockets[0].sent[1])).toHaveLength(3);
    expect(ais.sockets).toHaveLength(1);
    expect(ais.sockets[0].closed).toBe(0);
  });

  it('applies a rig change in the same render (settle gate reset on rig identity too)', () => {
    // Pinned derivation: PLAN_C sails genoa on PLAN's four legs and fock on
    // the two B_LEGS. Send #1 = onOpen at index 2 on genoa ⇒ 4 boxes (as
    // above). The genoa→fock switch (batched with the index reset, plan
    // identity UNCHANGED) must adopt null in the same render ⇒ fock full
    // route ⇒ 1 + 2 = 3 boxes. A stale settled index 2 would slice B_LEGS
    // from 1 ⇒ 2 total — rejected by the pin.
    const view = render(traffic(2, PLAN_C));
    act(() => ais.sockets[0].handlers.onOpen());
    expect(ais.sockets[0].sent).toHaveLength(1);
    expect(boxesOf(ais.sockets[0].sent[0])).toHaveLength(4);
    view.rerender(traffic(null, PLAN_C, 'fock'));
    expect(ais.sockets[0].sent).toHaveLength(2); // immediate — zero timers ran
    expect(boxesOf(ais.sockets[0].sent[1])).toHaveLength(3);
    expect(ais.sockets).toHaveLength(1);
  });
});

// #831: AIS vessel identification was pointer-only (a symbol-layer glyph
// click in AisLayer.tsx) — a MapLibre-rendered feature has NO DOM node, so
// it cannot be reached from the keyboard (WCAG 2.1.1). This suite pins the
// fix: RED at BASE (AisVesselsInView does not exist there — the import
// itself fails to compile), GREEN at HEAD. `mapHoist.map`'s fixed bounds
// (west 9.4 / south 54.3 / east 9.42 / north 54.32, from makeAisFakeMap
// above) double as the AIS-in-view viewport here.
describe('AisVesselsInView (#831 keyboard-reachable AIS list)', () => {
  function target(overrides: Partial<AisTargetSnapshot>): AisTargetSnapshot {
    return {
      mmsi: '211234560',
      position: { lat: 54.31, lon: 9.41 }, // inside makeAisFakeMap's bounds
      lastUpdateMs: 0,
      tier: 'fresh',
      ...overrides,
    };
  }

  // #831 review Priority 2: follows SeamarksInView.test.tsx's own `slot`
  // pattern — a real DOM node appended to document.body, since the component
  // now portals into `panelSlot` rather than rendering inline.
  let slot: HTMLDivElement;

  beforeEach(() => {
    mapHoist.map = makeAisFakeMap();
    aisLayerHoist.openAisPopupCalls.length = 0;
    // localStorage persists across tests in this file; an earlier
    // renderChip('…', { lang: 'de' }) run would otherwise leak German into
    // this suite's English assertions.
    localStorage.setItem('sc-lang', 'en');
    slot = document.createElement('div');
    document.body.append(slot);
  });

  afterEach(() => {
    slot.remove();
  });

  function renderList(targets: AisTargetSnapshot[]) {
    return render(
      <I18nProvider>
        <AisVesselsInView map={mapHoist.map as never} targets={targets} panelSlot={slot} />
      </I18nProvider>,
    );
  }

  it('renders nothing (no portal) while panelSlot is null — matches SeamarksInView’s null-slot contract', () => {
    render(
      <I18nProvider>
        <AisVesselsInView map={mapHoist.map as never} targets={[target({})]} panelSlot={null} />
      </I18nProvider>,
    );
    expect(slot.querySelectorAll('button')).toHaveLength(0);
  });

  it('exposes each in-view vessel as a real, keyboard-focusable <button> — the structural fix WCAG 2.1.1 asks for', () => {
    renderList([
      target({ mmsi: '211111111', name: 'ALBATROS' }),
      target({ mmsi: '211222222', name: 'SEAGULL' }),
    ]);
    const buttons = Array.from(slot.querySelectorAll('button'));
    // A native <button> is a real DOM node: it sits in the default tab
    // order and is Enter/Space-activatable by the browser with zero extra
    // JS — unlike the MapLibre canvas glyph AisLayer.tsx renders, which has
    // no DOM node at all and so can never receive keyboard focus.
    expect(buttons.map((b) => b.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ALBATROS'),
        expect.stringContaining('SEAGULL'),
      ]),
    );
  });

  it('activating a row opens the SAME themed popup a pointer click opens (openAisPopup), anchored at the vessel', () => {
    renderList([
      target({ mmsi: '211333333', name: 'KESTREL', position: { lat: 54.31, lon: 9.41 } }),
    ]);
    const button = slot.querySelector('button')!;
    button.click();
    expect(aisLayerHoist.openAisPopupCalls).toHaveLength(1);
    const [, lngLat, props] = aisLayerHoist.openAisPopupCalls[0] as [
      unknown,
      { lng: number; lat: number },
      { mmsi: string; name: string },
    ];
    expect(lngLat).toEqual({ lng: 9.41, lat: 54.31 });
    expect(props.mmsi).toBe('211333333');
    expect(props.name).toBe('KESTREL');
  });

  it('excludes a vessel outside the current viewport bounds — matching what a mouse user can actually see', () => {
    renderList([
      target({ mmsi: 'in', name: 'INVIEW', position: { lat: 54.31, lon: 9.41 } }),
      target({ mmsi: 'out', name: 'FARAWAY', position: { lat: 60, lon: 20 } }),
    ]);
    const text = Array.from(slot.querySelectorAll('button'))
      .map((b) => b.textContent)
      .join(' ');
    expect(text).toContain('INVIEW');
    expect(text).not.toContain('FARAWAY');
  });

  it('shows an empty-state message with zero vessels in view, never a crash', () => {
    renderList([]);
    expect(slot.querySelectorAll('button')).toHaveLength(0);
    expect(slot.textContent).toContain('No AIS vessels currently in view.');
  });

  // #831 review Priority 4, gap 2: the mutation `rest.filter(...) -> rest`
  // (i.e. dropping the age-row exclusion) was NOT caught by any prior test —
  // every row asserted on used `expect.stringContaining`/`.toContain`, which
  // stays true whether or not a trailing "0 min ago" substring is also
  // present. Assert the exact detail-row text instead, so an included age
  // row changes it.
  it('never renders the age row as a list-row detail (aisPopupRows’ trailing row is dropped)', () => {
    renderList([
      target({
        mmsi: '211444444',
        name: 'PUFFIN',
        shipType: 36,
        position: { lat: 54.31, lon: 9.41 },
      }),
    ]);
    const button = slot.querySelector('button')!;
    // Exact text, not a substring match: name + MMSI + ship type only — no
    // "Last signal"/age fragment. A mutation reinstating the age row would
    // append " · Last signal: 0 min ago" and fail this exact comparison.
    expect(button.textContent).toBe('PUFFIN · MMSI: 211444444 · Ship type: 36');
  });
});
