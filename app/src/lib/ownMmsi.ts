import { useCallback, useEffect, useState } from 'react';
import type { BoatId } from '../data/boats';
import { safeGetItem, safeRemoveItem, safeSetItem } from './storage';

/**
 * #746: the user's own vessel MMSI, stored PER BOAT.
 *
 * An MMSI identifies a VESSEL, so a single global value is wrong the moment
 * the catalogue holds more than one boat: the AIS overlay uses it to suppress
 * "my own ship" from the display (`lib/aisTargets.ts`, `mergeAisMessage`), so
 * a stale value from another boat suppresses the WRONG vessel — silently, and
 * on the one surface whose job is to show nearby traffic.
 *
 * ONE localStorage KEY PER BOAT, deliberately — not a `Record<BoatId, string>`
 * on a single key. A keyed lookup table would have to be read with
 * `Object.hasOwn` forever, because a bare `in`/bracket read over an object
 * literal walks the prototype chain and every `Object.prototype` member reads
 * as present (the #614/PR #656 defect). One key per boat has no lookup table
 * to walk, so that failure class cannot arise here at all — the hazard is
 * dissolved rather than guarded.
 *
 * ACCEPTED COST, stated rather than discovered later: a boat that leaves the
 * catalogue leaves its key behind. `usePersistedBoatId` already sets that
 * precedent for `sc-boat-id` and gives its reason (a stale entry is the only
 * record of what the user chose, should that id ever return).
 *
 * localStorage, NOT `Settings`/IndexedDB. Two reasons, both already written
 * down in this repo: `Settings` is snapshotted BY VALUE into every
 * `PlanRequest` (spec §I.3), and an MMSI does not describe a route
 * computation — `lib/planForm.ts`'s `ROUTING_RELEVANT_SETTINGS_KEYS` already
 * excludes it, with a comment recording zero references anywhere under
 * `app/src/routing/`. Same safe-wrapper contract as `usePersistedBoatId`
 * (#54), `usePersistedToggle` (#63) and `usePersistedNumber` (#355): every
 * access goes through `storage.ts`, because private/incognito modes throw on
 * localStorage access and this control must then degrade to session-only
 * state rather than crash the app.
 */
export const OWN_MMSI_KEY_PREFIX = 'sc-own-mmsi-';

export function ownMmsiStorageKey(boatId: BoatId): string {
  return `${OWN_MMSI_KEY_PREFIX}${boatId}`;
}

/**
 * `null` means "no MMSI stored for this boat" — a first-class value, not an
 * error, exactly as in `usePersistedNumber`'s contract. Never throws.
 *
 * The stored string is returned RAW, unvalidated. That is deliberate and
 * preserves the pre-#746 behaviour: `SettingsPanel` persisted every keystroke
 * and rendered its own `isValidMmsi` message beside the field, so a
 * half-typed value survived a tab switch and the user saw why it was not yet
 * accepted. Validation therefore stays at the RENDER site (`BoatPicker`), not
 * here. Nothing downstream can be misled by an invalid value: `aisTargets.ts`
 * compares it for exact equality against a real 9-digit MMSI, so a partial
 * string simply never matches and suppresses nothing.
 */
export function readOwnMmsi(boatId: BoatId): string | null {
  return safeGetItem(ownMmsiStorageKey(boatId));
}

// Cross-instance live sync, the `usePersistedNumber` mechanism and for the
// same reason: TWO components read this value at once. `BoatPicker` renders
// the field (Boat tab only), while `App.tsx` reads it to feed `<AisTraffic>`
// and stays mounted throughout. Without this, typing an MMSI on the Boat tab
// would write localStorage correctly and the AIS overlay would keep filtering
// on the previous value until a full remount. Keyed by STORAGE KEY, so two
// boats never cross-notify each other.
const listenersByKey = new Map<string, Set<(next: string | null) => void>>();

function notify(key: string, next: string | null): void {
  listenersByKey.get(key)?.forEach((listener) => listener(next));
}

/**
 * Test-only probe on the subscription registry, mirroring
 * `usePersistedNumber.__listenerCountForKey`'s rationale: calling a dead
 * instance's setter after unmount is a silent no-op under React 18, so a test
 * that only checks "no crash, right final value" cannot tell a real
 * unsubscribe from a leaked one.
 */
export function __ownMmsiListenerCountForKey(key: string): number {
  return listenersByKey.get(key)?.size ?? 0;
}

/**
 * Returns `[mmsi, setMmsi]` for the CURRENTLY SELECTED boat. Passing `''`
 * clears the entry, so "no value" is one state (`null`), never two.
 */
export function usePersistedOwnMmsi(boatId: BoatId): [string | null, (next: string) => void] {
  const key = ownMmsiStorageKey(boatId);
  const [value, setValue] = useState<string | null>(() => safeGetItem(key));
  const [seenKey, setSeenKey] = useState(key);

  // A boat switch changes the KEY, and `useState` seeds once — so without
  // this the hook would keep serving the previous boat's MMSI. Re-read
  // DURING RENDER (React's documented "adjusting state when a prop changes"
  // pattern), never from an effect: an effect runs after paint, so boat B
  // would paint carrying boat A's value for a frame. That frame is not
  // cosmetic here — this value SUPPRESSES an AIS target, so showing another
  // boat's filter even briefly is the exact failure #746 exists to remove.
  // React discards this render and re-runs before committing, so no
  // committed render ever carries the stale pair.
  if (seenKey !== key) {
    setSeenKey(key);
    setValue(safeGetItem(key));
  }

  useEffect(() => {
    let listeners = listenersByKey.get(key);
    if (!listeners) {
      listeners = new Set();
      listenersByKey.set(key, listeners);
    }
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
      if (listeners.size === 0) listenersByKey.delete(key);
    };
  }, [key]);

  const set = useCallback(
    (next: string) => {
      if (next === '') {
        safeRemoveItem(key);
        notify(key, null);
        return;
      }
      // Best-effort, mirroring usePersistedBoatId: a failed write (quota-0
      // private mode) leaves the value session-only rather than crashing.
      safeSetItem(key, next);
      notify(key, next);
    },
    [key],
  );

  return [seenKey === key ? value : safeGetItem(key), set];
}
