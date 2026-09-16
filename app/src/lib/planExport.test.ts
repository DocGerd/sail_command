import { describe, it, expect } from 'vitest';
import {
  buildExportEnvelope,
  exportEnvelopeToJson,
  exportFileName,
  parseExportFile,
  ImportParseError,
  EXPORT_SCHEMA_VERSION,
} from './planExport';
import type { SavedWaypoint } from '../services/db';
import { defaultBoatSnapshot, PLAN_SCHEMA_VERSION, type Plan, type Settings } from '../types';
import { uniformWindGrid } from '../test/fixtures';

const TEST_SETTINGS: Settings = {
  safetyDepthM: 3.0,
  depthComfortMarginM: 2.0,
  motorSpeedKn: 6.5,
  motorThresholdKn: 2.5,
  sailPreferenceKn: 2.8,
  maneuverPenaltyS: 45,
  performanceFactor: 0.9,
  motorEnabled: true,
  showOwnship: false,
};

function makeTestPlan(id = 'test-plan-1'): Plan {
  return {
    id,
    name: 'Flensburg → Marstal',
    createdAtMs: 1626340800000,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: { lat: 54.3, lon: 9.4 },
      destination: { lat: 55.0, lon: 10.0 },
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: 1626340800000,
      settings: TEST_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    // #1068 review MAJOR: sized to satisfy `lib/wind.ts`'s `WindField`
    // dimension invariant EXACTLY —
    // `speedKn.length === timesMs.length * lats.length * lons.length`
    // (here 3 * 1 * 1 = 3) — this fixture's own previous shape (9-element
    // arrays against a 3x3x3=27 grid) never actually satisfied that
    // invariant, which `decodeWindGrid` now enforces and this test relies on
    // NOT reddening.
    windGrid: {
      lats: [54.0],
      lons: [9.0],
      timesMs: [1000, 2000, 3000],
      // Deliberately three DIFFERENT value sets so a field-swap mutation
      // (e.g. gustKn <-> dirFromDeg) is observable rather than accidentally
      // symmetric.
      speedKn: new Float32Array([5.1, 6.2, 7.3]),
      dirFromDeg: new Float32Array([90, 95, 100]),
      gustKn: new Float32Array([7.1, 8.2, 9.3]),
      fetchedAtMs: 1626340800000,
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
            etaMs: 1626344400000,
            durationMs: 3600000,
            distanceNm: 42.5,
            maneuverCount: 2,
            motorDistanceNm: 0,
          },
          reason: null,
        },
        { sailId: 'fock', result: null, reason: null },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: { lat: 54.3, lon: 9.4 },
      snappedDestination: { lat: 55.0, lon: 10.0 },
    },
  };
}

const TEST_WAYPOINT: SavedWaypoint = {
  id: 'wp-1',
  name: 'off Holnis',
  lat: 54.83,
  lon: 9.87,
  createdAtMs: 1700000000000,
};

describe('planExport round-trip', () => {
  it('carries the wind grid through byte-for-byte, as real Float32Arrays', () => {
    const plan = makeTestPlan();
    const envelope = buildExportEnvelope([plan], TEST_SETTINGS, [TEST_WAYPOINT]);
    const json = exportEnvelopeToJson(envelope);
    const result = parseExportFile(json);

    expect(result.invalidPlanCount).toBe(0);
    expect(result.plans).toHaveLength(1);
    const roundTripped = result.plans[0];
    expect(roundTripped.windGrid.speedKn).toBeInstanceOf(Float32Array);
    expect(roundTripped.windGrid.dirFromDeg).toBeInstanceOf(Float32Array);
    expect(roundTripped.windGrid.gustKn).toBeInstanceOf(Float32Array);
    expect(Array.from(roundTripped.windGrid.speedKn)).toEqual(Array.from(plan.windGrid.speedKn));
    expect(Array.from(roundTripped.windGrid.dirFromDeg)).toEqual(
      Array.from(plan.windGrid.dirFromDeg),
    );
    expect(Array.from(roundTripped.windGrid.gustKn)).toEqual(Array.from(plan.windGrid.gustKn));
    expect(roundTripped.windGrid.lats).toEqual(plan.windGrid.lats);
    expect(roundTripped.id).toBe(plan.id);
    expect(roundTripped.name).toBe(plan.name);
  });

  it('round-trips settings exactly', () => {
    const envelope = buildExportEnvelope([], TEST_SETTINGS, []);
    const result = parseExportFile(exportEnvelopeToJson(envelope));
    expect(result.settings).toEqual(TEST_SETTINGS);
  });

  it('round-trips a null settings snapshot as null, not a fabricated default', () => {
    const envelope = buildExportEnvelope([], null, []);
    const result = parseExportFile(exportEnvelopeToJson(envelope));
    expect(result.settings).toBeNull();
  });

  it('round-trips saved waypoints', () => {
    const envelope = buildExportEnvelope([], null, [TEST_WAYPOINT]);
    const result = parseExportFile(exportEnvelopeToJson(envelope));
    expect(result.waypoints).toEqual([TEST_WAYPOINT]);
    expect(result.invalidWaypointCount).toBe(0);
  });

  it('exports the current EXPORT_SCHEMA_VERSION, and it parses back cleanly', () => {
    const envelope = buildExportEnvelope([], null, []);
    expect(envelope.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(() => parseExportFile(exportEnvelopeToJson(envelope))).not.toThrow();
  });
});

// #885: forced segment modes and forced legs travel through export/import; the
// import delegates validation to migratePlan, so a malformed mode list is one
// skipped plan, not a crashed import.
function makeForcedPlan(id: string): Plan {
  const plan = makeTestPlan(id);
  const via = { lat: 54.6, lon: 9.7 };
  const leg = {
    kind: 'motor' as const,
    board: null,
    start: { lat: 54.3, lon: 9.4 },
    end: via,
    startTimeMs: 1626340800000,
    endTimeMs: 1626344400000,
    headingDeg: 30,
    twsKn: 8,
    speedKn: 6.5,
    distanceNm: 6.5,
    maneuverAtStart: null,
    forced: true as const,
  };
  const genoa = plan.result.status === 'ok' ? plan.result.sails[0] : null;
  if (plan.result.status !== 'ok' || genoa?.result == null) throw new Error('fixture');
  return {
    ...plan,
    request: { ...plan.request, viaPoints: [via], segmentModes: ['motor', null] },
    result: {
      ...plan.result,
      sails: [{ ...genoa, result: { ...genoa.result, legs: [leg] } }, plan.result.sails[1]],
    },
  };
}

describe('#885 planExport: segment modes and forced legs', () => {
  it('round-trips segmentModes and forced legs through export and import', () => {
    const plan = makeForcedPlan('forced-1');
    const result = parseExportFile(exportEnvelopeToJson(buildExportEnvelope([plan], null, [])));
    expect(result.invalidPlanCount).toBe(0);
    const back = result.plans[0];
    expect(back.request.segmentModes).toEqual(['motor', null]);
    const legs = back.result.status === 'ok' ? (back.result.sails[0].result?.legs ?? []) : [];
    expect(legs).toHaveLength(1);
    expect(legs[0].forced).toBe(true);
  });

  it.each<[string, unknown]>([
    ['the wrong length', ['motor']],
    ['an unknown mode', ['motor', 'oars']],
    ['a non-array', 'motor'],
  ])(
    'counts an imported plan whose segmentModes has %s as invalid, keeping the others',
    (_n, bad) => {
      const good = buildExportEnvelope([makeForcedPlan('good')], null, []).plans[0];
      const broken = JSON.parse(JSON.stringify(good)) as {
        id: string;
        request: Record<string, unknown>;
      };
      broken.id = 'broken';
      broken.request.segmentModes = bad;
      const envelope = {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAtMs: Date.now(),
        plans: [good, broken],
        settings: null,
        waypoints: [],
      };
      const result = parseExportFile(JSON.stringify(envelope));
      expect(result.invalidPlanCount).toBe(1);
      expect(result.plans.map((p) => p.id)).toEqual(['good']);
    },
  );

  it('counts an imported plan whose leg carries forced other than true as invalid', () => {
    const good = buildExportEnvelope([makeForcedPlan('good')], null, []).plans[0];
    const broken = JSON.parse(JSON.stringify(good)) as {
      id: string;
      result: { sails: { result: { legs: Record<string, unknown>[] } }[] };
    };
    broken.id = 'broken';
    broken.result.sails[0].result.legs[0].forced = 'yes';
    const envelope = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      plans: [good, broken],
      settings: null,
      waypoints: [],
    };
    const result = parseExportFile(JSON.stringify(envelope));
    expect(result.invalidPlanCount).toBe(1);
    expect(result.plans.map((p) => p.id)).toEqual(['good']);
  });
});

describe('parseExportFile: fundamentally unreadable files', () => {
  it('rejects non-JSON text', () => {
    expect(() => parseExportFile('not json at all {{{')).toThrow(ImportParseError);
    try {
      parseExportFile('not json at all {{{');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ImportParseError);
      expect((err as ImportParseError).reason).toBe('not-json');
    }
  });

  it('rejects well-formed JSON that is not an envelope object', () => {
    try {
      parseExportFile(JSON.stringify([1, 2, 3]));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ImportParseError);
      expect((err as ImportParseError).reason).toBe('not-envelope');
    }
  });

  it('rejects an object with no schemaVersion field', () => {
    try {
      parseExportFile(JSON.stringify({ plans: [], settings: null, waypoints: [] }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ImportParseError);
      expect((err as ImportParseError).reason).toBe('not-envelope');
    }
  });

  it('rejects a schemaVersion newer than this build supports, distinctly from a malformed file', () => {
    try {
      parseExportFile(
        JSON.stringify({
          schemaVersion: EXPORT_SCHEMA_VERSION + 1,
          plans: [],
          settings: null,
          waypoints: [],
        }),
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ImportParseError);
      expect((err as ImportParseError).reason).toBe('unsupported-version');
    }
  });
});

describe('parseExportFile: per-item corruption is isolated, not fatal', () => {
  it('skips a plan with no windGrid at all and counts it, keeping the others', () => {
    const good = buildExportEnvelope([makeTestPlan('good-1')], null, []).plans[0];
    const broken = { ...good } as Record<string, unknown>;
    delete broken.windGrid;
    const envelope = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      plans: [good, broken],
      settings: null,
      waypoints: [],
    };
    const result = parseExportFile(JSON.stringify(envelope));
    expect(result.invalidPlanCount).toBe(1);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].id).toBe('good-1');
  });

  it('skips a plan whose windGrid base64 cannot decode', () => {
    const good = buildExportEnvelope([makeTestPlan('good-2')], null, []).plans[0];
    const broken = {
      ...good,
      windGrid: { ...good.windGrid, speedKn: 'not valid base64 !!!' },
    };
    const envelope = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      plans: [good, broken],
      settings: null,
      waypoints: [],
    };
    const result = parseExportFile(JSON.stringify(envelope));
    expect(result.invalidPlanCount).toBe(1);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].id).toBe('good-2');
  });

  // #1068 review MAJOR, reproduced exactly as the reviewer constructed it:
  // truncate ONLY `lats`, leaving the base64-encoded speedKn/dirFromDeg/
  // gustKn at their ORIGINAL (now too-long) length. Before the fix this
  // plan was accepted (invalidPlanCount stayed 0) and would have been
  // persisted, crashing the first `new WindField(...)` call downstream —
  // see decodeWindGrid's own comment for the full mechanism.
  it('skips a plan whose windGrid lats is truncated relative to its wind arrays (#1068 Major)', () => {
    const good = buildExportEnvelope([makeTestPlan('good-3')], null, []).plans[0];
    const truncated = {
      ...good,
      windGrid: { ...good.windGrid, lats: good.windGrid.lats.slice(0, 0) },
    };
    const envelope = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      plans: [good, truncated],
      settings: null,
      waypoints: [],
    };
    const result = parseExportFile(JSON.stringify(envelope));
    expect(result.invalidPlanCount).toBe(1);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].id).toBe('good-3');
  });

  // A NON-empty but still WRONG-length lats — the dimension check must fire
  // on a mismatch in either direction, not only on the empty-array case
  // above (which the isNumberArray-vacuity fix below could otherwise be
  // mistaken for covering on its own).
  it('skips a plan whose windGrid lats has the wrong (non-zero) length for its wind arrays', () => {
    const good = buildExportEnvelope([makeTestPlan('good-4')], null, []).plans[0];
    const wrongLength = {
      ...good,
      windGrid: { ...good.windGrid, lats: [54.0, 54.1] }, // 2 lats, but timesMs still 3 -> expected 6, arrays stay length 3
    };
    const envelope = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      plans: [good, wrongLength],
      settings: null,
      waypoints: [],
    };
    const result = parseExportFile(JSON.stringify(envelope));
    expect(result.invalidPlanCount).toBe(1);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].id).toBe('good-4');
  });

  // `[].every(...)` is vacuously true (the CLAUDE.md-documented `[]`-defeats-
  // truthiness class) — an empty `timesMs` must not slip past isNumberArray
  // and then produce `expected = 0`, which a same-length-0 wind array could
  // satisfy trivially. Chosen to differ from the truncated-lats case above:
  // here EVERY axis-derived length agrees (0), so only the explicit
  // non-empty check — not the dimension-mismatch check — can catch it.
  it('skips a plan whose windGrid has an empty timesMs axis', () => {
    const good = buildExportEnvelope([makeTestPlan('good-5')], null, []).plans[0];
    const emptyAxis = {
      ...good,
      windGrid: { ...good.windGrid, timesMs: [], speedKn: '', dirFromDeg: '', gustKn: '' },
    };
    const envelope = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      plans: [good, emptyAxis],
      settings: null,
      waypoints: [],
    };
    const result = parseExportFile(JSON.stringify(envelope));
    expect(result.invalidPlanCount).toBe(1);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].id).toBe('good-5');
  });

  // #295 ruling: with bounds supplied (the app passes DATA_AREA), import accepts
  // a grid that covers them OR the exact pre-#295 11 x 17 lattice, and still
  // rejects any other non-covering grid (#1178).
  describe('#295: wind-grid coverage on import', () => {
    const BOUNDS = { west: 9.4, south: 54.3, east: 11.6, north: 55.6 };
    const importGrid = (id: string, windGrid: Plan['windGrid']) =>
      parseExportFile(
        exportEnvelopeToJson(buildExportEnvelope([{ ...makeTestPlan(id), windGrid }], null, [])),
        BOUNDS,
      );

    it('imports a plan on the pre-#295 187-point lattice with its grid intact', () => {
      const oldGrid = uniformWindGrid(12, 45, { north: 55.3, east: 11.0 });
      expect(oldGrid.lats.length * oldGrid.lons.length).toBe(187);
      const result = importGrid('old-lattice', oldGrid);
      expect(result.invalidPlanCount).toBe(0);
      expect(result.plans).toHaveLength(1);
      const imported = result.plans[0].windGrid;
      expect(imported.lats).toEqual(oldGrid.lats);
      expect(imported.lons).toEqual(oldGrid.lons);
      expect(imported.speedKn).toEqual(oldGrid.speedKn);
    });

    it('imports a plan whose grid covers the bounds', () => {
      const result = importGrid('covering', uniformWindGrid(12, 45));
      expect(result.invalidPlanCount).toBe(0);
      expect(result.plans).toHaveLength(1);
    });

    it('rejects an 11 x 17 lattice shifted 0.1 deg north of the legacy one', () => {
      const shifted = uniformWindGrid(12, 45, { south: 54.4, north: 55.4, east: 11.0 });
      expect([shifted.lats.length, shifted.lons.length]).toEqual([11, 17]);
      const result = importGrid('shifted', shifted);
      expect(result.invalidPlanCount).toBe(1);
      expect(result.plans).toHaveLength(0);
    });
  });

  it('skips a waypoint missing a required field and counts it, keeping the others', () => {
    const broken = { id: 'wp-broken', name: 'incomplete' }; // no lat/lon/createdAtMs
    const envelope = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      plans: [],
      settings: null,
      waypoints: [TEST_WAYPOINT, broken],
    };
    const result = parseExportFile(JSON.stringify(envelope));
    expect(result.invalidWaypointCount).toBe(1);
    expect(result.waypoints).toEqual([TEST_WAYPOINT]);
  });

  it('falls back to null settings on a malformed settings object, without throwing', () => {
    const envelope = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      plans: [],
      settings: { safetyDepthM: 'not a number' },
      waypoints: [],
    };
    const result = parseExportFile(JSON.stringify(envelope));
    expect(result.settings).toBeNull();
  });
});

describe('exportFileName', () => {
  it('produces a filename with no characters illegal on any OS', () => {
    const name = exportFileName(Date.UTC(2026, 8, 7, 12, 30, 0));
    expect(name).toMatch(/^sailcommand-export-[\dT-]+Z\.json$/);
    expect(name).not.toMatch(/[:]/);
  });
});
