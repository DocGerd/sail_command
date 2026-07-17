import { useCallback, useState } from 'react';
import { safeGetItem, safeSetItem } from './storage';

// Persisted boolean toggle (#63). The map-overlay checkboxes (wind barbs,
// times & speeds, depth) default ON for a fresh profile, but an explicit user
// choice must survive reloads. Values are stored as '1'/'0' (the existing
// sc-gps-hint-shown convention — no JSON, so no parse can ever throw); any
// other stored value (missing key, legacy garbage) falls back to
// `defaultValue`. All storage access goes through storage.ts's safe wrappers:
// private/incognito modes (notably Safari) throw on localStorage access, and
// the toggle must then degrade to plain session-only state, never crash.
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
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      // Best-effort: a failed write (quota-0 private mode) leaves the choice
      // session-only, which is exactly the pre-#63 behavior.
      safeSetItem(key, next ? '1' : '0');
    },
    [key],
  );
  return [value, set];
}
