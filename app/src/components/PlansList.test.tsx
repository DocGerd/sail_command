import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppStateProvider, useActivePlan } from '../state/AppState';
import { I18nProvider } from '../i18n';
import { savePlan, __resetDbForTests } from '../services/db';
import * as db from '../services/db';
import * as openMeteo from '../services/openMeteo';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Plan, type SailId, type WindGrid } from '../types';
import PlansList, { type PlansListProps } from './PlansList';
import { de } from '../i18n/dict.de';
import { en } from '../i18n/dict.en';
import { defaultBoatSnapshot } from '../types';
import { PLAN_SCHEMA_VERSION } from '../types';

function makePlan(overrides: {
  id: string;
  createdAtMs: number;
  name?: string;
  windGrid?: WindGrid;
  recommended?: SailId;
  etaMs?: number;
  departureMs?: number;
}): Plan {
  const recommended = overrides.recommended ?? 'genoa';
  const etaMs = overrides.etaMs ?? overrides.createdAtMs + 4 * 3_600_000;
  const rigResult = {
    legs: [],
    etaMs,
    durationMs: 4 * 3_600_000,
    distanceNm: 40,
    maneuverCount: 1,
    motorDistanceNm: 0,
  };
  return {
    id: overrides.id,
    name: overrides.name ?? `Plan ${overrides.id}`,
    createdAtMs: overrides.createdAtMs,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: { lat: 54.0, lon: 9.0 },
      destination: { lat: 55.0, lon: 10.0 },
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: overrides.departureMs ?? overrides.createdAtMs,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: overrides.windGrid ?? uniformWindGrid(10, 270),
    result: {
      status: 'ok',
      sails: [
        {
          sailId: 'genoa',
          result: recommended === 'genoa' ? { sailId: 'genoa', ...rigResult } : null,
          reason: recommended === 'genoa' ? null : 'calm-motor-off',
        },
        {
          sailId: 'fock',
          result: recommended === 'fock' ? { sailId: 'fock', ...rigResult } : null,
          reason: recommended === 'fock' ? null : 'calm-motor-off',
        },
      ],
      recommended,
      comparisonComplete: true,
      snappedOrigin: { lat: 54.0, lon: 9.0 },
      snappedDestination: { lat: 55.0, lon: 10.0 },
    },
  };
}

// Exposes the active plan's windGrid so tests can assert a loaded plan
// carries its STORED grid (by value) rather than a freshly fetched one.
function ActivePlanWindProbe() {
  const { plan } = useActivePlan();
  return (
    <span data-testid="active-wind">
      {plan ? Array.from(plan.windGrid.speedKn).join(',') : 'none'}
    </span>
  );
}

function renderList(props: Partial<PlansListProps> = {}) {
  localStorage.setItem('sc-lang', 'en');
  const onRecalculate =
    props.onRecalculate ?? vi.fn<PlansListProps['onRecalculate']>().mockResolvedValue(undefined);
  return {
    onRecalculate,
    ...render(
      <I18nProvider>
        <AppStateProvider>
          <PlansList
            online={props.online ?? true}
            busy={props.busy ?? false}
            onRecalculate={onRecalculate}
          />
          <ActivePlanWindProbe />
        </AppStateProvider>
      </I18nProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('PlansList', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  it('shows the empty state when there are no saved plans', async () => {
    renderList();
    expect(await screen.findByText(/no saved plans/i)).toBeInTheDocument();
  });

  it('renders rows newest-first with name, created date, ETA, and recommended-rig tag', async () => {
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000, name: 'Older' }));
    await savePlan(makePlan({ id: 'p2', createdAtMs: 2000, name: 'Newer' }));

    renderList();

    const rows = await screen.findAllByRole('button', { name: /Older|Newer/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Newer');
    expect(rows[1]).toHaveTextContent('Older');
    expect(rows[0]).toHaveTextContent('Genoa');
  });

  it('shows the departure time on the card, distinct from created and ETA', async () => {
    // Local-time Date construction (matching format.test.ts's idiom) keeps
    // the expected literal independent of the runner's timezone: whatever
    // zone Intl resolves to, `new Date(y, m, d, h, min)` and the formatted
    // output agree. departureMs is deliberately NOT createdAtMs, so this
    // also pins that the card reads PlanSummary.departureMs specifically
    // (not accidentally re-showing createdAtMs under a new label).
    const createdAtMs = new Date(2026, 0, 10, 8, 0).getTime();
    const departureMs = new Date(2026, 0, 15, 6, 30).getTime();
    await savePlan(makePlan({ id: 'p1', createdAtMs, departureMs, name: 'Solo' }));

    renderList();

    const row = await screen.findByRole('button', { name: /Solo/ });
    // en-GB, hourCycle h23 renders DD/MM/YYYY, HH:MM (pinned in
    // format.test.ts) — computed by hand, not via formatDateTime.
    expect(row).toHaveTextContent('Created 10/01/2026, 08:00');
    expect(row).toHaveTextContent('Departure 15/01/2026, 06:30');
  });

  it('tapping a row loads the full plan into active state with the stored wind grid, never refetching', async () => {
    const fetchSpy = vi.spyOn(openMeteo, 'fetchWindGrid');
    const windGrid = uniformWindGrid(17, 90);
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000, windGrid }));

    renderList();

    const row = await screen.findByRole('button', { name: /Plan p1/ });
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByTestId('active-wind')).toHaveTextContent(
        Array.from(windGrid.speedKn).join(','),
      );
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a single delete tap shows a confirm state and does not delete', async () => {
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000 }));
    renderList();

    const del = await screen.findByRole('button', { name: 'Delete plan' });
    fireEvent.click(del);

    expect(await screen.findByRole('button', { name: 'Confirm delete' })).toBeInTheDocument();
    expect(screen.getByText('Plan p1')).toBeInTheDocument();
  });

  it('a second tap on the confirm button deletes the plan and refreshes to the empty state', async () => {
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000 }));
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete plan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm delete' }));

    expect(await screen.findByText(/no saved plans/i)).toBeInTheDocument();
  });

  it("tapping a different row's delete switches the pending confirm without deleting either plan", async () => {
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000, name: 'First' }));
    await savePlan(makePlan({ id: 'p2', createdAtMs: 2000, name: 'Second' }));
    renderList();

    const deleteButtons = await screen.findAllByRole('button', { name: 'Delete plan' });
    expect(deleteButtons).toHaveLength(2);
    fireEvent.click(deleteButtons[0]); // pending on the newest row (Second)
    expect(await screen.findByRole('button', { name: 'Confirm delete' })).toBeInTheDocument();

    const stillDelete = screen.getAllByRole('button', { name: 'Delete plan' });
    fireEvent.click(stillDelete[stillDelete.length - 1]); // tap the other row's delete instead

    expect(screen.getAllByRole('button', { name: 'Confirm delete' })).toHaveLength(1);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('a failed load shows an inline error and does not touch the active plan', async () => {
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000 }));
    renderList();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'getPlan').mockRejectedValueOnce(new Error('idb boom'));

    fireEvent.click(await screen.findByRole('button', { name: /Plan p1/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/failed/i);
    expect(screen.getByTestId('active-wind')).toHaveTextContent('none');
  });

  it('a failed delete shows an inline error, leaves the plan undeleted, and resets pendingDeleteId so the row is ready for a retry', async () => {
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000 }));
    renderList();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'deletePlan').mockRejectedValueOnce(new Error('idb boom'));

    fireEvent.click(await screen.findByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('button', { name: 'Confirm delete' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/failed/i);
    // The plan is still there (delete failed) and pendingDeleteId was reset
    // (cleared only after the rejected deletePlan() settled), so the row is
    // back to its un-armed "Delete plan" state, ready for another attempt.
    expect(screen.getByText('Plan p1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete plan' })).toBeInTheDocument();
  });

  it('tapping the row itself while its delete is pending resets the confirm and loads the plan', async () => {
    const windGrid = uniformWindGrid(21, 45);
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000, windGrid }));
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('button', { name: 'Confirm delete' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Plan p1/ }));

    await waitFor(() => {
      expect(screen.getByTestId('active-wind')).toHaveTextContent(
        Array.from(windGrid.speedKn).join(','),
      );
    });
    expect(screen.queryByRole('button', { name: 'Confirm delete' })).not.toBeInTheDocument();
  });
});

// #114: per-row recalculate editor. Departure-value expectations use the
// local-time Date construction idiom (see the departure-time test above) so
// the pinned literals are timezone-independent; Date.now is mocked so the
// "future vs. past stored departure" seeding rule is deterministic.
describe('PlansList recalculate (#114)', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  const NOW_MS = new Date(2026, 0, 10, 12, 0).getTime();
  const FUTURE_DEPARTURE_MS = new Date(2026, 0, 15, 6, 30).getTime();

  it('expands an editor seeded with the stored (future) departure and runs a recalc-as-new with the edited value', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    const windGrid = uniformWindGrid(19, 135);
    await savePlan(
      makePlan({ id: 'p1', createdAtMs: 1000, departureMs: FUTURE_DEPARTURE_MS, windGrid }),
    );
    const { onRecalculate } = renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Recalculate' }));

    const input = screen.getByLabelText<HTMLInputElement>('Departure');
    expect(input.value).toBe('2026-01-15T06:30'); // stored departure, still in the future → kept

    fireEvent.change(input, { target: { value: '2026-01-16T08:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate as new plan' }));

    await waitFor(() => expect(onRecalculate).toHaveBeenCalledTimes(1));
    const [plan, departureMs, mode] = vi.mocked(onRecalculate).mock.calls[0];
    expect(plan.id).toBe('p1');
    // The FULL plan (stored grid included) is handed over — the seed request
    // is built from it upstream in App.tsx.
    expect(Array.from(plan.windGrid.speedKn).every((v) => v === 19)).toBe(true);
    expect(departureMs).toBe(new Date(2026, 0, 16, 8, 0).getTime());
    expect(mode).toBe('new');

    // Editor closes once the run settles.
    await waitFor(() => expect(screen.queryByLabelText('Departure')).not.toBeInTheDocument());
  });

  it('seeds a PAST stored departure with the next full hour instead', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 0, 20, 9, 15).getTime());
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000, departureMs: FUTURE_DEPARTURE_MS }));
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Recalculate' }));

    // 2026-01-15 06:30 is in the past on 2026-01-20 09:15 → next full hour.
    expect(screen.getByLabelText<HTMLInputElement>('Departure').value).toBe('2026-01-20T10:00');
  });

  it('replace requires a second confirming tap before anything runs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000, departureMs: FUTURE_DEPARTURE_MS }));
    const { onRecalculate } = renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Recalculate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace original' }));

    // First tap only arms the confirm — nothing ran.
    expect(onRecalculate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm replace' }));

    await waitFor(() => expect(onRecalculate).toHaveBeenCalledTimes(1));
    const [plan, departureMs, mode] = vi.mocked(onRecalculate).mock.calls[0];
    expect(plan.id).toBe('p1');
    expect(departureMs).toBe(FUTURE_DEPARTURE_MS);
    expect(mode).toBe('replace');
  });

  it('offline: the recalc actions are disabled with the i18n message and never run', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000, departureMs: FUTURE_DEPARTURE_MS }));
    const { onRecalculate } = renderList({ online: false });

    // The editor still opens offline (the user can see why nothing runs)…
    fireEvent.click(await screen.findByRole('button', { name: 'Recalculate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Recalculation requires a connection — it fetches a fresh wind forecast.',
    );
    const saveNew = screen.getByRole('button', { name: 'Recalculate as new plan' });
    const replace = screen.getByRole('button', { name: 'Replace original' });
    expect(saveNew).toBeDisabled();
    expect(replace).toBeDisabled();
    fireEvent.click(saveNew);
    fireEvent.click(replace);
    expect(onRecalculate).not.toHaveBeenCalled();
  });

  it('busy (a run already in flight): the recalc actions are disabled', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    await savePlan(makePlan({ id: 'p1', createdAtMs: 1000, departureMs: FUTURE_DEPARTURE_MS }));
    const { onRecalculate } = renderList({ busy: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Recalculate' }));

    fireEvent.click(screen.getByRole('button', { name: 'Recalculate as new plan' }));
    expect(onRecalculate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Recalculate as new plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Replace original' })).toBeDisabled();
  });

  // #54 spec §I.3: a record the read-time normaliser cannot handle is LISTED,
  // never skipped. §I.3 names both causes — "missing required field; a
  // schemaVersion from a newer build" — and this block fixtures both.
  describe('an unreadable record', () => {
    async function saveUnreadable(id: string, createdAtMs: number, name: string) {
      await savePlan({
        ...makePlan({ id, createdAtMs, name }),
        schemaVersion: 999,
      });
    }

    async function saveDamaged(id: string, createdAtMs: number, name: string) {
      const plan = makePlan({ id, createdAtMs, name }) as unknown as Record<string, unknown>;
      delete (plan.result as Record<string, unknown>).snappedOrigin;
      await savePlan(plan as unknown as Plan);
    }

    // #547 part D: a damaged record can lack createdAtMs entirely, distinct
    // from the missing-field damage saveDamaged() above exercises.
    async function saveDamagedMissingCreatedAt(id: string, name: string) {
      const plan = makePlan({ id, createdAtMs: 2000, name }) as unknown as Record<string, unknown>;
      delete plan.createdAtMs;
      await savePlan(plan as unknown as Plan);
    }

    it('is shown, with its name and creation date, alongside readable rows', async () => {
      await savePlan(makePlan({ id: 'p1', createdAtMs: 1000, name: 'Readable' }));
      await saveUnreadable('p2', 2000, 'From The Future');

      renderList();

      expect(await screen.findByText('From The Future')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Readable/ })).toBeInTheDocument();
    });

    // The row's only control is a destructive one, and prod and /uat/ share
    // one origin-scoped database, so telling the user which case they are
    // looking at is what makes that two-tap delete an informed choice.
    it('tells the user a newer build wrote it, and claims nothing about its integrity', async () => {
      await saveUnreadable('p2', 2000, 'From The Future');

      renderList();

      expect(await screen.findByText(/newer version of the app/i)).toBeInTheDocument();
      expect(screen.getByText(/cannot read it/i)).toBeInTheDocument();
      expect(screen.queryByText(/incomplete or damaged/i)).not.toBeInTheDocument();
    });

    // BOTH dictionaries, asserted on the strings themselves: the rendered
    // check above runs in English only, so a regex there could never reach the
    // German copy however many languages it names. The classification comes
    // from schemaVersion alone (services/db.ts) and cannot rule out a record
    // that is BOTH newer and corrupt, so neither language may promise the
    // record is intact — the row's only control deletes it irreversibly.
    it('#54: neither dictionary promises the newer-version record is undamaged', () => {
      for (const [lang, dict] of [
        ['de', de],
        ['en', en],
      ] as const) {
        expect(dict['plansList.unreadable.newerVersion'], lang).not.toMatch(
          /undamaged|unbeschädigt|intact|unversehrt|heil/i,
        );
      }
    });

    it('says a genuinely damaged record is damaged, not that it came from a newer build', async () => {
      await saveDamaged('p3', 2000, 'Broken One');

      renderList();

      expect(await screen.findByText(/incomplete or damaged/i)).toBeInTheDocument();
      expect(screen.queryByText(/newer version of the app/i)).not.toBeInTheDocument();
    });

    // #547 part D: readNumber falls back to 0 for a missing createdAtMs,
    // and formatDateTime(0, lang) would otherwise render an epoch date
    // ("1 Jan 1970") on a row whose only action is an irreversible delete —
    // gate the Created line the same way the name is already gated, rather
    // than show a fabricated date.
    it('omits the Created line rather than show an epoch date when createdAtMs is missing', async () => {
      await saveDamagedMissingCreatedAt('p4', 'No Date');

      const { container } = renderList();

      await screen.findByText('No Date');
      expect(container.querySelector('.plans-list-created')).not.toBeInTheDocument();
    });

    it('offers no way to open or recalculate it, but can still be deleted by the user', async () => {
      await saveUnreadable('p2', 2000, 'From The Future');

      renderList();

      await screen.findByText('From The Future');
      expect(screen.queryByRole('button', { name: /From The Future/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Recalculate' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete plan' })).toBeInTheDocument();
    });

    it('survives a listing — the row is a placeholder, never a delete', async () => {
      await saveUnreadable('p2', 2000, 'From The Future');

      const { unmount } = renderList();
      await screen.findByText('From The Future');
      unmount();

      renderList();
      expect(await screen.findByText('From The Future')).toBeInTheDocument();
    });
  });
});
