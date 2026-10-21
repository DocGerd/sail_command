import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptFix,
  emptyTrack,
  fixAgeS,
  gpsState,
  markDenied,
  rerouteGate,
  type GpsState,
  type GpsTrack,
  type RerouteGate,
} from '../lib/gpsFix';
import { claimGpsHintOnce } from '../lib/gpsHint';
import { watchPosition as realWatchPosition, type GpsFix } from '../services/geolocation';

const GPS_TICK_MS = 250;

export interface GpsSource {
  state: GpsState;
  /** Whole seconds since the last new fix; null before the first one. Refreshed on state changes and each second once stale. */
  ageS: number | null;
  /** Last accepted fix, kept through stale, lost and denied. Null while inactive. */
  fix: GpsFix | null;
  /** Date.now() when `fix` was received. */
  fixAtMs: number | null;
  denied: boolean;
  reroute: RerouteGate;
  hintVisible: boolean;
  dismissHint: () => void;
}

/**
 * The single GPS watch shared by Live and the ownship marker (#1800). Runs
 * only while `active`. GPS state and fix age are pure functions of the last
 * new fix's receipt time (lib/gpsFix.ts), re-evaluated by a timer so a silent
 * device still goes stale and lost. Only PERMISSION_DENIED changes state; the
 * watch is re-armed on visibilitychange/pageshow because a denied or
 * backgrounded watch does not recover on its own.
 *
 * `watchPosition` is injectable for tests.
 */
export function useGpsSource(
  active: boolean,
  watchPosition: typeof realWatchPosition = realWatchPosition,
): GpsSource {
  const [track, setTrack] = useState<GpsTrack<GpsFix>>(emptyTrack);
  const [monoNowMs, setMonoNowMs] = useState(0);
  const [hintVisible, setHintVisible] = useState(false);
  const trackRef = useRef(track);
  const monoRef = useRef(0);

  const commit = useCallback((next: GpsTrack<GpsFix>) => {
    const now = performance.now();
    trackRef.current = next;
    monoRef.current = now;
    setTrack(next);
    setMonoNowMs(now);
  }, []);

  useEffect(() => {
    if (!active) return;
    let unsubscribe = () => {};
    const arm = () => {
      unsubscribe();
      unsubscribe = watchPosition(
        (fix) => {
          const next = acceptFix(trackRef.current, fix, performance.now(), Date.now());
          if (next !== trackRef.current) commit(next);
        },
        (kind) => {
          if (kind === 'denied') commit(markDenied(trackRef.current));
          if (kind !== 'timeout' && claimGpsHintOnce()) setHintVisible(true);
        },
      );
    };
    const rearm = (e: Event) => {
      if (e instanceof PageTransitionEvent && !e.persisted) return;
      if (document.visibilityState === 'visible') arm();
    };
    arm();
    let disposed = false;
    let perm: PermissionStatus | null = null;
    navigator.permissions
      ?.query({ name: 'geolocation' })
      .then((s) => {
        if (disposed) return;
        perm = s;
        s.onchange = () => {
          if (s.state === 'granted') arm();
        };
      })
      .catch(() => {});
    document.addEventListener('visibilitychange', rearm);
    window.addEventListener('pageshow', rearm);
    return () => {
      disposed = true;
      if (perm) perm.onchange = null;
      document.removeEventListener('visibilitychange', rearm);
      window.removeEventListener('pageshow', rearm);
      unsubscribe();
      commit(emptyTrack());
    };
  }, [active, watchPosition, commit]);

  // Re-evaluates age without callbacks. Re-renders only when the state or, once
  // stale, the whole-second age changed.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const tr = trackRef.current;
      if (tr.receivedMonoMs === null || tr.denied) return;
      const prev = monoRef.current;
      const now = performance.now();
      const state = gpsState(tr, now);
      if (
        state === gpsState(tr, prev) &&
        (state === 'fresh' || fixAgeS(tr, prev) === fixAgeS(tr, now))
      ) {
        return;
      }
      monoRef.current = now;
      setMonoNowMs(now);
    }, GPS_TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  const view = active ? track : emptyTrack<GpsFix>();
  const state = gpsState(view, monoNowMs);
  const ageS = fixAgeS(view, monoNowMs);

  return {
    state,
    ageS,
    fix: view.fix,
    fixAtMs: view.receivedWallMs,
    denied: view.denied,
    reroute: rerouteGate(state, view.fix, ageS),
    hintVisible,
    dismissHint: () => setHintVisible(false),
  };
}
