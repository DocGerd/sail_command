import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/dict.en';
import { MAX_GPX_FILE_BYTES } from '../lib/gpx';
import { FORECAST_DAYS } from '../services/openMeteo';
import { uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  type Harbor,
  type LatLon,
  type Leg,
  type PickedPoint,
  type Plan,
  type Rig,
  type RigRecommendation,
  type RigResult,
} from '../types';
import PlannerPanel, { nextFullHourMs, type PlannerStatus, type TapTarget } from './PlannerPanel';

const FLENSBURG: Harbor = {
  id: 'flensburg',
  names: { de: 'Flensburg', da: 'Flensborg', en: 'Flensburg' },
  country: 'DE',
  snap: { lat: 54.795, lon: 9.435 },
};

const MARSTAL: Harbor = {
  id: 'marstal',
  names: { de: 'Marstal', da: 'Marstal', en: 'Marstal' },
  country: 'DK',
  snap: { lat: 54.855, lon: 10.52 },
};

const HARBORS = [FLENSBURG, MARSTAL];

const DEPARTURE_MS = Date.UTC(2026, 6, 20, 9, 0, 0);
const PLAN_DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

const GENOA_LEGS: Leg[] = [
  {
    kind: 'sail',
    board: 'starboard',
    start: { lat: 54.79, lon: 9.43 },
    end: { lat: 54.85, lon: 10.52 },
    startTimeMs: PLAN_DEPARTURE_MS,
    endTimeMs: PLAN_DEPARTURE_MS + 5 * 3_600_000,
    headingDeg: 88,
    twaDeg: 92,
    twsKn: 10,
    speedKn: 7,
    distanceNm: 21.5,
    maneuverAtStart: null,
  },
];

const GENOA_RESULT: RigResult = {
  rig: 'genoa',
  etaMs: PLAN_DEPARTURE_MS + 5 * 3_600_000,
  durationMs: 5 * 3_600_000,
  distanceNm: 21.5,
  maneuverCount: 1,
  motorDistanceNm: 5,
  legs: GENOA_LEGS,
};

function makePlan(
  over: { id?: string; distanceNm?: number; rigRecommendation?: RigRecommendation } = {},
): Plan {
  const distanceNm = over.distanceNm ?? GENOA_RESULT.distanceNm;
  return {
    id: over.id ?? 'plan-1',
    name: 'Flensburg to Marstal',
    createdAtMs: PLAN_DEPARTURE_MS,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.85, lon: 10.52 },
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'marstal',
      departureMs: PLAN_DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
    },
    windGrid: { ...uniformWindGrid(10, 270), fetchedAtMs: PLAN_DEPARTURE_MS },
    result: {
      status: 'ok',
      genoa: { ...GENOA_RESULT, distanceNm },
      fock: null,
      genoaReason: null,
      fockReason: 'calm-motor-off',
      recommended: 'genoa',
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.85, lon: 10.52 },
      // #259: only set when a test explicitly asks for it — most tests
      // exercise rigRecommendationOf's fallback (absent field).
      ...(over.rigRecommendation ? { rigRecommendation: over.rigRecommendation } : {}),
    },
  };
}

interface Overrides {
  harbors?: Harbor[];
  origin?: PickedPoint | null;
  destination?: PickedPoint | null;
  onPickOrigin?: (p: PickedPoint) => void;
  onPickDestination?: (p: PickedPoint) => void;
  onRequestMapTap?: (target: TapTarget) => void;
  viaPoints?: LatLon[];
  onRemoveVia?: (index: number) => void;
  onReorderVia?: (index: number, direction: 'up' | 'down') => void;
  viaReplanning?: boolean;
  onDepartureChange?: (ms: number) => void;
  onSettingsChange?: (s: typeof DEFAULT_SETTINGS) => void;
  canPlan?: boolean;
  planDisabledReason?: string | null;
  online?: boolean;
  onPlan?: () => void;
  planning?: PlannerStatus;
  plan?: Plan | null;
  rig?: Rig | null;
  formDirty?: boolean;
  onViewDetails?: () => void;
  onOpenBoatSettings?: () => void;
}

function baseProps(overrides: Overrides = {}) {
  return {
    harbors: HARBORS,
    origin: null,
    destination: null,
    onPickOrigin: vi.fn(),
    onPickDestination: vi.fn(),
    onImportRoute: vi.fn(),
    onRequestMapTap: vi.fn(),
    viaPoints: [],
    onRemoveVia: vi.fn(),
    onReorderVia: vi.fn(),
    viaReplanning: false,
    departureMs: DEPARTURE_MS,
    onDepartureChange: vi.fn(),
    settings: DEFAULT_SETTINGS,
    onSettingsChange: vi.fn(),
    canPlan: true,
    planDisabledReason: null,
    online: true,
    onPlan: vi.fn(),
    planning: { phase: 'idle' } as PlannerStatus,
    plan: null as Plan | null,
    rig: null as Rig | null,
    formDirty: false,
    onViewDetails: vi.fn(),
    onOpenBoatSettings: vi.fn(),
    ...overrides,
  };
}

function renderPanel(overrides: Overrides = {}) {
  localStorage.setItem('sc-lang', 'en');
  const props = baseProps(overrides);
  render(
    <I18nProvider>
      <PlannerPanel {...props} />
    </I18nProvider>,
  );
  return props;
}

// Same as renderPanel but exposes the container for class-based structural
// assertions (the skeleton/onboarding presentation carries no accessible role).
function renderPanelReturningContainer(overrides: Overrides = {}) {
  localStorage.setItem('sc-lang', 'en');
  return render(
    <I18nProvider>
      <PlannerPanel {...baseProps(overrides)} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('nextFullHourMs', () => {
  it('rounds up to the next full hour, strictly after now', () => {
    const now = Date.UTC(2026, 6, 15, 14, 23, 10);
    const result = nextFullHourMs(now);
    expect(result).toBe(Date.UTC(2026, 6, 15, 15, 0, 0));
  });

  it('advances a full hour even when now already sits exactly on an hour boundary', () => {
    const now = Date.UTC(2026, 6, 15, 14, 0, 0);
    expect(nextFullHourMs(now)).toBe(Date.UTC(2026, 6, 15, 15, 0, 0));
  });

  it('always stays within [now, now + FORECAST_DAYS days]', () => {
    const now = Date.UTC(2026, 6, 15, 23, 50, 0);
    const result = nextFullHourMs(now);
    expect(result).toBeGreaterThan(now);
    expect(result).toBeLessThanOrEqual(now + FORECAST_DAYS * 86_400_000);
  });
});

describe('PlannerPanel', () => {
  it('shows a search combobox for each endpoint when none is selected', () => {
    renderPanel();
    const originSection = screen.getByRole('region', { name: 'Origin' });
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    expect(within(originSection).getByRole('combobox')).toBeInTheDocument();
    expect(within(destinationSection).getByRole('combobox')).toBeInTheDocument();
  });

  it('renders the picked origin and destination labels', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
      destination: {
        source: 'harbor',
        point: MARSTAL.snap,
        harborId: MARSTAL.id,
        label: 'Marstal',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    expect(within(originSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument();
    expect(within(destinationSection).getByText('Marstal', { selector: 'p' })).toBeInTheDocument();
  });

  it('collapses a selected endpoint to a row (name + Change), hiding the combobox but keeping map-pick', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    expect(within(originSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument();
    expect(within(originSection).getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(within(originSection).getByRole('button', { name: 'Pick on map' })).toBeInTheDocument();
    expect(within(originSection).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('reopens the combobox when Change is clicked on a selected endpoint', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Change' }));
    expect(within(originSection).getByRole('combobox')).toBeInTheDocument();
  });

  it('reverts a re-picked selected endpoint to its row when the search is dismissed with Escape', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Change' }));
    const combobox = within(originSection).getByRole('combobox');
    fireEvent.focus(combobox);
    fireEvent.keyDown(combobox, { key: 'Escape' });
    expect(within(originSection).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(originSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument();
    expect(within(originSection).getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('reverts a re-picked selected endpoint to its row when the search loses focus without a pick', () => {
    renderPanel({
      origin: {
        source: 'harbor',
        point: FLENSBURG.snap,
        harborId: FLENSBURG.id,
        label: 'Flensburg',
      },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Change' }));
    const combobox = within(originSection).getByRole('combobox');
    fireEvent.focus(combobox);
    fireEvent.blur(combobox);
    expect(within(originSection).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(originSection).getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('keeps the combobox for a first, still-unselected endpoint when the search is dismissed', () => {
    renderPanel();
    const originSection = screen.getByRole('region', { name: 'Origin' });
    const combobox = within(originSection).getByRole('combobox');
    fireEvent.focus(combobox);
    fireEvent.keyDown(combobox, { key: 'Escape' });
    expect(within(originSection).getByRole('combobox')).toBeInTheDocument();
  });

  it('shows the full approach caveat on a selected endpoint row', () => {
    const noted: Harbor = {
      ...MARSTAL,
      approachNote: { de: 'Enge Zufahrt.', en: 'Narrow entrance.' },
    };
    renderPanel({
      harbors: [FLENSBURG, noted],
      origin: { source: 'harbor', point: noted.snap, harborId: noted.id, label: 'Marstal' },
    });
    const originSection = screen.getByRole('region', { name: 'Origin' });
    expect(within(originSection).getByText('Narrow entrance.')).toBeInTheDocument();
  });

  it('requests map-tap mode for the correct target when its "pick on map" button is clicked', () => {
    const props = renderPanel();
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.click(within(originSection).getByRole('button', { name: 'Pick on map' }));
    expect(props.onRequestMapTap).toHaveBeenCalledWith('origin');

    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    fireEvent.click(within(destinationSection).getByRole('button', { name: 'Pick on map' }));
    expect(props.onRequestMapTap).toHaveBeenCalledWith('destination');
  });

  it('picking a harbor from the origin search calls onPickOrigin with a PickedPoint, not onPickDestination', () => {
    const props = renderPanel();
    const originSection = screen.getByRole('region', { name: 'Origin' });
    fireEvent.change(within(originSection).getByRole('combobox'), { target: { value: 'Marstal' } });
    fireEvent.click(within(originSection).getByRole('option', { name: 'Marstal' }));
    expect(props.onPickOrigin).toHaveBeenCalledWith({
      source: 'harbor',
      point: MARSTAL.snap,
      harborId: MARSTAL.id,
      label: 'Marstal',
    });
    expect(props.onPickDestination).not.toHaveBeenCalled();
  });

  it('picking a harbor from the destination search calls onPickDestination with a PickedPoint', () => {
    const props = renderPanel();
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    fireEvent.change(within(destinationSection).getByRole('combobox'), {
      target: { value: 'Flensburg' },
    });
    fireEvent.click(within(destinationSection).getByRole('option', { name: 'Flensburg' }));
    expect(props.onPickDestination).toHaveBeenCalledWith({
      source: 'harbor',
      point: FLENSBURG.snap,
      harborId: FLENSBURG.id,
      label: 'Flensburg',
    });
    expect(props.onPickOrigin).not.toHaveBeenCalled();
  });

  it('renders the departure time as a local datetime-local value and round-trips edits to epoch ms', () => {
    const props = renderPanel();
    const input = screen.getByLabelText('Departure') as HTMLInputElement;
    const expected = new Date(DEPARTURE_MS);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedValue = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}T${pad(expected.getHours())}:${pad(expected.getMinutes())}`;
    expect(input.value).toBe(expectedValue);

    fireEvent.change(input, { target: { value: '2026-07-21T10:30' } });
    expect(props.onDepartureChange).toHaveBeenCalledWith(new Date('2026-07-21T10:30').getTime());
  });

  it('disables the plan button and shows the offline disabled reason (offline suppresses onboarding)', () => {
    // Offline: onboarding is suppressed (nothing can be planned), so the
    // disabled reason itself renders. role="alert" — an actionable blocker.
    renderPanel({
      canPlan: false,
      online: false,
      planDisabledReason: 'Wind forecast service is unreachable.',
    });
    expect(screen.getByRole('button', { name: 'Plan route' })).toBeDisabled();
    const reason = screen.getByText('Wind forecast service is unreachable.');
    expect(reason).toBeInTheDocument();
    expect(reason).toHaveAttribute('role', 'alert');
    // The empty-state onboarding must NOT also show — one message only.
    expect(
      screen.queryByText('Pick a start and destination to plan a route.'),
    ).not.toBeInTheDocument();
  });

  it('shows the missing-endpoints disabled reason (no onboarding) once a plan already exists', () => {
    // A plan exists but an endpoint is missing: onboarding (a first-run hint)
    // is gone, so the terse disabled reason renders instead.
    renderPanel({
      plan: makePlan(),
      rig: 'genoa',
      origin: null,
      destination: null,
      canPlan: false,
      planDisabledReason: 'Select a start and destination.',
    });
    expect(screen.getByText('Select a start and destination.')).toBeInTheDocument();
    expect(
      screen.queryByText('Pick a start and destination to plan a route.'),
    ).not.toBeInTheDocument();
  });

  it('enables the plan button and calls onPlan when clicked, with no reason shown', () => {
    const props = renderPanel({ canPlan: true, planDisabledReason: null });
    const button = screen.getByRole('button', { name: 'Plan route' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(props.onPlan).toHaveBeenCalled();
  });

  it('renders a fetching status message during planning.phase "fetching"', () => {
    renderPanel({ planning: { phase: 'fetching' } });
    expect(screen.getByRole('status')).toHaveTextContent('Fetching wind forecast');
  });

  // #340: the readout is a bounded phase indicator ("sail N of 2 (Rig)"),
  // not a percentage — pinning literal text for both rigs so a mixed-up
  // index/rig-name substitution would fail visibly.
  it('renders the genoa routing phase as "sail 1 of 2 (Genoa)"', () => {
    renderPanel({ planning: { phase: 'routing', rig: 'genoa' } });
    expect(screen.getByRole('status')).toHaveTextContent('Calculating route… sail 1 of 2 (Genoa)');
  });

  it('renders the fock routing phase as "sail 2 of 2 (Fock)" — the genoa->fock switch is not a regression', () => {
    renderPanel({ planning: { phase: 'routing', rig: 'fock' } });
    expect(screen.getByRole('status')).toHaveTextContent('Calculating route… sail 2 of 2 (Fock)');
  });

  it('does NOT render a plan-run error inline (the App banner is the single alert surface)', () => {
    // §3.5 consolidation: the error lives only in App.tsx's tab-independent
    // <Banner>, so it is never announced twice. The panel stays quiet.
    renderPanel({ planning: { phase: 'error', message: 'Open-Meteo is unreachable.' } });
    expect(screen.queryByText('Open-Meteo is unreachable.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('via waypoints', () => {
    const VIA_A = { lat: 54.8, lon: 9.9 };
    const VIA_B = { lat: 54.82, lon: 9.95 };

    it('shows no chip list when there are no via points', () => {
      renderPanel({ viaPoints: [] });
      const viaSection = screen.getByRole('region', { name: 'Waypoints' });
      expect(within(viaSection).queryByRole('list')).not.toBeInTheDocument();
    });

    it('requests map-tap mode for "via" when "Add waypoint" is clicked', () => {
      const props = renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Add waypoint' }));
      expect(props.onRequestMapTap).toHaveBeenCalledWith('via');
    });

    it('renders one chip per via point, formatted as a coordinate label', () => {
      renderPanel({ viaPoints: [VIA_A, VIA_B] });
      const viaSection = screen.getByRole('region', { name: 'Waypoints' });
      const items = within(viaSection).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent('54.800°N 9.900°E');
      expect(items[1]).toHaveTextContent('54.820°N 9.950°E');
    });

    it("removing a chip calls onRemoveVia with that chip's index", () => {
      const props = renderPanel({ viaPoints: [VIA_A, VIA_B] });
      fireEvent.click(screen.getByRole('button', { name: 'Remove waypoint 2' }));
      expect(props.onRemoveVia).toHaveBeenCalledWith(1);
    });

    it('reordering a chip calls onReorderVia with its index and direction', () => {
      const props = renderPanel({ viaPoints: [VIA_A, VIA_B] });
      fireEvent.click(screen.getByRole('button', { name: 'Move waypoint 2 up' }));
      expect(props.onReorderVia).toHaveBeenCalledWith(1, 'up');
      fireEvent.click(screen.getByRole('button', { name: 'Move waypoint 1 down' }));
      expect(props.onReorderVia).toHaveBeenCalledWith(0, 'down');
    });

    it('disables the first chip\'s "move up" and the last chip\'s "move down" buttons', () => {
      renderPanel({ viaPoints: [VIA_A, VIA_B] });
      expect(screen.getByRole('button', { name: 'Move waypoint 1 up' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move waypoint 2 down' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move waypoint 1 down' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Move waypoint 2 up' })).toBeEnabled();
    });

    it('disables all via controls while a replan is in flight', () => {
      renderPanel({ viaPoints: [VIA_A], viaReplanning: true });
      expect(screen.getByRole('button', { name: 'Add waypoint' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Remove waypoint 1' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move waypoint 1 down' })).toBeDisabled();
    });
  });

  // §3.3 / #299: safety depth stays inline in the compact row; the rest of
  // what used to sit behind "Erweitert" moved to the dedicated Boat tab
  // (SettingsPanel.tsx, covered by SettingsPanel.test.tsx) — this panel no
  // longer renders it at all, only a discoverable link back to it.
  describe('safety depth compact row + boat-settings link (§3.3, #299)', () => {
    it('keeps departure AND safety depth visible in the compact row', () => {
      renderPanel();
      expect(screen.getByLabelText('Departure')).toBeInTheDocument();
      expect(screen.getByLabelText('Safety depth (m)')).toBeInTheDocument();
    });

    it('commits a clamped safety depth on blur (max 10)', () => {
      const props = renderPanel();
      const input = screen.getByLabelText('Safety depth (m)');
      fireEvent.change(input, { target: { value: '12' } });
      fireEvent.blur(input);
      expect(input).toHaveValue(10);
      expect(props.onSettingsChange).toHaveBeenCalledWith({
        ...DEFAULT_SETTINGS,
        safetyDepthM: 10,
      });
    });

    it('clamps safety depth below the 2.2 m floor (never below draft + margin)', () => {
      const props = renderPanel();
      const input = screen.getByLabelText('Safety depth (m)');
      fireEvent.change(input, { target: { value: '1' } });
      fireEvent.blur(input);
      expect(input).toHaveValue(2.2);
      expect(props.onSettingsChange).toHaveBeenCalledWith({
        ...DEFAULT_SETTINGS,
        safetyDepthM: 2.2,
      });
    });

    it('no longer renders the advanced fields/disclosure inline — they moved to the Boat tab', () => {
      localStorage.setItem('sc-lang', 'en');
      const { container } = render(
        <I18nProvider>
          <PlannerPanel {...baseProps()} />
        </I18nProvider>,
      );
      expect(container.querySelector('details.planner-advanced')).toBeNull();
      expect(screen.queryByLabelText('Motoring speed (kn)')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Depth comfort margin (m)')).not.toBeInTheDocument();
    });

    it('renders a discoverable link to the Boat tab next to safety depth, naming the depth comfort margin', () => {
      const props = renderPanel();
      const link = screen.getByRole('button', {
        name: /Depth comfort margin & more boat settings/,
      });
      expect(link).toBeInTheDocument();
      fireEvent.click(link);
      expect(props.onOpenBoatSettings).toHaveBeenCalledTimes(1);
    });
  });

  // §3.4 (Option B): compact Ergebnis strip + completion announcement.
  describe('compact Ergebnis strip (§3.4)', () => {
    it('renders no Ergebnis strip before a plan exists', () => {
      renderPanel({ plan: null, rig: null });
      expect(screen.queryByRole('button', { name: /View details/ })).not.toBeInTheDocument();
    });

    it('renders the strip with distance, avg speed and a faster-rig chip once a plan is present', () => {
      renderPanel({ plan: makePlan(), rig: 'genoa' });
      // 21.5 nm / 5 h = 4.3 kn (hand-derived).
      expect(screen.getByText('21.5 nm')).toBeInTheDocument();
      expect(screen.getByText('4.3 kn')).toBeInTheDocument();
      expect(screen.getByText('Faster: Genoa')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /View details/ })).toBeInTheDocument();
    });

    it('"View details" calls onViewDetails (tab switch + focus handled by the parent)', () => {
      const props = renderPanel({ plan: makePlan(), rig: 'genoa' });
      fireEvent.click(screen.getByRole('button', { name: /View details/ }));
      expect(props.onViewDetails).toHaveBeenCalledTimes(1);
    });

    it('swaps the status live region to the completion summary on the routing->idle transition', () => {
      localStorage.setItem('sc-lang', 'en');
      const { rerender } = render(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({ planning: { phase: 'routing', rig: 'genoa' }, plan: null, rig: null })}
          />
        </I18nProvider>,
      );
      // In-flight: the region shows the routing message.
      expect(screen.getByRole('status')).toHaveTextContent('Calculating route');

      rerender(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({ planning: { phase: 'idle' }, plan: makePlan(), rig: 'genoa' })}
          />
        </I18nProvider>,
      );
      const status = screen.getByRole('status');
      // Stable summary swapped into the SAME region (no second live region).
      expect(status).toHaveTextContent('Route calculated');
      expect(status).toHaveTextContent('21.5 nm');
      expect(status).toHaveTextContent('5 h 00 min');
    });

    it('does NOT re-announce on a same-id plan update (via-edit/slider re-render freezes the summary)', () => {
      localStorage.setItem('sc-lang', 'en');
      const { rerender } = render(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({ planning: { phase: 'routing', rig: 'genoa' }, plan: null, rig: null })}
          />
        </I18nProvider>,
      );
      rerender(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({ planning: { phase: 'idle' }, plan: makePlan(), rig: 'genoa' })}
          />
        </I18nProvider>,
      );
      expect(screen.getByRole('status')).toHaveTextContent('21.5 nm');

      // A new plan OBJECT with the SAME id but a different distance (as a via
      // re-plan produces). The announcement must stay frozen at 21.5, proving
      // it did not re-derive/re-fire on a same-id update.
      rerender(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'idle' },
              plan: makePlan({ id: 'plan-1', distanceNm: 30 }),
              rig: 'genoa',
            })}
          />
        </I18nProvider>,
      );
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('21.5 nm');
      expect(status).not.toHaveTextContent('30.0 nm');
    });

    it('does NOT announce on mount when a plan is already present (only on a genuine completion)', () => {
      renderPanel({ planning: { phase: 'idle' }, plan: makePlan(), rig: 'genoa' });
      // Seeded from the mount plan id, so re-entering the tab with an existing
      // result stays quiet — the region is empty, not restating the summary.
      expect(screen.getByRole('status').textContent).toBe('');
    });
  });

  // #452: the shallow-water warning + the effective (relaxed) depth must be
  // visible on THIS strip — the first surface a user sees a result on —
  // without switching to the Routes tab. Distinct requested/used/minGate
  // values (3.0 / 2.5 / 2.3) so a test asserting on `usedDepthM` cannot pass
  // by accident against `minGateDepthM` or `requestedDepthM` instead.
  describe('shallow-water warning (#452)', () => {
    function makeShallowPlan(): Plan {
      const plan = makePlan();
      plan.result.shallow = { requestedDepthM: 3.0, usedDepthM: 2.5, minGateDepthM: 2.3 };
      return plan;
    }

    it('renders the plan-level shallow warning, naming the effective (used) depth', () => {
      renderPanel({ plan: makeShallowPlan(), rig: 'genoa' });
      const banner = screen.getByText(/was not passable/);
      expect(banner).toHaveAttribute('role', 'alert');
      expect(banner).toHaveClass('shallow-warning');
      // Requested depth.
      expect(banner.textContent).toContain('3.0 m');
      // #452: the effective depth the route was actually computed at — the
      // defect this test guards was that usedDepthM rendered nowhere.
      expect(banner.textContent).toContain('2.5 m');
      // Shallowest charted depth crossed by the plan (Minor 5, PR #461: not
      // "actually crossed" — minGateDepthM folds over BOTH rigs' legs, so on
      // one rig's tab it can name the OTHER rig's leg).
      expect(banner.textContent).toContain('2.3 m');
      // Honest passage-planning-aid copy (#455): never claims an unflagged
      // section IS safe. review (PR #461 Major 3): the ORIGINAL
      // `/\bis (verified|guaranteed)\b/i` matched only those two exact word
      // pairs, so appending "All unmarked water on this route is safe." to
      // the EN string reproduced 91/91 GREEN — measured directly against
      // this branch before this fix. Widened to also catch "is/are safe" and
      // "is/are clear", the reviewer's specific counter-example. NARROWED,
      // NOT CLOSED (re-run against MY OWN replacement, per the fix-wave
      // brief): appending "This route poses no risk beyond the marked
      // sections." to the EN string still passes the WIDENED regex too —
      // no finite word list closes this class for free-form prose. The
      // POSITIVE `toContain` below is what actually earns its
      // keep (it reds the moment the required hedge clause is removed,
      // added-to, or reworded away); this negative check is a regression pin
      // against the two SPECIFIC phrasings already seen going wrong, not a
      // content classifier.
      expect(banner.textContent).not.toMatch(/\b(is|are) (safe|clear|verified|guaranteed)\b/i);
      expect(banner.textContent).toContain('not guaranteed to be clear');
    });

    it('is absent on a plan with no relaxation', () => {
      renderPanel({ plan: makePlan(), rig: 'genoa' });
      expect(screen.queryByText(/was not passable/)).not.toBeInTheDocument();
    });

    it('is absent before any plan exists', () => {
      renderPanel({ plan: null, rig: null });
      expect(screen.queryByText(/was not passable/)).not.toBeInTheDocument();
    });

    // Review finding (PR #461 Major 1): the warning is plan-level, but its
    // OLD render site lived inside a `summary &&` gate, and `summary` is
    // null whenever the ACTIVE rig's own result is null — so a user on the
    // rig tab whose solve failed saw no warning for a plan that carries one.
    // `makeShallowPlan()` -> `makePlan()` sets `fock: null` by default
    // (`fockReason: 'calm-motor-off'`), which is exactly this shape; viewing
    // it on the fock tab reproduces the reviewer's measured probe.
    it('#452 Major 1: still renders when the ACTIVE rig itself has no result', () => {
      renderPanel({ plan: makeShallowPlan(), rig: 'fock' });
      expect(screen.getByText(/was not passable/)).toBeInTheDocument();
      // No summary-dependent content exists for fock — the warning is the
      // only thing this rig's strip has to show; "View details" needs
      // `summary` too and must stay absent.
      expect(screen.queryByRole('button', { name: /View details/ })).not.toBeInTheDocument();
    });
  });

  // #301: the dirty-form indicator — a second Chip in the Ergebnis card plus
  // the same sentence folded into the panel's ONE existing live region.
  describe('dirty-form indicator (#301)', () => {
    it('renders a second Chip when formDirty && summary', () => {
      renderPanel({ plan: makePlan(), rig: 'genoa', formDirty: true });
      // Scoped to the Chip's <span> — the identical sentence is ALSO folded
      // into the sr-only status <p> below (see the live-region tests further
      // down), so an unscoped query would match two elements.
      expect(
        screen.getByText(en['planner.result.stale'], { selector: 'span' }),
      ).toBeInTheDocument();
      // Beside the existing faster-rig chip, not replacing it.
      expect(screen.getByText('Faster: Genoa')).toBeInTheDocument();
    });

    it('does NOT render the stale chip when formDirty is false', () => {
      renderPanel({ plan: makePlan(), rig: 'genoa', formDirty: false });
      expect(screen.queryByText(en['planner.result.stale'])).not.toBeInTheDocument();
    });

    it('does NOT render the stale chip when formDirty is true but there is no result yet (no plan)', () => {
      renderPanel({ plan: null, rig: null, formDirty: true });
      expect(screen.queryByText(en['planner.result.stale'])).not.toBeInTheDocument();
    });

    it('folds the same sentence into the panel status region, and there is still exactly ONE role="status" region', () => {
      renderPanel({ planning: { phase: 'idle' }, plan: makePlan(), rig: 'genoa', formDirty: true });
      expect(screen.getAllByRole('status')).toHaveLength(1);
      // No fresh announcement fired on this mount (seeded from the mount plan
      // id, per the test above) — so the status text is the stale sentence
      // ALONE, with no leading space from an empty announcement half.
      expect(screen.getByRole('status').textContent).toBe(en['planner.result.stale']);
    });

    it('joins a genuine completion announcement AND the stale sentence into the one region, space-separated', () => {
      localStorage.setItem('sc-lang', 'en');
      const { rerender } = render(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({ planning: { phase: 'routing', rig: 'genoa' }, plan: null, rig: null })}
          />
        </I18nProvider>,
      );
      rerender(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'idle' },
              plan: makePlan(),
              rig: 'genoa',
              formDirty: true,
            })}
          />
        </I18nProvider>,
      );
      const status = screen.getByRole('status');
      const text = status.textContent ?? '';
      expect(text).toContain('Route calculated');
      expect(text.endsWith(en['planner.result.stale'])).toBe(true);
      // Exactly ONE space joins the two halves — not glued together (zero
      // spaces) and not a double space (would read as two run-on sentences).
      const beforeSuffix = text.slice(0, text.length - en['planner.result.stale'].length);
      expect(beforeSuffix.endsWith(' ')).toBe(true);
      expect(beforeSuffix.endsWith('  ')).toBe(false);
    });

    it('does NOT change the status text when formDirty flips false→false (only the boolean flip drives a change)', () => {
      const { rerender } = render(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'idle' },
              plan: makePlan(),
              rig: 'genoa',
              formDirty: false,
            })}
          />
        </I18nProvider>,
      );
      const before = screen.getByRole('status').textContent;
      rerender(
        <I18nProvider>
          <PlannerPanel
            {...baseProps({
              planning: { phase: 'idle' },
              plan: makePlan(),
              rig: 'genoa',
              formDirty: false,
            })}
          />
        </I18nProvider>,
      );
      expect(screen.getByRole('status').textContent).toBe(before);
    });
  });

  // §3.5: empty/first-run onboarding + loading skeleton.
  describe('states & motion (§3.5)', () => {
    const ORIGIN: PickedPoint = {
      source: 'harbor',
      point: FLENSBURG.snap,
      harborId: FLENSBURG.id,
      label: 'Flensburg',
    };
    const DESTINATION: PickedPoint = {
      source: 'harbor',
      point: MARSTAL.snap,
      harborId: MARSTAL.id,
      label: 'Marstal',
    };

    it('shows the onboarding line when no plan exists and an endpoint is unpicked', () => {
      renderPanel({ origin: null, destination: null, plan: null });
      expect(screen.getByText('Pick a start and destination to plan a route.')).toBeInTheDocument();
    });

    it('hides the onboarding line once both endpoints are set', () => {
      renderPanel({ origin: ORIGIN, destination: DESTINATION, plan: null });
      expect(
        screen.queryByText('Pick a start and destination to plan a route.'),
      ).not.toBeInTheDocument();
    });

    it('hides the onboarding line once a plan exists', () => {
      renderPanel({ origin: null, destination: null, plan: makePlan(), rig: 'genoa' });
      expect(
        screen.queryByText('Pick a start and destination to plan a route.'),
      ).not.toBeInTheDocument();
    });

    it('suppresses the onboarding line while offline (the offline reason takes its place)', () => {
      renderPanel({ online: false, origin: null, destination: null, plan: null });
      expect(
        screen.queryByText('Pick a start and destination to plan a route.'),
      ).not.toBeInTheDocument();
    });

    it('renders a decorative skeleton in the result slot while a first plan is in flight', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'routing', rig: 'genoa' },
        plan: null,
        rig: null,
      });
      const skeletonCard = container.querySelector('.planner-result-skeleton');
      expect(skeletonCard).not.toBeNull();
      expect(skeletonCard).toHaveAttribute('aria-hidden', 'true');
      // Placeholder shapes: one chip + four stat blocks (matching the compact card).
      expect(skeletonCard!.querySelectorAll('.sc-skeleton')).toHaveLength(5);
      // The live status region still carries the a11y feedback (not the skeleton).
      expect(screen.getByRole('status')).toHaveTextContent('Calculating route');
    });

    it('shows no skeleton once a result is present (real card replaces it)', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'idle' },
        plan: makePlan(),
        rig: 'genoa',
      });
      expect(container.querySelector('.planner-result-skeleton')).toBeNull();
    });

    it('shows no skeleton while idle before any planning has started', () => {
      const { container } = renderPanelReturningContainer({ planning: { phase: 'idle' } });
      expect(container.querySelector('.planner-result-skeleton')).toBeNull();
    });

    it('shows no skeleton while re-planning an existing result — the live card stays, not stacked', () => {
      // Replan case: in-flight (routing) WITH an existing summary. The `!summary`
      // gate must keep the real compact Ergebnis card and NOT overlay a skeleton
      // on top of it. Mutating the gate to drop `!summary` makes this fail.
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'routing', rig: 'genoa' },
        plan: makePlan(),
        rig: 'genoa',
      });
      expect(container.querySelector('.planner-result-skeleton')).toBeNull();
      // The real card (its faster-rig chip only exists on the real Ergebnis card).
      expect(container.querySelector('.chip-faster-rig')).not.toBeNull();
    });

    it('#259: a tie comparison renders the honest tie chip, not "Faster: X"', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'idle' },
        plan: makePlan({ rigRecommendation: { kind: 'tie' } }),
        rig: 'genoa',
      });
      const chip = container.querySelector('.chip-faster-rig');
      expect(chip?.textContent).toBe('Genoa and Fock are effectively tied for this passage');
    });

    it('#259: a moot (all-motor) comparison renders the honest moot chip, not "Faster: X"', () => {
      const { container } = renderPanelReturningContainer({
        planning: { phase: 'idle' },
        plan: makePlan({ rigRecommendation: { kind: 'moot' } }),
        rig: 'genoa',
      });
      const chip = container.querySelector('.chip-faster-rig');
      expect(chip?.textContent).toBe(
        'Rig does not matter here — this passage runs entirely under engine',
      );
    });
  });
});

describe('GPX import — file-size DoS guard (#3 hardening)', () => {
  it('rejects an oversized file with the too-large error and never reads it', async () => {
    renderPanel();
    const fileInput = document.querySelector('input[type="file"]');
    if (!(fileInput instanceof HTMLInputElement)) throw new Error('import file input not found');

    // A tiny File whose reported .size is stubbed one byte past the cap, so the
    // guard fires without allocating a real >10 MB blob. The text() spy is the
    // load-bearing assertion: the rejection must happen BEFORE any read, so the
    // hundreds-of-MB file is never pulled into memory (parseGpx never runs).
    const file = new File(['<gpx/>'], 'huge.gpx', { type: 'application/gpx+xml' });
    Object.defineProperty(file, 'size', { value: MAX_GPX_FILE_BYTES + 1 });
    const textSpy = vi.spyOn(file, 'text');

    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText(en['planner.import.error.tooLarge'])).toBeInTheDocument();
    expect(textSpy).not.toHaveBeenCalled();
  });
});
