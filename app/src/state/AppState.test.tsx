import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AppStateProvider,
  useSettings,
  useActivePlan,
  useOnline,
  useSettingsPersistenceError,
} from './AppState';
import { loadSettings, saveSettings, __resetDbForTests } from '../services/db';
import * as db from '../services/db';
import { DEFAULT_SETTINGS, type Plan, type WindGrid } from '../types';

function SettingsProbe() {
  const [settings, setSettings] = useSettings();
  return (
    <div>
      <span data-testid="safetyDepth">{settings.safetyDepthM}</span>
      <span data-testid="motorEnabled">{String(settings.motorEnabled)}</span>
      <span data-testid="motorSpeed">{settings.motorSpeedKn}</span>
      <span data-testid="showOwnship">{String(settings.showOwnship)}</span>
      <button onClick={() => setSettings({ safetyDepthM: 2.5, motorEnabled: false })}>patch</button>
      <button onClick={() => setSettings({ safetyDepthM: 4 })}>patchSafetyDepthOnly</button>
      <button onClick={() => setSettings({ motorSpeedKn: 9 })}>patchMotorSpeedOnly</button>
      <button onClick={() => setSettings({ showOwnship: true })}>patchShowOwnship</button>
    </div>
  );
}

function ActivePlanProbe() {
  const { plan, rig, setPlan, setRig, activeLegIndex, setActiveLegIndex } = useActivePlan();
  return (
    <div>
      <span data-testid="planId">{plan ? plan.id : 'none'}</span>
      <span data-testid="rig">{rig ?? 'none'}</span>
      <span data-testid="activeLegIndex">{activeLegIndex ?? 'none'}</span>
      <button onClick={() => setPlan(TEST_PLAN)}>setPlan</button>
      <button onClick={() => setPlan(null)}>clearPlan</button>
      <button onClick={() => setRig('fock')}>setRigFock</button>
      <button onClick={() => setActiveLegIndex(2)}>setActiveLegIndex</button>
    </div>
  );
}

function OnlineProbe() {
  const online = useOnline();
  return <span data-testid="online">{String(online)}</span>;
}

function SettingsPersistenceErrorProbe() {
  const [settingsPersistenceError, clearSettingsPersistenceError] = useSettingsPersistenceError();
  return (
    <div>
      <span data-testid="settingsPersistenceError">{String(settingsPersistenceError)}</span>
      <button onClick={clearSettingsPersistenceError}>clearSettingsPersistenceError</button>
    </div>
  );
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
    fock: {
      rig: 'fock',
      legs: [],
      etaMs: 5000,
      durationMs: 3000,
      distanceNm: 41.0,
      maneuverCount: 2,
      motorDistanceNm: 0,
    },
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
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent(
      String(DEFAULT_SETTINGS.safetyDepthM),
    );
    expect(screen.getByTestId('motorEnabled')).toHaveTextContent(
      String(DEFAULT_SETTINGS.motorEnabled),
    );
    // #25 addendum: the standalone ownship marker toggle is opt-in — pinned
    // literal 'false' (not DEFAULT_SETTINGS.showOwnship, which the code under
    // test also defines) so a regression flipping the DEFAULT_SETTINGS
    // literal itself would still be caught.
    expect(screen.getByTestId('showOwnship')).toHaveTextContent('false');
  });

  it('#25: showOwnship defaults OFF and a patch persists to IndexedDB across a provider remount', async () => {
    const { unmount } = render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    expect(screen.getByTestId('showOwnship')).toHaveTextContent('false');

    fireEvent.click(screen.getByText('patchShowOwnship'));
    expect(screen.getByTestId('showOwnship')).toHaveTextContent('true');

    await waitFor(async () => {
      const persisted = await loadSettings();
      expect(persisted?.showOwnship).toBe(true);
    });

    unmount();

    render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('showOwnship')).toHaveTextContent('true');
    });
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

  it('a pre-load patch to one field does not clobber a different field already persisted (regression)', async () => {
    // Field A: a non-default value already on disk from a previous session.
    await saveSettings({ ...DEFAULT_SETTINGS, motorSpeedKn: 8 });

    const { unmount } = render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    // Field B: patched synchronously, before the mount-time load resolves.
    // The pre-fix code would compute `{...DEFAULT_SETTINGS, ...patch}` here
    // (persisted data hasn't arrived yet), persist that whole object, and
    // latch out the load's merge — permanently reverting field A to its
    // default both in memory and on disk.
    fireEvent.click(screen.getByText('patchSafetyDepthOnly'));
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent('4');

    // Let the load resolve and reconcile; both fields must be correct.
    await waitFor(() => {
      expect(screen.getByTestId('motorSpeed')).toHaveTextContent('8');
    });
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent('4');
    expect(screen.getByTestId('motorSpeed')).toHaveTextContent('8');

    await waitFor(async () => {
      const persisted = await loadSettings();
      expect(persisted?.motorSpeedKn).toBe(8);
      expect(persisted?.safetyDepthM).toBe(4);
    });

    unmount();

    render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('safetyDepth')).toHaveTextContent('4');
      expect(screen.getByTestId('motorSpeed')).toHaveTextContent('8');
    });
  });

  it('two pre-load patches to different fields both survive reconciliation (accumulation, not clobber)', async () => {
    render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    // Both fired synchronously, before the mount-time load resolves —
    // pendingRef must accumulate `{ ...pendingRef.current, ...patch }`
    // across the two calls, not let the second overwrite the first's
    // (non-overlapping) field.
    fireEvent.click(screen.getByText('patch')); // safetyDepthM: 2.5, motorEnabled: false
    fireEvent.click(screen.getByText('patchMotorSpeedOnly')); // motorSpeedKn: 9 (different field)

    expect(screen.getByTestId('safetyDepth')).toHaveTextContent('2.5');
    expect(screen.getByTestId('motorEnabled')).toHaveTextContent('false');
    expect(screen.getByTestId('motorSpeed')).toHaveTextContent('9');

    await waitFor(async () => {
      const persisted = await loadSettings();
      expect(persisted?.safetyDepthM).toBe(2.5);
      expect(persisted?.motorEnabled).toBe(false);
      expect(persisted?.motorSpeedKn).toBe(9);
    });

    // Final in-memory state still reflects all three patched fields.
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent('2.5');
    expect(screen.getByTestId('motorEnabled')).toHaveTextContent('false');
    expect(screen.getByTestId('motorSpeed')).toHaveTextContent('9');
  });

  it('a pre-load patch on a fresh DB (nothing persisted) is reflected in both final state and the persisted value', async () => {
    render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    // Patch synchronously on the same tick as mount, before loadSettings() resolves.
    fireEvent.click(screen.getByText('patch'));
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent('2.5');
    expect(screen.getByTestId('motorEnabled')).toHaveTextContent('false');

    // The load-resolution flush must persist the reconciled baseline (defaults
    // + the pending patch) even though nothing was on disk beforehand.
    await waitFor(async () => {
      const persisted = await loadSettings();
      expect(persisted?.safetyDepthM).toBe(2.5);
      expect(persisted?.motorEnabled).toBe(false);
    });

    // Final in-memory state still reflects the patch, and untouched fields
    // still reflect the defaults.
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent('2.5');
    expect(screen.getByTestId('motorEnabled')).toHaveTextContent('false');
    expect(screen.getByTestId('motorSpeed')).toHaveTextContent(
      String(DEFAULT_SETTINGS.motorSpeedKn),
    );
  });

  it('a loadSettings rejection on mount is caught and logged; defaults apply and nothing crashes', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadError = new Error('load boom');
    vi.spyOn(db, 'loadSettings').mockRejectedValue(loadError);

    render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('settings load failed', loadError);
    });

    expect(screen.getByTestId('safetyDepth')).toHaveTextContent(
      String(DEFAULT_SETTINGS.safetyDepthM),
    );
    expect(screen.getByTestId('motorEnabled')).toHaveTextContent(
      String(DEFAULT_SETTINGS.motorEnabled),
    );
  });

  it('a saveSettings rejection after the load resolves is caught and logged, not thrown', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AppStateProvider>
        <SettingsProbe />
      </AppStateProvider>,
    );

    // Let the mount-time load settle first (nothing persisted, defaults apply).
    await waitFor(() => {
      expect(screen.getByTestId('safetyDepth')).toHaveTextContent(
        String(DEFAULT_SETTINGS.safetyDepthM),
      );
    });

    const saveError = new Error('save boom');
    vi.spyOn(db, 'saveSettings').mockRejectedValue(saveError);

    fireEvent.click(screen.getByText('patch'));
    expect(screen.getByTestId('safetyDepth')).toHaveTextContent('2.5');

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('settings save failed', saveError);
    });
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

  it('useActivePlan().activeLegIndex defaults to null, is settable, and resets when setPlan runs (new or cleared plan)', () => {
    render(
      <AppStateProvider>
        <ActivePlanProbe />
      </AppStateProvider>,
    );

    expect(screen.getByTestId('activeLegIndex')).toHaveTextContent('none');

    fireEvent.click(screen.getByText('setActiveLegIndex'));
    expect(screen.getByTestId('activeLegIndex')).toHaveTextContent('2');

    // A leg index computed against the previous plan is meaningless once the
    // plan itself changes — setPlan resets it, whether loading a new plan...
    fireEvent.click(screen.getByText('setPlan'));
    expect(screen.getByTestId('activeLegIndex')).toHaveTextContent('none');

    fireEvent.click(screen.getByText('setActiveLegIndex'));
    expect(screen.getByTestId('activeLegIndex')).toHaveTextContent('2');

    // ...or clearing it outright.
    fireEvent.click(screen.getByText('clearPlan'));
    expect(screen.getByTestId('activeLegIndex')).toHaveTextContent('none');
  });

  it('useSettingsPersistenceError surfaces a saveSettings failure and can be cleared', async () => {
    render(
      <AppStateProvider>
        <SettingsProbe />
        <SettingsPersistenceErrorProbe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('safetyDepth')).toHaveTextContent(
        String(DEFAULT_SETTINGS.safetyDepthM),
      );
    });
    expect(screen.getByTestId('settingsPersistenceError')).toHaveTextContent('false');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'saveSettings').mockRejectedValue(new Error('save boom'));

    fireEvent.click(screen.getByText('patch'));

    await waitFor(() => {
      expect(screen.getByTestId('settingsPersistenceError')).toHaveTextContent('true');
    });

    fireEvent.click(screen.getByText('clearSettingsPersistenceError'));
    expect(screen.getByTestId('settingsPersistenceError')).toHaveTextContent('false');
  });

  it('settingsPersistenceError self-heals on the next successful direct save, without an explicit dismiss', async () => {
    render(
      <AppStateProvider>
        <SettingsProbe />
        <SettingsPersistenceErrorProbe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('safetyDepth')).toHaveTextContent(
        String(DEFAULT_SETTINGS.safetyDepthM),
      );
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'saveSettings').mockRejectedValueOnce(new Error('save boom'));

    fireEvent.click(screen.getByText('patch'));
    await waitFor(() => {
      expect(screen.getByTestId('settingsPersistenceError')).toHaveTextContent('true');
    });

    // mockRejectedValueOnce only overrides the next call; this one falls
    // through to the real saveSettings and should succeed, self-healing the
    // flag without the explicit clearSettingsPersistenceError() button.
    fireEvent.click(screen.getByText('patchSafetyDepthOnly'));
    await waitFor(() => {
      expect(screen.getByTestId('settingsPersistenceError')).toHaveTextContent('false');
    });
  });

  it('settingsPersistenceError self-heals when a subsequent pre-load-flush save succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'saveSettings').mockRejectedValueOnce(new Error('flush boom'));

    render(
      <AppStateProvider>
        <SettingsProbe />
        <SettingsPersistenceErrorProbe />
      </AppStateProvider>,
    );

    // Patch synchronously, before the mount-time load resolves — goes
    // through the flush-on-load-resolve saveSettings call, which fails once.
    fireEvent.click(screen.getByText('patch'));
    await waitFor(() => {
      expect(screen.getByTestId('settingsPersistenceError')).toHaveTextContent('true');
    });

    // The next save (real saveSettings, via the direct setSettings path since
    // the load has resolved by now) succeeds and should clear the flag.
    fireEvent.click(screen.getByText('patchSafetyDepthOnly'));
    await waitFor(() => {
      expect(screen.getByTestId('settingsPersistenceError')).toHaveTextContent('false');
    });
  });

  it('a pre-load patch that fails to flush once the load resolves also surfaces settingsPersistenceError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'saveSettings').mockRejectedValue(new Error('flush boom'));

    render(
      <AppStateProvider>
        <SettingsProbe />
        <SettingsPersistenceErrorProbe />
      </AppStateProvider>,
    );

    // Patch synchronously, before the mount-time load resolves — this goes
    // through the flush-on-load-resolve saveSettings call, not the direct
    // one in setSettings.
    fireEvent.click(screen.getByText('patch'));

    await waitFor(() => {
      expect(screen.getByTestId('settingsPersistenceError')).toHaveTextContent('true');
    });
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
