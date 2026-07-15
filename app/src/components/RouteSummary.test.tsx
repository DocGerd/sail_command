import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import { uniformWindGrid } from '../test/fixtures';
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
): { plan: Plan; rig: Rig; onRigChange: (r: Rig) => void; totals: HTMLElement | null } {
  localStorage.setItem('sc-lang', 'en');
  const plan = overrides.plan ?? makePlan();
  const rig = overrides.rig ?? 'genoa';
  const onRigChange = overrides.onRigChange ?? vi.fn();
  const { container } = render(
    <I18nProvider>
      <RouteSummary plan={plan} rig={rig} onRigChange={onRigChange} />
    </I18nProvider>,
  );
  return { plan, rig, onRigChange, totals: container.querySelector('.route-totals') };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('RouteSummary', () => {
  it('shows a ★ badge on the recommended tab and not on the other', () => {
    renderSummary({ rig: 'genoa' });
    const genoaTab = screen.getByRole('tab', { name: /Genoa/ });
    const fockTab = screen.getByRole('tab', { name: /Fock/ });
    expect(within(genoaTab).getByLabelText('Recommended')).toBeInTheDocument();
    expect(within(fockTab).queryByLabelText('Recommended')).not.toBeInTheDocument();
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

  it('shows the motor-distance totals row when motor nm > 0', () => {
    const { totals } = renderSummary({ rig: 'genoa' });
    expect(totals).not.toBeNull();
    expect(within(totals!).getByText('Motor distance').nextElementSibling).toHaveTextContent('5.0 nm');
  });

  it('omits the motor-distance totals row when motor nm is 0', () => {
    const { totals } = renderSummary({ rig: 'fock' });
    expect(totals).not.toBeNull();
    expect(within(totals!).queryByText('Motor distance')).not.toBeInTheDocument();
  });

  it('shows a stale-forecast warning when departure is more than 12h after the forecast fetch', () => {
    const plan = makePlan({ departureMs: FETCHED_AT_MS + 12 * 3_600_000 + 1 });
    renderSummary({ plan });
    expect(screen.getByRole('alert')).toHaveTextContent(/12 hours/i);
  });

  it('hides the stale-forecast warning when departure is within 12h of the forecast fetch', () => {
    renderSummary();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the legs table with kind chips, heading, and a maneuver badge at the tack leg', () => {
    renderSummary({ rig: 'genoa' });
    expect(screen.getByText('Motor')).toBeInTheDocument();
    expect(screen.getByText('Tack')).toBeInTheDocument();
    expect(screen.getByText('088°')).toBeInTheDocument();
  });

  it('renders a no-route message instead of totals/legs when the selected rig has no result', () => {
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
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
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
