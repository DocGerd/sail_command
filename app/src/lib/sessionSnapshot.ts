import { safeGetItem, safeSetItem } from './storage';
import type { SailId } from '../types';
import { BOATS } from '../data/boats';

// #54: derived from the BOATS catalogue rather than a hand-written
// two-branch equality check against the two sail ids, so this stays
// correct if a boat with a different sail set is ever added — and stays
// out of test/sailLiteralCallSites.test.ts's KNOWN_OFFENDERS.
const VALID_SAIL_IDS: ReadonlySet<string> = new Set(BOATS.flatMap((b) => b.sails.map((s) => s.id)));

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
  // #54: field NAME unchanged (retyped only) — this is a PERSISTED
  // localStorage schema (real users' browsers), and renaming the key would
  // silently drop every existing snapshot's rig choice rather than parse it,
  // a migration concern outside this task's scope.
  rig: SailId | null;
}

function isTab(x: unknown): x is Tab {
  return x === 'plan' || x === 'routes' || x === 'live' || x === 'boat';
}

function isSailId(x: unknown): x is SailId {
  return typeof x === 'string' && VALID_SAIL_IDS.has(x);
}

// Tolerant parse (mirrors parseRecentHarbors): malformed JSON, a non-object,
// a foreign version, or any field outside its exact union collapses to null —
// the caller treats null as "no snapshot" and boots fresh. A PURE parser,
// deliberately: it validates SHAPE only and carries no restore POLICY, so
// `parseSessionSnapshot(JSON.stringify(x))` round-trips to `x` for every
// valid `x` — including `tab: 'boat'` (see the `Tab` comment above for why
// that's a genuinely valid persisted value). PR #486 review, Minor 6: an
// earlier version of this function ALSO coerced a persisted 'boat' tab to
// 'plan' here, which broke that round-trip property (a parser silently
// returning something other than what was written is surprising on its own
// terms) for a policy question — "what tab may a fresh boot land on" — that
// has nothing to do with whether the JSON was well-formed. That decision now
// lives in readSessionSnapshot below, the one place it's actually needed.
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
    if (rig !== null && !isSailId(rig)) return null;
    return { v: 1, planId, tab, rig };
  } catch {
    return null;
  }
}

// #299 RESTORE POLICY (not parse validity): 'boat' is a syntactically VALID
// persisted tab (isTab/parseSessionSnapshot accept it — planId/rig survive
// intact, the snapshot is never treated as corrupt), but it is deliberately
// never a tab a fresh boot restores INTO — a sailor reopening the PWA on
// deck must land on a content tab, not the boat/skipper settings form.
// Applied here, AFTER parsing, not inside parseSessionSnapshot: this is the
// one caller a restore decision belongs to (useSessionRestore.ts reads only
// through this function), so putting it here rather than in the parser
// keeps the parser a pure, round-trippable shape validator — see that
// function's own comment. The WRITE path (writeSessionSnapshot) is
// untouched — it still persists 'boat' verbatim whenever that's genuinely
// the active tab when a plan/tab/rig change fires, which is what makes this
// read-time fallback-to-'plan' correct rather than merely convenient (the
// raw value stays in storage; only a RESTORE read ever coerces it). A
// genuinely CORRUPT persisted value is unaffected: parseSessionSnapshot
// returns null for it, and the `=== null` check below short-circuits before
// this policy step ever runs, so a corrupt value still fails exactly as it
// did before this function existed.
export function readSessionSnapshot(): SessionSnapshot | null {
  const snapshot = parseSessionSnapshot(safeGetItem(SESSION_SNAPSHOT_KEY));
  if (snapshot === null) return null;
  return snapshot.tab === 'boat' ? { ...snapshot, tab: 'plan' } : snapshot;
}

/** Best-effort: a failed write (private-mode quota 0) leaves the session
 * un-persisted — session-only behavior, matching the storage.ts contract. */
export function writeSessionSnapshot(snapshot: SessionSnapshot): void {
  safeSetItem(SESSION_SNAPSHOT_KEY, JSON.stringify(snapshot));
}
