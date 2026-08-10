import { safeGetItem, safeSetItem } from './storage';
import type { Rig } from '../types';

// #113 session restore: a SMALL versioned UI-session snapshot — the pointer
// to the active plan plus the selected tab and rig choice — persisted under
// one localStorage key via storage.ts's safe wrappers (private/incognito
// modes throw on access; every path here degrades to "no snapshot" /
// "not persisted", never a crash). Deliberately NOT in the IndexedDB plans
// store: the snapshot is UI session state about plans, not plan data, and a
// synchronous read keeps boot restore trivial.
//
// The plan itself is NOT duplicated here — restore replays PlansList's load
// path (getPlan(id) → setPlan) against IndexedDB, so a restored plan always
// renders from its STORED wind grid, zero network. The slider hour (`hourIdx`,
// RouteLayer.tsx) is deliberately excluded: it resets to the departure hour on
// every plan change by design, and persisting it would turn every slider drag
// step into a localStorage write.

// The bottom-sheet tab strip's tabs. Defined here (App.tsx imports it) so
// this module can validate a persisted value without importing a component.
// #299: 'boat' (the static boat/skipper-profile settings tab) is a REAL,
// persistable tab value — the write-back effect below saves it like any
// other whenever it's the active tab — but it must never be a tab a fresh
// boot RESTORES INTO (see parseSessionSnapshot's own comment on `tab` for
// why and how that's enforced).
export type Tab = 'plan' | 'routes' | 'live' | 'boat';

export const SESSION_SNAPSHOT_KEY = 'sc-session';

export interface SessionSnapshot {
  // Shape version for forward compat: bump when the shape changes; any other
  // value (including a future writer's) parses to null → graceful fresh boot.
  v: 1;
  planId: string | null;
  tab: Tab;
  rig: Rig | null;
}

function isTab(x: unknown): x is Tab {
  return x === 'plan' || x === 'routes' || x === 'live' || x === 'boat';
}

function isRig(x: unknown): x is Rig {
  return x === 'genoa' || x === 'fock';
}

// Tolerant parse (mirrors parseRecentHarbors): malformed JSON, a non-object,
// a foreign version, or any field outside its exact union collapses to null —
// the caller treats null as "no snapshot" and boots fresh.
export function parseSessionSnapshot(raw: string | null): SessionSnapshot | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Sole cast in this module: unknown → indexable, so the field checks
    // below can narrow each property honestly (no per-field casts).
    const { v, planId, tab, rig } = parsed as Record<string, unknown>;
    if (v !== 1) return null;
    if (!isTab(tab)) return null;
    if (planId !== null && typeof planId !== 'string') return null;
    if (rig !== null && !isRig(rig)) return null;
    // #299: 'boat' is a syntactically VALID persisted tab (isTab accepts it
    // above, so a snapshot naming it is not treated as corrupt — planId/rig
    // survive intact), but it is deliberately never a RESTORE target: a
    // sailor reopening the PWA on deck must land on a content tab, not the
    // boat/skipper settings form. Coerced here, at the single parse boundary
    // every restore read (readSessionSnapshot -> useSessionRestore.ts) goes
    // through, rather than in the restore hook itself, so this can't be
    // forgotten at a second call site. The WRITE path (writeSessionSnapshot)
    // is untouched — it still persists 'boat' verbatim whenever that's
    // genuinely the active tab when a plan/tab/rig change fires, which is
    // what makes the next restore's fallback-to-'plan' correct rather than
    // merely convenient (the raw value is preserved in storage, only the
    // RESTORE read coerces it).
    const restoreTab: Tab = tab === 'boat' ? 'plan' : tab;
    return { v: 1, planId, tab: restoreTab, rig };
  } catch {
    return null;
  }
}

export function readSessionSnapshot(): SessionSnapshot | null {
  return parseSessionSnapshot(safeGetItem(SESSION_SNAPSHOT_KEY));
}

/** Best-effort: a failed write (private-mode quota 0) leaves the session
 * un-persisted — session-only behavior, matching the storage.ts contract. */
export function writeSessionSnapshot(snapshot: SessionSnapshot): void {
  safeSetItem(SESSION_SNAPSHOT_KEY, JSON.stringify(snapshot));
}
