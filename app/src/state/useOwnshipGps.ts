import { watchPosition as realWatchPosition } from '../services/geolocation';
import { useGpsSource, type GpsSource } from './useGpsSource';

export type UseOwnshipGpsResult = GpsSource;

/**
 * The GPS source App.tsx shares between the boat marker and Live (#1800). The
 * watch runs while the `showOwnship` setting is on OR Live tracking is active,
 * so the marker follows the fix whenever either holds. The setting itself is
 * only read here, never written.
 *
 * 1 Hz fixes must not re-render the whole app via AppState (see
 * AppState.tsx's docstring), so this stays local React state.
 */
export function useOwnshipGps(
  showOwnship: boolean,
  liveTracking: boolean,
  watchPosition: typeof realWatchPosition = realWatchPosition,
): UseOwnshipGpsResult {
  return useGpsSource(showOwnship || liveTracking, watchPosition);
}
