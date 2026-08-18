/**
 * #54/Task 8: a canonicalising comparator for the PlanResultOk rename.
 *
 * The byte comparator (`compare.mjs`'s default mode) can certify that NOTHING
 * changed — it cannot certify that a DELIBERATE, presentation-only shape
 * change (Task 9: `genoa`/`fock`/`genoaReason`/`fockReason` -> a `sails` list,
 * `RigResult.rig` -> `sailId`) preserved every route. And it fails in the
 * REASSURING direction: `PlanResultError` carries no sail fields at all, so
 * the all-error `becalmed`/`deep-becalmed` arms stay byte-identical straight
 * through the rename and report IDENTICAL — a false green on two of the
 * sweep's nine arms.
 *
 * `canonicalizePlan(plan)` maps BOTH the pre-rename shape (named
 * genoa/fock/genoaReason/fockReason, `RigResult.rig`) and the post-rename
 * shape (a per-sail list, `RigResult.sailId`) onto ONE canonical form, so a
 * BASE plan and a HEAD plan carrying the same routes can be compared after
 * the rename.
 *
 * It deliberately does NOT normalise leg geometry, ETAs, distances or
 * reasons — only the CONTAINER shape (which field holds a rig's result, and
 * what that rig is called). Flattening any of the route content itself would
 * make every comparison pass regardless of whether the routes actually
 * matched, which is exactly the failure mode this file exists to avoid: a
 * canonicaliser that cannot fail is worse than none.
 *
 * STATED LIMIT — canonical mode is BLIND TO SAIL ORDER (#549). The `sails`
 * array is SORTED by `sailId` below, which is exactly what makes the
 * pre-rename and post-rename shapes comparable at all, and is therefore not a
 * defect to be fixed here. But it means two plans whose `sails` lists hold
 * identical entries in a DIFFERENT ORDER canonicalise to the same object and
 * compare IDENTICAL. That matters because `PlanRequest.sailIds` order is not
 * cosmetic: spec §E.3 makes it the SOLVE order, so reordering it changes
 * which sail solves first and which progress messages a plan reports. Two
 * things bound the exposure, and neither is this file:
 *
 *   1. The BYTE comparator (`compare.mjs`'s default mode) is NOT blind to it
 *      — a reordered `sails` array changes the serialised bytes. Canonical
 *      mode is the deliberately weaker check, used only to certify a
 *      known shape change.
 *   2. `recommended`, `comparisonComplete` and `rigRecommendation` all pass
 *      through in `rest`, UNSORTED, so an order change that actually altered
 *      the verdict (e.g. the `a.etaMs <= b.etaMs` tie-break in
 *      `planRoute.ts`'s `assemble`, which is position-dependent) still shows
 *      up. What canonical mode cannot see is a reordering that changed
 *      nothing BUT the order.
 *
 * So: certify a deliberate SAIL-ORDER change in byte mode, never in canonical
 * mode. Do not "fix" this by dropping the sort — that would break the rename
 * comparison this file exists to make possible.
 *
 * Every call returns a NEW object — the input plan (and any nested `sails`
 * array or `RigResult`) is never mutated. That matters here specifically
 * because `sweepArms.ts` writes a shared `rows` map that this comparator's
 * caller (`compare.mjs`) re-reads from disk (via `JSON.parse`, itself a
 * fresh copy) but is worth stating as an explicit contract rather than an
 * accident of how compare.mjs happens to call it.
 */

/**
 * Normalises one RigResult: `rig` (pre-rename) or `sailId` (post-rename)
 * becomes `sailId`, first key, with every OTHER field passed through
 * untouched (legs, etaMs, durationMs, distanceNm, maneuverCount,
 * motorDistanceNm — none of those are route content this file may alter).
 * `null` (the rig found no route) passes through as `null`.
 */
function normalizeRigResult(result) {
  if (result == null) return null;
  const { rig, sailId, ...rest } = result;
  return { sailId: sailId ?? rig, ...rest };
}

/**
 * Maps one PlanResult (either shape) onto the canonical form:
 *
 *   { ...everything else, comparisonComplete: true|false, sails: [...] }
 *
 * `sails` is always a per-sail list, sorted by `sailId`, each entry
 * `{ sailId, result: normalizeRigResult(result), reason }`.
 *
 * `PlanResultError` (`status !== 'ok'`) is returned as a shallow copy,
 * unchanged in shape — the rename touches only `PlanResultOk`, so an error
 * plan is already shape-stable across BASE and HEAD.
 */
export function canonicalizePlan(plan) {
  if (plan == null) return plan;
  if (plan.status !== 'ok') return { ...plan };

  const sails = plan.sails
    ? plan.sails.map((s) => ({
        sailId: s.sailId,
        result: normalizeRigResult(s.result),
        reason: s.reason ?? null,
      }))
    : [
        { sailId: 'genoa', result: normalizeRigResult(plan.genoa), reason: plan.genoaReason ?? null },
        { sailId: 'fock', result: normalizeRigResult(plan.fock), reason: plan.fockReason ?? null },
      ];

  // Exclude every field the two shapes disagree on by name from `rest` —
  // both the pre-rename fields (genoa/fock/genoaReason/fockReason) and the
  // post-rename ones (sails, comparisonComplete) — so `rest` carries only
  // fields both shapes already spell identically (status, recommended,
  // shallow?, rigRecommendation?, snappedOrigin, snappedDestination).
  const { genoa, fock, genoaReason, fockReason, sails: _sails, comparisonComplete, ...rest } = plan;

  return {
    ...rest,
    // `comparisonComplete` is NEW in Task 9 and absent from every pre-rename
    // plan on disk — default it to `true` (Task 9's shipped meaning: "both
    // sails were compared") rather than leaving BASE plans permanently
    // differing from HEAD on a field BASE never had.
    comparisonComplete: comparisonComplete ?? true,
    sails: sails.sort((a, b) => a.sailId.localeCompare(b.sailId)),
  };
}

/**
 * Maps one arm file's parsed contents (a harbour-id -> PlanResult record) to
 * its canonical form, ONE PLAN AT A TIME via `canonicalizePlan`, preserving
 * the INPUT's own key (harbour) insertion order — never sorted, never any
 * other side's order.
 *
 * That preservation is load-bearing, not incidental (fix round 1, #54
 * review): `compare.mjs`'s per-plan compare already iterates a SHARED
 * sorted key list, so it is order-independent by construction and cannot
 * see a harbour reordering either way. The whole-file digest is the ONLY
 * check in the harness that can — but only if each side is built from its
 * OWN on-disk order. An earlier version of `compare.mjs` built both sides
 * from the same shared sorted list, which made the canonical-mode digest
 * blind to a harbour-order swap (a real byte-mode-only regression,
 * reproduced: reversing one arm file's harbour order changed the byte
 * digest but left the canonical digest IDENTICAL). Call this once per side
 * with that side's OWN `JSON.parse` result — never pass a pre-sorted key
 * list or a shared object through it.
 */
/**
 * #553 / MAJOR 4 — the third comparison mode's two halves.
 *
 * WHY A THIRD MODE EXISTS. `rigRecommendation` is NOT in `canonicalizePlan`'s
 * `rest` exclusion list, so it passes through and is compared verbatim in
 * BOTH existing modes. A PR that deliberately changes that field therefore
 * has no mode that can certify it: byte and canonical both report a
 * difference per affected plan (MEASURED in review on `light-motorless`:
 * 12/33 differ in each mode, 0/33 with the field elided), and the only arms
 * reading IDENTICAL are `becalmed`/`deep-becalmed`, which §K already names as
 * vacuous — 33/33 errors, `assemble` never reached. Partial green from
 * exactly the arms that prove nothing is the failure §K warns about.
 *
 * "Ignore the field" ALONE would be a comparator that cannot fail: a HEAD
 * emitting `not-compared` on a fully-compared plan would sail through it. So
 * this is deliberately two assertions, and `compare.mjs` runs both.
 *
 * ORDER-SENSITIVE, unlike byte and canonical mode. `<dirA>` must be BASE and
 * `<dirB>` HEAD: half 2 asks a directional question ("did A's verdict become
 * B's in the one permitted way"), so swapping the arguments is a different
 * claim, not the same one.
 */

/** Half 1's subject: the plan with `rigRecommendation` removed. */
export function withoutRigRecommendation(plan) {
  if (plan == null || plan.status !== 'ok') return canonicalizePlan(plan);
  const { rigRecommendation: _rr, ...rest } = canonicalizePlan(plan);
  return rest;
}

/**
 * Half 2: is this plan's BASE -> HEAD verdict change one #553 permits?
 *
 * Returns `null` when the verdict did not change at all, otherwise a
 * `{ ok, why }` verdict. Permitted means ALL THREE of:
 *   - BASE was `{ kind: 'decided', rig: <any> }`,
 *   - HEAD is  `{ kind: 'not-compared' }`,
 *   - the HEAD plan really has FEWER THAN TWO non-null `sails[].result`, i.e.
 *     no comparison was available — which is the property that makes
 *     `not-compared` true rather than merely asserted.
 *
 * The third clause is the one that stops this from being a blanket ignore.
 * Read off HEAD's own `sails` via `canonicalizePlan`, so it works on either
 * container shape rather than assuming the post-rename one.
 */
export function classifyRigVerdictChange(planA, planB) {
  const ca = canonicalizePlan(planA);
  const cb = canonicalizePlan(planB);
  const ra = ca == null ? undefined : ca.rigRecommendation;
  const rb = cb == null ? undefined : cb.rigRecommendation;
  if (JSON.stringify(ra ?? null) === JSON.stringify(rb ?? null)) return null;

  if (!ra || ra.kind !== 'decided') {
    return { ok: false, why: `BASE verdict was ${JSON.stringify(ra ?? null)}, expected 'decided'` };
  }
  if (!rb || rb.kind !== 'not-compared') {
    return { ok: false, why: `HEAD verdict is ${JSON.stringify(rb ?? null)}, expected 'not-compared'` };
  }
  const solved = (cb.sails ?? []).filter((x) => x.result != null).length;
  if (solved >= 2) {
    return {
      ok: false,
      why: `HEAD says 'not-compared' but ${solved} sails produced a result — a comparison WAS available`,
    };
  }
  return { ok: true, why: `decided/${ra.rig} -> not-compared (${solved} solved)` };
}

export function canonicalizeArmFile(plansByHarbour) {
  const out = {};
  for (const k of Object.keys(plansByHarbour)) out[k] = canonicalizePlan(plansByHarbour[k]);
  return out;
}
