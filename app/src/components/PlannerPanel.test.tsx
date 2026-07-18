import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
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

function makePlan(over: { id?: string; distanceNm?: number } = {}): Plan {
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
  onPlan?: () => void;
  planning?: PlannerStatus;
  plan?: Plan | null;
  rig?: Rig | null;
  onViewDetails?: () => void;
}

function baseProps(overrides: Overrides = {}) {
  return {
    harbors: HARBORS,
    origin: null,
    destination: null,
    onPickOrigin: vi.fn(),
    onPickDestination: vi.fn(),
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
    onPlan: vi.fn(),
    planning: { phase: 'idle' } as PlannerStatus,
    plan: null as Plan | null,
    rig: null as Rig | null,
    onViewDetails: vi.fn(),
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

  it('disables the plan button and shows the reason when canPlan is false', () => {
    renderPanel({ canPlan: false, planDisabledReason: 'Pick an origin and destination first.' });
    expect(screen.getByRole('button', { name: 'Plan route' })).toBeDisabled();
    expect(screen.getByText('Pick an origin and destination first.')).toBeInTheDocument();
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

  it('renders a routing status message, with progress when provided', () => {
    renderPanel({ planning: { phase: 'routing', progress: 0.42 } });
    expect(screen.getByRole('status')).toHaveTextContent('42%');
  });

  it('renders a generic routing status message when no progress is given', () => {
    renderPanel({ planning: { phase: 'routing' } });
    expect(screen.getByRole('status')).toHaveTextContent('Calculating route');
  });

  it('renders the error message during planning.phase "error"', () => {
    renderPanel({ planning: { phase: 'error', message: 'Open-Meteo is unreachable.' } });
    expect(screen.getByText('Open-Meteo is unreachable.')).toBeInTheDocument();
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

  // §3.3: advanced-options progressive disclosure.
  describe('advanced disclosure (§3.3)', () => {
    it('keeps departure AND safety depth visible in the compact row (not behind the disclosure)', () => {
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

    it('hides the five advanced fields behind a collapsed "Advanced" disclosure', () => {
      localStorage.setItem('sc-lang', 'en');
      const { container } = render(
        <I18nProvider>
          <PlannerPanel {...baseProps()} />
        </I18nProvider>,
      );
      const details = container.querySelector('details.planner-advanced') as HTMLDetailsElement;
      expect(details).not.toBeNull();
      expect(details.open).toBe(false);
      // The advanced fields live inside the disclosure (native details keeps
      // them in the DOM even when collapsed).
      expect(within(details).getByLabelText('Motoring speed (kn)')).toBeInTheDocument();
      expect(within(details).getByLabelText('Performance factor (×)')).toBeInTheDocument();
    });

    it('shows a one-line value summary of the advanced settings when collapsed', () => {
      localStorage.setItem('sc-lang', 'en');
      const { container } = render(
        <I18nProvider>
          <PlannerPanel {...baseProps()} />
        </I18nProvider>,
      );
      const values = container.querySelector('.planner-advanced-values');
      expect(values).not.toBeNull();
      // DEFAULT_SETTINGS: motor on, 6.5 kn, 45 s penalty, ×0.9.
      const text = values!.textContent ?? '';
      expect(text).toContain('Motor on');
      expect(text).toContain('6.5 kn');
      expect(text).toContain('Maneuver 45 s');
      expect(text).toContain('×0.9');
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
          <PlannerPanel {...baseProps({ planning: { phase: 'routing' }, plan: null, rig: null })} />
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
          <PlannerPanel {...baseProps({ planning: { phase: 'routing' }, plan: null, rig: null })} />
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
});
