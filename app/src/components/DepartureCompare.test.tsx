import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  PLAN_SCHEMA_VERSION,
  defaultBoatSnapshot,
  type LatLon,
  type Plan,
  type PlanResultOk,
} from '../types';
import DepartureCompare from './DepartureCompare';
import { useDepartureScan, type DepartureScanState } from '../state/useDepartureScan';

vi.mock('../state/useDepartureScan', () => ({ useDepartureScan: vi.fn() }));

const ORIGIN: LatLon = { lat: 54.75, lon: 10.0 };
const DESTINATION: LatLon = { lat: 54.75, lon: 10.4 };
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

const OK_RESULT: PlanResultOk = {
  status: 'ok',
  sails: [
    {
      sailId: 'genoa',
      result: {
        sailId: 'genoa',
        legs: [],
        etaMs: DEPARTURE_MS + 3_600_000,
        durationMs: 3_600_000,
        distanceNm: 10,
        maneuverCount: 0,
        motorDistanceNm: 0,
      },
      reason: null,
    },
    { sailId: 'fock', result: null, reason: 'calm-motor-off' },
  ],
  recommended: 'genoa',
  comparisonComplete: true,
  snappedOrigin: ORIGIN,
  snappedDestination: DESTINATION,
};

function makePlan(): Plan {
  return {
    id: 'plan-1',
    name: 'Test plan',
    createdAtMs: DEPARTURE_MS - 3_600_000,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: ORIGIN,
      destination: DESTINATION,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: uniformWindGrid(12, 0, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 96 }),
    result: OK_RESULT,
  };
}

function stubHook(overrides: Partial<DepartureScanState> = {}, scan = vi.fn(), cancel = vi.fn()) {
  const state: DepartureScanState = {
    scanning: false,
    index: 0,
    total: 0,
    candidates: [],
    error: null,
    cancelled: false,
    ...overrides,
  };
  vi.mocked(useDepartureScan).mockReturnValue({ state, scan, cancel, reset: vi.fn() });
  return { scan, cancel };
}

function renderCompare(plan: Plan | null) {
  return render(
    <I18nProvider>
      <DepartureCompare plan={plan} ensureClient={() => Promise.resolve(null)} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DepartureCompare', () => {
  it('renders nothing before a plan exists', () => {
    stubHook();
    const { container } = renderCompare(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the count/step controls and a start button once a plan exists', () => {
    stubHook();
    renderCompare(makePlan());
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vergleich starten' })).toBeInTheDocument();
  });

  it("clicking the start button calls scan() with the plan's own windGrid", () => {
    const { scan } = stubHook();
    renderCompare(makePlan());
    fireEvent.click(screen.getByRole('button', { name: 'Vergleich starten' }));
    expect(scan).toHaveBeenCalledTimes(1);
    const req = scan.mock.calls[0]?.[0];
    expect(req.windGrid).toEqual(
      uniformWindGrid(12, 0, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 96 }),
    );
    expect(req.base.departureMs).toBe(DEPARTURE_MS);
  });

  it('while scanning: shows the phase readout and a cancel button, hides the controls', () => {
    const { cancel } = stubHook({ scanning: true, index: 2, total: 6 });
    renderCompare(makePlan());
    expect(screen.getByRole('status')).toHaveTextContent('Fenster 2 von 6 wird berechnet');
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('renders a plain list row per candidate, honestly labelling ok/no-route/failed outcomes', () => {
    stubHook({
      candidates: [
        { departureMs: DEPARTURE_MS, outcome: { kind: 'ok', result: OK_RESULT } },
        {
          departureMs: DEPARTURE_MS + 3_600_000,
          outcome: { kind: 'no-route', reason: 'beyond-horizon' },
        },
        {
          departureMs: DEPARTURE_MS + 7_200_000,
          outcome: { kind: 'failed', messageKey: 'error.boatNotInCatalogue' },
        },
      ],
    });
    renderCompare(makePlan());
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('% Motor');
    expect(items[1]?.textContent).toMatch(/Vorhersagehorizont/);
    expect(items[2]?.textContent).toMatch(/nicht mehr verfügbar/);
  });

  it('shows a cancelled-notice chip after a scan stops early via cancel()', () => {
    stubHook({
      cancelled: true,
      candidates: [{ departureMs: DEPARTURE_MS, outcome: { kind: 'ok', result: OK_RESULT } }],
    });
    renderCompare(makePlan());
    expect(screen.getByText(/Abgebrochen/)).toBeInTheDocument();
  });
});
