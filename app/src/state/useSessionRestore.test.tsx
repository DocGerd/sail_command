import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { AppStateProvider, useActivePlan } from './AppState';
import { useSessionRestore } from './useSessionRestore';
import { savePlan, __resetDbForTests } from '../services/db';
import { SESSION_SNAPSHOT_KEY, type Tab } from '../lib/sessionSnapshot';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Plan, type Rig, type RigResult } from '../types';

// A plan whose BOTH rigs have results (recommended: genoa), so restoring a
// persisted rig 'fock' is distinguishable from setPlan's own reset to the
// recommended rig — the honest proof that the rig is re-applied AFTER setPlan.
function makePlan(id: string, windKn = 12): Plan {
  const base = Date.now() - 60_000;
  const rigResult = (rig: Rig): RigResult => ({
    rig,
    legs: [],
    etaMs: base + 4 * 3_600_000,
    durationMs: 4 * 3_600_000,
    distanceNm: 40,
    maneuverCount: 1,
    motorDistanceNm: 0,
  });
  return {
    id,
    name: `Plan ${id}`,
    createdAtMs: base,
    request: {
      origin: { lat: 54.8, lon: 9.5 },
      destination: { lat: 54.9, lon: 10.5 },
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: base + 3_600_000,
      settings: DEFAULT_SETTINGS,
    },
    windGrid: uniformWindGrid(windKn, 270),
    result: {
      status: 'ok',
      genoa: rigResult('genoa'),
      fock: rigResult('fock'),
      genoaReason: null,
      fockReason: null,
      recommended: 'genoa',
      snappedOrigin: { lat: 54.8, lon: 9.5 },
      snappedDestination: { lat: 54.9, lon: 10.5 },
    },
  };
}

// Minimal stand-in for AppShell's wiring: owns the tab state exactly like
// App.tsx does and exposes probes + event buttons for the write-back path.
function Harness({ plan2 }: { plan2?: Plan }) {
  const [tab, setTab] = useState<Tab>('plan');
  useSessionRestore(tab, setTab);
  const { plan, rig, setPlan, setRig } = useActivePlan();
  return (
    <>
      <span data-testid="tab">{tab}</span>
      <span data-testid="plan-id">{plan?.id ?? 'none'}</span>
      <span data-testid="rig">{rig ?? 'none'}</span>
      <span data-testid="wind">{plan ? String(plan.windGrid.speedKn[0]) : 'none'}</span>
      <button type="button" onClick={() => setTab('routes')}>
        to-routes
      </button>
      <button type="button" onClick={() => setTab('live')}>
        to-live
      </button>
      <button type="button" onClick={() => setRig('fock')}>
        rig-fock
      </button>
      <button type="button" onClick={() => setPlan(null)}>
        clear-plan
      </button>
      {plan2 && (
        <button type="button" onClick={() => setPlan(plan2)}>
          load-2
        </button>
      )}
    </>
  );
}

function renderHarness(plan2?: Plan) {
  return render(
    <AppStateProvider>
      <Harness {...(plan2 ? { plan2 } : {})} />
    </AppStateProvider>,
  );
}

function storedSnapshot(): unknown {
  const raw = localStorage.getItem(SESSION_SNAPSHOT_KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe('useSessionRestore (#113)', () => {
  beforeEach(async () => {
    await __resetDbForTests();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('restores plan, rig, and tab from the snapshot by pure local replay — zero fetch calls', async () => {
    await savePlan(makePlan('p1', 12));
    localStorage.setItem(SESSION_SNAPSHOT_KEY, '{"v":1,"planId":"p1","tab":"routes","rig":"fock"}');
    const fetchSpy = vi.fn(() => Promise.reject(new Error('restore must never fetch')));
    vi.stubGlobal('fetch', fetchSpy);

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('plan-id').textContent).toBe('p1'));
    // 'fock' is NOT the plan's recommended rig ('genoa') — this pins that the
    // persisted rig choice is re-applied after setPlan's reset-to-recommended.
    expect(screen.getByTestId('rig').textContent).toBe('fock');
    expect(screen.getByTestId('tab').textContent).toBe('routes');
    // The rendered wind is the STORED grid's value (seeded as 12 kn above).
    expect(screen.getByTestId('wind').textContent).toBe('12');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('restores the tab alone when no plan was open (planId null)', async () => {
    localStorage.setItem(SESSION_SNAPSHOT_KEY, '{"v":1,"planId":null,"tab":"live","rig":null}');

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('tab').textContent).toBe('live'));
    expect(screen.getByTestId('plan-id').textContent).toBe('none');
  });

  it('a snapshot pointing at a since-deleted plan falls back to a full fresh boot and self-heals the snapshot', async () => {
    // Nothing saved under 'ghost' — getPlan resolves undefined.
    localStorage.setItem(
      SESSION_SNAPSHOT_KEY,
      '{"v":1,"planId":"ghost","tab":"routes","rig":"genoa"}',
    );

    renderHarness();

    // Fresh boot: neither the plan nor the tab is restored, and once the
    // restore settles the write-back replaces the stale snapshot.
    await waitFor(() =>
      expect(storedSnapshot()).toEqual({ v: 1, planId: null, tab: 'plan', rig: null }),
    );
    expect(screen.getByTestId('plan-id').textContent).toBe('none');
    expect(screen.getByTestId('tab').textContent).toBe('plan');
  });

  it('a corrupt snapshot falls back to a fresh boot without crashing', async () => {
    localStorage.setItem(SESSION_SNAPSHOT_KEY, '{"v":1,"planId":');

    renderHarness();

    await waitFor(() =>
      expect(storedSnapshot()).toEqual({ v: 1, planId: null, tab: 'plan', rig: null }),
    );
    expect(screen.getByTestId('tab').textContent).toBe('plan');
    expect(screen.getByTestId('plan-id').textContent).toBe('none');
  });

  it('storage that throws on every access degrades to session-only state without crashing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    renderHarness();

    expect(screen.getByTestId('tab').textContent).toBe('plan');
    // In-memory tab state keeps working even though nothing persists.
    fireEvent.click(screen.getByRole('button', { name: 'to-live' }));
    await waitFor(() => expect(screen.getByTestId('tab').textContent).toBe('live'));
  });

  it('writes the snapshot event-driven on plan set/cleared, tab change, and rig change (literal payloads)', async () => {
    const plan2 = makePlan('p2');

    renderHarness(plan2);

    // Restore settled (no snapshot existed) — the write-back now mirrors the
    // fresh-boot state.
    await waitFor(() =>
      expect(storedSnapshot()).toEqual({ v: 1, planId: null, tab: 'plan', rig: null }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'load-2' }));
    // setPlan resets the rig to the plan's recommended one ('genoa').
    await waitFor(() =>
      expect(storedSnapshot()).toEqual({ v: 1, planId: 'p2', tab: 'plan', rig: 'genoa' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'rig-fock' }));
    await waitFor(() =>
      expect(storedSnapshot()).toEqual({ v: 1, planId: 'p2', tab: 'plan', rig: 'fock' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'to-routes' }));
    await waitFor(() =>
      expect(storedSnapshot()).toEqual({ v: 1, planId: 'p2', tab: 'routes', rig: 'fock' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'clear-plan' }));
    await waitFor(() =>
      expect(storedSnapshot()).toEqual({ v: 1, planId: null, tab: 'routes', rig: null }),
    );
  });
});
