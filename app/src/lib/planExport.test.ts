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
    windGrid: {
      lats: [54.0, 54.5, 55.0],
      lons: [9.0, 9.5, 10.0],
      timesMs: [1000, 2000, 3000],
      // Deliberately three DIFFERENT value sets so a field-swap mutation
      // (e.g. gustKn <-> dirFromDeg) is observable rather than accidentally
      // symmetric.
      speedKn: new Float32Array([5.1, 6.2, 7.3, 8.4, 9.5, 10.6, 11.7, 12.8, 13.9]),
      dirFromDeg: new Float32Array([90, 95, 100, 105, 110, 115, 120, 125, 130]),
      gustKn: new Float32Array([7.1, 8.2, 9.3, 10.4, 11.5, 12.6, 13.7, 14.8, 15.9]),
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
