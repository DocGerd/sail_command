import { useCallback, useState } from 'react';
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

  const set = useCallback(
    (next: number | null) => {
      if (next === null) {
        setRaw(null);
        safeRemoveItem(key);
        return;
      }
      const clamped = clamp(next, min, max);
      setRaw(clamped);
      safeSetItem(key, String(clamped));
    },
    [key, min, max],
  );

  const value = raw === null ? null : clamp(raw, min, max);
  return [value, set];
}
