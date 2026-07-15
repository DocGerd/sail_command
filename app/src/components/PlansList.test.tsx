import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppStateProvider, useActivePlan } from '../state/AppState';
import { I18nProvider } from '../i18n';
import { savePlan, __resetDbForTests } from '../services/db';
import * as openMeteo from '../services/openMeteo';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Plan, type Rig, type WindGrid } from '../types';
import PlansList from './PlansList';

function makePlan(overrides: {
  id: string;
  createdAtMs: number;
  name?: string;
  windGrid?: WindGrid;
  recommended?: Rig;
  etaMs?: number;
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
    request: {
      origin: { lat: 54.0, lon: 9.0 },
      destination: { lat: 55.0, lon: 10.0 },
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: overrides.createdAtMs,
      settings: DEFAULT_SETTINGS,
    },
    windGrid: overrides.windGrid ?? uniformWindGrid(10, 270),
    result: {
      status: 'ok',
      genoa: recommended === 'genoa' ? { rig: 'genoa', ...rigResult } : null,
      fock: recommended === 'fock' ? { rig: 'fock', ...rigResult } : null,
      genoaReason: recommended === 'genoa' ? null : 'calm-motor-off',
      fockReason: recommended === 'fock' ? null : 'calm-motor-off',
      recommended,
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
    <span data-testid="active-wind">{plan ? Array.from(plan.windGrid.speedKn).join(',') : 'none'}</span>
  );
}

function renderList() {
  localStorage.setItem('sc-lang', 'en');
  return render(
    <I18nProvider>
      <AppStateProvider>
        <PlansList />
        <ActivePlanWindProbe />
      </AppStateProvider>
    </I18nProvider>,
  );
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
