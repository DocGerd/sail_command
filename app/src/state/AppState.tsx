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

  // Guards the mount-time load against a patch that lands first: once true,
  // the async loadSettings() merge below is a no-op instead of clobbering a
  // patch the user already made before the load resolved.
  const settledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((persisted) => {
      if (cancelled || settledRef.current) return;
      settledRef.current = true;
      if (persisted) setSettingsState((prev) => ({ ...prev, ...persisted }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    settledRef.current = true;
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);

  const setPlan = useCallback((p: Plan | null) => {
    setPlanState(p);
    setRig(p ? p.result.recommended : null);
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({ settings, setSettings, plan, rig, setPlan, setRig }),
    [settings, setSettings, plan, rig, setPlan],
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
} {
  const { plan, rig, setPlan, setRig } = useAppState();
  return { plan, rig, setPlan, setRig };
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
