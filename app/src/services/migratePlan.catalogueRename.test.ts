import { describe, expect, it, vi } from 'vitest';

// Its own file because `vi.mock` is hoisted per module graph: this suite needs
// a DIFFERENT catalogue from every other test, and migratePlan.test.ts asserts
// against the real one.
//
// #54: `migratePlan`'s LEGACY_SAIL_FIELDS comment claims the pre-#54 field
// names are frozen HISTORY rather than catalogue data, so that renaming a
// Salona sail id cannot change how already-stored records are READ. Nothing
// pinned that claim, and the first implementation cancelled it one line later
// by resolving each field through `boat.sails.find(s => s.id === field)` and
// refusing on a miss — under which a rename made EVERY pre-#54 plan
// unreadable. This file is that claim's keeper.
vi.mock('../data/boats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/boats')>();
  const renamed = {
    ...actual.BOATS[0]!,
    sails: actual.BOATS[0]!.sails.map((s) => ({ ...s, id: s.id === 'genoa' ? 'code0' : s.id })),
  };
  return {
    ...actual,
    BOATS: [renamed],
    boatById: () => renamed,
    DEFAULT_SAIL_IDS: renamed.sails.map((s) => s.id),
  };
});

const { migratePlan } = await import('./migratePlan');
const { DEFAULT_SETTINGS } = await import('../types');

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
    windGrid: {
      lats: [54.0],
      lons: [9.0],
      timesMs: [1000],
      speedKn: new Float32Array([5]),
      dirFromDeg: new Float32Array([90]),
      gustKn: new Float32Array([7]),
      fetchedAtMs: 1_626_340_800_000,
      model: 'open-meteo',
    },
    result: {
      status: 'ok',
      genoa: { rig: 'genoa', legs: [], etaMs: 111_000, durationMs: 1, distanceNm: 1 },
      fock: { rig: 'fock', legs: [], etaMs: 222_000, durationMs: 1, distanceNm: 1 },
      genoaReason: null,
      fockReason: null,
      recommended: 'genoa',
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.85, lon: 10.51 },
    },
  };
}

describe('#54 migratePlan is not coupled to the catalogue sail ids', () => {
  it('the mocked catalogue really did rename genoa', async () => {
    const { BOATS } = await import('../data/boats');
    expect(BOATS[0]!.sails.map((s) => s.id)).toEqual(['code0', 'fock']);
  });

  it('still reads a pre-#54 record after a catalogue sail-id rename', () => {
    const migrated = migratePlan(legacyPlan());
    expect(migrated).not.toBeNull();
    // The STORED ids are carried forward unchanged — the record says genoa,
    // so the plan says genoa, whatever the catalogue now calls that sail.
    expect(migrated!.result.sails.map((s) => s.sailId)).toEqual(['genoa', 'fock']);
    expect(migrated!.request.sailIds).toEqual(['genoa', 'fock']);
    // The relabelled boat snapshot does follow the catalogue, because that is
    // a statement about the boat rather than about what this plan solved.
    expect(migrated!.request.boat.sails.map((s) => s.id)).toEqual(['code0', 'fock']);
  });
});
