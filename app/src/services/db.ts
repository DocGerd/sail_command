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
      // Distinguishes a record this build cannot read YET — one whose stored
      // schemaVersion is from a newer build — from one that failed for any
      // other reason. Prod and `/uat/` share one origin-scoped database, so a
      // PLAN_SCHEMA_VERSION bump on develop puts UAT-written plans in front
      // of a production user, whose only control on that row is an
      // irreversible delete; naming which case it is makes that choice
      // informed. It is NOT an integrity verdict: the discriminator is that
      // one number, so a record both newer AND corrupt lands in
      // 'newer-version' too, and the copy is worded to promise only what the
      // number proves.
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
  // Newest first: createdAtMs descending, ties broken by id descending. That
  // reproduces the reversed index order for every record the index actually
  // returned AND whose ids are this app's own lowercase-hex
  // crypto.randomUUID()s, where locale collation and IndexedDB's code-unit
  // key order agree. It is deliberately not claimed as a general equivalence
  // — a future non-UUID id source could collate differently, and the records
  // the index omitted entirely (absent/NaN createdAtMs) now sort to the end
  // via readNumber's 0 fallback, which is the point of this hunk.
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
 *
 * ACCEPTED RESIDUAL — read-time migration is not the only write-shaped risk.
 * Two call sites save a migratePlan output UNDER AN EXISTING RECORD'S ID and
 * therefore drop the same legacy quartet a write-back would:
 * state/replan.ts's replanWithVias (`{ ...plan, request, result }`) and
 * usePlanFlow.ts's replace-recalculation (`opts.replacePlanId`). Neither is
 * made additive, deliberately. A write-back fires on a record the user only
 * OPENED; these fire only after a deliberate edit whose entire purpose is to
 * replace that record's result. Retaining the stored quartet would leave a
 * PRE-edit result beside a POST-edit `request`, so one record would describe
 * two different passages; deriving a fresh quartet instead would re-couple
 * the WRITE path to the frozen sail names this branch removed from it, and
 * would cover only sails still named genoa/fock.
 *
 * What is NOT lost: the record these two write is a complete current-shape
 * record, so it re-reads through migratePlan unchanged — rather than the
 * RECORD being destroyed — an older build skips the row (the plan vanishes
 * from its Routes list) until that build is upgraded, the same user-visible
 * loss a write-back would cause, which is why the deliberate-edit distinction
 * above is the whole justification. Both halves are pinned in db.test.ts by
 * 'a write under an existing id drops the legacy quartet, and what it leaves
 * still reads and lists'; the two call sites are covered individually by
 * replan.test.ts's '#54: the record it saves under the existing id stays
 * readable' and by usePlanFlow.test.tsx's pre-existing 'recalc-replace' row,
 * which reads the replaced record back through getPlan.
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
