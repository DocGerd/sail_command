import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  PLAN_SCHEMA_VERSION,
  recommendedResult,
  type Plan,
  type SailId,
  type Settings,
} from '../types';
import { migratePlan } from './migratePlan';

interface SailDB extends DBSchema {
  plans: { key: string; value: Plan; indexes: { 'by-createdAt': number } };
  settings: { key: 'user'; value: Settings };
}

let dbPromise: Promise<IDBPDatabase<SailDB>> | null = null;

function db(): Promise<IDBPDatabase<SailDB>> {
  dbPromise ??= openDB<SailDB>('sailcommand', 1, {
    upgrade(d) {
      const plans = d.createObjectStore('plans', { keyPath: 'id' });
      plans.createIndex('by-createdAt', 'createdAtMs');
      d.createObjectStore('settings');
    },
  });
  return dbPromise;
}

export async function __resetDbForTests(): Promise<void> {
  // test-only helper — closes the cached connection so deleteDatabase cannot block; not for app use
  if (dbPromise) {
    (await dbPromise).close();
  }
  dbPromise = null;
  // idb's deleteDB actually awaits IDBOpenDBRequest completion; a bare
  // `await indexedDB.deleteDatabase(...)` awaits the request object itself
  // (a no-op — it resolves immediately, not on the request's success event)
  // and only worked here by incidental ordering.
  await deleteDB('sailcommand');
}

// #54 spec §I.3: a row the app cannot open is LISTED, never skipped and
// never deleted. `name` and `createdAtMs` are readable from any shape, so an
// unreadable row still identifies itself to the user; everything else needs a
// plan the normaliser could actually produce, hence the discriminated union
// rather than nullable fields on one shape.
export type PlanSummary =
  | {
      kind: 'ok';
      id: string;
      name: string;
      createdAtMs: number;
      departureMs: number;
      recommended: SailId;
      etaMs: number;
    }
  | {
      kind: 'unreadable';
      // Distinguishes a record this build simply cannot read yet — written by
      // a newer build, intact, and openable THERE — from one that is actually
      // damaged. Prod and `/uat/` share one origin-scoped database, so a
      // PLAN_SCHEMA_VERSION bump on develop puts real, recoverable UAT plans
      // in front of a production user; telling them the record is fine is the
      // difference between an informed two-tap delete and a destroyed plan.
      reason: 'newer-version' | 'damaged';
      id: string;
      name: string;
      createdAtMs: number;
    };

function readString(raw: unknown, key: string): string {
  if (typeof raw !== 'object' || raw === null) return '';
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

function readNumber(raw: unknown, key: string): number {
  if (typeof raw !== 'object' || raw === null) return 0;
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function unreadableRow(raw: unknown): PlanSummary {
  return {
    kind: 'unreadable',
    // Read here rather than returned by migratePlan: the normaliser's own
    // answer is a single null by design, and this is the one caller that
    // needs to tell the two apart.
    reason: readNumber(raw, 'schemaVersion') > PLAN_SCHEMA_VERSION ? 'newer-version' : 'damaged',
    id: readString(raw, 'id'),
    name: readString(raw, 'name'),
    createdAtMs: readNumber(raw, 'createdAtMs'),
  };
}

/** One stored record → one list row. Exported so the row shapes can be
 * exercised without an IndexedDB round trip. */
export function summarizePlanRecord(raw: unknown): PlanSummary {
  const plan = migratePlan(raw);
  if (plan === null) return unreadableRow(raw);
  return {
    kind: 'ok',
    id: plan.id,
    name: plan.name,
    createdAtMs: plan.createdAtMs,
    departureMs: plan.request.departureMs,
    recommended: plan.result.recommended,
    etaMs: recommendedResult(plan.result).etaMs,
  };
}

export async function savePlan(plan: Plan): Promise<void> {
  await (await db()).put('plans', plan);
}

export async function listPlans(): Promise<PlanSummary[]> {
  // Reads the OBJECT STORE, not the by-createdAt index, and sorts here.
  // IndexedDB omits a record from an index whenever its key path is absent or
  // not a valid key, and a missing/NaN createdAtMs is exactly what
  // migratePlan refuses — so the index read skipped precisely the records the
  // unreadable placeholder exists for (measured: 4 stored, 1 listed). That
  // silent skip is the §I.3 defect this task removes, so the listing cannot
  // be built on a structure that reproduces it. readNumber is the same
  // tolerant reader the placeholder row uses.
  const all = await (await db()).getAll('plans');
  // Newest first, matching the reversed index order the store previously
  // returned: createdAtMs descending, ties broken by id descending.
  const ordered = [...all].sort((a, b) => {
    const byDate = readNumber(b, 'createdAtMs') - readNumber(a, 'createdAtMs');
    return byDate !== 0 ? byDate : readString(b, 'id').localeCompare(readString(a, 'id'));
  });
  const summaries: PlanSummary[] = [];
  // Isolated per row: one corrupt record must not blank out the entire list
  // for the user. #54 spec §I.3 replaced the old catch-and-SKIP — which made
  // a plan silently vanish from the list while its bytes survived,
  // indistinguishable from deletion where the user sits — with a placeholder
  // row. summarizePlanRecord already answers "unreadable" for every shape
  // migratePlan rejects, so this catch covers only a record that throws while
  // being READ (a getter, a revoked proxy). It is a partial net, not a
  // guarantee: unreadableRow re-reads the same object, so such a getter would
  // rethrow from inside the catch. Unreachable today — a getter does not
  // survive structured clone into IndexedDB. Logged, not surfaced as a
  // banner: a data-integrity issue the user can't act on beyond "some plan
  // somewhere is broken", not a transient failure.
  for (const p of ordered) {
    try {
      summaries.push(summarizePlanRecord(p));
    } catch (err) {
      console.error('listPlans: unreadable plan record', err);
      summaries.push(unreadableRow(p));
    }
  }
  return summaries;
}

/**
 * Migrates on the way OUT and writes NOTHING. §I.3 also asks for an
 * opportunistic write-back; it is deliberately not implemented, and
 * re-adding it in the obvious form destroys production data.
 *
 * The chain, verified against origin/main: IndexedDB is origin-scoped, so
 * production and `/uat/` share one 'sailcommand' database. migratePlan
 * rebuilds the record from named fields, so a write-back DROPS the pre-#54
 * genoa/fock/genoaReason/fockReason quartet. Production's recommendedResult
 * still reads `result.genoa`/`result.fock`, throws on undefined, and its
 * listPlans catches and SKIPS the row. useSessionRestore calls getPlan at
 * BOOT, so merely opening /uat/ once would make a production user's saved
 * plans vanish from their Routes list, irreversibly — the exact outcome
 * §I.3 exists to remove. §I.3's rollback paragraph does not cover this
 * because it reasons about an older build that also has migratePlan;
 * production does not.
 *
 * Read-time migration alone satisfies every requirement — the normaliser
 * runs on every read by design, which is the documented cost of lazy
 * migration. Any future write-back must be ADDITIVE: no key present in the
 * stored record may be removed. Both properties are pinned in db.test.ts.
 */
export async function getPlan(id: string): Promise<Plan | undefined> {
  const raw: unknown = await (await db()).get('plans', id);
  if (raw === undefined) return undefined;
  const plan = migratePlan(raw);
  // Unreadable: `undefined` (the same answer as "no such plan") rather than a
  // throw, so every existing caller degrades to its own not-found path. The
  // record itself is left untouched — never deleted, never overwritten.
  return plan ?? undefined;
}

export async function deletePlan(id: string): Promise<void> {
  await (await db()).delete('plans', id);
}

export async function loadSettings(): Promise<Settings | undefined> {
  return (await db()).get('settings', 'user');
}

export async function saveSettings(s: Settings): Promise<void> {
  await (await db()).put('settings', s, 'user');
}
