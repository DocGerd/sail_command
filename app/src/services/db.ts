import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { recommendedResult, type Plan, type Rig, type Settings } from '../types';

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

export interface PlanSummary {
  id: string;
  name: string;
  createdAtMs: number;
  departureMs: number;
  recommended: Rig;
  etaMs: number;
}

export async function savePlan(plan: Plan): Promise<void> {
  await (await db()).put('plans', plan);
}

export async function listPlans(): Promise<PlanSummary[]> {
  const all = await (await db()).getAllFromIndex('plans', 'by-createdAt');
  const summaries: PlanSummary[] = [];
  // Isolated per row: one corrupt/invariant-violating plan (recommendedResult
  // throws — see its own docstring in types.ts) must not blank out the
  // entire list for the user. Logged, not surfaced as a banner — this is a
  // pre-existing-data integrity issue a user can't act on beyond "some plan
  // somewhere is broken", not a transient failure worth a dismissible UI.
  for (const p of all.reverse()) {
    try {
      const rec = recommendedResult(p.result);
      summaries.push({
        id: p.id,
        name: p.name,
        createdAtMs: p.createdAtMs,
        departureMs: p.request.departureMs,
        recommended: p.result.recommended,
        etaMs: rec.etaMs,
      });
    } catch (err) {
      console.error(`listPlans: skipping corrupt plan ${p.id}`, err);
    }
  }
  return summaries;
}

export async function getPlan(id: string): Promise<Plan | undefined> {
  return (await db()).get('plans', id);
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
