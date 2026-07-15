import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppStateProvider, useSettings, useActivePlan, useOnline } from './AppState';
import { loadSettings, saveSettings, __resetDbForTests } from '../services/db';
import { DEFAULT_SETTINGS, type Plan, type WindGrid } from '../types';

function SettingsProbe() {
  const [settings, setSettings] = useSettings();
  return (
    <div>
      <span data-testid="safetyDepth">{settings.safetyDepthM}</span>
      <span data-testid="motorEnabled">{String(settings.motorEnabled)}</span>
      <button onClick={() => setSettings({ safetyDepthM: 2.5, motorEnabled: false })}>patch</button>
    </div>
  );
}

function ActivePlanProbe() {
  const { plan, rig, setPlan, setRig } = useActivePlan();
  return (
    <div>
      <span data-testid="planId">{plan ? plan.id : 'none'}</span>
      <span data-testid="rig">{rig ?? 'none'}</span>
      <button onClick={() => setPlan(TEST_PLAN)}>setPlan</button>
      <button onClick={() => setPlan(null)}>clearPlan</button>
      <button onClick={() => setRig('fock')}>setRigFock</button>
    </div>
  );
}

function OnlineProbe() {
  const online = useOnline();
  return <span data-testid="online">{String(online)}</span>;
}

const TEST_WIND_GRID: WindGrid = {
  lats: [54.0],
  lons: [9.0],
  timesMs: [1000],
  speedKn: new Float32Array([5.0]),
  dirFromDeg: new Float32Array([90]),
  gustKn: new Float32Array([7.0]),
  fetchedAtMs: 1626340800000,
  model: 'test',
};

const TEST_PLAN: Plan = {
  id: 'plan-active-1',
  name: 'Test Plan',
  createdAtMs: 1000,
  request: {
    origin: { lat: 54.0, lon: 9.0 },
    destination: { lat: 55.0, lon: 10.0 },
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: 1000,
    settings: DEFAULT_SETTINGS,
  },
  windGrid: TEST_WIND_GRID,
  result: {
    status: 'ok',
    genoa: null,
    fock: { rig: 'fock', legs: [], etaMs: 5000, durationMs: 3000, distanceNm: 41.0, maneuverCount: 2, motorDistanceNm: 0 },
    genoaReason: null,
    fockReason: null,
    recommended: 'fock',
    snappedOrigin: { lat: 54.0, lon: 9.0 },
    snappedDestination: { lat: 55.0, lon: 10.0 },
  },
};

describe('AppStateProvider', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders children with default settings when nothing is persisted', () => {
    render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent(String(DEFAULT_SETTINGS.safetyDepthM));
    expect(screen.getByTestId('motorEnabled')).toHaveTextContent(String(DEFAULT_SETTINGS.motorEnabled));
  });

  it('useSettings patch persists to IndexedDB and survives a provider remount', async () => {
    const { unmount } = render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    fireEvent.click(screen.getByText('patch'));
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent('2.5');

    // Wait for the fire-and-forget saveSettings() write to actually land before
    // tearing this provider down, otherwise the remount below races the write.
    await waitFor(async () => {
      const persisted = await loadSettings();
      expect(persisted?.safetyDepthM).toBe(2.5);
      expect(persisted?.motorEnabled).toBe(false);
    });

    unmount();

    render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('safetyDepth')).toHaveTextContent('2.5');
      expect(screen.getByTestId('motorEnabled')).toHaveTextContent('false');
    });
  });

  it('a patch issued before the initial load resolves is not clobbered by the load', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, safetyDepthM: 4.0 });

    render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    // Patch synchronously on the same tick as mount, before loadSettings() resolves.
    fireEvent.click(screen.getByText('patch'));
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent('2.5');

    // Give the pending initial load a chance to resolve; the patch must win.
    await waitFor(async () => {
      const persisted = await loadSettings();
      expect(persisted?.safetyDepthM).toBe(2.5);
    });
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent('2.5');
  });

  it('useActivePlan().setPlan defaults rig to the recommended rig, and setPlan(null) clears both', () => {
    render(
      <AppStateProvider>
        <ActivePlanProbe />
      </AppStateProvider>,
    );

    expect(screen.getByTestId('planId')).toHaveTextContent('none');
    expect(screen.getByTestId('rig')).toHaveTextContent('none');

    fireEvent.click(screen.getByText('setPlan'));
    expect(screen.getByTestId('planId')).toHaveTextContent('plan-active-1');
    expect(screen.getByTestId('rig')).toHaveTextContent('fock');

    fireEvent.click(screen.getByText('setRigFock'));
    expect(screen.getByTestId('rig')).toHaveTextContent('fock');

    fireEvent.click(screen.getByText('clearPlan'));
    expect(screen.getByTestId('planId')).toHaveTextContent('none');
    expect(screen.getByTestId('rig')).toHaveTextContent('none');
  });

  it('useOnline reflects navigator.onLine and flips on the offline/online events', () => {
    const onlineSpy = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);

    render(
      <AppStateProvider>
        <OnlineProbe />
      </AppStateProvider>,
    );
    expect(screen.getByTestId('online')).toHaveTextContent('true');

    onlineSpy.mockReturnValue(false);
    fireEvent(window, new Event('offline'));
    expect(screen.getByTestId('online')).toHaveTextContent('false');

    onlineSpy.mockReturnValue(true);
    fireEvent(window, new Event('online'));
    expect(screen.getByTestId('online')).toHaveTextContent('true');
  });
});
