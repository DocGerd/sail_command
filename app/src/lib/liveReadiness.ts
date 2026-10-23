// #1807: the pre-sail readiness checks, as pure functions of their inputs.
// Every input that cannot be read maps to not ready (guard asymmetry): the
// panel may under-claim readiness, never over-claim it.
import type { MsgKey } from '../i18n/dict.de';
import type { RegionReadinessStatus } from '../state/useRegionReadiness';
import type { AisStatus } from '../state/useAisTraffic';

export type ReadinessCheckId = 'regions' | 'glyphs' | 'gps' | 'forecast' | 'wakeLock' | 'ais';

export interface ReadinessCheck {
  readonly id: ReadinessCheckId;
  readonly ready: boolean;
  readonly detailKey: MsgKey;
}

/** `PermissionState` plus the two states the Permissions API cannot report. */
export type GpsPermission = PermissionState | 'unknown' | 'checking';

export function regionsCheck(status: RegionReadinessStatus): ReadinessCheck {
  if (status === 'ready') return { id: 'regions', ready: true, detailKey: 'live.ready.regions.ok' };
  if (status === 'pinning')
    return { id: 'regions', ready: false, detailKey: 'live.ready.regions.pinning' };
  return { id: 'regions', ready: false, detailKey: 'live.ready.regions.no' };
}

/** `complete` is null while the cache check is still running. */
export function glyphsCheck(complete: boolean | null): ReadinessCheck {
  return complete === true
    ? { id: 'glyphs', ready: true, detailKey: 'live.ready.glyphs.ok' }
    : { id: 'glyphs', ready: false, detailKey: 'live.ready.glyphs.no' };
}

/** `denied` is the shared GPS source's PERMISSION_DENIED flag; it wins over the query. */
export function gpsCheck(permission: GpsPermission, denied: boolean): ReadinessCheck {
  if (denied || permission === 'denied')
    return { id: 'gps', ready: false, detailKey: 'live.ready.gps.denied' };
  if (permission === 'granted') return { id: 'gps', ready: true, detailKey: 'live.ready.gps.ok' };
  if (permission === 'prompt')
    return { id: 'gps', ready: false, detailKey: 'live.ready.gps.prompt' };
  return { id: 'gps', ready: false, detailKey: 'live.ready.gps.unknown' };
}

/**
 * Whether the plan's stored forecast covers the passage if it starts now (or
 * at the planned departure, whichever is later): the grid must start at or
 * before that time and its last hour must reach the shifted arrival.
 */
export function forecastCovers(
  timesMs: ArrayLike<number>,
  departureMs: number,
  arrivalMs: number,
  nowMs: number,
): boolean {
  if (timesMs.length === 0) return false;
  const first = timesMs[0];
  const last = timesMs[timesMs.length - 1];
  if (![first, last, departureMs, arrivalMs, nowMs].every(Number.isFinite)) return false;
  if (arrivalMs < departureMs) return false;
  const startMs = Math.max(nowMs, departureMs);
  const endMs = startMs + (arrivalMs - departureMs);
  return first <= startMs && endMs <= last;
}

export function forecastCheck(covers: boolean): ReadinessCheck {
  return covers
    ? { id: 'forecast', ready: true, detailKey: 'live.ready.forecast.ok' }
    : { id: 'forecast', ready: false, detailKey: 'live.ready.forecast.no' };
}

export function wakeLockCheck(supported: boolean): ReadinessCheck {
  return supported
    ? { id: 'wakeLock', ready: true, detailKey: 'live.ready.wakeLock.ok' }
    : { id: 'wakeLock', ready: false, detailKey: 'live.ready.wakeLock.no' };
}

/** Only a received message proves the key ('noTraffic' can occur before any). Null = AIS not mounted. */
export function aisCheck(status: AisStatus | null): ReadinessCheck {
  switch (status) {
    case 'live':
      return { id: 'ais', ready: true, detailKey: 'live.ready.ais.ok' };
    case 'off':
      return { id: 'ais', ready: false, detailKey: 'live.ready.ais.off' };
    case 'keyError':
      return { id: 'ais', ready: false, detailKey: 'live.ready.ais.keyError' };
    case 'offline':
      return { id: 'ais', ready: false, detailKey: 'live.ready.ais.offline' };
    default:
      return { id: 'ais', ready: false, detailKey: 'live.ready.ais.unconfirmed' };
  }
}
