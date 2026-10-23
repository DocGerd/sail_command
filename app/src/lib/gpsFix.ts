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
  /** Last fix rejected as behind `deviceTimestampMs`, kept to detect a stamp-source regression (#1821). */
  rejected: { timestampMs: number; monoMs: number } | null;
  denied: boolean;
}

export function emptyTrack<F extends TimedFix>(): GpsTrack<F> {
  return {
    fix: null,
    deviceTimestampMs: null,
    receivedMonoMs: null,
    receivedWallMs: null,
    rejected: null,
    denied: false,
  };
}

/** Largest shift in (wall clock at receipt − device timestamp) still read as one clock. */
export const GPS_CLOCK_STEP_TOLERANCE_MS = 5_000;

/**
 * Accepts `fix` only if its device timestamp advanced past the last accepted
 * one, so a re-delivered cached position cannot refresh the age. A timestamp
 * that went backwards is accepted only as a device clock step: the wall clock
 * stepped back with it, so their offset is unchanged, whereas an older cached
 * fix shifts that offset by its age.
 *
 * A provider stamping its own (GNSS) clock can regress against the system
 * clock, e.g. after one fix stamped by a clock that runs ahead (#1821). A
 * single fix behind the last accepted one is indistinguishable from a cached
 * replay, so it is held back; the next one is accepted if its timestamp
 * advanced past it in step with the receipt clock, as a live stream does.
 * Residual: two or more old fixes replayed at real-time pace pass too.
 *
 * A rejected fix never changes `fix` or the receipt clocks; a re-delivered
 * timestamp returns the same object.
 */
export function acceptFix<F extends TimedFix>(
  track: GpsTrack<F>,
  fix: F,
  monoNowMs: number,
  wallNowMs: number,
): GpsTrack<F> {
  const ts = fix.timestampMs;
  const lastTs = track.deviceTimestampMs;
  if (ts !== undefined && lastTs !== null && ts <= lastTs) {
    if (ts === lastTs) return track;
    const lastWall = track.receivedWallMs;
    const clockStepped =
      lastWall !== null &&
      Math.abs(wallNowMs - ts - (lastWall - lastTs)) <= GPS_CLOCK_STEP_TOLERANCE_MS;
    const prev = track.rejected;
    const inStep =
      prev !== null &&
      ts > prev.timestampMs &&
      Math.abs(ts - prev.timestampMs - (monoNowMs - prev.monoMs)) <= GPS_CLOCK_STEP_TOLERANCE_MS;
    if (!clockStepped && !inStep) {
      if (prev !== null && prev.timestampMs === ts) return track;
      return { ...track, rejected: { timestampMs: ts, monoMs: monoNowMs } };
    }
  }
  return {
    fix,
    deviceTimestampMs: ts ?? null,
    receivedMonoMs: monoNowMs,
    receivedWallMs: wallNowMs,
    rejected: null,
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
  if (fix === null || !(fix.accuracyM <= REROUTE_MAX_ACCURACY_M)) {
    return { allowed: false, reason: 'accuracy', ...base };
  }
  return { allowed: true, reason: null, ...base };
}
