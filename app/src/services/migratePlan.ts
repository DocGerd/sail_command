import { boatById, DEFAULT_BOAT_ID } from '../data/boats';
import {
  boatSnapshot,
  PLAN_SCHEMA_VERSION,
  type BoatSnapshot,
  type Plan,
  type PlanRequest,
  type PlanResultOk,
  type RigResult,
  type SailId,
  type SailResult,
  type WindGrid,
} from '../types';

/**
 * #54 spec §I.3: the lazy read-time normaliser for stored plan records.
 *
 * A PURE RELABELLING with zero recomputation — never re-plan, never re-derive
 * an ETA, never re-run the solver. The stored wind grid is stale by
 * definition and the result must keep rendering exactly as it was computed.
 * It therefore also stays inside the structured-clone domain: legs, wind grid
 * and snapped points are carried across BY REFERENCE, never through a JSON
 * round-trip, which would silently destroy WindGrid's Float32Array fields.
 *
 * Returns null for a record it cannot handle (a `schemaVersion` from a newer
 * build, a missing required field, a boat snapshot it cannot parse). A null
 * NEVER means "delete" — services/db.ts lists such a record as unreadable and
 * leaves the bytes untouched.
 */

// The pre-#54 PlanResultOk carried one RigResult per rig under a field NAMED
// after that rig, plus a `<rig>Reason` sibling. These names are frozen
// history rather than catalogue data: deriving them from BOATS would change
// how already-stored records are READ if the Salona's sail ids were ever
// renamed. Hence the literals here, and the deliberate entry for this file in
// test/sailLiteralCallSites.test.ts's ALLOWED list. Kept honest by
// migratePlan.catalogueRename.test.ts, which mocks a renamed catalogue and
// requires a pre-#54 record to still read.
const LEGACY_SAIL_FIELDS = ['genoa', 'fock'] as const;

// Public NoRouteReason for the internal 'budget-exhausted' cause. A pre-#54
// record predates PlanResultOk.comparisonComplete, so the flag is derived
// from the same condition planRoute.ts applies when it computes it.
const BUDGET_REASON = 'search-budget-exceeded';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Task 9 renamed RigResult.rig to .sailId. A record written before that
 * carries the old key; one written after already carries the new one. Strips
 * the old key rather than leaving both, so a migrated record has exactly the
 * current shape. Every other field — legs included — passes through by
 * reference, untouched.
 */
function normaliseRigResult(x: unknown): RigResult | null {
  if (!isRecord(x)) return null;
  const { rig, sailId, ...rest } = x;
  const id = typeof sailId === 'string' ? sailId : typeof rig === 'string' ? rig : null;
  if (id === null) return null;
  return { ...rest, sailId: id as SailId } as RigResult;
}

function sailResultOf(sailId: SailId, result: unknown, reason: unknown): SailResult | null {
  const rigResult = result === null || result === undefined ? null : normaliseRigResult(result);
  if (result !== null && result !== undefined && rigResult === null) return null;
  return {
    sailId,
    result: rigResult,
    reason:
      rigResult === null && typeof reason === 'string' ? (reason as SailResult['reason']) : null,
  };
}

/**
 * Reads the per-sail list out of either shape: a `sails` array (written since
 * Task 9) or the pre-#54 genoa/fock/genoaReason/fockReason quartet.
 *
 * The legacy field name IS the stored sail id, and it is carried straight
 * across. It is deliberately NOT looked up in the catalogue first: a lookup
 * would make every pre-#54 plan unreadable the moment a Salona sail id was
 * renamed, which is exactly the coupling LEGACY_SAIL_FIELDS' own comment says
 * this module does not have. That makes the `as SailId` cast the load-bearing
 * line — it is what carries a frozen historical id into the current union.
 */
function migrateSails(result: Record<string, unknown>): SailResult[] | null {
  const stored = result.sails;
  if (Array.isArray(stored)) {
    const out: SailResult[] = [];
    for (const entry of stored) {
      if (!isRecord(entry) || typeof entry.sailId !== 'string') return null;
      const migrated = sailResultOf(entry.sailId as SailId, entry.result, entry.reason);
      if (migrated === null) return null;
      out.push(migrated);
    }
    return out.length > 0 ? out : null;
  }
  const out: SailResult[] = [];
  for (const field of LEGACY_SAIL_FIELDS) {
    if (!(field in result)) continue;
    const migrated = sailResultOf(field as SailId, result[field], result[`${field}Reason`]);
    if (migrated === null) return null;
    out.push(migrated);
  }
  return out.length > 0 ? out : null;
}

function migrateResult(result: Record<string, unknown>): PlanResultOk | null {
  if (result.status !== 'ok') return null;
  if (!isRecord(result.snappedOrigin) || !isRecord(result.snappedDestination)) return null;
  const sails = migrateSails(result);
  if (sails === null) return null;

  // recommendedResult()'s invariant, enforced at the read boundary: status
  // 'ok' guarantees the recommended sail has a non-null result. A record that
  // violates it is unreadable, never a plan handed to the UI with an ETA the
  // renderer would have to fabricate.
  const recommended = result.recommended;
  if (typeof recommended !== 'string') return null;
  const winner = sails.find((s) => s.sailId === recommended);
  if (!winner?.result) return null;

  const comparisonComplete =
    typeof result.comparisonComplete === 'boolean'
      ? result.comparisonComplete
      : !sails.some((s) => s.result === null && s.reason === BUDGET_REASON);

  // ANNOTATED, never `... as PlanResultOk`. This literal enumerates the
  // fields it carries, so a future required field on PlanResultOk would be
  // silently stripped from every stored plan on read — and a trailing cast
  // compiles clean through exactly that, since `{a, b} as R` type-asserts
  // rather than type-checks. The annotation makes tsc the keeper; the
  // per-field casts stay, because each one narrows an `unknown` the
  // normaliser deliberately does not deep-validate.
  //
  // exactOptionalPropertyTypes: carry an absent optional as an absent KEY,
  // never as `undefined`.
  const out: PlanResultOk = {
    status: 'ok',
    sails,
    recommended: recommended as SailId,
    comparisonComplete,
    // NonNullable, not the bare indexed access: `PlanResultOk['shallow']`
    // includes `undefined`, which exactOptionalPropertyTypes rejects on an
    // optional key. The trailing cast this literal used to carry silenced
    // that; the annotation surfaced it.
    ...(result.shallow !== undefined
      ? { shallow: result.shallow as NonNullable<PlanResultOk['shallow']> }
      : {}),
    ...(result.rigRecommendation !== undefined
      ? {
          rigRecommendation: result.rigRecommendation as NonNullable<
            PlanResultOk['rigRecommendation']
          >,
        }
      : {}),
    snappedOrigin: result.snappedOrigin as unknown as PlanResultOk['snappedOrigin'],
    snappedDestination: result.snappedDestination as unknown as PlanResultOk['snappedDestination'],
  };
  return out;
}

/**
 * A stored boat snapshot is kept verbatim — that is what lets a plan whose
 * boat has left the catalogue still open. Only its ABSENCE (the pre-#54
 * shape) relabels onto the catalogue's Salona 45. A snapshot that is present
 * but unparseable makes the record unreadable rather than being replaced by
 * the catalogue's numbers. Three call sites read this snapshot and propagate
 * it into the next PlanRequest — lib/recalc.ts, state/replan.ts and
 * state/reroute.ts — so a substituted one does not stay put; it becomes what
 * the recalculated or rerouted plan claims its boat was. (The SOLVER is not
 * among them: it takes its boat from PlanDeps.boat, and nothing under
 * app/src/routing/** reads PlanRequest.boat.)
 *
 * The sail ENTRIES are validated too, not just the array: two of those three
 * call sites re-copy this object through boatSnapshot(), which reads
 * `s.polarProvenance.tier`, so an entry-shaped hole would surface there as a
 * TypeError rather than here as an honest unreadable row.
 */
function migrateBoat(
  request: Record<string, unknown>,
  fallback: BoatSnapshot,
): BoatSnapshot | null {
  const stored = request.boat;
  if (stored === undefined) return fallback;
  if (!isRecord(stored)) return null;
  if (typeof stored.id !== 'string' || typeof stored.name !== 'string') return null;
  if (typeof stored.draftM !== 'number' || !Number.isFinite(stored.draftM)) return null;
  if (!Array.isArray(stored.sails)) return null;
  for (const sail of stored.sails) {
    if (!isRecord(sail)) return null;
    if (typeof sail.id !== 'string' || typeof sail.label !== 'string') return null;
    if (!isRecord(sail.polarProvenance)) return null;
  }
  return stored as unknown as BoatSnapshot;
}

function migrateRequest(
  request: Record<string, unknown>,
  sails: readonly SailResult[],
  fallbackBoat: BoatSnapshot,
): PlanRequest | null {
  const boat = migrateBoat(request, fallbackBoat);
  if (boat === null) return null;
  if (typeof request.departureMs !== 'number') return null;
  // A pre-#54 request has no sailIds; the sails the plan actually compared,
  // in the order the result lists them, is the honest reconstruction of it.
  const sailIds =
    Array.isArray(request.sailIds) && request.sailIds.every((s) => typeof s === 'string')
      ? (request.sailIds as SailId[])
      : sails.map((s) => s.sailId);
  return { ...request, sailIds, boat } as unknown as PlanRequest;
}

export function migratePlan(raw: unknown): Plan | null {
  if (!isRecord(raw)) return null;

  // Explicit version dispatch rather than shape-sniffing (§I.3). An absent
  // tag is version 0: every record written before this task, whether by a
  // released build or by an interim develop one.
  const version = raw.schemaVersion === undefined ? 0 : raw.schemaVersion;
  if (typeof version !== 'number' || !Number.isFinite(version)) return null;
  if (version > PLAN_SCHEMA_VERSION) return null;

  const { id, name, createdAtMs, request, windGrid, result } = raw;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs)) return null;
  if (!isRecord(request) || !isRecord(windGrid) || !isRecord(result)) return null;

  const fallbackBoat = boatSnapshot(boatById(DEFAULT_BOAT_ID));
  const migratedResult = migrateResult(result);
  if (migratedResult === null) return null;
  const migratedRequest = migrateRequest(request, migratedResult.sails, fallbackBoat);
  if (migratedRequest === null) return null;

  return {
    id,
    name,
    createdAtMs,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: migratedRequest,
    // Carried by reference: the Float32Array fields survive only because
    // nothing here copies or serialises them. Deliberately not validated
    // field by field — that matches getPlan's pre-existing trust model for
    // records this app itself wrote.
    windGrid: windGrid as unknown as WindGrid,
    result: migratedResult,
  };
}
