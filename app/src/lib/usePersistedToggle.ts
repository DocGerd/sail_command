import { useCallback, useEffect, useState } from 'react';
import { safeGetItem, safeSetItem } from './storage';

// Persisted boolean toggle (#63). The map-overlay checkboxes (wind barbs,
// times & speeds, depth) default ON for a fresh profile, but an explicit user
// choice must survive reloads. Values are stored as '1'/'0' (the existing
// sc-gps-hint-shown convention — no JSON, so no parse can ever throw); any
// other stored value (missing key, legacy garbage) falls back to
// `defaultValue`. All storage access goes through storage.ts's safe wrappers:
// private/incognito modes (notably Safari) throw on localStorage access, and
// the toggle must then degrade to plain session-only state, never crash.

// #681 x #813: cross-instance live sync, the boolean sibling of
// `usePersistedNumber.ts`'s own mechanism (#353 PR2) — same shape, same
// module comment there for the full rationale, ported here because #681's
// composition fix hit the IDENTICAL requirement one level down: the hazard-
// hatch toggle is now offered from TWO complementary surfaces
// (DataLayers.tsx's own `.depth-legend`, reachable while `plan === null`,
// and RouteLegend.tsx's folded-in `.route-legend-depth`, reachable once a
// plan exists) for the SAME two keys (`sc-depth-hatch-visible` and
// `sc-depth-visible`, the latter needed for the `disabled` mirror), while
// DataLayers.tsx itself stays mounted and driving the map layer in BOTH
// states. Without this, checking the box in RouteLegend would write
// localStorage correctly but DataLayers.tsx's OWN `hatchVisible` state
// (the one its layer-visibility effect actually reads) would only pick up
// the change on a future remount — the exact gap #353 PR2 closed for
// `usePersistedNumber`. Keyed by the storage key so unrelated keys never
// cross-notify; every mounted instance for a key is notified on any set()
// call for that key, itself included.
const listenersByKey = new Map<string, Set<(next: boolean) => void>>();

function notify(key: string, next: boolean): void {
  listenersByKey.get(key)?.forEach((listener) => listener(next));
}

/**
 * Test-only: the number of currently-subscribed listeners for `key` — the
 * boolean sibling of `usePersistedNumber.ts`'s own `__listenerCountForKey`,
 * same rationale (a "no crash" assertion cannot tell a real unsubscribe from
 * a leaked one that happens not to matter under React 18's silent
 * setState-on-unmounted no-op; this probe reads the registry directly).
 */
export function __listenerCountForKey(key: string): number {
  return listenersByKey.get(key)?.size ?? 0;
}

export function usePersistedToggle(
  key: string,
  defaultValue: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = safeGetItem(key);
    if (stored === '1') return true;
    if (stored === '0') return false;
    return defaultValue;
  });

  // Registers THIS instance's setter for `key` so a `set()` call from ANY
  // instance (including a sibling component reading the same key) reaches
  // it. Re-subscribes only if `key` itself changes; `setValue` has a stable
  // identity across renders (a React guarantee), so this never re-registers
  // on every render.
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
    (next: boolean) => {
      setValue(next);
      // Best-effort: a failed write (quota-0 private mode) leaves the choice
      // session-only, which is exactly the pre-#63 behavior.
      safeSetItem(key, next ? '1' : '0');
      notify(key, next);
    },
    [key],
  );
  return [value, set];
}
