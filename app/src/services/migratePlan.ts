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
// test/sailLiteralCallSites.test.ts's ALLOWED list.
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
 * §I.3's relabelling rule is applied by ID EQUALITY, not positionally: a
 * legacy `genoa` field becomes the catalogue boat's sail whose id is `genoa`.
 * If that boat has no such sail the record is unreadable rather than
 * relabelled onto whatever sail happens to sit at the same index.
 */
function migrateSails(result: Record<string, unknown>, boat: BoatSnapshot): SailResult[] | null {
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
    const sail = boat.sails.find((s) => s.id === field);
    if (sail === undefined) return null;
    const migrated = sailResultOf(sail.id as SailId, result[field], result[`${field}Reason`]);
    if (migrated === null) return null;
    out.push(migrated);
  }
  return out.length > 0 ? out : null;
}

function migrateResult(result: Record<string, unknown>, boat: BoatSnapshot): PlanResultOk | null {
  if (result.status !== 'ok') return null;
  if (!isRecord(result.snappedOrigin) || !isRecord(result.snappedDestination)) return null;
  const sails = migrateSails(result, boat);
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

  // exactOptionalPropertyTypes: carry an absent optional as an absent KEY,
  // never as `undefined`.
  return {
    status: 'ok',
    sails,
    recommended: recommended as SailId,
    comparisonComplete,
    ...(result.shallow !== undefined ? { shallow: result.shallow as PlanResultOk['shallow'] } : {}),
    ...(result.rigRecommendation !== undefined
      ? { rigRecommendation: result.rigRecommendation as PlanResultOk['rigRecommendation'] }
      : {}),
    snappedOrigin: result.snappedOrigin as unknown as PlanResultOk['snappedOrigin'],
    snappedDestination: result.snappedDestination as unknown as PlanResultOk['snappedDestination'],
  } as PlanResultOk;
}

/**
 * A stored boat snapshot is kept verbatim — that is what lets a plan whose
 * boat has left the catalogue still open. Only its ABSENCE (the pre-#54
 * shape) relabels onto the catalogue's Salona 45. A snapshot that is present
 * but unparseable makes the record unreadable rather than silently reporting
 * a different hull: draftM drives the depth gate and the #53 relaxation
 * floor, so guessing it is a safety misstatement.
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
  const migratedResult = migrateResult(result, fallbackBoat);
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
