import { describe, expect, it } from 'vitest';
import { migratePlan, validRigRecommendation } from './migratePlan';
import { DEFAULT_SETTINGS, PLAN_SCHEMA_VERSION, defaultBoatSnapshot } from '../types';

// The one leg literal in this file: legacyRigResult spreads it, and the
// damage rows below perturb copies of it. Declared before its first use, so
// there is no second copy to drift.
const HEALTHY_LEG: Record<string, unknown> = {
  kind: 'motor',
  board: null,
  start: { lat: 54.79, lon: 9.43 },
  end: { lat: 54.85, lon: 10.51 },
  startTimeMs: 1_700_003_600_000,
  endTimeMs: 1_700_007_200_000,
  headingDeg: 90,
  twsKn: 8,
  speedKn: 6.5,
  distanceNm: 12.5,
  maneuverAtStart: null,
};

// A record in the PRE-#54 shape: no schemaVersion, no request.boat, no
// request.sailIds, no result.comparisonComplete, one RigResult per rig under
// a field named after that rig with a `<rig>Reason` sibling, and RigResult
// carrying `rig` rather than Task 9's `sailId`. Deliberately typed as a bare
// record — it does not satisfy today's Plan, which is the point.
function legacyRigResult(rig: string, etaMs: number): Record<string, unknown> {
  return {
    rig,
    // A REALISTIC Leg, not a three-field stub: normaliseRigResult validates
    // every LegCommon field a renderer reads a property off (isLegShaped), so
    // a stub here would be refused for being unlike anything a released build
    // ever wrote rather than for anything this suite is about. Spread from
    // HEALTHY_LEG rather than repeated, so the damage rows below cannot drift
    // away from the leg this fixture actually carries.
    legs: [{ ...HEALTHY_LEG }],
    etaMs,
    durationMs: 3_600_000,
    distanceNm: 12.5,
    maneuverCount: 2,
    motorDistanceNm: 1.5,
  };
}

function legacyWindGrid(): Record<string, unknown> {
  return {
    lats: [54.0, 54.5],
    lons: [9.0, 9.5],
    timesMs: [1000, 2000],
    speedKn: new Float32Array([5, 6, 7, 8, 9, 10, 11, 12]),
    dirFromDeg: new Float32Array([90, 91, 92, 93, 94, 95, 96, 97]),
    gustKn: new Float32Array([7, 8, 9, 10, 11, 12, 13, 14]),
    fetchedAtMs: 1_626_340_800_000,
    model: 'open-meteo',
  };
}

function legacyPlan(): Record<string, unknown> {
  return {
    id: 'legacy-1',
    name: 'Flensburg → Marstal',
    createdAtMs: 1_700_000_000_000,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.85, lon: 10.51 },
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'marstal',
      departureMs: 1_700_003_600_000,
      settings: { ...DEFAULT_SETTINGS },
    },
    windGrid: legacyWindGrid(),
    result: {
      status: 'ok',
      genoa: legacyRigResult('genoa', 111_000),
      fock: legacyRigResult('fock', 222_000),
      genoaReason: null,
      fockReason: null,
      recommended: 'genoa',
      rigRecommendation: { kind: 'decided', rig: 'genoa' },
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.85, lon: 10.51 },
    },
  };
}

describe('#54 migratePlan: pre-#54 records', () => {
  it('relabels an old plan onto the Salona 45', () => {
    const migrated = migratePlan(legacyPlan());
    expect(migrated).not.toBeNull();
    expect(migrated!.request.boat.id).toBe('salona-45');
    expect(migrated!.request.boat.name).toBe('Salona 45');
    expect(migrated!.request.boat.draftM).toBe(2.1);
    expect(migrated!.schemaVersion).toBe(PLAN_SCHEMA_VERSION);
  });

  it('lists the sails in the order the legacy record solved them, each carrying its own result', () => {
    const migrated = migratePlan(legacyPlan())!;
    expect(migrated.result.sails.map((s) => s.sailId)).toEqual(['genoa', 'fock']);
    expect(migrated.result.sails[0]!.result!.etaMs).toBe(111_000);
    expect(migrated.result.sails[1]!.result!.etaMs).toBe(222_000);
  });

  // A pure relabelling. The pinned ETA literals above are already
  // unsatisfiable by a re-solve; this adds the stronger form — a recomputed
  // route would allocate a NEW legs array, so carrying the stored one by
  // reference proves nothing was re-planned even if the numbers happened to
  // come out the same.
  it('carries every leg across BY REFERENCE — never re-plans, never re-derives', () => {
    const raw = legacyPlan();
    const legacyLegs = ((raw.result as Record<string, unknown>).genoa as Record<string, unknown>)
      .legs;
    const migrated = migratePlan(raw)!;
    expect(migrated.result.sails[0]!.result!.legs).toBe(legacyLegs);
  });

  it('preserves the wind grid as the SAME Float32Array-carrying object (structured-clone domain)', () => {
    const raw = legacyPlan();
    const migrated = migratePlan(raw)!;
    expect(migrated.windGrid).toBe(raw.windGrid);
    expect(migrated.windGrid.speedKn).toBeInstanceOf(Float32Array);
    expect(migrated.windGrid.speedKn[0]).toBe(5);
  });

  it('renames RigResult.rig to sailId and leaves no stale key behind', () => {
    const migrated = migratePlan(legacyPlan())!;
    const first = migrated.result.sails[0]!.result!;
    expect(first.sailId).toBe('genoa');
    expect('rig' in first).toBe(false);
  });

  // `[].every(...)` is VACUOUSLY TRUE, so an empty stored list used to be
  // taken as authoritative and skip the reconstruction below entirely. It is
  // neither nullish nor falsy, so none of the `?? DEFAULT_SAIL_IDS` backfills
  // downstream catches it either, and planRoute's `runAll` maps over it —
  // every tier came back `[]` and the plan-level cause assertion threw a bare
  // TypeError inside the worker, surfacing as the generic routing-failed
  // banner with nothing pointing at the stored record.
  it('rebuilds an EMPTY stored sailIds from the sails the plan actually compared', () => {
    const raw = legacyPlan();
    (raw.request as Record<string, unknown>).sailIds = [];
    expect(migratePlan(raw)!.request.sailIds).toEqual(['genoa', 'fock']);
  });

  it('reconstructs sailIds from the sails the plan actually compared', () => {
    const migrated = migratePlan(legacyPlan())!;
    expect(migrated.request.sailIds).toEqual(['genoa', 'fock']);
  });

  // #551 review round 2 (two independent reviewers): a stored sailIds used
  // to be accepted verbatim whenever it was a non-empty array of strings,
  // with NO cross-check at all — so a foreign or stale sailId reached
  // planRoute.ts's polarFor, which throws "#54: no polar table for ${key}".
  // The FIRST round of this fix checked against the migrated boat
  // snapshot's own `boat.sails` — but `polarFor` resolves polars against
  // `boatById(catalogueBoatId(boat.id))`, the CATALOGUE's own entry for
  // that id, never `boat.sails`. This test is that gap: a real catalogue
  // boat.id whose SELF-REPORTED `boat.sails` (falsely) includes a sail no
  // catalogue boat carries — checking `boat.sails` alone would have
  // accepted it.
  it('rejects a stored sailIds naming a sail the CATALOGUE does not have for this boat.id, even when the self-reported boat.sails claims it (#551 review round 2)', () => {
    const raw = legacyPlan();
    const request = raw.request as Record<string, unknown>;
    request.boat = {
      id: 'salona-45',
      name: 'Salona 45',
      draftM: 2.1,
      sails: [
        { id: 'genoa', label: 'Genoa 135 %', polarProvenance: { tier: 'modelled', note: 'n' } },
        // Real catalogue salona-45 has genoa+fock only — 'spinnaker' is
        // foreign to EVERY catalogue boat, self-reported here anyway.
        { id: 'spinnaker', label: 'Spinnaker', polarProvenance: { tier: 'estimated', note: 'n' } },
      ],
    };
    request.sailIds = ['genoa', 'spinnaker'];
    const migrated = migratePlan(raw)!;
    // Rejected wholesale — reconstructed from the sails the plan actually
    // compared (legacyPlan()'s genoa+fock), filtered against the
    // CATALOGUE, where both are real.
    expect(migrated.request.sailIds).toEqual(['genoa', 'fock']);
  });

  // #551 review round 2, MAJOR 2: the FALLBACK reconstruction was never
  // cross-checked at all — `sails.map(s => s.sailId)` comes straight from
  // `migrateSails`, which validates a `sailId` only to be a string, with
  // zero catalogue check. So rejecting a bad stored list could still hand
  // the SAME foreign sail back through the fallback. Forces the fallback
  // path (no stored sailIds at all — the pre-#54 shape) with a THIRD,
  // catalogue-foreign sail ('spinnaker') present only in the RESULT's own
  // (modern-shape) sails list, alongside two genuinely real ones.
  it('filters the fallback reconstruction against the catalogue too — a rejected foreign sail cannot come back through it (#551 review round 2, MAJOR 2)', () => {
    const raw = legacyPlan();
    const request = raw.request as Record<string, unknown>;
    const result = raw.result as Record<string, unknown>;
    delete result.genoa;
    delete result.fock;
    delete result.genoaReason;
    delete result.fockReason;
    result.sails = [
      { sailId: 'genoa', result: legacyRigResult('genoa', 111_000), reason: null },
      { sailId: 'fock', result: null, reason: 'unreachable' },
      { sailId: 'spinnaker', result: null, reason: 'unreachable' },
    ];
    result.recommended = 'genoa';
    // Self-consistent, catalogue-agreeing boat.sails — the FIRST-round
    // `boat.sails` check would have missed this entirely, since the
    // foreign sail is visible only through the RESULT's sails list.
    request.boat = {
      id: 'salona-45',
      name: 'Salona 45',
      draftM: 2.1,
      sails: [
        { id: 'genoa', label: 'Genoa 135 %', polarProvenance: { tier: 'modelled', note: 'n' } },
        { id: 'fock', label: 'Jib 110 %', polarProvenance: { tier: 'certificate', note: 'n' } },
      ],
    };
    // No stored sailIds — forces the fallback reconstruction.
    delete request.sailIds;
    const migrated = migratePlan(raw)!;
    // 'spinnaker' is dropped by the fallback's own catalogue filter.
    expect(migrated.request.sailIds).toEqual(['genoa', 'fock']);
  });

  // #551 review round 2, Minor 3 (the reviewer's own probe): pins that
  // `typeof s === 'string'` is load-bearing for an OFF-CATALOGUE boat,
  // where `sailIsSafe` alone would pass ANY value unconditionally —
  // including a non-string one. Off-catalogue boat id ('gone-45', not in
  // BOATS, so `catalogueSailIds` returns null) + a raw NUMBER inside the
  // stored sailIds array: with the term present this is rejected (typeof
  // check fails) and falls to the unfiltered legacy reconstruction.
  //
  // MUTATION-CHECKED (deleting the term, restored after): the raw number
  // does NOT simply "survive into request.sailIds" as `sailIsSafe(12345)`
  // alone would suggest — `storedSailIdsAreValid` does go true and
  // `sailIds` does become `[12345]`, but review round 3's OWN
  // `!sailIds.includes(recommended)` invariant then catches it one line
  // later (12345 !== 'genoa') and refuses the whole record, so the
  // observed mutant behaviour is `migratePlan(raw) === null`, not a
  // shipped numeric sailId. Both are wrong outcomes for a valid off-
  // catalogue record; this test pins the CORRECT one (term present).
  it('typeof-string check rejects a non-string stored sailId even for an off-catalogue boat, where sailIsSafe alone would pass anything (#551 review round 2 Minor 3)', () => {
    const raw = legacyPlan();
    const request = raw.request as Record<string, unknown>;
    request.boat = {
      id: 'gone-45',
      name: 'Gone 45',
      draftM: 2.4,
      sails: [
        { id: 'genoa', label: 'Genoa 150 %', polarProvenance: { tier: 'estimated', note: 'n' } },
      ],
    };
    request.sailIds = [12345];
    const migrated = migratePlan(raw)!;
    // Rejected — falls to the (unfiltered, off-catalogue) legacy
    // reconstruction, never the raw number.
    expect(migrated.request.sailIds).toEqual(['genoa', 'fock']);
  });

  it('carries a per-sail no-route reason across from its <rig>Reason sibling', () => {
    const raw = legacyPlan();
    const result = raw.result as Record<string, unknown>;
    result.fock = null;
    result.fockReason = 'unreachable';
    const migrated = migratePlan(raw)!;
    expect(migrated.result.sails[1]).toEqual({
      sailId: 'fock',
      result: null,
      reason: 'unreachable',
    });
  });

  it('#614: falls back to null for a stored reason outside the NoRouteReason union', () => {
    const raw = legacyPlan();
    const result = raw.result as Record<string, unknown>;
    result.fock = null;
    result.fockReason = 'route-teleported-to-mars';
    const migrated = migratePlan(raw)!;
    expect(migrated.result.sails[1].reason).toBe(null);
  });

  // #614 follow-up (review finding): `in` walks the PROTOTYPE CHAIN, so
  // every OWN name of Object.prototype is `in NO_ROUTE_MESSAGE_KEY` even
  // though none is an OWN key of it — `NO_ROUTE_MESSAGE_KEY` is a plain
  // object literal, so it inherits Object.prototype's own members. A guard
  // written as `reason in NO_ROUTE_MESSAGE_KEY` therefore lets each of these
  // cast straight through, reproducing #614 with a different sentinel: the
  // cast value coerces to a non-message (a function, for `toString`), `t()`
  // resolves nothing, and the alert renders empty again. `Object.hasOwn`
  // checks OWN properties only, so all of them must fall back to null.
  //
  // Sourced from Object.getOwnPropertyNames(Object.prototype) itself, not a
  // hand-copied list, so needle (the JS engine's own member set) and
  // haystack (the production guard) stay independent and the table cannot
  // silently go stale or be emptied without the suite noticing (the
  // SOLVER_LABELS shape from #411's review: a hardcoded list has no twin and
  // can be stubbed to `[]` while the guard keeps reporting green).
  it.each(Object.getOwnPropertyNames(Object.prototype))(
    '#614 follow-up: falls back to null for the Object.prototype member %s',
    (name) => {
      const raw = legacyPlan();
      const result = raw.result as Record<string, unknown>;
      result.fock = null;
      result.fockReason = name;
      const migrated = migratePlan(raw)!;
      expect(migrated.result.sails[1].reason).toBe(null);
    },
  );

  // #614 follow-up (review Minor 4): types.ts documents reason as null
  // EXACTLY when the sail has a result. genoa here already carries a real
  // RigResult from legacyPlan() — stamp a stored reason alongside it (as a
  // corrupted or pre-#54 record might) and confirm the migration still
  // drops it. Deleting the `rigResult === null` guard term alone (leaving
  // the membership check intact) would let both survive together, silently
  // violating that invariant.
  it('#614 follow-up: reason stays null when the sail already has a result', () => {
    const raw = legacyPlan();
    const result = raw.result as Record<string, unknown>;
    result.genoaReason = 'unreachable';
    const migrated = migratePlan(raw)!;
    expect(migrated.result.sails[0]!.reason).toBe(null);
  });

  it('derives comparisonComplete: true when every sail finished its search', () => {
    expect(migratePlan(legacyPlan())!.result.comparisonComplete).toBe(true);
  });

  it('derives comparisonComplete: false when a sail was cut short by the budget', () => {
    const raw = legacyPlan();
    const result = raw.result as Record<string, unknown>;
    result.fock = null;
    result.fockReason = 'search-budget-exceeded';
    expect(migratePlan(raw)!.result.comparisonComplete).toBe(false);
  });

  // #540: the target window between #259 (rigRecommendation shipped,
  // 2026-07-31 79ef507) and #553 (the not-compared fallback, 2026-08-18
  // bc295e2) — a record whose stored `rigRecommendation` is `{kind:
  // 'decided'}` (legacyPlan()'s own fixture, unchanged since it predates
  // #553's fix) alongside a DERIVED comparisonComplete: false (this record
  // has no stored comparisonComplete field either, so it takes the same
  // derived path the row above exercises). The stale 'decided' verdict must
  // be overridden to 'not-compared', never passed through as a live star on
  // a comparison that never finished.
  it('#540: overrides a stale decided verdict to not-compared when the derived comparisonComplete is false', () => {
    const raw = legacyPlan();
    const result = raw.result as Record<string, unknown>;
    result.fock = null;
    result.fockReason = 'search-budget-exceeded';
    expect(result.rigRecommendation).toEqual({ kind: 'decided', rig: 'genoa' });
    const migrated = migratePlan(raw)!;
    expect(migrated.result.comparisonComplete).toBe(false);
    expect(migrated.result.rigRecommendation).toEqual({ kind: 'not-compared' });
  });

  // Discriminating control for the row above: the SAME stored 'decided'
  // verdict, but comparisonComplete stays true (no sail cut short by the
  // budget) — legacyPlan()'s unmodified shape. The override must NOT fire
  // here; the stored verdict passes through unchanged, matching every other
  // 'records this build already understands' expectation.
  it('#540: leaves a decided verdict unchanged when comparisonComplete is true', () => {
    const migrated = migratePlan(legacyPlan())!;
    expect(migrated.result.comparisonComplete).toBe(true);
    expect(migrated.result.rigRecommendation).toEqual({ kind: 'decided', rig: 'genoa' });
  });

  // #540: a record with an EXPLICIT stored comparisonComplete: false (the
  // post-4547ced, pre-#553 window — a narrower slice of the same target
  // window, where the flag is read directly rather than derived) must get
  // the same override.
  it('#540: overrides a stale decided verdict when comparisonComplete is stored explicitly as false', () => {
    const raw = legacyPlan();
    const result = raw.result as Record<string, unknown>;
    result.comparisonComplete = false;
    const migrated = migratePlan(raw)!;
    expect(migrated.result.rigRecommendation).toEqual({ kind: 'not-compared' });
  });

  it('leaves the input record untouched', () => {
    const raw = legacyPlan();
    const before = JSON.stringify({ id: raw.id, request: raw.request, result: raw.result });
    migratePlan(raw);
    expect(JSON.stringify({ id: raw.id, request: raw.request, result: raw.result })).toBe(before);
  });

  // exactOptionalPropertyTypes: an absent optional must stay an absent KEY.
  it('omits an absent optional rather than setting it to undefined', () => {
    const raw = legacyPlan();
    delete (raw.result as Record<string, unknown>).rigRecommendation;
    const migrated = migratePlan(raw)!;
    expect('shallow' in migrated.result).toBe(false);
    expect('rigRecommendation' in migrated.result).toBe(false);
  });
});

// #661: an unrecognised stored `rigRecommendation.kind` used to be cast
// straight through unchecked (`result.rigRecommendation as NonNullable<...>`)
// and reach lib/resultSummary.ts's rigVerdictKey exhaustiveness switch as a
// bogus MsgKey — that switch's `never`-typed default arm is a BUILD-TIME-ONLY
// guarantee (erasableSyntaxOnly strips it at runtime), and useT() (a bare
// `dicts[lang][key]` lookup with no existence check) renders an absent key
// as nothing at all. See migratePlan.ts's validRigRecommendation for the
// full mechanism, including why simply OMITTING a present-but-invalid field
// is not the safe fallback it looks like: rigRecommendationOf's
// `?? { kind: 'decided', rig: result.recommended }` fallback exists for a
// genuinely pre-#259 record that never had the field, and would fabricate a
// verdict for a record that DID once carry a real, now-corrupted one —
// exactly what ADR-0002 forbids. Every row below degrades to 'not-compared'
// instead, the one RigRecommendation member that makes no comparative claim.
describe('#661 migratePlan: rigRecommendation.kind is validated, never passed through unchecked', () => {
  it('degrades an unrecognised kind to not-compared rather than passing it through unchecked', () => {
    const raw = legacyPlan();
    (raw.result as Record<string, unknown>).rigRecommendation = { kind: 'somehow-corrupted' };
    const migrated = migratePlan(raw)!;
    expect(migrated.result.rigRecommendation).toEqual({ kind: 'not-compared' });
  });

  // Isolates the `isRecord` term: `null` is present (not undefined, so this
  // does not take the 'genuinely absent' path below) but is not a record —
  // `.kind` on `null` throws if that guard is ever deleted, rather than
  // silently misreading as an unrecognised kind.
  it('degrades a non-record stored value (null) rather than throwing or passing it through', () => {
    const raw = legacyPlan();
    (raw.result as Record<string, unknown>).rigRecommendation = null;
    const migrated = migratePlan(raw)!;
    expect(migrated.result.rigRecommendation).toEqual({ kind: 'not-compared' });
  });

  // Isolates the decided/rig term: a recognised `kind` whose `rig` is
  // missing (not a string), which would otherwise mint `{ kind: 'decided',
  // rig: undefined }` — a fabricated star on an undefined "winner".
  it('degrades a "decided" verdict with a missing/non-string rig rather than passing it through', () => {
    const raw = legacyPlan();
    (raw.result as Record<string, unknown>).rigRecommendation = { kind: 'decided' };
    const migrated = migratePlan(raw)!;
    expect(migrated.result.rigRecommendation).toEqual({ kind: 'not-compared' });
  });

  // Positive controls: every EXISTING, well-formed verdict must still pass
  // through unchanged — the validator must not over-reject a genuine record.
  it.each([
    ['decided', { kind: 'decided', rig: 'fock' }],
    ['tie', { kind: 'tie' }],
    ['moot', { kind: 'moot' }],
    ['not-compared', { kind: 'not-compared' }],
  ])('leaves a well-formed %s verdict unchanged', (_label, verdict) => {
    const raw = legacyPlan();
    (raw.result as Record<string, unknown>).rigRecommendation = verdict;
    const migrated = migratePlan(raw)!;
    expect(migrated.result.rigRecommendation).toEqual(verdict);
  });

  // This fix touches only the PRESENT-but-invalid branch — a genuinely
  // absent field must still omit the key (unchanged from the pre-existing
  // 'omits an absent optional' test above), never get stamped to
  // not-compared, so rigRecommendationOf's pre-#259 fallback still fires
  // for the record it is designed for.
  it('still omits a genuinely absent rigRecommendation rather than stamping not-compared onto it', () => {
    const raw = legacyPlan();
    delete (raw.result as Record<string, unknown>).rigRecommendation;
    const migrated = migratePlan(raw)!;
    expect('rigRecommendation' in migrated.result).toBe(false);
  });
});

// #661 review MINOR A: the it.each 'not-compared' row above (line ~439)
// exercises migratePlan()'s RENDERED output, and that output is byte-identical
// whether validRigRecommendation's own `case 'not-compared'` arm returns
// `{ kind: 'not-compared' }` OR `null` — the call site's `?? { kind:
// 'not-compared' }` fallback (migrateResult) silently substitutes the exact
// same value either way. MEASURED: mutating that one arm to `return null`
// left every existing #661/#54/#654 test GREEN (100/100). These two tests
// bypass the call site and assert on validRigRecommendation's OWN return
// value, so the arm is provably covered rather than merely shadowed by the
// fallback around it. The other three arms ('decided'/'tie'/'moot') do NOT
// share this gap — their correct return value differs from the fallback's
// substitute, so the existing it.each rows above already discriminate them
// (reviewer-verified: mutating any of those three to `return null` reds its
// own positive-control row, because migratePlan() then returns
// `{ kind: 'not-compared' }` where the test expects the real verdict).
describe('#661 validRigRecommendation: direct unit tests (closes the not-compared coverage gap)', () => {
  it('returns { kind: "not-compared" } for a well-formed not-compared record — the row the call-site fallback shadows', () => {
    expect(validRigRecommendation({ kind: 'not-compared' })).toEqual({ kind: 'not-compared' });
  });

  it('returns null (not a fabricated verdict) for an unrecognised kind', () => {
    expect(validRigRecommendation({ kind: 'somehow-corrupted' })).toBeNull();
  });
});

describe('#54 migratePlan: records this build already understands', () => {
  it('passes a current-version record through with its boat snapshot intact', () => {
    const raw = migratePlan(legacyPlan())!;
    const again = migratePlan(raw)!;
    expect(again.schemaVersion).toBe(PLAN_SCHEMA_VERSION);
    expect(again.request.boat).toEqual(raw.request.boat);
    expect(again.result.sails).toEqual(raw.result.sails);
  });

  // The interim shape written on this branch between Tasks 9 and 11: a
  // `sails` list and `sailIds` already, but no boat and no schemaVersion.
  it('backfills only the boat on a record that already carries a sails list', () => {
    const raw = migratePlan(legacyPlan())! as unknown as Record<string, unknown>;
    delete raw.schemaVersion;
    delete (raw.request as Record<string, unknown>).boat;
    const migrated = migratePlan(raw)!;
    expect(migrated.request.boat.id).toBe('salona-45');
    expect(migrated.result.sails.map((s) => s.sailId)).toEqual(['genoa', 'fock']);
  });

  // §I.3: "A saved plan referencing a boat no longer in the catalogue still
  // opens, still renders, still exports GPX, and still shows its original
  // boat and sail names and provenance." This row covers the DATA half — the
  // snapshot survives the read — not the GPX export, which nothing here
  // exercises.
  it('keeps a stored snapshot of a boat that has left the catalogue, verbatim', () => {
    const gone = {
      id: 'gone-45',
      name: 'Gone 45',
      draftM: 2.4,
      sails: [
        { id: 'genoa', label: 'Genoa 150 %', polarProvenance: { tier: 'estimated', note: 'n' } },
      ],
    };
    const raw = migratePlan(legacyPlan())! as unknown as Record<string, unknown>;
    (raw.request as Record<string, unknown>).boat = gone;
    const migrated = migratePlan(raw)!;
    expect(migrated.request.boat).toEqual(gone);
    expect(migrated.request.boat.draftM).toBe(2.4);
  });
});

describe('#54 migratePlan: records it refuses, so they can be listed as unreadable', () => {
  it('refuses a schemaVersion from a newer build', () => {
    expect(migratePlan({ ...legacyPlan(), schemaVersion: PLAN_SCHEMA_VERSION + 1 })).toBeNull();
  });

  it.each([
    ['not an object', 42],
    ['an array', []],
    ['null', null],
  ])('refuses %s', (_label, raw) => {
    expect(migratePlan(raw)).toBeNull();
  });

  it.each(['id', 'name', 'createdAtMs', 'request', 'windGrid', 'result'])(
    'refuses a record missing %s',
    (field) => {
      const raw = legacyPlan();
      delete raw[field];
      expect(migratePlan(raw)).toBeNull();
    },
  );

  // recommendedResult()'s invariant, enforced at the read boundary rather
  // than left to throw inside the renderer.
  it('refuses a record whose recommended sail has no result', () => {
    const raw = legacyPlan();
    const result = raw.result as Record<string, unknown>;
    result.genoa = null;
    result.genoaReason = 'unreachable';
    expect(migratePlan(raw)).toBeNull();
  });

  // A NaN version is `typeof 'number'`, so only the Number.isFinite half of
  // the version guard rejects it — without it, NaN > 1 is false and the
  // record would be accepted as legacy.
  it('refuses a non-finite schemaVersion', () => {
    expect(migratePlan({ ...legacyPlan(), schemaVersion: Number.NaN })).toBeNull();
  });

  // Without this guard the sail silently becomes {result: null, reason: null}
  // — a FABRICATED "no route, cause unknown" rather than an honest unreadable
  // row.
  it('refuses a stored sail result that is neither null nor an object', () => {
    const raw = legacyPlan();
    (raw.result as Record<string, unknown>).fock = 42;
    expect(migratePlan(raw)).toBeNull();
  });

  // The malformed entry is the NON-recommended one, and a valid recommended
  // entry is kept beside it. Put the malformed entry first and the row passes
  // for the wrong reason: whatever the entry-shape guard does, the
  // recommended sail then has no result and the recommended-invariant guard
  // refuses the record on its own. Measured — an earlier version of this row
  // stayed green with the entry-shape guard deleted.
  it.each([
    ['a non-record entry', 1],
    ['an entry with no sailId', { result: null, reason: null }],
  ])('refuses a sails list containing %s', (_label, badEntry) => {
    const raw = migratePlan(legacyPlan())! as unknown as Record<string, unknown>;
    const result = raw.result as Record<string, unknown>;
    const recommendedEntry = (result.sails as unknown[])[0];
    result.sails = [recommendedEntry, badEntry];
    expect(migratePlan(raw)).toBeNull();
  });

  it.each(['snappedOrigin', 'snappedDestination'])('refuses a record missing %s', (field) => {
    const raw = legacyPlan();
    delete (raw.result as Record<string, unknown>)[field];
    expect(migratePlan(raw)).toBeNull();
  });

  // Without this guard summarizePlanRecord emits departureMs: undefined and
  // the Routes list renders "Invalid Date".
  it('refuses a request with no departureMs', () => {
    const raw = legacyPlan();
    delete (raw.request as Record<string, unknown>).departureMs;
    expect(migratePlan(raw)).toBeNull();
  });

  it('refuses a record with no sail results at all', () => {
    const raw = legacyPlan();
    raw.result = {
      status: 'ok',
      recommended: 'genoa',
      snappedOrigin: { lat: 54, lon: 9 },
      snappedDestination: { lat: 55, lon: 10 },
    };
    expect(migratePlan(raw)).toBeNull();
  });

  // BODY damage, one level in from the entry-shape rows above. The
  // recommended-sail invariant only asks whether the winner HAS a result
  // object; a result missing the two fields the renderer DEREFERENCES was
  // admitted as `kind: 'ok'`, rendered `Invalid Date`, stayed clickable, and
  // reached `result.legs.length` on `undefined` when opened — and with no
  // error boundary anywhere in app/src that TypeError unmounts the React
  // root. A white screen instead of the labelled unreadable placeholder.
  it.each(['legs', 'etaMs'])('refuses a recommended sail whose result has no %s', (field) => {
    const raw = legacyPlan();
    delete ((raw.result as Record<string, unknown>).genoa as Record<string, unknown>)[field];
    expect(migratePlan(raw)).toBeNull();
  });

  // `formatNm` is `${nm.toFixed(1)} nm` — a DEREFERENCE, not a format — and
  // BOTH of these reach it during render (resultSummary.ts:116 for
  // distanceNm; RouteSummary.tsx:469's unconditional
  // `formatNm(summary.motorNm)` for motorDistanceNm, carried through raw).
  // MEASURED per shape: undefined / null / '3' throw, NaN degrades to
  // "NaN nm". `durationMs` and `maneuverCount` are the CONTROL — the same
  // measurement shows all four shapes rendering for those two, which is why
  // this list is exactly these three fields and not the whole interface.
  it.each(['etaMs', 'distanceNm', 'motorDistanceNm'])(
    'refuses a recommended sail whose %s is not finite',
    (field) => {
      const raw = legacyPlan();
      ((raw.result as Record<string, unknown>).genoa as Record<string, unknown>)[field] =
        Number.NaN;
      expect(migratePlan(raw)).toBeNull();
    },
  );

  it.each(['distanceNm', 'motorDistanceNm'])(
    'refuses a recommended sail whose result has no %s',
    (field) => {
      const raw = legacyPlan();
      delete ((raw.result as Record<string, unknown>).genoa as Record<string, unknown>)[field];
      expect(migratePlan(raw)).toBeNull();
    },
  );

  // The CONTROL for the two rows above: the fields the comment says degrade
  // really do. Damaging either leaves the record readable, so the refusals
  // above are field-specific rather than "any damage anywhere".
  it.each(['durationMs', 'maneuverCount'])('still reads a record whose %s is damaged', (field) => {
    const raw = legacyPlan();
    ((raw.result as Record<string, unknown>).genoa as Record<string, unknown>)[field] = undefined;
    expect(migratePlan(raw)).not.toBeNull();
  });

  // The legs ARRAY passing `Array.isArray` is not enough: each of these was
  // MEASURED to render and throw before isLegShaped existed — `[null]` at
  // RouteSummary's `(legs ?? []).filter((leg) => leg.shallow)`, `[{}]` at the
  // legs table's `.toFixed` on an absent number — and with no error boundary
  // in app/src that unmounts the React root. useSessionRestore calls getPlan
  // at BOOT, so it does not self-heal.
  //
  // The `shallow` row is the one this suite found rather than inherited: a
  // TRUTHY NON-OBJECT passes RouteSummary's `leg.shallow &&` guard and then
  // reads `.minDepthM` off it, which `.toFixed` throws on.
  it.each([
    ['a null element', null],
    ['a non-object element', 42],
    ['an element with no LegCommon fields', {}],
    ['an element whose start is not a point', { ...HEALTHY_LEG, start: {} }],
    ['an element whose distanceNm is not finite', { ...HEALTHY_LEG, distanceNm: Number.NaN }],
    ['an element with an unknown kind', { ...HEALTHY_LEG, kind: 'kite' }],
    ['an element whose shallow flag is a truthy non-object', { ...HEALTHY_LEG, shallow: 5 }],
  ])('refuses a legs array containing %s', (_label, leg) => {
    const raw = legacyPlan();
    ((raw.result as Record<string, unknown>).genoa as Record<string, unknown>).legs = [leg];
    expect(migratePlan(raw)).toBeNull();
  });

  // The positive control the rows above need: the SAME construction with an
  // undamaged element migrates, so they are not passing because any
  // single-element legs array is refused.
  it('accepts a legs array whose element is intact', () => {
    const raw = legacyPlan();
    ((raw.result as Record<string, unknown>).genoa as Record<string, unknown>).legs = [
      { ...HEALTHY_LEG },
    ];
    expect(migratePlan(raw)).not.toBeNull();
  });

  // The NEIGHBOURING input: damage the sail that did NOT win, leaving a
  // healthy recommended sail beside it. Scoping the check to the recommended
  // sail alone would leave this record admitted — and it reaches the same
  // dereference the moment the user switches rig tabs.
  it('refuses a NON-recommended sail whose result is body-damaged', () => {
    const raw = legacyPlan();
    delete ((raw.result as Record<string, unknown>).fock as Record<string, unknown>).legs;
    expect(migratePlan(raw)).toBeNull();
  });

  // lib/recalc.ts, state/replan.ts and state/reroute.ts each read this
  // snapshot and propagate it into the next PlanRequest, so replacing an
  // unparseable one with the Salona's numbers would not stay put — it would
  // become what the recalculated or rerouted plan claims its boat was.
  it.each([
    ['a non-object boat', 'not-a-boat'],
    ['a boat with no draftM', { id: 'x', name: 'X', sails: [] }],
    ['a boat with a non-numeric draftM', { id: 'x', name: 'X', draftM: 'deep', sails: [] }],
    ['a boat with no sails array', { id: 'x', name: 'X', draftM: 2.0 }],
    [
      'a boat whose sail entries are not sail-shaped',
      { id: 'x', name: 'X', draftM: 2, sails: [1] },
    ],
  ])('refuses %s rather than relabelling it onto the catalogue boat', (_label, boat) => {
    const raw = migratePlan(legacyPlan())! as unknown as Record<string, unknown>;
    (raw.request as Record<string, unknown>).boat = boat;
    expect(migratePlan(raw)).toBeNull();
  });
});

describe('#54 migratePlan: the snapshot is by VALUE, never a catalogue alias', () => {
  it('gives each migrated plan its own boat object and its own sail entries', () => {
    const a = migratePlan(legacyPlan())!;
    const b = migratePlan(legacyPlan())!;
    expect(a.request.boat).not.toBe(b.request.boat);
    expect(a.request.boat.sails[0]).not.toBe(b.request.boat.sails[0]);
    expect(a.request.boat.sails[0]!.polarProvenance).not.toBe(
      b.request.boat.sails[0]!.polarProvenance,
    );
    expect(a.request.boat).not.toBe(defaultBoatSnapshot());
    expect(a.request.boat).toEqual(defaultBoatSnapshot());
  });
});

// #654: `request.viaPoints` was introduced by `eb2d7ee` ("feat: via-waypoint
// segmented routing", 2026-07-15) — the SAME commit that introduced the
// via-points feature itself. `legacyPlan()` above already carries
// `viaPoints: []`, so it cannot exercise this gap.
//
// No LEGITIMATE stored record can lack the key, though: `services/db.ts`,
// the only IndexedDB writer this app has ever shipped, was created by
// `a1d2e6f` ~3 hours AFTER eb2d7ee (both predate `v0.1.0`, git-verified
// 2026-08-25) — persistence itself did not exist until after the field did.
// These rows construct a HAND-EDITED/corrupted record instead (or stand in
// for a future regression of the guarantee migratePlan.ts establishes) —
// `normaliseViaPoints`'s own docstring carries the full dated argument.
describe('#654 migratePlan: an absent/malformed viaPoints key (hand-edited or corrupted record)', () => {
  it('normalises an entirely absent viaPoints key to [] rather than refusing the record', () => {
    const raw = legacyPlan();
    delete (raw.request as Record<string, unknown>).viaPoints;
    const migrated = migratePlan(raw);
    expect(migrated).not.toBeNull();
    expect(migrated!.request.viaPoints).toEqual([]);
  });

  // The positive control the row above needs: a record that DOES carry real
  // via points still reads them back verbatim — normalisation only kicks in
  // when the key is absent, it must never clobber a genuine list.
  it('preserves a genuine non-empty viaPoints list unchanged', () => {
    const raw = legacyPlan();
    (raw.request as Record<string, unknown>).viaPoints = [
      { lat: 54.83, lon: 9.9 },
      { lat: 54.9, lon: 10.2 },
    ];
    const migrated = migratePlan(raw);
    expect(migrated!.request.viaPoints).toEqual([
      { lat: 54.83, lon: 9.9 },
      { lat: 54.9, lon: 10.2 },
    ]);
  });

  // Fail-CLOSED, per ADR-0002: a PRESENT but malformed viaPoints is not "no
  // via points" — it is corrupted or foreign data, and normalising it to []
  // would be exactly the fabricated default the ADR forbids. The whole
  // record is refused instead, same as every other structurally-damaged
  // field in this file.
  it.each([
    ['a non-array value', 'not-an-array'],
    ['an array containing a non-object element', [{ lat: 54.83, lon: 9.9 }, 'not-a-point']],
    ['an array containing a point missing lon', [{ lat: 54.83 }]],
    ['an array containing a point with a non-numeric lat', [{ lat: 'north', lon: 9.9 }]],
    // Reviewer-supplied (Minor 1, self-review of PR #687), adopted verbatim.
    // `null.lat` THROWS synchronously (unlike `'not-a-point'.lat`, which
    // returns `undefined` harmlessly) — deleting `!isRecord(p) ||` turns
    // this row from an honest refusal into a raw TypeError propagating out
    // of migratePlan(), the exact crash class #654 exists to close, one
    // level in. This is the row that DISCRIMINATES the mutation (measured:
    // 84/84 stay green without it; see the dedicated isolating test below
    // for the other, non-throwing half of the same gap).
    ['an array containing a null element', [null]],
    // Pins the other shape isRecord excludes (arrays) — does not itself
    // discriminate the isRecord deletion (a plain array's .lat is
    // `undefined`, caught by Number.isFinite regardless), kept for
    // completeness per the reviewer's own comment.
    ['an array containing an array element', [[54.83, 9.9]]],
  ])('refuses %s rather than fabricating a via-point list', (_label, viaPoints) => {
    const raw = legacyPlan();
    (raw.request as Record<string, unknown>).viaPoints = viaPoints;
    expect(migratePlan(raw)).toBeNull();
  });

  // Reviewer finding (Minor 1, self-review of PR #687): every row above ALSO
  // reds if `!isRecord(p) ||` is deleted from normaliseViaPoints, because
  // each non-object element (`'not-a-point'`, a missing/non-numeric lat/lon)
  // independently fails the `Number.isFinite` terms too — so that term was
  // untested (a per-term deletion battery reds 84/84 either way). This row
  // isolates it: an ARRAY carrying its own `lat`/`lon` OWN PROPERTIES passes
  // BOTH `Number.isFinite` checks (JS arrays are ordinary objects, so
  // attaching arbitrary keys is legal), so only `isRecord`'s
  // `!Array.isArray(x)` term can reject it — `isRecord` rejects arrays
  // specifically so a via point can never be array-shaped, distinct from a
  // plain `{lat, lon}` record.
  it('refuses an array-shaped element even when it carries lat/lon properties that would otherwise pass every Number.isFinite check (isolates the isRecord term)', () => {
    const raw = legacyPlan();
    const arrayShapedPoint: unknown = Object.assign([], { lat: 54.83, lon: 9.9 });
    (raw.request as Record<string, unknown>).viaPoints = [arrayShapedPoint];
    expect(migratePlan(raw)).toBeNull();
  });
});
