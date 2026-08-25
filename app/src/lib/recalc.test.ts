import { describe, it, expect } from 'vitest';
import { recalcRequest } from './recalc';
import { OFF_CATALOGUE_BOAT, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SAIL_IDS } from '../data/boats';
import { DEFAULT_SETTINGS, type Plan, type PlanRequest, type Settings } from '../types';
import { defaultBoatSnapshot } from '../types';
import { PLAN_SCHEMA_VERSION } from '../types';

// Literal request values (mutation-check rule: expectations are pinned
// literals, never derived from the function under test).
const ORIGINAL_REQUEST: PlanRequest = {
  origin: { lat: 54.81, lon: 9.44 },
  destination: { lat: 54.85, lon: 10.51 },
  viaPoints: [{ lat: 54.83, lon: 9.9 }],
  originHarborId: 'flensburg',
  destinationHarborId: null,
  departureMs: 1_780_000_000_000,
  settings: {
    safetyDepthM: 2.3,
    depthComfortMarginM: 2.0,
    motorSpeedKn: 6.5,
    motorThresholdKn: 2.5,
    sailPreferenceKn: 2.8,
    maneuverPenaltyS: 45,
    performanceFactor: 0.9,
    motorEnabled: false,
    showOwnship: true,
  },
  sailIds: ['genoa', 'fock'],
  boat: defaultBoatSnapshot(),
};

function makePlan(): Plan {
  return {
    id: 'plan-original',
    name: 'Flensburg → Ærøskøbing',
    createdAtMs: 1_779_990_000_000,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: ORIGINAL_REQUEST,
    windGrid: uniformWindGrid(12, 225),
    result: {
      status: 'ok',
      sails: [
        {
          sailId: 'genoa',
          result: {
            sailId: 'genoa',
            legs: [],
            etaMs: 1_780_010_000_000,
            durationMs: 10_000_000,
            distanceNm: 30,
            maneuverCount: 2,
            motorDistanceNm: 0,
          },
          reason: null,
        },
        { sailId: 'fock', result: null, reason: 'calm-motor-off' },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: { lat: 54.81, lon: 9.44 },
      snappedDestination: { lat: 54.85, lon: 10.51 },
    },
  };
}

describe('recalcRequest (#114 seed-from-plan)', () => {
  it('keeps origin/destination/vias/harbors/settings and swaps only the departure', () => {
    const plan = makePlan();

    const seeded = recalcRequest(plan, 1_780_086_400_000);

    expect(seeded).toEqual({
      origin: { lat: 54.81, lon: 9.44 },
      destination: { lat: 54.85, lon: 10.51 },
      viaPoints: [{ lat: 54.83, lon: 9.9 }],
      originHarborId: 'flensburg',
      destinationHarborId: null,
      departureMs: 1_780_086_400_000, // the edited departure, NOT the stored 1_780_000_000_000
      settings: {
        safetyDepthM: 2.3,
        depthComfortMarginM: 2.0,
        motorSpeedKn: 6.5,
        motorThresholdKn: 2.5,
        sailPreferenceKn: 2.8,
        maneuverPenaltyS: 45,
        performanceFactor: 0.9,
        motorEnabled: false,
        showOwnship: true,
      },
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    });
  });

  it('never aliases the plan mutable sub-objects, and leaves the plan request untouched', () => {
    const plan = makePlan();

    const seeded = recalcRequest(plan, 1_780_086_400_000);

    // Copies, not shared references — nothing downstream of the run can
    // reach back into the saved plan's own request.
    expect(seeded.origin).not.toBe(plan.request.origin);
    expect(seeded.destination).not.toBe(plan.request.destination);
    expect(seeded.viaPoints).not.toBe(plan.request.viaPoints);
    expect(seeded.viaPoints[0]).not.toBe(plan.request.viaPoints[0]);
    expect(seeded.settings).not.toBe(plan.request.settings);

    // The original request still holds its literal pre-seed values.
    expect(plan.request.departureMs).toBe(1_780_000_000_000);
    expect(plan.request.viaPoints).toEqual([{ lat: 54.83, lon: 9.9 }]);
    expect(plan.request.settings.safetyDepthM).toBe(2.3);
  });

  // #243 fix wave item 3: a plan saved before depthComfortMarginM existed on
  // Settings has that field simply absent from its stored snapshot (an old
  // IndexedDB record, never migrated). Without backfilling from
  // DEFAULT_SETTINGS first, recalcRequest would carry `undefined` forward
  // into a field typed as a required `number`, and — because
  // planRoute.ts:133 treats "not > 0" as "off" — would silently disable the
  // depth comfort preference on every recalculation of that old plan.
  it('backfills depthComfortMarginM (and any other newer field) from DEFAULT_SETTINGS on a pre-#243-shaped saved plan', () => {
    const oldShapedSettings = { ...ORIGINAL_REQUEST.settings } as Partial<Settings>;
    delete oldShapedSettings.depthComfortMarginM;
    const plan = makePlan();
    plan.request = { ...plan.request, settings: oldShapedSettings as Settings };

    const seeded = recalcRequest(plan, 1_780_086_400_000);

    expect(seeded.settings.depthComfortMarginM).toBe(DEFAULT_SETTINGS.depthComfortMarginM);
    // Every field the old plan DID have is still preserved verbatim, not
    // silently overwritten by the default.
    expect(seeded.settings.safetyDepthM).toBe(2.3);
    expect(seeded.settings.motorEnabled).toBe(false);
  });

  // #54 fix round 1: same mechanism as the depthComfortMarginM case above, on
  // a field OUTSIDE Settings this time. A plan saved before sailIds existed
  // on PlanRequest (pre-multi-boat) does not carry the key at all in its
  // stored snapshot; without backfilling from DEFAULT_SAIL_IDS,
  // planRoute.ts's `runAll` calls `req.sailIds.map(...)` unconditionally —
  // throwing on recalculation of a pre-#54 plan rather than degrading.
  it('backfills sailIds from DEFAULT_SAIL_IDS on a pre-#54-shaped saved plan', () => {
    // The local cast is what makes `delete` compile on `PlanRequest.sailIds`
    // — the depthComfortMarginM test above needs no such cast, since
    // Settings's own fields are not readonly.
    const oldShapedRequest = { ...ORIGINAL_REQUEST } as Partial<{
      -readonly [K in keyof PlanRequest]: PlanRequest[K];
    }>;
    delete oldShapedRequest.sailIds;
    const plan = makePlan();
    plan.request = oldShapedRequest as PlanRequest;

    const seeded = recalcRequest(plan, 1_780_086_400_000);

    expect(seeded.sailIds).toEqual(DEFAULT_SAIL_IDS);
    // Every field the old plan DID have is still preserved verbatim.
    expect(seeded.originHarborId).toBe('flensburg');
  });

  // #654: same mechanism as the sailIds backfill above, on viaPoints. A plan
  // saved before eb2d7ee ("feat: via-waypoint segmented routing",
  // 2026-07-15) does not carry the key at all — the via-points feature and
  // the field were introduced by that ONE commit, so an absent key means the
  // plan genuinely never had any via points (docs/adr/
  // 0002-pre-1.0-db-migration-low-priority.md). Before this fix,
  // recalcRequest called `plan.request.viaPoints.map(...)` unconditionally,
  // throwing "Cannot read properties of undefined (reading 'map')" on
  // recalculation of such a plan rather than degrading to an empty via list.
  it('normalises viaPoints to [] on a pre-#654-shaped saved plan (viaPoints key absent)', () => {
    const oldShapedRequest = { ...ORIGINAL_REQUEST } as Partial<{
      -readonly [K in keyof PlanRequest]: PlanRequest[K];
    }>;
    delete oldShapedRequest.viaPoints;
    const plan = makePlan();
    plan.request = oldShapedRequest as PlanRequest;

    expect(() => recalcRequest(plan, 1_780_086_400_000)).not.toThrow();
    const seeded = recalcRequest(plan, 1_780_086_400_000);

    expect(seeded.viaPoints).toEqual([]);
    // Every field the old plan DID have is still preserved verbatim.
    expect(seeded.originHarborId).toBe('flensburg');
  });

  // #54 Task 11: pins the PROPERTY the keeper below rests on, not just its
  // detection logic (#516). That keeper discriminates ONLY because ['fock']
  // is not value-equal to DEFAULT_SAIL_IDS; if the default boat's sail set
  // ever became exactly ['fock'], the keeper would degenerate into the
  // vacuity it was added to close and would still pass.
  it('#54: the non-default fixture below is genuinely non-default', () => {
    expect(DEFAULT_SAIL_IDS).not.toEqual(['fock']);
  });

  // #54 review round 3: the INHERITANCE half of the backfill `??`.
  // ORIGINAL_REQUEST's sailIds is ['genoa', 'fock'], value-equal to
  // DEFAULT_SAIL_IDS — so no assertion against it can tell an inherited list
  // from a hardcoded default. A non-default fixture can.
  it("seeds the saved plan's OWN sails, not the default", () => {
    const plan = makePlan();
    plan.request = { ...ORIGINAL_REQUEST, sailIds: ['fock'] };

    const seeded = recalcRequest(plan, 1_780_086_400_000);

    expect(seeded.sailIds).toEqual(['fock']);
  });

  // #54 Task 11: the BOAT half of the same inheritance question, previously
  // unguarded — replacing this site's `boatSnapshot(plan.request.boat)` with
  // a bare `defaultBoatSnapshot()` left this suite and its replan/reroute
  // siblings green, because ORIGINAL_REQUEST's boat IS the catalogue default
  // and the substitution is value-identical. `OFF_CATALOGUE_BOAT` is a boat
  // BOATS does not contain — the state spec §I.3 requires a plan to keep, and
  // the reason services/migratePlan.ts refuses to REPLACE an unparseable
  // snapshot rather than substituting one: a substituted snapshot does not
  // stay put, it becomes what the recalculated plan claims its boat was.
  it("seeds the saved plan's OWN boat snapshot, not the catalogue default", () => {
    const plan = makePlan();
    plan.request = { ...ORIGINAL_REQUEST, boat: OFF_CATALOGUE_BOAT };

    const seeded = recalcRequest(plan, 1_780_086_400_000);

    expect(seeded.boat).toEqual(OFF_CATALOGUE_BOAT);
    // COPIED, never aliased — the same rule this function applies to
    // viaPoints/settings, and the reason the value assertion alone is not
    // enough.
    expect(seeded.boat).not.toBe(plan.request.boat);
    expect(seeded.boat.sails[0]).not.toBe(plan.request.boat.sails[0]);
  });
});
