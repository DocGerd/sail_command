import { safeGetItem, safeSetItem } from './storage';

// Marks the GPS-denied/unavailable hint as shown, forever (spec §4: "hint
// shown once"). Shared by LiveView and the standalone ownship marker (#25
// addendum) so whichever of the two GPS consumers hits a denial/unavailable
// error FIRST is the one that ever shows it — a later error from the other
// consumer, or from either one after a remount, must not show it again. Set
// the moment the claim succeeds, not on dismiss, so a remount before the user
// dismisses it doesn't show it again either.
const GPS_HINT_STORAGE_KEY = 'sc-gps-hint-shown';

/**
 * Returns true (the caller should display the hint now) exactly once, ever,
 * across every caller sharing this module — false on every subsequent call.
 */
export function claimGpsHintOnce(): boolean {
  if (safeGetItem(GPS_HINT_STORAGE_KEY) === '1') return false;
  safeSetItem(GPS_HINT_STORAGE_KEY, '1');
  return true;
}
