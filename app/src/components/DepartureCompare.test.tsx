import { act, render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { useDepartureConfirm, type DepartureConfirmState } from '../state/useDepartureConfirm';

vi.mock('../state/useDepartureScan', () => ({ useDepartureScan: vi.fn() }));
vi.mock('../state/useDepartureConfirm', () => ({ useDepartureConfirm: vi.fn() }));

const ORIGIN: LatLon = { lat: 54.75, lon: 10.0 };
const DESTINATION: LatLon = { lat: 54.75, lon: 10.4 };
const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

function okResult(durationMs: number): PlanResultOk {
  return {
    status: 'ok',
    sails: [
      {
        sailId: 'genoa',
        result: {
          sailId: 'genoa',
          legs: [],
          etaMs: DEPARTURE_MS + durationMs,
          durationMs,
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
}

const OK_RESULT = okResult(3_600_000);

// windSpeedKn default (12) -> real WindField.sample() exercised, Beaufort
// force 4 ('11 <= 16' bucket), heading '000°'. Parameterized so the #936
// review Minor's boundary test can request exactly 1 kn.
function makePlan(windSpeedKn = 12): Plan {
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
    windGrid: uniformWindGrid(windSpeedKn, 0, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 96 }),
    result: OK_RESULT,
  };
}

function stubHook(
  overrides: Partial<DepartureScanState> = {},
  scan = vi.fn(),
  cancel = vi.fn(),
  reset = vi.fn(),
) {
  const state: DepartureScanState = {
    scanning: false,
    index: 0,
    total: 0,
    candidates: [],
    error: null,
    cancelled: false,
    ...overrides,
  };
  vi.mocked(useDepartureScan).mockReturnValue({ state, scan, cancel, reset });
  return { scan, cancel, reset };
}

// #937: default idle state for every test that does not itself exercise the
// confirm action — set in beforeEach so the 8 pre-#937 tests above need no
// changes (they never touch the confirm hook at all), while a test that
// DOES exercise it overrides via a second stubConfirmHook() call.
function stubConfirmHook(
  overrides: Partial<DepartureConfirmState> = {},
  confirm = vi.fn().mockResolvedValue(null),
) {
  const state: DepartureConfirmState = {
    confirming: false,
    departureMs: null,
    error: null,
    ...overrides,
  };
  vi.mocked(useDepartureConfirm).mockReturnValue({ state, confirm, clearError: vi.fn() });
  return { confirm };
}

function renderCompare(plan: Plan | null, onConfirmed = vi.fn()) {
  return render(
    <I18nProvider>
      <DepartureCompare
        plan={plan}
        ensureClient={() => Promise.resolve(null)}
        onConfirmed={onConfirmed}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  stubConfirmHook();
});

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

  it('renders one ranked card per candidate, each carrying a wind-character badge', () => {
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
    // Real windGrid sample (12 kn from 000°) -> Beaufort force 4, heading
    // 000° — every card carries it, ok or not, since it does not depend on
    // routing having succeeded.
    for (const item of items) {
      expect(item).toHaveTextContent('Bft 4 · 000°');
    }
    expect(items[0]).toHaveTextContent('% Motor');
    expect(items[1]?.textContent).toMatch(/Vorhersagehorizont/);
    expect(items[2]?.textContent).toMatch(/nicht mehr verfügbar/);
  });

  it('mutation: reverting a distinct no-route reason to a shared string would fail this — beyond-horizon and unreachable read differently', () => {
    stubHook({
      candidates: [
        {
          departureMs: DEPARTURE_MS,
          outcome: { kind: 'no-route', reason: 'beyond-horizon' },
        },
        {
          departureMs: DEPARTURE_MS + 3_600_000,
          outcome: { kind: 'no-route', reason: 'unreachable' },
        },
      ],
    });
    renderCompare(makePlan());
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Both before AND after this assertion: the two reasons must render
    // different text. A collapse to one generic "no route" string (the
    // shape this test guards against) would make both items identical and
    // this assertion would fail.
    expect(items[0]?.textContent).not.toEqual(items[1]?.textContent);
    expect(items[0]?.textContent).toMatch(/Vorhersagehorizont/);
    expect(items[1]?.textContent).not.toMatch(/Vorhersagehorizont/);
  });

  it('ranks ok candidates by ascending duration (fastest first badge), never ranks an unroutable one', () => {
    stubHook({
      candidates: [
        // Slower of the two ok candidates, listed FIRST (chronological, not
        // by rank) — the rank badge must reorder logically without
        // reordering the DOM.
        { departureMs: DEPARTURE_MS, outcome: { kind: 'ok', result: okResult(7_200_000) } },
        {
          departureMs: DEPARTURE_MS + 3_600_000,
          outcome: { kind: 'ok', result: okResult(3_600_000) },
        },
        {
          departureMs: DEPARTURE_MS + 7_200_000,
          outcome: { kind: 'no-route', reason: 'unreachable' },
        },
      ],
    });
    renderCompare(makePlan());
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).getByText('#2')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Am schnellsten')).toBeInTheDocument();
    // The unroutable candidate must carry neither "Am schnellsten" nor any
    // "#n" badge — a rank number next to a failure would misrepresent it as
    // merely slower rather than not achieved at all.
    expect(within(items[2]!).queryByText('Am schnellsten')).not.toBeInTheDocument();
    expect(within(items[2]!).queryByText(/^#\d+$/)).not.toBeInTheDocument();
  });

  it('#936 review Minor: exactly 1 kn is Beaufort force 1, not force 0 (the 1-3 kn band is closed on the left)', () => {
    stubHook({
      candidates: [{ departureMs: DEPARTURE_MS, outcome: { kind: 'ok', result: OK_RESULT } }],
    });
    renderCompare(makePlan(1));
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Bft 1 · 000°');
    expect(items[0]?.textContent).not.toMatch(/Bft 0/);
  });

  it('shows a cancelled-notice chip after a scan stops early via cancel()', () => {
    stubHook({
      cancelled: true,
      candidates: [{ departureMs: DEPARTURE_MS, outcome: { kind: 'ok', result: OK_RESULT } }],
    });
    renderCompare(makePlan());
    expect(screen.getByText(/Abgebrochen/)).toBeInTheDocument();
  });

  describe('#937 confirm action', () => {
    // A two-rig result — unlike OK_RESULT above (the SCAN's own genoa-only
    // shape) — is what the real confirm solve returns.
    function twoRigResult(recommended: 'genoa' | 'fock'): PlanResultOk {
      return {
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
          {
            sailId: 'fock',
            result: {
              sailId: 'fock',
              legs: [],
              etaMs: DEPARTURE_MS + 3_500_000,
              durationMs: 3_500_000,
              distanceNm: 10,
              maneuverCount: 0,
              motorDistanceNm: 0,
            },
            reason: null,
          },
        ],
        recommended,
        comparisonComplete: true,
        rigRecommendation: { kind: 'decided', rig: recommended },
        snappedOrigin: ORIGIN,
        snappedDestination: DESTINATION,
      };
    }

    it('renders a confirm button only on ok candidates, never on no-route/failed ones', () => {
      stubHook({
        candidates: [
          { departureMs: DEPARTURE_MS, outcome: { kind: 'ok', result: OK_RESULT } },
          {
            departureMs: DEPARTURE_MS + 3_600_000,
            outcome: { kind: 'no-route', reason: 'beyond-horizon' },
          },
        ],
      });
      renderCompare(makePlan());
      expect(screen.getAllByRole('button', { name: 'Diese Abfahrt übernehmen' })).toHaveLength(1);
    });

    it('clicking confirm calls confirm() with the plan and that exact candidate departureMs', () => {
      const plan = makePlan();
      const candidateMs = DEPARTURE_MS + 3_600_000;
      stubHook({
        candidates: [{ departureMs: candidateMs, outcome: { kind: 'ok', result: OK_RESULT } }],
      });
      const { confirm } = stubConfirmHook();
      renderCompare(plan);
      fireEvent.click(screen.getByRole('button', { name: 'Diese Abfahrt übernehmen' }));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(plan, candidateMs);
    });

    it('while confirming THAT candidate: shows a status readout instead of its button; a SIBLING ok candidate keeps its button, disabled', () => {
      const candidateMs = DEPARTURE_MS;
      const siblingMs = DEPARTURE_MS + 3_600_000;
      stubHook({
        candidates: [
          { departureMs: candidateMs, outcome: { kind: 'ok', result: OK_RESULT } },
          { departureMs: siblingMs, outcome: { kind: 'ok', result: OK_RESULT } },
        ],
      });
      stubConfirmHook({ confirming: true, departureMs: candidateMs });
      renderCompare(makePlan());

      expect(
        screen.getByText('Vollständige Berechnung mit beiden Riggs läuft …'),
      ).toBeInTheDocument();
      const siblingButton = screen.getByRole('button', { name: 'Diese Abfahrt übernehmen' });
      expect(siblingButton).toBeDisabled();
    });

    it('a successful confirm calls onConfirmed and shows a plain success notice when the comparison agrees with genoa', async () => {
      const plan = makePlan();
      const candidateMs = DEPARTURE_MS;
      stubHook({
        candidates: [{ departureMs: candidateMs, outcome: { kind: 'ok', result: OK_RESULT } }],
      });
      const updated: Plan = {
        ...plan,
        createdAtMs: plan.createdAtMs + 1,
        result: twoRigResult('genoa'),
      };
      const { confirm } = stubConfirmHook({}, vi.fn().mockResolvedValue(updated));
      const onConfirmed = vi.fn();
      renderCompare(plan, onConfirmed);

      fireEvent.click(screen.getByRole('button', { name: 'Diese Abfahrt übernehmen' }));
      await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(updated));
      expect(confirm).toHaveBeenCalledWith(plan, candidateMs);
      expect(screen.getByText('Plan übernommen.')).toBeInTheDocument();
      // Honest: agreeing with the scan's own genoa ranking names no rig.
      expect(screen.queryByText(/empfiehlt/)).not.toBeInTheDocument();
    });

    // Mutation, verified by hand (not committed): deleting the
    // `rec.rig !== GENOA_SAIL_ID` half of DepartureCompare.tsx's
    // disagreeingRig computation (leaving only `rec.kind === 'decided'`)
    // turns this GREEN into a false disagreement notice even for a
    // genoa-agreeing confirm — this test's `queryByText(/empfiehlt/)` above
    // would then fail (BEFORE the fix: fails, finds the disagreement text
    // where none is expected; AFTER: passes).
    it('§2.2 "worth surfacing" residual: a confirmed result that decides a DIFFERENT rig than genoa is surfaced honestly, naming the rig', async () => {
      const plan = makePlan();
      const candidateMs = DEPARTURE_MS;
      stubHook({
        candidates: [{ departureMs: candidateMs, outcome: { kind: 'ok', result: OK_RESULT } }],
      });
      const updated: Plan = {
        ...plan,
        createdAtMs: plan.createdAtMs + 1,
        result: twoRigResult('fock'),
      };
      stubConfirmHook({}, vi.fn().mockResolvedValue(updated));
      renderCompare(plan);

      fireEvent.click(screen.getByRole('button', { name: 'Diese Abfahrt übernehmen' }));
      expect(await screen.findByText(/empfiehlt hier Fock/)).toBeInTheDocument();
    });

    it('a confirm error renders as an inline alert scoped to that candidate', () => {
      const candidateMs = DEPARTURE_MS;
      stubHook({
        candidates: [{ departureMs: candidateMs, outcome: { kind: 'ok', result: OK_RESULT } }],
      });
      stubConfirmHook({ departureMs: candidateMs, error: 'error.routingTimeout' });
      renderCompare(makePlan());

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Die Routenberechnung hat das Zeitlimit überschritten');
    });

    // #960 review Major 1(a). Mutation: dropping `!mountedRef.current` from
    // handleConfirm's guard turns this red — onConfirmed IS called after
    // unmount.
    it('#960 review Major 1: unmounting before a confirm resolves discards the result — onConfirmed never fires', async () => {
      const plan = makePlan();
      const candidateMs = DEPARTURE_MS;
      stubHook({
        candidates: [{ departureMs: candidateMs, outcome: { kind: 'ok', result: OK_RESULT } }],
      });
      let resolveConfirm!: (p: Plan | null) => void;
      const confirmPromise = new Promise<Plan | null>((res) => {
        resolveConfirm = res;
      });
      stubConfirmHook({}, vi.fn().mockReturnValue(confirmPromise));
      const onConfirmed = vi.fn();
      const { unmount } = renderCompare(plan, onConfirmed);

      fireEvent.click(screen.getByRole('button', { name: 'Diese Abfahrt übernehmen' }));
      unmount();

      const updated: Plan = {
        ...plan,
        createdAtMs: plan.createdAtMs + 1,
        result: twoRigResult('genoa'),
      };
      await act(async () => {
        resolveConfirm(updated);
        await confirmPromise;
      });

      expect(onConfirmed).not.toHaveBeenCalled();
    });

    // #960 review Major 1(b). Mutation: dropping the
    // `activePlanIdentityRef.current !== identity` half of the guard turns
    // this red — onConfirmed IS called with a result computed against a plan
    // that is no longer active. Also asserts the scan reset the reviewer
    // asked for (a different plan.id must not leave a stale card behind).
    it('#960 review Major 1: a plan superseded while a confirm is in flight discards the stale result and resets the scan', async () => {
      const plan = makePlan();
      const candidateMs = DEPARTURE_MS;
      const { reset } = stubHook({
        candidates: [{ departureMs: candidateMs, outcome: { kind: 'ok', result: OK_RESULT } }],
      });
      let resolveConfirm!: (p: Plan | null) => void;
      const confirmPromise = new Promise<Plan | null>((res) => {
        resolveConfirm = res;
      });
      stubConfirmHook({}, vi.fn().mockReturnValue(confirmPromise));
      const onConfirmed = vi.fn();
      const { rerender } = renderCompare(plan, onConfirmed);

      fireEvent.click(screen.getByRole('button', { name: 'Diese Abfahrt übernehmen' }));
      reset.mockClear();

      // A DIFFERENT route becomes active while the confirm is still solving
      // — the same shape as an unrelated recalc/reroute superseding it.
      const otherPlan: Plan = { ...plan, id: 'plan-2' };
      rerender(
        <I18nProvider>
          <DepartureCompare
            plan={otherPlan}
            ensureClient={() => Promise.resolve(null)}
            onConfirmed={onConfirmed}
          />
        </I18nProvider>,
      );
      await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));

      const stale: Plan = {
        ...plan,
        createdAtMs: plan.createdAtMs + 1,
        result: twoRigResult('genoa'),
      };
      await act(async () => {
        resolveConfirm(stale);
        await confirmPromise;
      });

      expect(onConfirmed).not.toHaveBeenCalled();
    });
  });
});
