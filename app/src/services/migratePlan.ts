import { BOATS, boatById, DEFAULT_BOAT_ID } from '../data/boats';
import { NO_ROUTE_MESSAGE_KEY } from '../lib/plan';
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
  // The two fields the renderer DEREFERENCES rather than merely formats.
  // Checking only the container (an object with a usable id) admitted a
  // body-damaged result as a readable plan, and RouteSummary then reaches
  // `result.legs.length` on `undefined`. app/src carries no error boundary
  // and no window.onerror handler (grepped), so that TypeError unmounts the
  // React root — a white screen instead of the labelled unreadable
  // placeholder this normaliser exists to produce.
  //
  // Checked on EVERY sail, not just the recommended one: a damaged
  // non-recommended sail reaches the same dereference the moment the user
  // switches rig tabs.
  //
  // `distanceNm` and `motorDistanceNm` are here because `formatNm` is
  // `${nm.toFixed(1)} nm` — a DEREFERENCE, not a format — and both reach it
  // during render: resultSummary.ts:116 formats `result.distanceNm`, and
  // `summary.motorNm` is `result.motorDistanceNm` carried through RAW to
  // RouteSummary.tsx:469's unconditional `formatNm(summary.motorNm)`.
  // MEASURED by rendering RouteSummary with each field damaged four ways:
  // undefined / null / '3' all THROW for these two ("Cannot read properties
  // of undefined (reading 'toFixed')", "nm.toFixed is not a function"); only
  // NaN degrades to "NaN nm".
  //
  // The remaining two (durationMs, maneuverCount) are deliberately NOT
  // checked, and that is measured on the same run rather than assumed:
  // `formatDuration` does arithmetic (`Math.round(ms / 60_000)`) and
  // `maneuverCount` is rendered as a bare React child, so all four damage
  // shapes render for both. Do not widen this list to them, and do not
  // narrow it to `distanceNm` alone — `motorDistanceNm` is the neighbouring
  // input with the identical signature.
  //
  // The legs ARRAY is not enough on its own — see isLegShaped above for what
  // each element must carry and what it deliberately does not.
  if (!Number.isFinite(rest.etaMs)) return null;
  if (!Number.isFinite(rest.distanceNm)) return null;
  if (!Number.isFinite(rest.motorDistanceNm)) return null;
  if (!Array.isArray(rest.legs) || !rest.legs.every(isLegShaped)) return null;
  return { ...rest, sailId: id as SailId } as RigResult;
}

/**
 * The LEG fields a renderer reads a property OFF, i.e. the ones whose damage
 * is a TypeError rather than a wrong-looking number. `Array.isArray(legs)`
 * alone admitted `[null]` (RouteSummary's `(legs ?? []).filter((leg) =>
 * leg.shallow)` throws on it) and `[{}]` (the legs table calls `.toFixed` on
 * an absent number), and with no error boundary in app/src that unmounts the
 * React root — the white screen the container check exists to prevent,
 * reached one input over.
 *
 * Every UNCONDITIONALLY checked field is one of LegCommon's eight (plus the
 * `kind` discriminant), all present in `git show v0.1.0:app/src/types.ts`, so
 * this cannot refuse a record any released build wrote. `shallow` is the
 * exception and needs none: #53 added it, it is optional, and it is checked
 * only when present — a record predating it is unaffected.
 *
 * NOT CHECKED, deliberately and verifiably: `board`, `twaDeg` and
 * `maneuverAtStart`. A repo-wide scan for a property read off any of the
 * three (`\b(leg|l)\.(board|twaDeg|maneuverAtStart)\.[a-zA-Z]+`, run with
 * `shallow` added as a positive control, which found RouteSummary's
 * `leg.shallow.minDepthM`) returns nothing: they are interpolated into a
 * class name, used as a lookup key, passed to `Math.abs`, or compared. Damage
 * there renders a wrong label or a missing dot, never a throw.
 */
function isLegShaped(x: unknown): boolean {
  if (!isRecord(x)) return false;
  if (x.kind !== 'sail' && x.kind !== 'motor') return false;
  for (const k of [
    'startTimeMs',
    'endTimeMs',
    'headingDeg',
    'twsKn',
    'speedKn',
    'distanceNm',
  ] as const) {
    if (!Number.isFinite(x[k])) return false;
  }
  for (const point of [x.start, x.end]) {
    if (!isRecord(point) || !Number.isFinite(point.lat) || !Number.isFinite(point.lon))
      return false;
  }
  // Optional, so absence is fine — but a TRUTHY non-object passes
  // RouteSummary's `leg.shallow &&` guard and then reads `.minDepthM` off it,
  // which `.toFixed` throws on.
  if (x.shallow !== undefined) {
    if (!isRecord(x.shallow) || !Number.isFinite(x.shallow.minDepthM)) return false;
  }
  return true;
}

function sailResultOf(sailId: SailId, result: unknown, reason: unknown): SailResult | null {
  const rigResult = result === null || result === undefined ? null : normaliseRigResult(result);
  if (result !== null && result !== undefined && rigResult === null) return null;
  return {
    sailId,
    result: rigResult,
    reason:
      rigResult === null &&
      typeof reason === 'string' &&
      Object.hasOwn(NO_ROUTE_MESSAGE_KEY, reason)
        ? (reason as SailResult['reason'])
        : null,
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

  // #540: a record written between #259 (rigRecommendation shipped,
  // 2026-07-31 79ef507) and #553 (the not-compared fallback, 2026-08-18
  // bc295e2) can carry `rigRecommendation: { kind: 'decided' }` even though
  // one sail was cut short by the plan's wall-clock budget. Before #553,
  // planRoute.ts's ELSE branch — any solve that did NOT take the two-sail
  // compareRigs path, including a budget-exhausted sail — ALSO stamped
  // `decided`, not `not-compared`; #553 is what taught it to decline
  // instead. `comparisonComplete` shipped in between (2026-08-15 4547ced),
  // so a record from that window can carry a computed `comparisonComplete:
  // false` beside a `decided` verdict predating the fix that would have
  // suppressed it — a live star on a comparison the record's own flag says
  // never finished. A record with NO stored `rigRecommendation` at all
  // (pre-79ef507) is NOT this case: it predates `comparisonComplete`
  // (2026-08-15) AND the internal budget-exhaustion cause it derives from
  // (2026-08-07 b4c383f) entirely, so it cannot contain a budget-exhausted
  // sail — rigRecommendationOf()'s own `?? { kind: 'decided', ... }`
  // fallback correctly stars it, and that path is left untouched here.
  const storedRigRecommendation = result.rigRecommendation;
  const staleDecidedStar =
    isRecord(storedRigRecommendation) &&
    storedRigRecommendation.kind === 'decided' &&
    !comparisonComplete;

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
    ...(staleDecidedStar
      ? // #540: override the stale 'decided' verdict rather than pass it
        // through — see staleDecidedStar's own comment above for the window
        // this targets.
        { rigRecommendation: { kind: 'not-compared' } as const }
      : result.rigRecommendation !== undefined
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

// #551 review round 2 (two independent reviewers converged on this): the
// hazard this exists to prevent — planRoute.ts's polarFor throwing `#54: no
// polar table for ${key}` — is decided by `polarKey(deps.boat.id, sailId)`,
// where `deps.boat = boatById(catalogueBoatId(request.boat.id))`
// (protocol.ts + workerClient.ts's `catalogueBoatId`) — the CATALOGUE's OWN
// entry for this boat id. `polarFor` never consults the migrated
// `BoatSnapshot.sails` at all. So the authority a sailId must agree with is
// BOATS itself, not the record's self-reported `boat.sails` snapshot (which
// `migrateBoat` validates only structurally — id/label/polarProvenance
// shape, never against the catalogue): a foreign/imported record can claim a
// sail in `boat.sails` that the catalogue's SAME-id boat does not carry, and
// checking against the snapshot would let it straight through to the crash
// it exists to prevent.
//
// Deliberately inlined via `BOATS` (not `catalogueBoatId` from
// routing/workerClient.ts, which is the identical `BOATS.find(...)` lookup
// under a different name) — this file is a services/-layer read-time
// normaliser and has no existing dependency on routing/, and importing one
// pure lookup is not worth adding that edge.
//
// Returns null (not, say, an empty array) when `boatId` is off-catalogue:
// §I.3 requires a plan whose boat has left the catalogue to still open, and
// `RoutingClient.plan()` (workerClient.ts) already rejects an off-catalogue
// `request.boat.id` client-side as 'boat-not-in-catalogue' BEFORE `polarFor`
// is ever reached — so sailIds validity is moot for that case, and the null
// return is what makes `sailIsSafe` below pass everything unconditionally
// for it, rather than refusing an otherwise-honest pre-#54 or off-catalogue
// record.
function catalogueSailIds(boatId: string): readonly string[] | null {
  const catalogueBoat = BOATS.find((b) => b.id === boatId);
  return catalogueBoat ? catalogueBoat.sails.map((s) => s.id) : null;
}

function migrateRequest(
  request: Record<string, unknown>,
  sails: readonly SailResult[],
  recommended: SailId,
  fallbackBoat: BoatSnapshot,
  // #551 review round 2 fix-wave 2 (caught by the PRE-EXISTING
  // migratePlan.catalogueRename.test.ts, which round-2's first pass never
  // ran): whether `sails` was built from the MODERN `result.sails` array
  // (migrateSails' Array.isArray(stored) branch) as opposed to the LEGACY
  // `<rig>Reason` field pair. That distinction is exactly what
  // LEGACY_SAIL_FIELDS' own comment at the top of this file protects — a
  // pre-#54 record's sail ids are FROZEN HISTORY, deliberately never
  // resolved through the catalogue, so that a later catalogue rename cannot
  // make an already-stored record unreadable. The catalogue filter below
  // applies to the fallback reconstruction ONLY when this is true.
  sailsAreModernShape: boolean,
): PlanRequest | null {
  const boat = migrateBoat(request, fallbackBoat);
  if (boat === null) return null;
  if (typeof request.departureMs !== 'number') return null;
  // A pre-#54 request has no sailIds; the sails the plan actually compared,
  // in the order the result lists them, is the honest reconstruction of it.
  //
  // #551: the STORED sailIds is validated against `catalogueSailIds(boat.id)`
  // — see that function's own comment for WHY it is the catalogue and not
  // `boat.sails`. This branch is unconditionally safe to catalogue-check
  // regardless of legacy/modern: a pre-#54 record NEVER carries
  // `request.sailIds` at all (the field didn't exist yet), so
  // `storedSailIdsAreValid` is always false for one and this check is
  // simply never exercised by a legacy record.
  //
  // `typeof s === 'string'` is NOT redundant here even though `sailIsSafe`
  // looks like it would already reject a non-string entry: it does, but
  // ONLY when `catalogueSails !== null`. For an off-catalogue boat,
  // `sailIsSafe` returns true UNCONDITIONALLY (see catalogueSailIds'
  // comment), so without this term a non-string entry would slip through
  // in exactly that case. It also still licenses the `as SailId[]` cast
  // below. Pinned by 'typeof-string check rejects a non-string stored
  // sailId even for an off-catalogue boat' in migratePlan.test.ts (#551
  // review round 2 Minor 3 — the reviewer's own probe: this term reds 0/88
  // on its own for an ON-catalogue boat, and only the off-catalogue
  // combination separates the two readings).
  const catalogueSails = catalogueSailIds(boat.id);
  const sailIsSafe = (s: string): boolean => catalogueSails === null || catalogueSails.includes(s);
  const storedSailIdsAreValid =
    Array.isArray(request.sailIds) &&
    request.sailIds.length > 0 &&
    request.sailIds.every((s) => typeof s === 'string') &&
    request.sailIds.every((s) => sailIsSafe(s as string));
  // The FALLBACK reconstruction: catalogue-filtered ONLY for a modern-shape
  // `sails` list (#551 review round 2, MAJOR 2 — `migrateSails` validates a
  // modern entry's `sailId` only to be a string, zero catalogue check, so
  // this path was exactly as unguarded as the stored list). A legacy-shape
  // `sails` list is passed through UNFILTERED, preserving the frozen-history
  // guarantee `LEGACY_SAIL_FIELDS` exists for.
  const sailIds: readonly SailId[] = storedSailIdsAreValid
    ? (request.sailIds as SailId[])
    : sailsAreModernShape
      ? sails.map((s) => s.sailId).filter(sailIsSafe)
      : sails.map((s) => s.sailId);
  // #551 review round 3 MAJOR: whichever path produced `sailIds`, the
  // RECOMMENDED sail must be a MEMBER of it. Every replan/recalc path reads
  // `request.sailIds` — never `result.recommended` — to decide what to
  // re-solve (replan.ts, recalc.ts, reroute.ts), so a `sailIds` that has
  // silently dropped the recommended sail can never reproduce the
  // recommendation the UI is currently showing: the record would be
  // internally inconsistent in a way nothing downstream can detect.
  //
  // Fires on ANY path whose sailIds omits `recommended` — most reachably a
  // stored sailIds that simply disagrees with the stored result, with no
  // catalogue rename involved. On the LEGACY fallback it can never fire:
  // that branch is unfiltered and migrateResult already guarantees
  // `recommended` is among `sails`, so legacy records keep their
  // frozen-history readability while a modern record whose recommended sail
  // the catalogue filter drops is refused. The asymmetry is therefore
  // narrowed to a loud refusal instead of a silent desync, not removed.
  //
  // Subsumes the pre-existing "`sailIds` must be non-empty" requirement
  // rather than sitting beside it as a separate check: `recommended` is
  // always a real, non-empty SailId string (migrateResult already refuses
  // an invalid one), so `[].includes(recommended)` is always false — an
  // empty `sailIds` fails THIS check on its own, with no separate
  // `length === 0` branch needed. `[].every(...)`'s VACUOUS-TRUE trap
  // (which is why the STORED path's `length > 0` term above stays
  // separate) does not apply to `.includes`, which is false, not
  // vacuously true, on an empty array.
  if (!sailIds.includes(recommended)) return null;
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
  // Read straight off the RAW result, mirroring migrateSails' own dispatch
  // (`Array.isArray(stored)` on `result.sails`) — see migrateRequest's
  // `sailsAreModernShape` parameter comment for why this distinction must
  // survive into the fallback-reconstruction catalogue check.
  const sailsAreModernShape = Array.isArray(result.sails);
  const migratedRequest = migrateRequest(
    request,
    migratedResult.sails,
    migratedResult.recommended,
    fallbackBoat,
    sailsAreModernShape,
  );
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
