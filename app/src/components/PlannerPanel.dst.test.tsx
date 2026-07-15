// @ts-expect-error process is not typed in browser context
process.env.TZ = 'Europe/Berlin';

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import { FORECAST_DAYS } from '../services/openMeteo';
import { DEFAULT_SETTINGS, type Harbor } from '../types';
import PlannerPanel, { nextFullHourMs, type PickedPoint, type PlanningState } from './PlannerPanel';

// Verify TZ pinning works: DST fold instant 2026-10-25 02:00 CEST becomes 03:00 CET
const dstTest = new Date(2026, 9, 25, 2, 23);
const tzVerifyHour = dstTest.getHours();
if (tzVerifyHour !== 2) {
  throw new Error(`TZ pinning failed: expected hour 2 at DST fold, got ${tzVerifyHour}. Skipping DST tests.`);
}

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
  departureMs?: number;
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
    departureMs: Date.UTC(2026, 6, 20, 9, 0, 0),
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
  vi.clearAllMocks();
});

describe('nextFullHourMs DST fold (Europe/Berlin)', () => {
  it('returns strictly-after result even during autumn DST fold at 02:23 CEST→CET', () => {
    // 2026-10-25 02:23 CEST (before fold): nextFullHourMs should return 03:00 CET (after fold)
    // The old code would naively add 3600000 ms, landing at 02:00 CET (wall-clock EARLIER)
    // The fixed code uses setHours to advance wall-clock hour, respecting the DST transition.
    const startMs = new Date(2026, 9, 25, 2, 23).getTime();
    const resultMs = nextFullHourMs(startMs);

    // Result must be strictly after start
    expect(resultMs).toBeGreaterThan(startMs);

    // Result wall-clock hour must be 3 (after the fold)
    const resultDate = new Date(resultMs);
    expect(resultDate.getHours()).toBe(3);
  });
});

describe('PlannerPanel departure input attributes', () => {
  it('renders min and max attributes on the datetime-local input, based on now and forecast horizon', () => {
    vi.useFakeTimers();
    // Fake timers set to 2026-07-15 14:30:00 UTC
    const fakeNow = new Date('2026-07-15T14:30:00Z').getTime();
    vi.setSystemTime(fakeNow);

    renderPanel();

    const input = screen.getByLabelText('Departure') as HTMLInputElement;

    // Extract expected min/max from the component's own toLocalInputValue logic
    // min should be now, max should be now + FORECAST_DAYS * 86_400_000
    const nowDate = new Date();
    const maxDate = new Date(nowDate.getTime() + FORECAST_DAYS * 86_400_000);

    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedMinStr = `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}T${pad(nowDate.getHours())}:${pad(nowDate.getMinutes())}`;
    const expectedMaxStr = `${maxDate.getFullYear()}-${pad(maxDate.getMonth() + 1)}-${pad(maxDate.getDate())}T${pad(maxDate.getHours())}:${pad(maxDate.getMinutes())}`;

    expect(input.getAttribute('min')).toBe(expectedMinStr);
    expect(input.getAttribute('max')).toBe(expectedMaxStr);

    vi.useRealTimers();
  });
});
