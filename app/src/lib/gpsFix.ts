// Live GPS fix-age model (#1800). State is a pure function of how long ago
// the last NEW fix was received plus a denied flag. Errors other than
// PERMISSION_DENIED never enter it.

export const GPS_STALE_AFTER_MS = 10_000;
export const GPS_LOST_AFTER_MS = 30_000;
export const REROUTE_MAX_ACCURACY_M = 100;

export type GpsState = 'waiting' | 'fresh' | 'stale' | 'lost' | 'denied';

export interface TimedFix {
  accuracyM: number;
  /** Device `pos.timestamp`. Absent (simulator): every delivery counts as new. */
  timestampMs?: number;
}

export interface GpsTrack<F extends TimedFix> {
  fix: F | null;
  /** Device timestamp of the last accepted fix. */
  deviceTimestampMs: number | null;
  /** Monotonic receipt clock (performance.now) of the last accepted fix. */
  receivedMonoMs: number | null;
  /** Wall clock (Date.now) at receipt, for display and ETA projection. */
  receivedWallMs: number | null;
  denied: boolean;
}

export function emptyTrack<F extends TimedFix>(): GpsTrack<F> {
  return {
    fix: null,
    deviceTimestampMs: null,
    receivedMonoMs: null,
    receivedWallMs: null,
    denied: false,
  };
}

/**
 * Accepts `fix` only if its device timestamp advanced past the last accepted
 * one, so a re-delivered cached position cannot refresh the age. Returns the
 * same object when the fix is not new.
 */
export function acceptFix<F extends TimedFix>(
  track: GpsTrack<F>,
  fix: F,
  monoNowMs: number,
  wallNowMs: number,
): GpsTrack<F> {
  const ts = fix.timestampMs;
  if (ts !== undefined && track.deviceTimestampMs !== null && ts <= track.deviceTimestampMs) {
    return track;
  }
  return {
    fix,
    deviceTimestampMs: ts ?? null,
    receivedMonoMs: monoNowMs,
    receivedWallMs: wallNowMs,
    denied: false,
  };
}

export function markDenied<F extends TimedFix>(track: GpsTrack<F>): GpsTrack<F> {
  return track.denied ? track : { ...track, denied: true };
}

export function fixAgeMs<F extends TimedFix>(track: GpsTrack<F>, monoNowMs: number): number | null {
  return track.receivedMonoMs === null ? null : Math.max(0, monoNowMs - track.receivedMonoMs);
}

export function gpsState<F extends TimedFix>(track: GpsTrack<F>, monoNowMs: number): GpsState {
  if (track.denied) return 'denied';
  const age = fixAgeMs(track, monoNowMs);
  if (age === null) return 'waiting';
  if (age >= GPS_LOST_AFTER_MS) return 'lost';
  if (age >= GPS_STALE_AFTER_MS) return 'stale';
  return 'fresh';
}

/** Whole seconds since the last new fix, or null before the first one. */
export function fixAgeS<F extends TimedFix>(track: GpsTrack<F>, monoNowMs: number): number | null {
  const age = fixAgeMs(track, monoNowMs);
  return age === null ? null : Math.floor(age / 1000);
}

export type RerouteBlockReason = 'waiting' | 'denied' | 'lost' | 'accuracy';

export interface RerouteGate {
  allowed: boolean;
  /** Null when allowed. */
  reason: RerouteBlockReason | null;
  accuracyM: number | null;
  thresholdM: number;
  ageS: number | null;
}

export function rerouteGate(
  state: GpsState,
  fix: TimedFix | null,
  ageS: number | null,
): RerouteGate {
  const base = {
    accuracyM: fix?.accuracyM ?? null,
    thresholdM: REROUTE_MAX_ACCURACY_M,
    ageS,
  };
  if (state === 'waiting' || state === 'denied' || state === 'lost') {
    return { allowed: false, reason: state, ...base };
  }
  if (fix === null || fix.accuracyM > REROUTE_MAX_ACCURACY_M) {
    return { allowed: false, reason: 'accuracy', ...base };
  }
  return { allowed: true, reason: null, ...base };
}
