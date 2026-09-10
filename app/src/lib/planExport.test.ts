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
import { TEST_MASK_META } from '../test/fixtures';

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

  // #1178 (PR #1182 round-2 review): the import path (SettingsPanel.tsx ->
  // parseExportFile -> decodePlan -> migratePlan -> savePlan) never
  // constructs a WindField, so wind.ts's own construction-time domain-
  // coverage assertion never runs for an imported plan — a spatially
  // narrow but dimension-consistent windGrid would reach
  // DepthProfile.tsx/DepartureCompare.tsx/routeGeoJson.ts's "already
  // validated" WindField constructions completely unvalidated. This test
  // FAILS on the pre-#1178-part-2 shape of decodeWindGrid (no maskBounds
  // parameter at all -> the narrow grid below was silently accepted, see
  // the mutation check in this PR's report) and PASSES now that
  // parseExportFile threads an optional maskBounds through to it.
  // makeTestPlan's own windGrid is `lats: [54.0], lons: [9.0]` — a SINGLE
  // point, nowhere near TEST_MASK_META's 54.3-55.3/9.4-11.0 domain — so no
  // fixture mutation is needed to construct the narrow case.
  it('skips a plan whose windGrid does not cover the supplied mask bounds (#1178)', () => {
    const narrow = buildExportEnvelope([makeTestPlan('narrow-1')], null, []).plans[0];
    const envelope = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      plans: [narrow],
      settings: null,
      waypoints: [],
    };
    const result = parseExportFile(JSON.stringify(envelope), TEST_MASK_META);
    expect(result.invalidPlanCount).toBe(1);
    expect(result.plans).toHaveLength(0);
  });

  // Complement of the test above: the SAME narrow windGrid is still
  // ACCEPTED when maskBounds is omitted — preserving every pre-existing
  // caller (this whole file's other tests, none of which pass maskBounds)
  // byte-for-byte. Proves the parameter is genuinely optional, not merely
  // typed as such.
  it('still accepts the narrow windGrid above when maskBounds is omitted', () => {
    const narrow = buildExportEnvelope([makeTestPlan('narrow-2')], null, []).plans[0];
    const envelope = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtMs: Date.now(),
      plans: [narrow],
      settings: null,
      waypoints: [],
    };
    const result = parseExportFile(JSON.stringify(envelope));
    expect(result.invalidPlanCount).toBe(0);
    expect(result.plans).toHaveLength(1);
  });

  // Positive control for the #1178 check: a windGrid that DOES cover the
  // supplied mask bounds must still be accepted — proves the guard
  // discriminates rather than rejecting every import once maskBounds is
  // supplied. A 2x2x3 grid (lats/lons spanning TEST_MASK_META's corners,
  // 3 times) is built with CORRECTLY sized Float32Arrays and run through
  // the real `buildExportEnvelope` (its own `encodeWindGrid` does the
  // base64 encoding) so this exercises the exact round-trip, not a
  // hand-spliced partial object like the dimension-mismatch tests above —
  // those deliberately construct a broken shape; this one must not be one.
  it('accepts a plan whose windGrid covers the supplied mask bounds', () => {
    const base = makeTestPlan('covers-1');
    const covering: Plan = {
      ...base,
      windGrid: {
        lats: [TEST_MASK_META.south, TEST_MASK_META.north],
        lons: [TEST_MASK_META.west, TEST_MASK_META.east],
        timesMs: base.windGrid.timesMs,
        speedKn: new Float32Array(12).fill(5),
        dirFromDeg: new Float32Array(12).fill(90),
        gustKn: new Float32Array(12).fill(7),
        fetchedAtMs: base.windGrid.fetchedAtMs,
        model: base.windGrid.model,
      },
    };
    const envelope = buildExportEnvelope([covering], null, []);
    const result = parseExportFile(exportEnvelopeToJson(envelope), TEST_MASK_META);
    expect(result.invalidPlanCount).toBe(0);
    expect(result.plans).toHaveLength(1);
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
