import { useCallback, useState } from 'react';
import { BOATS, DEFAULT_BOAT_ID, type BoatId } from '../data/boats';
import { safeGetItem, safeSetItem } from './storage';

/**
 * #54 boat selection. localStorage, NOT IndexedDB — same contract as
 * usePersistedToggle (#63) and usePersistedNumber (#355): every access goes
 * through storage.ts's safe wrappers, because private/incognito modes
 * (notably Safari) throw on localStorage access and the picker must then
 * degrade to session-only state rather than crash the app.
 *
 * Deliberately NOT a `Settings` field: `Settings` round-trips through
 * IndexedDB and is snapshotted BY VALUE into every `PlanRequest` (spec I.3).
 * The boat a given plan was computed for already travels inside that plan's
 * own boat snapshot, so putting the live selection in `Settings` would state
 * the same fact in two places with no derivation between them.
 */
export const BOAT_ID_STORAGE_KEY = 'sc-boat-id';

/**
 * VALIDATE ON READ. A boat can leave the catalogue between two visits (a
 * deferred fleet vessel withdrawn, an id corrected), and `boatById` THROWS on
 * a miss — so an unchecked read would turn a stale localStorage entry into a
 * blank app on every subsequent load, with no way for the user to clear it
 * from inside the app. Degrade to DEFAULT_BOAT_ID instead.
 *
 * The stale entry is left in storage untouched, deliberately: the next
 * explicit selection overwrites it, and silently rewriting it here would
 * destroy the only record of what the user had chosen if that id ever
 * returns to the catalogue.
 */
export function isCatalogueBoatId(raw: string | null): raw is BoatId {
  return raw !== null && BOATS.some((b) => b.id === raw);
}

export function usePersistedBoatId(): [BoatId, (next: BoatId) => void] {
  const [boatId, setBoatIdState] = useState<BoatId>(() => {
    const stored = safeGetItem(BOAT_ID_STORAGE_KEY);
    return isCatalogueBoatId(stored) ? stored : DEFAULT_BOAT_ID;
  });
  const setBoatId = useCallback((next: BoatId) => {
    setBoatIdState(next);
    // Best-effort, mirroring usePersistedToggle: a failed write (quota-0
    // private mode) leaves the choice session-only.
    safeSetItem(BOAT_ID_STORAGE_KEY, next);
  }, []);
  return [boatId, setBoatId];
}
