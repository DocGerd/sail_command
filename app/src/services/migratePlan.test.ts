import { describe, expect, it } from 'vitest';
import { migratePlan } from './migratePlan';
import { DEFAULT_SETTINGS, PLAN_SCHEMA_VERSION, defaultBoatSnapshot } from '../types';

// A record in the PRE-#54 shape: no schemaVersion, no request.boat, no
// request.sailIds, no result.comparisonComplete, one RigResult per rig under
// a field named after that rig with a `<rig>Reason` sibling, and RigResult
// carrying `rig` rather than Task 9's `sailId`. Deliberately typed as a bare
// record — it does not satisfy today's Plan, which is the point.
function legacyRigResult(rig: string, etaMs: number): Record<string, unknown> {
  return {
    rig,
    legs: [{ kind: 'motor', board: null, maneuverAtStart: null }],
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

  it('reconstructs sailIds from the sails the plan actually compared', () => {
    const migrated = migratePlan(legacyPlan())!;
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

  // The snapshot is what the UI SHOWS for this plan — nothing in
  // app/src/routing/** reads it, the solver taking its boat from
  // PlanDeps.boat — so replacing an unparseable one with the Salona's numbers
  // would state a different hull's name and draft as this plan's.
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
