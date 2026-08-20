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
// never deleted. `name` and `createdAtMs` are read from the raw record where
// present, so an unreadable row identifies itself when the stored bytes
// still carry them — not for every shape, since either can be absent
// whichever case the row is (field presence is independent of `reason`,
// which comes from schemaVersion alone); everything else needs a plan the
// normaliser could actually produce, hence the discriminated union rather
// than nullable fields on one shape.
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

// #551 review round 2 (Minor 2, self-review, sharpened by an independent
// PWA-reviewer repro on the same line): the FALLBACK display id for a
// non-string primary key needs a serialization `String(key)` doesn't give.
// MEASURED live against openDB/fake-indexeddb by review: `String(12345)`
// and `String('12345')` are the same text; `String([1,2])` and
// `String(['1,2'])` are the same text (Array.prototype.join drops
// element-type information); `String([])` is `''`, colliding with a real
// empty-string id; and `Date#toString()` DROPS SUB-SECOND PRECISION, so two
// distinct same-second Date keys stringify identically.
function displayIdOfKey(key: unknown): string {
  // A STRING key passes through UNCHANGED, deliberately never
  // JSON.stringify'd. This is what makes a genuinely empty-string id
  // round-trip correctly: `storedId !== ''` (unreadableRow, below) is
  // false BOTH when raw.id is missing/non-string AND when raw.id really IS
  // the string '' — the two are indistinguishable from `storedId` alone,
  // so this function is reached for a legitimate empty-string id too, and
  // `key` for that record is exactly `''` (keyPath derives the key from
  // the id field). JSON.stringify('') is `'""'`, which would silently
  // change what a NEVER-BROKEN case displays.
  if (typeof key === 'string') return key;
  // Every OTHER IndexedDB key type gets JSON.stringify, which preserves
  // the structural differences String() drops: bracket/quote placement for
  // Array keys, and Date#toJSON()'s millisecond precision for Date keys —
  // closing the two collisions MEASURED above.
  //
  // NOT closed by this or any other key-only transform, and left as a
  // DOCUMENTED residual: a non-string key can still coincide, digit for
  // digit, with an UNRELATED real string id sitting on a DIFFERENT record
  // (e.g. numeric key 12345 vs a genuine string id '12345') — `readString`
  // returns a non-empty string id verbatim, which never reaches this
  // function at all, so no transform applied only HERE can prevent that
  // cross-path collision. Also unaddressed: an ArrayBuffer/typed-array key
  // (JSON.stringify degrades it to an opaque `{}`/index-keyed object).
  // Both are reachable only via a future importer or foreign writer
  // (#551's own framing) and are narrower than the original all-non-string
  // ids-collapse-to-'' defect this fix closes — fixing either would need a
  // distinguishing PREFIX on every fallback id, changing what the
  // overwhelmingly common (real string id) case displays: the
  // general-purpose key-identification scheme review said not to build.
  return JSON.stringify(key) ?? String(key);
}

// #551: readString(raw, 'id') returns '' for ANY non-string stored id —
// e.g. an imported (#3) or foreign-written record whose id is a number,
// since numbers are valid IndexedDB keys. Two such records, each with a
// DIFFERENT real primary key, both read '' from readString and would
// collide on React key and on delete target. `key` is the record's ACTUAL
// IndexedDB primary key (from listPlans' cursor, or undefined when this is
// exercised without an IndexedDB round trip per summarizePlanRecord's own
// doc comment) — used only as a fallback, so a record whose stored `id`
// really IS a usable string (the overwhelmingly common case, including a
// genuinely empty-string id) is unaffected.
function unreadableRow(raw: unknown, key?: unknown): PlanSummary {
  const storedId = readString(raw, 'id');
  return {
    kind: 'unreadable',
    // Read here rather than returned by migratePlan: the normaliser's own
    // answer is a single null by design, and this is the one caller that
    // needs to tell the two apart.
    reason: readNumber(raw, 'schemaVersion') > PLAN_SCHEMA_VERSION ? 'newer-version' : 'damaged',
    id: storedId !== '' ? storedId : key === undefined ? '' : displayIdOfKey(key),
    name: readString(raw, 'name'),
    createdAtMs: readNumber(raw, 'createdAtMs'),
  };
}

/** One stored record → one list row. Exported so the row shapes can be
 * exercised without an IndexedDB round trip. `key` is the record's real
 * IndexedDB primary key when known (see unreadableRow's comment) — pass it
 * whenever one is available; the 'ok' path never needs it, since
 * migratePlan already refuses any record whose `id` field isn't a string. */
export function summarizePlanRecord(raw: unknown, key?: unknown): PlanSummary {
  const plan = migratePlan(raw);
  if (plan === null) return unreadableRow(raw, key);
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
  //
  // #551: a CURSOR, not `getAll`, because getAll returns only VALUES — the
  // record's own `id` field, which readString collapses to '' for any
  // non-string primary key (see unreadableRow's comment). A cursor carries
  // the REAL primary key (`cursor.key`) alongside each value, and doing so
  // inside ONE transaction makes the (key, value) pairing atomic rather
  // than assumed — a separate getAll()+getAllKeys() pair would each open
  // their own transaction, leaving a window for a concurrent write to shift
  // one relative to the other.
  const all: { key: unknown; raw: unknown }[] = [];
  const tx = (await db()).transaction('plans', 'readonly');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    all.push({ key: cursor.key, raw: cursor.value });
    cursor = await cursor.continue();
  }
  await tx.done;
  // Newest first: createdAtMs descending, ties broken by id descending. That
  // reproduces the reversed index order for every record the index actually
  // returned AND whose ids are this app's own lowercase-hex
  // crypto.randomUUID()s, where locale collation and IndexedDB's code-unit
  // key order agree. It is deliberately not claimed as a general equivalence
  // — a future non-UUID id source could collate differently, and the records
  // the index omitted entirely (absent/NaN createdAtMs) now sort to the end
  // via readNumber's 0 fallback, which is the point of this hunk.
  const ordered = [...all].sort((a, b) => {
    const byDate = readNumber(b.raw, 'createdAtMs') - readNumber(a.raw, 'createdAtMs');
    return byDate !== 0 ? byDate : readString(b.raw, 'id').localeCompare(readString(a.raw, 'id'));
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
  for (const { key, raw } of ordered) {
    try {
      summaries.push(summarizePlanRecord(raw, key));
    } catch (err) {
      console.error('listPlans: unreadable plan record', err);
      summaries.push(unreadableRow(raw, key));
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
 * plans vanish from their Routes list — EVERY plan, unprompted, and until
 * that build is upgraded, which is the SAME duration as the ACCEPTED
 * RESIDUAL below: what separates the two is consent, not permanence. The
 * exact outcome §I.3 exists to remove. §I.3's rollback paragraph does not
 * cover this because it reasons about an older build that also has
 * migratePlan; production does not.
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

// #551 review round 2 (Minor 1, self-review — explicitly "in scope, not
// deferrable"): a plain `store.delete(id)` is a SILENT NO-OP for a
// non-string primary key, because IndexedDB key comparison is type-
// sensitive — the displayed id for such a row is a STRING (`'12345'`, from
// displayIdOfKey above), and it never equals the real numeric/Date/Array
// key it was derived from. Item 1's own acceptance criteria names the
// delete target alongside the React key, so fixing only the display
// collision leaves the row undeletable — worse than before in one respect:
// it now looks like a working control.
//
// The direct `getKey` + `delete` path stays first and is the one every
// real stored plan (a `crypto.randomUUID()` string id) takes — a cursor
// scan of the whole store on every delete would be a needless O(n) cost
// for the common case. Only when no record's REAL key equals `id` exactly
// does this fall back to a cursor scan matching by `displayIdOfKey`, the
// SAME serialization `unreadableRow` used to derive `id` in the first
// place — so a row a user can SEE is a row this can delete.
//
// Residual, matching displayIdOfKey's own documented gap: two distinct
// primary keys that happen to serialize to the same JSON text (the
// ArrayBuffer/typed-array case) would both match the scan and this deletes
// the FIRST one found — the same collision the display id already carries,
// not a new one this function introduces.
export async function deletePlan(id: string): Promise<void> {
  const store = (await db()).transaction('plans', 'readwrite').store;
  if ((await store.getKey(id)) !== undefined) {
    await store.delete(id);
    return;
  }
  let cursor = await store.openCursor();
  while (cursor) {
    if (displayIdOfKey(cursor.key) === id) {
      await cursor.delete();
      return;
    }
    cursor = await cursor.continue();
  }
}

export async function loadSettings(): Promise<Settings | undefined> {
  return (await db()).get('settings', 'user');
}

export async function saveSettings(s: Settings): Promise<void> {
  await (await db()).put('settings', s, 'user');
}
