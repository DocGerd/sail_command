import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { recommendedResult, type Plan, type SailId, type Settings } from '../types';
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
  | { kind: 'unreadable'; id: string; name: string; createdAtMs: number };

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
  const all = await (await db()).getAllFromIndex('plans', 'by-createdAt');
  const summaries: PlanSummary[] = [];
  // Isolated per row: one corrupt record must not blank out the entire list
  // for the user. #54 spec §I.3 replaced the old catch-and-SKIP — which made
  // a plan silently vanish from the list while its bytes survived,
  // indistinguishable from deletion where the user sits — with a placeholder
  // row. summarizePlanRecord already answers "unreadable" for every shape
  // migratePlan rejects; this catch is the residual net for a record that
  // throws while merely being READ (a getter, a revoked proxy), which is the
  // only remaining way one row could take the list down with it. Logged, not
  // surfaced as a banner — a data-integrity issue the user can't act on
  // beyond "some plan somewhere is broken", not a transient failure.
  for (const p of all.reverse()) {
    try {
      summaries.push(summarizePlanRecord(p));
    } catch (err) {
      console.error('listPlans: unreadable plan record', err);
      summaries.push(unreadableRow(p));
    }
  }
  return summaries;
}

export async function getPlan(id: string): Promise<Plan | undefined> {
  const d = await db();
  const raw: unknown = await d.get('plans', id);
  if (raw === undefined) return undefined;
  const plan = migratePlan(raw);
  // Unreadable: `undefined` (the same answer as "no such plan") rather than a
  // throw, so every existing caller degrades to its own not-found path. The
  // record itself is left untouched — never deleted, never overwritten.
  if (plan === null) return undefined;
  // #54 spec §I.3: opportunistic write-back, so a record migrates once rather
  // than on every read. Only when the normaliser actually changed the stored
  // version, and best-effort — a failed write leaves a record that still
  // reads correctly, so it must not fail the read.
  if (readNumber(raw, 'schemaVersion') !== plan.schemaVersion) {
    try {
      await d.put('plans', plan);
    } catch (err) {
      console.error(`getPlan: migration write-back failed for ${plan.id}`, err);
    }
  }
  return plan;
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
