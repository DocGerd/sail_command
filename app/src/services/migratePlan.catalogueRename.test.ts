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
      // All seven RigResult fields, not a subset: normaliseRigResult refuses a
      // result missing one the renderer would dereference, and every one of
      // these has been on RigResult since v0.1.0, so a stub here would be
      // refused for being unlike anything a released build wrote rather than
      // for anything this suite is about.
      genoa: {
        rig: 'genoa',
        legs: [],
        etaMs: 111_000,
        durationMs: 1,
        distanceNm: 1,
        maneuverCount: 0,
        motorDistanceNm: 0,
      },
      fock: {
        rig: 'fock',
        legs: [],
        etaMs: 222_000,
        durationMs: 1,
        distanceNm: 1,
        maneuverCount: 0,
        motorDistanceNm: 0,
      },
      genoaReason: null,
      fockReason: null,
      recommended: 'genoa',
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.85, lon: 10.51 },
    },
  };
}

// #551 review round 2 MAJOR (the review that found this file protects only
// LEGACY records from a catalogue rename): a MODERN record — one with a
// `request.boat` snapshot and a `result.sails` array, both introduced by
// #54 — has its OWN sailIds catalogue-cross-checked (#551's whole point),
// so a rename can affect it too, through a completely different mechanism
// than the legacy one this file was written to guard. `boat.id: 'salona-45'`
// matches the mocked catalogue's (unchanged) id, so `catalogueSailIds`
// resolves it to the RENAMED sails.
function modernPlan(): Record<string, unknown> {
  return {
    id: 'modern-1',
    name: 'Flensburg → Marstal (modern)',
    createdAtMs: 1_700_000_000_000,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.85, lon: 10.51 },
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'marstal',
      departureMs: 1_700_003_600_000,
      settings: { ...DEFAULT_SETTINGS },
      // PRE-RENAME stored ids — a real modern record written before the
      // catalogue rename happened.
      sailIds: ['genoa', 'fock'],
      boat: {
        id: 'salona-45',
        name: 'Salona 45',
        draftM: 2.1,
        sails: [
          { id: 'genoa', label: 'Genoa 135 %', polarProvenance: { tier: 'modelled', note: 'n' } },
          { id: 'fock', label: 'Jib 110 %', polarProvenance: { tier: 'certificate', note: 'n' } },
        ],
      },
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
      sails: [
        {
          sailId: 'genoa',
          result: {
            sailId: 'genoa',
            legs: [],
            etaMs: 111_000,
            durationMs: 1,
            distanceNm: 1,
            maneuverCount: 0,
            motorDistanceNm: 0,
          },
          reason: null,
        },
        {
          sailId: 'fock',
          result: {
            sailId: 'fock',
            legs: [],
            etaMs: 222_000,
            durationMs: 1,
            distanceNm: 1,
            maneuverCount: 0,
            motorDistanceNm: 0,
          },
          reason: null,
        },
      ],
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

// #551 review round 2/3: this file had exactly two tests, both legacy —
// nothing here could see a MODERN record's own exposure to a catalogue
// rename, introduced by #551's own sailIds cross-check. The invariant these
// three tests pin: a rename must never desynchronise `request.sailIds` from
// `result.sails`/`result.recommended`, in EITHER record shape — chosen over
// the alternative (silently letting `recommended` fall out of `sailIds`)
// because every replan/recalc path reads `request.sailIds`, never
// `result.recommended`, to decide what to re-solve.
describe('#551 review round 3: a MODERN record is not silently desynchronised by a catalogue rename either', () => {
  it('refuses (unreadable) a modern record whose RECOMMENDED sail was renamed out of the catalogue, rather than silently dropping it from sailIds', () => {
    // Stored sailIds ['genoa','fock'] fails the catalogue check post-rename
    // (genoa -> code0), so this falls to the fallback reconstruction, which
    // filters 'genoa' out too — leaving sailIds=['fock'] without the
    // recommended 'genoa'. Refused rather than returned inconsistent.
    expect(migratePlan(modernPlan())).toBeNull();
  });

  it('refuses (unreadable) a modern record whose ONLY sail was renamed out of the catalogue', () => {
    const raw = modernPlan();
    const request = raw.request as Record<string, unknown>;
    const result = raw.result as Record<string, unknown>;
    delete request.sailIds; // forces the fallback reconstruction
    result.sails = [(result.sails as unknown[])[0]]; // genoa only
    result.recommended = 'genoa';
    expect(migratePlan(raw)).toBeNull();
  });

  it('reads a modern record correctly when its RECOMMENDED sail survives the rename — only the renamed, non-recommended sail is dropped', () => {
    const raw = modernPlan();
    (raw.result as Record<string, unknown>).recommended = 'fock';
    const migrated = migratePlan(raw);
    expect(migrated).not.toBeNull();
    // 'genoa' (renamed to 'code0' in the catalogue) is dropped from
    // sailIds; 'fock' (the recommended sail, unaffected by the rename)
    // survives. result.sails is untouched — it is the historical record of
    // what this plan actually solved, not something a rename may edit.
    expect(migrated!.request.sailIds).toEqual(['fock']);
    expect(migrated!.result.sails.map((s) => s.sailId)).toEqual(['genoa', 'fock']);
  });
});
