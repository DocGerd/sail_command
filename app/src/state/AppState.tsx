import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { loadSettings, saveSettings } from '../services/db';
import { DEFAULT_SETTINGS, type Plan, type Rig, type Settings } from '../types';

interface AppStateValue {
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  plan: Plan | null;
  rig: Rig | null;
  setPlan: (p: Plan | null) => void;
  setRig: (r: Rig) => void;
  // Index into the active rig's legs nearest the live GPS fix, set by
  // LiveView (whose fix state itself stays local — 1 Hz updates must not
  // re-render the whole app) so RouteLayer can render the active-leg
  // highlight without LiveView and RouteLayer needing to be siblings under a
  // common prop-drilling parent. Changes only on leg transitions, not on
  // every fix, so sharing it here doesn't reintroduce the 1 Hz re-render
  // this field's neighbor deliberately avoids.
  activeLegIndex: number | null;
  setActiveLegIndex: (i: number | null) => void;
}

const AppStateCtx = createContext<AppStateValue | null>(null);

/**
 * Wraps I18nProvider's children in App (wiring is Phase E's job). Owns:
 * settings (persisted via D2's saveSettings/loadSettings), the active plan +
 * rig selection, and nothing else — GPS position stays local to LiveView
 * because 1 Hz updates must not re-render the whole app.
 */
export function AppStateProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [plan, setPlanState] = useState<Plan | null>(null);
  const [rig, setRig] = useState<Rig | null>(null);
  const [activeLegIndex, setActiveLegIndex] = useState<number | null>(null);

  // Mirrors the latest settings outside React state so setSettings can
  // compute `next` and call saveSettings as plain statements rather than
  // from inside a functional state updater — StrictMode double-invokes
  // updaters, which would double-fire the persistence write.
  const settingsRef = useRef(settings);

  // True once the mount-time load has resolved (or failed) and any pre-load
  // patches have been reconciled into `settings`.
  const loadedRef = useRef(false);
  // Patches issued before the load resolves. These are applied to display
  // state immediately but NOT persisted yet, because persisting them would
  // mean writing a guess (defaults + patch) that overwrites every other
  // persisted field once the real baseline arrives. Once the load resolves,
  // they're replayed on top of the persisted baseline and the reconciled
  // result is persisted exactly once.
  const pendingRef = useRef<Partial<Settings> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSettings()
      .catch((err) => {
        console.error('settings load failed', err);
        return undefined;
      })
      .then((persisted) => {
        const pending = pendingRef.current;
        // Merge order is the contract: persisted values first, pre-load
        // patches last, so a patch made while the load was in flight wins
        // over the now-known persisted baseline instead of reverting it.
        const final: Settings = { ...DEFAULT_SETTINGS, ...persisted, ...pending };
        // Persistence doesn't need the component mounted — flush the
        // reconciled baseline even if unmounted by now, otherwise an
        // in-flight pre-load patch is silently dropped instead of written.
        if (pending) {
          void saveSettings(final).catch((err) => console.error('settings save failed', err));
        }
        if (cancelled) return;
        settingsRef.current = final;
        loadedRef.current = true;
        pendingRef.current = null;
        setSettingsState(final);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettingsState(next);
    if (!loadedRef.current) {
      pendingRef.current = { ...pendingRef.current, ...patch };
      return;
    }
    void saveSettings(next).catch((err) => console.error('settings save failed', err));
  }, []);

  const setPlan = useCallback((p: Plan | null) => {
    setPlanState(p);
    setRig(p ? p.result.recommended : null);
    // A leg index computed against the previous plan's legs is meaningless
    // (and possibly out of bounds) once the plan itself changes.
    setActiveLegIndex(null);
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({ settings, setSettings, plan, rig, setPlan, setRig, activeLegIndex, setActiveLegIndex }),
    [settings, setSettings, plan, rig, setPlan, activeLegIndex],
  );

  return <AppStateCtx.Provider value={value}>{children}</AppStateCtx.Provider>;
}

function useAppState(): AppStateValue {
  const ctx = useContext(AppStateCtx);
  if (!ctx) throw new Error('useSettings/useActivePlan must be used within AppStateProvider');
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const { settings, setSettings } = useAppState();
  return [settings, setSettings];
}

// eslint-disable-next-line react-refresh/only-export-components
export function useActivePlan(): {
  plan: Plan | null;
  rig: Rig | null;
  setPlan: (p: Plan | null) => void;
  setRig: (r: Rig) => void;
  activeLegIndex: number | null;
  setActiveLegIndex: (i: number | null) => void;
} {
  const { plan, rig, setPlan, setRig, activeLegIndex, setActiveLegIndex } = useAppState();
  return { plan, rig, setPlan, setRig, activeLegIndex, setActiveLegIndex };
}

function subscribeOnlineStatus(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function getOnlineSnapshot(): boolean {
  return navigator.onLine;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnlineStatus, getOnlineSnapshot);
}
