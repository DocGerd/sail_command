import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import { uniformWindGrid } from '../test/fixtures';
import { formatDateTime } from '../lib/format';
import { DEFAULT_SETTINGS, type Leg, type Plan, type Rig, type RigResult } from '../types';
import RouteSummary from './RouteSummary';

const FETCHED_AT_MS = Date.UTC(2026, 6, 15, 6, 0, 0);
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0); // 2h after fetch: not stale

const GENOA_LEGS: Leg[] = [
  {
    kind: 'sail',
    board: 'starboard',
    start: { lat: 54.79, lon: 9.43 },
    end: { lat: 54.8, lon: 10.0 },
    startTimeMs: DEPARTURE_MS,
    endTimeMs: DEPARTURE_MS + 2 * 3_600_000,
    headingDeg: 88,
    twaDeg: 92,
    twsKn: 10,
    speedKn: 7,
    distanceNm: 15,
    maneuverAtStart: null,
  },
  {
    kind: 'motor',
    board: null,
    start: { lat: 54.8, lon: 10.0 },
    end: { lat: 54.85, lon: 10.52 },
    startTimeMs: DEPARTURE_MS + 2 * 3_600_000,
    endTimeMs: DEPARTURE_MS + 4 * 3_600_000,
    headingDeg: 90,
    twsKn: 2,
    speedKn: 6.5,
    distanceNm: 5,
    maneuverAtStart: null,
  },
  {
    kind: 'sail',
    board: 'port',
    start: { lat: 54.85, lon: 10.52 },
    end: { lat: 54.86, lon: 10.55 },
    startTimeMs: DEPARTURE_MS + 4 * 3_600_000,
    endTimeMs: DEPARTURE_MS + 5 * 3_600_000,
    headingDeg: 60,
    twaDeg: -80,
    twsKn: 10,
    speedKn: 6,
    distanceNm: 1.5,
    maneuverAtStart: 'tack',
  },
];

const GENOA_RESULT: RigResult = {
  rig: 'genoa',
  etaMs: DEPARTURE_MS + 5 * 3_600_000,
  durationMs: 5 * 3_600_000,
  distanceNm: 21.5,
  maneuverCount: 1,
  motorDistanceNm: 5,
  legs: GENOA_LEGS,
};

const FOCK_RESULT: RigResult = {
  rig: 'fock',
  etaMs: DEPARTURE_MS + 6 * 3_600_000,
  durationMs: 6 * 3_600_000,
  distanceNm: 22.0,
  maneuverCount: 0,
  motorDistanceNm: 0,
  legs: [
    {
      kind: 'sail',
      board: 'starboard',
      start: { lat: 54.79, lon: 9.43 },
      end: { lat: 54.85, lon: 10.52 },
      startTimeMs: DEPARTURE_MS,
      endTimeMs: DEPARTURE_MS + 6 * 3_600_000,
      headingDeg: 85,
      twaDeg: 95,
      twsKn: 9,
      speedKn: 5.5,
      distanceNm: 22,
      maneuverAtStart: null,
    },
  ],
};

function makePlan(overrides: { departureMs?: number; recommended?: Rig } = {}): Plan {
  return {
    id: 'plan-1',
    name: 'Flensburg to Marstal',
    createdAtMs: FETCHED_AT_MS,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.85, lon: 10.52 },
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'marstal',
      departureMs: overrides.departureMs ?? DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
    },
    windGrid: { ...uniformWindGrid(10, 270), fetchedAtMs: FETCHED_AT_MS },
    result: {
      status: 'ok',
      genoa: GENOA_RESULT,
      fock: FOCK_RESULT,
      genoaReason: null,
      fockReason: null,
      recommended: overrides.recommended ?? 'genoa',
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.85, lon: 10.52 },
    },
  };
}

function renderSummary(
  overrides: { plan?: Plan; rig?: Rig; onRigChange?: (r: Rig) => void } = {},
): { plan: Plan; rig: Rig; onRigChange: (r: Rig) => void; container: HTMLElement } {
  localStorage.setItem('sc-lang', 'en');
  const plan = overrides.plan ?? makePlan();
  const rig = overrides.rig ?? 'genoa';
  const onRigChange = overrides.onRigChange ?? vi.fn();
  const { container } = render(
    <I18nProvider>
      <RouteSummary plan={plan} rig={rig} onRigChange={onRigChange} />
    </I18nProvider>,
  );
  return { plan, rig, onRigChange, container };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('RouteSummary', () => {
  it('wraps the results in an Ergebnis card whose heading is a focus target', () => {
    const { container } = renderSummary();
    const heading = container.querySelector('.route-ergebnis > .sc-card-title') as HTMLElement;
    expect(heading).not.toBeNull();
    expect(heading.textContent).toBe('Result');
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('shows a ★ badge on the recommended tab and not on the other', () => {
    renderSummary({ rig: 'genoa' });
    const genoaTab = screen.getByRole('tab', { name: /Genoa/ });
    const fockTab = screen.getByRole('tab', { name: /Fock/ });
    expect(within(genoaTab).getByLabelText('Recommended')).toBeInTheDocument();
    expect(within(fockTab).queryByLabelText('Recommended')).not.toBeInTheDocument();
  });

  it('keeps the rig tablist named "Rig comparison" with exactly one ★', () => {
    renderSummary();
    const tablist = screen.getByRole('tablist', { name: 'Rig comparison' });
    expect(within(tablist).getAllByLabelText('Recommended')).toHaveLength(1);
  });

  it('renders an additive faster-rig chip for the recommended rig', () => {
    renderSummary({ rig: 'genoa' });
    expect(screen.getByText('Faster: Genoa')).toBeInTheDocument();
  });

  it('clicking a non-active tab calls onRigChange with that rig', () => {
    const { onRigChange } = renderSummary({ rig: 'genoa' });
    fireEvent.click(screen.getByRole('tab', { name: /Fock/ }));
    expect(onRigChange).toHaveBeenCalledWith('fock');
  });

  it('clicking the already-active tab does not call onRigChange', () => {
    const { onRigChange } = renderSummary({ rig: 'genoa' });
    fireEvent.click(screen.getByRole('tab', { name: /Genoa/ }));
    expect(onRigChange).not.toHaveBeenCalled();
  });

  it('renders the stat grid with hand-derived distance, duration and avg speed', () => {
    const { container } = renderSummary({ rig: 'genoa' });
    const stats = container.querySelector('.ergebnis-stats') as HTMLElement;
    expect(stats).not.toBeNull();
    // 21.5 nm over 5 h = 4.3 kn (hand-derived).
    expect(within(stats).getByText('21.5 nm')).toBeInTheDocument();
    expect(within(stats).getByText('5 h 00 min')).toBeInTheDocument();
    expect(within(stats).getByText('4.3 kn')).toBeInTheDocument();
    // Arrival delegates to formatDateTime (separately tested; TZ-independent
    // because both sides format the same instant with the same locale).
    expect(within(stats).getByText(formatDateTime(GENOA_RESULT.etaMs, 'en'))).toBeInTheDocument();
  });

  it('keeps maneuver count as a secondary stat', () => {
    const { container } = renderSummary({ rig: 'genoa' });
    const maneuvers = container.querySelector('.ergebnis-maneuvers');
    expect(maneuvers?.textContent).toContain('Maneuvers');
    expect(maneuvers?.textContent).toContain('1');
  });

  it('renders the sail/motor split bar with hand-derived proportions (5 motor of 21.5)', () => {
    const { container } = renderSummary({ rig: 'genoa' });
    const split = container.querySelector('.ergebnis-split') as HTMLElement;
    expect(split).not.toBeNull();
    // 21.5 total, 5 motor -> 16.5 sail; 5/21.5 = 23 %, sail 77 %.
    expect(split.textContent).toContain('16.5 nm');
    expect(split.textContent).toContain('77%');
    expect(split.textContent).toContain('5.0 nm');
    expect(split.textContent).toContain('23%');
    // Two proportional segments since motor > 0.
    expect(container.querySelectorAll('.ergebnis-split-bar > span')).toHaveLength(2);
    const sailSeg = container.querySelector('.ergebnis-split-sail') as HTMLElement;
    expect(Number(sailSeg.style.flexGrow)).toBeCloseTo(16.5 / 21.5, 6);
  });

  it('an all-sail rig renders a single split segment at 100 %', () => {
    const { container } = renderSummary({ rig: 'fock' });
    const split = container.querySelector('.ergebnis-split') as HTMLElement;
    expect(split.textContent).toContain('100%');
    // Only the sail segment when motor nm is 0.
    expect(container.querySelectorAll('.ergebnis-split-bar > span')).toHaveLength(1);
    expect(container.querySelector('.ergebnis-split-motor')).toBeNull();
  });

  it('moves the legs table behind a disclosure labelled "Legs (n)"', () => {
    const { container } = renderSummary({ rig: 'genoa' });
    const disclosure = container.querySelector(
      'details.route-legs-disclosure',
    ) as HTMLDetailsElement;
    expect(disclosure).not.toBeNull();
    expect(disclosure.querySelector('summary')?.textContent).toBe('Legs (3)');
    // The table lives inside the disclosure (in DOM even when collapsed).
    expect(disclosure.querySelector('table.route-legs')).not.toBeNull();
  });

  it('renders the legs table with kind chips, heading, and a maneuver badge at the tack leg', () => {
    renderSummary({ rig: 'genoa' });
    expect(screen.getByText('Motor')).toBeInTheDocument();
    expect(screen.getByText('Tack')).toBeInTheDocument();
    expect(screen.getByText('088°')).toBeInTheDocument();
  });

  it('prefixes each sail-leg chip with the displayed rig name (genoa)', () => {
    renderSummary({ rig: 'genoa' });
    expect(screen.getByText('Genoa · Stbd Reach')).toBeInTheDocument();
    expect(screen.getByText('Genoa · Port Reach')).toBeInTheDocument();
  });

  it('switches the sail-chip rig prefix to the displayed rig (fock)', () => {
    renderSummary({ rig: 'fock' });
    expect(screen.getByText('Fock · Stbd Reach')).toBeInTheDocument();
  });

  it('renders the motor-note footnote inside the legs disclosure when the result has legs', () => {
    renderSummary({ rig: 'genoa' });
    expect(screen.getByText(/Motor = engine only/)).toBeInTheDocument();
  });

  it('omits the motor-note footnote when the selected rig result has no legs', () => {
    const plan = makePlan();
    plan.result.genoa = { ...GENOA_RESULT, legs: [] };
    renderSummary({ plan, rig: 'genoa' });
    expect(screen.queryByText(/Motor = engine only/)).not.toBeInTheDocument();
  });

  it('shows a stale-forecast warning when departure is more than 12h after the forecast fetch', () => {
    const plan = makePlan({ departureMs: FETCHED_AT_MS + 12 * 3_600_000 + 1 });
    renderSummary({ plan });
    expect(screen.getByText(/12 hours/i)).toBeInTheDocument();
  });

  it('hides the stale-forecast warning when departure is within 12h of the forecast fetch', () => {
    renderSummary();
    expect(screen.queryByText(/hours old relative to departure/i)).not.toBeInTheDocument();
  });

  it('renders a no-route message instead of stats/legs when the selected rig has no result', () => {
    const plan = makePlan();
    plan.result.fock = null;
    plan.result.fockReason = 'unreachable';
    renderSummary({ plan, rig: 'fock' });
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be reached/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('GPX export creates a Blob via URL.createObjectURL and clicks an anchor named "<name>-<rig>.gpx"', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature must accept a Blob for the tuple-typed assertion below
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    let downloadName = '';
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });

    try {
      const { plan } = renderSummary({ rig: 'genoa' });
      fireEvent.click(screen.getByRole('button', { name: 'Export GPX' }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
      expect(downloadName).toBe(`${plan.name}-genoa.gpx`);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      clickSpy.mockRestore();
    }
  });

  it('GPX export button is disabled when result has zero legs', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature must accept a Blob for the tuple-typed assertion
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = createObjectURL;

    try {
      const plan = makePlan();
      plan.result.genoa = { ...GENOA_RESULT, legs: [] };
      renderSummary({ plan, rig: 'genoa' });

      const button = screen.getByRole('button', { name: 'Export GPX' });
      expect(button).toBeDisabled();

      fireEvent.click(button);
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });
});

describe('shallow-water warning banner (#53)', () => {
  function makeShallowPlan(): Plan {
    const plan = makePlan();
    plan.result.shallow = { requestedDepthM: 3.0, usedDepthM: 2.3, minGateDepthM: 2.3 };
    return plan;
  }

  it('renders the plan-level warning with the requested and minimum charted gate depths', () => {
    renderSummary({ plan: makeShallowPlan() });
    const banner = screen.getByText(/charted shallower than your safety depth/);
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveClass('shallow-warning');
    expect(banner.textContent).toContain('3.0 m');
    expect(banner.textContent).toContain('2.3 m');
    // Honest passage-planning-aid copy: never claims verified safety.
    expect(banner.textContent).not.toMatch(/verified|guaranteed/i);
  });

  it('renders on BOTH rig tabs — the warning is plan-level, not per rig', () => {
    renderSummary({ plan: makeShallowPlan(), rig: 'fock' });
    expect(screen.getByText(/charted shallower than your safety depth/)).toBeInTheDocument();
  });

  it('is absent on plans without relaxation', () => {
    renderSummary();
    expect(screen.queryByText(/charted shallower than your safety depth/)).toBeNull();
  });
});
