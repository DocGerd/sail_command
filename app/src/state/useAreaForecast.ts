import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWaveGrid, fetchWindGrid, OpenMeteoError } from '../services/openMeteo';
import { mapWindError } from './windErrorKey';
import type { MsgKey } from '../i18n/dict.de';
import type { WaveGrid, WindGrid } from '../types';

// The Wetter tab's area forecast (#1854, spike §7/§10). Held in memory for
// the session only; never written to a plan, IndexedDB or the SW cache.

export const AREA_FORECAST_DWELL_MS = 600;
export const AREA_FORECAST_AUTO_REFETCH_MS = 3_600_000;
export const AREA_FORECAST_COOLDOWN_MS = 60_000;

export type AreaForecastSource = 'session' | 'plan';

export interface AreaForecast {
  wind: WindGrid | null;
  wave: WaveGrid | null;
  source: AreaForecastSource | null;
  /** A fetch is running. */
  pending: boolean;
  /** The last wind fetch failed with nothing to show. */
  errorKey: MsgKey | null;
  /** The last wind fetch failed while a grid is shown. */
  refreshFailed: boolean;
  /** Wind came, waves did not. */
  waveError: boolean;
  /** After a rate limit, no manual refresh before this instant. */
  cooldownUntilMs: number | null;
  refresh: () => void;
}

export interface AreaForecastDeps {
  fetchWind?: typeof fetchWindGrid;
  fetchWave?: typeof fetchWaveGrid;
}

interface Held {
  wind: WindGrid;
  wave: WaveGrid | null;
}

function fixtureParams(): { wind?: string; wave?: string } {
  const query = new URLSearchParams(location.search);
  const wind = query.get('windFixture') || undefined;
  const wave = query.get('waveFixture') || undefined;
  return { ...(wind ? { wind } : {}), ...(wave ? { wave } : {}) };
}

/** Newest wind wins; its own source's waves go with it. */
export function pairAreaForecast(
  session: Held | null,
  planWind: WindGrid | null,
  planWave: WaveGrid | null,
): { wind: WindGrid | null; wave: WaveGrid | null; source: AreaForecastSource | null } {
  if (planWind && (!session || planWind.fetchedAtMs > session.wind.fetchedAtMs)) {
    return { wind: planWind, wave: planWave, source: 'plan' };
  }
  if (session) return { wind: session.wind, wave: session.wave, source: 'session' };
  return { wind: null, wave: null, source: null };
}

export function useAreaForecast(
  active: boolean,
  online: boolean,
  planWind: WindGrid | null,
  planWave: WaveGrid | null,
  deps: AreaForecastDeps = {},
): AreaForecast {
  const fetchWind = deps.fetchWind ?? fetchWindGrid;
  const fetchWave = deps.fetchWave ?? fetchWaveGrid;
  const [session, setSession] = useState<Held | null>(null);
  const [running, setRunning] = useState(false);
  const [errorKey, setErrorKey] = useState<MsgKey | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [waveError, setWaveError] = useState(false);
  const [cooldownUntilMs, setCooldownUntilMs] = useState<number | null>(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set here too, not only at init: StrictMode runs this cleanup once.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const shown = pairAreaForecast(session, planWind, planWave);
  const shownRef = useRef(shown.wind);
  useEffect(() => {
    shownRef.current = shown.wind;
  }, [shown.wind]);

  const load = useCallback(async () => {
    if (runningRef.current || !navigator.onLine) return;
    runningRef.current = true;
    setRunning(true);
    setErrorKey(null);
    const fixtures = fixtureParams();
    try {
      let wind: WindGrid;
      try {
        wind = await fetchWind(fixtures.wind ? { fixtureUrl: fixtures.wind } : {});
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof OpenMeteoError && err.kind === 'rate-limited') {
          setCooldownUntilMs(Date.now() + AREA_FORECAST_COOLDOWN_MS);
        }
        if (shownRef.current) {
          setRefreshFailed(true);
        } else {
          setErrorKey(mapWindError(err));
        }
        return;
      }
      if (!mountedRef.current) return;
      setErrorKey(null);
      setRefreshFailed(false);
      setSession({ wind, wave: null });
      if (fixtures.wind !== undefined && fixtures.wave === undefined) {
        setWaveError(false);
        return;
      }
      try {
        const wave = await fetchWave(fixtures.wave ? { fixtureUrl: fixtures.wave } : {});
        if (!mountedRef.current) return;
        setWaveError(false);
        setSession((s) => (s && s.wind === wind ? { wind, wave } : s));
      } catch {
        if (mountedRef.current) setWaveError(true);
      }
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  }, [fetchWind, fetchWave]);

  const due = useCallback((): boolean => {
    const held = shownRef.current;
    return held === null || Date.now() - held.fetchedAtMs > AREA_FORECAST_AUTO_REFETCH_MS;
  }, []);

  // Entry and the `online` event: after the dwell, only when nothing recent is held.
  useEffect(() => {
    if (!active || !online || !due()) return;
    const timer = setTimeout(() => void load(), AREA_FORECAST_DWELL_MS);
    return () => clearTimeout(timer);
  }, [active, online, due, load]);

  const refresh = useCallback(() => {
    if (cooldownUntilMs !== null && Date.now() < cooldownUntilMs) return;
    setCooldownUntilMs(null);
    void load();
  }, [cooldownUntilMs, load]);

  return {
    ...shown,
    pending: running,
    errorKey,
    refreshFailed,
    waveError,
    cooldownUntilMs,
    refresh,
  };
}
