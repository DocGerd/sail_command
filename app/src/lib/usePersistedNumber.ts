import { useCallback, useEffect, useState } from 'react';
import { safeGetItem, safeRemoveItem, safeSetItem } from './storage';

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function parseStored(raw: string | null): number | null {
  // Number('') is 0 (finite), not NaN — an empty/missing entry must fall
  // back to `null` ("no override"), not a spurious zero (mirrors
  // NumberInput.tsx's identical guard on its own blur handler).
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// #353 PR2: cross-instance live sync. Every consumer before this (App.tsx's
// panel width, #355) had exactly ONE mounted instance at a time, so a write
// through `set()` was always observed by re-reading that SAME component's
// own state — there was no gap. #353's seamark size/display-tier controls
// are the first case with TWO simultaneously-mounted consumers of the SAME
// key (SettingsPanel.tsx renders the control, DataLayers.tsx applies the
// live value to the MapLibre layer, and DataLayers stays mounted whether or
// not the Settings tab is open) — without this, a slider drag would write
// localStorage correctly but the map would only pick it up on the next full
// remount. Keyed by the storage key so unrelated keys never cross-notify;
// every mounted hook instance for a key is notified on any `set()` call for
// that key (itself included, since it registers its own setter on mount) —
// the same-tab analogue of a cross-tab `storage` event, which fires only in
// OTHER documents and would not close this gap.
const listenersByKey = new Map<string, Set<(next: number | null) => void>>();

function notify(key: string, next: number | null): void {
  listenersByKey.get(key)?.forEach((listener) => listener(next));
}

/**
 * Test-only: the number of currently-subscribed listeners for `key` (0 if
 * none, or if `key` has no entry at all — the cleanup below deletes an
 * emptied entry rather than leaving a zero-size `Set` behind). Exported so a
 * test can assert the subscribe/unsubscribe lifecycle DIRECTLY (#513 F4):
 * calling a dead instance's `setRaw` after unmount is a silent no-op under
 * React 18 (the "setState on an unmounted component" warning was removed),
 * so a test that only checks "no crash, right final value" cannot tell a
 * real unsubscribe from a leaked one that happens not to matter — MEASURED,
 * not assumed: deleting the cleanup below left such a test, and the whole
 * file, green. This probe reads the actual registry state instead.
 */
export function __listenerCountForKey(key: string): number {
  return listenersByKey.get(key)?.size ?? 0;
}

/**
 * Numeric sibling of usePersistedToggle (#355) — same localStorage +
 * safe-wrapper degrade-to-session-only contract, but for a bounded number
 * rather than a boolean. `null` is a first-class return value meaning "no
 * stored override; the caller's own default governs" — for the panel-width
 * use this is what lets app.css's `var(--sc-panel-w, 1fr)` fallback keep
 * today's exact layout until a user actually drags or keys the resizer.
 *
 * `min`/`max` clamp on both read and write. Clamping is applied to the
 * RETURNED value on every call (`clamp(raw, min, max)`, recomputed fresh —
 * never cached), so a width stored on a wide external monitor can never be
 * handed back wider than the caller's current bounds, even right after a
 * viewport shrink and before any explicit re-commit. The RAW stored number
 * itself is left untouched by a bounds change alone — only an explicit
 * `set()` call (a real user action: drag, keyboard step, reset) persists a
 * new value — so visiting a narrow viewport once cannot silently overwrite
 * a wide-screen preference for the next time the panel is wide again; only
 * the number actually handed to callers is safe, not the storage entry.
 */
export function usePersistedNumber(
  key: string,
  min: number,
  max: number,
): [number | null, (next: number | null) => void] {
  const [raw, setRaw] = useState<number | null>(() => parseStored(safeGetItem(key)));

  // Registers THIS instance's setter for `key` so a `set()` call from ANY
  // instance (including a sibling component reading the same key) reaches
  // it — see the module-level comment above. Re-subscribes only if `key`
  // itself changes; `setRaw` has a stable identity across renders (a React
  // guarantee), so this never re-registers on every render.
  useEffect(() => {
    let listeners = listenersByKey.get(key);
    if (!listeners) {
      listeners = new Set();
      listenersByKey.set(key, listeners);
    }
    listeners.add(setRaw);
    return () => {
      listeners.delete(setRaw);
      if (listeners.size === 0) listenersByKey.delete(key);
    };
  }, [key]);

  const set = useCallback(
    (next: number | null) => {
      if (next === null) {
        safeRemoveItem(key);
        notify(key, null);
        return;
      }
      const clamped = clamp(next, min, max);
      safeSetItem(key, String(clamped));
      notify(key, clamped);
    },
    [key, min, max],
  );

  const value = raw === null ? null : clamp(raw, min, max);
  return [value, set];
}
