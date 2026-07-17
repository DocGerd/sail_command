import { useCallback, useState } from 'react';
import { safeGetItem, safeSetItem } from './storage';

// Small most-recently-used store of harbor ids (#64 phase 2), so the combobox's
// empty-query state can surface the common round-trip harbors first. Persisted
// as a JSON string array under one key via storage.ts's safe wrappers (private/
// incognito modes throw on access — the hook must degrade to session-only, never
// crash). Boolean-only usePersistedToggle can't hold a list, hence a dedicated
// store rather than that hook.
const STORAGE_KEY = 'sc-recent-harbors';
const CAP = 5;

// Tolerant parse: any non-array, malformed JSON, or non-string entries collapse
// to an empty list rather than throwing. Trims to CAP so a hand-edited oversized
// array can't grow the list unbounded.
export function parseRecentHarbors(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, CAP);
  } catch {
    return [];
  }
}

export interface RecentHarbors {
  recent: string[]; // most-recent-first, de-duped, capped at CAP
  remember: (harborId: string) => void;
}

export function useRecentHarbors(): RecentHarbors {
  const [recent, setRecent] = useState<string[]>(() =>
    parseRecentHarbors(safeGetItem(STORAGE_KEY)),
  );

  const remember = useCallback((harborId: string) => {
    setRecent((prev) => {
      // Move-to-front + de-dupe: drop any existing occurrence, prepend, cap.
      const next = [harborId, ...prev.filter((id) => id !== harborId)].slice(0, CAP);
      // Best-effort persist: a failed write (quota-0 private mode) leaves the
      // ordering session-only, matching the storage.ts contract.
      safeSetItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { recent, remember };
}
