import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import { FORECAST_DAYS } from '../services/openMeteo';
import { DEFAULT_SETTINGS, type Harbor } from '../types';
import PlannerPanel, { nextFullHourMs, type PickedPoint, type PlanningState } from './PlannerPanel';

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

interface Overrides {
  origin?: PickedPoint | null;
  destination?: PickedPoint | null;
  onPickOrigin?: (p: PickedPoint) => void;
  onPickDestination?: (p: PickedPoint) => void;
  onRequestMapTap?: (target: 'origin' | 'destination') => void;
  onDepartureChange?: (ms: number) => void;
  onSettingsChange?: (s: typeof DEFAULT_SETTINGS) => void;
  canPlan?: boolean;
  planDisabledReason?: string | null;
  onPlan?: () => void;
  planning?: PlanningState;
}

function renderPanel(overrides: Overrides = {}) {
  localStorage.setItem('sc-lang', 'en');
  const props = {
    harbors: HARBORS,
    origin: null,
    destination: null,
    onPickOrigin: vi.fn(),
    onPickDestination: vi.fn(),
    onRequestMapTap: vi.fn(),
    departureMs: DEPARTURE_MS,
    onDepartureChange: vi.fn(),
    settings: DEFAULT_SETTINGS,
    onSettingsChange: vi.fn(),
    canPlan: true,
    planDisabledReason: null,
    onPlan: vi.fn(),
    planning: { phase: 'idle' } as PlanningState,
    ...overrides,
  };
  render(
    <I18nProvider>
      <PlannerPanel {...props} />
    </I18nProvider>,
  );
  return props;
}

afterEach(() => {
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
  it('shows a placeholder when origin/destination are unset', () => {
    renderPanel();
    expect(screen.getAllByText('Not selected')).toHaveLength(2);
  });

  it('renders the picked origin and destination labels', () => {
    renderPanel({
      origin: { point: FLENSBURG.snap, harborId: FLENSBURG.id, label: 'Flensburg' },
      destination: { point: MARSTAL.snap, harborId: MARSTAL.id, label: 'Marstal' },
    });
    // Scoped to the <p> label, not the harbor-picker buttons that also
    // render "Flensburg"/"Marstal" as list entries.
    const originSection = screen.getByRole('region', { name: 'Origin' });
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    expect(within(originSection).getByText('Flensburg', { selector: 'p' })).toBeInTheDocument();
    expect(within(destinationSection).getByText('Marstal', { selector: 'p' })).toBeInTheDocument();
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
    fireEvent.click(within(originSection).getByRole('button', { name: 'Marstal' }));
    expect(props.onPickOrigin).toHaveBeenCalledWith({
      point: MARSTAL.snap,
      harborId: MARSTAL.id,
      label: 'Marstal',
    });
    expect(props.onPickDestination).not.toHaveBeenCalled();
  });

  it('picking a harbor from the destination search calls onPickDestination with a PickedPoint', () => {
    const props = renderPanel();
    const destinationSection = screen.getByRole('region', { name: 'Destination' });
    fireEvent.click(within(destinationSection).getByRole('button', { name: 'Flensburg' }));
    expect(props.onPickDestination).toHaveBeenCalledWith({
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
});
