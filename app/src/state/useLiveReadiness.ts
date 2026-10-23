// #1807: the pre-sail readiness checks for one plan. Region and wake-lock
// state come from their existing owners; glyph coverage is re-read from
// CacheStorage, never cached as a boolean. Never starts GPS (#113): the
// permission is only queried.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Plan } from '../types';
import { useRegionReadiness } from './useRegionReadiness';
import type { AisStatus } from './useAisTraffic';
import { glyphCacheComplete, glyphWarmupSettled } from '../services/glyphWarmup';
import {
  aisCheck,
  forecastCheck,
  forecastCovers,
  glyphsCheck,
  gpsCheck,
  regionsCheck,
  wakeLockCheck,
  type GpsPermission,
  type ReadinessCheck,
} from '../lib/liveReadiness';

const CLOCK_TICK_MS = 60_000;

export interface LiveReadinessInput {
  readonly wakeLockSupported: boolean;
  readonly aisStatus: AisStatus | null;
  readonly gpsDenied: boolean;
}

export interface LiveReadinessDeps {
  readonly now?: () => number;
  readonly glyphComplete?: () => Promise<boolean>;
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}
const isVisible = () => document.visibilityState === 'visible';

function useGlyphsComplete(probe: () => Promise<boolean>): boolean | null {
  const visible = useSyncExternalStore(subscribeVisibility, isVisible);
  const [checks, setChecks] = useState(0);
  const [complete, setComplete] = useState<boolean | null>(null);

  // A warm-up finishing during this mount re-checks once.
  useEffect(() => {
    // Set here, not only in cleanup: StrictMode runs cleanup then setup on the same component.
    let cancelled = false;
    void glyphWarmupSettled()?.then(() => {
      if (!cancelled) setChecks((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Set here, not only in cleanup: StrictMode runs cleanup then setup on the same component.
    let cancelled = false;
    void probe()
      .catch(() => false)
      .then((ok) => {
        if (!cancelled) setComplete(ok);
      });
    return () => {
      cancelled = true;
    };
  }, [probe, visible, checks]);

  return complete;
}

const hasPermissionsApi = () =>
  typeof navigator !== 'undefined' && typeof navigator.permissions?.query === 'function';

function useGeolocationPermission(): GpsPermission {
  const [permission, setPermission] = useState<GpsPermission>(() =>
    hasPermissionsApi() ? 'checking' : 'unknown',
  );
  useEffect(() => {
    if (!hasPermissionsApi()) return;
    // Set here, not only in cleanup: StrictMode runs cleanup then setup on the same component.
    let cancelled = false;
    let status: PermissionStatus | null = null;
    // useGpsSource assigns `onchange` on its own status object; a listener cannot clobber it.
    const onChange = () => {
      if (!cancelled && status) setPermission(status.state);
    };
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((s) => {
        if (cancelled) return;
        status = s;
        s.addEventListener('change', onChange);
        setPermission(s.state);
      })
      .catch(() => {
        if (!cancelled) setPermission('unknown');
      });
    return () => {
      cancelled = true;
      status?.removeEventListener('change', onChange);
    };
  }, []);
  return permission;
}

function useNow(now: () => number): number {
  const [nowMs, setNowMs] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setNowMs(now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [now]);
  return nowMs;
}

export function useLiveReadiness(
  plan: Plan,
  arrivalMs: number,
  input: LiveReadinessInput,
  deps: LiveReadinessDeps = {},
): ReadinessCheck[] {
  const now = deps.now ?? Date.now;
  const probe = deps.glyphComplete ?? glyphCacheComplete;
  const regions = useRegionReadiness(plan);
  const glyphs = useGlyphsComplete(probe);
  const permission = useGeolocationPermission();
  const nowMs = useNow(now);
  const covers = forecastCovers(plan.windGrid.timesMs, plan.request.departureMs, arrivalMs, nowMs);
  return [
    regionsCheck(regions.status),
    glyphsCheck(glyphs),
    gpsCheck(permission, input.gpsDenied),
    forecastCheck(covers),
    wakeLockCheck(input.wakeLockSupported),
    aisCheck(input.aisStatus),
  ];
}
