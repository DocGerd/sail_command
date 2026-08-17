import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDB } from 'idb';
import {
  savePlan,
  getPlan,
  listPlans,
  deletePlan,
  saveSettings,
  loadSettings,
  __resetDbForTests,
} from './db';
import type { Plan, Settings, WindGrid } from '../types';
import { defaultBoatSnapshot } from '../types';
import { PLAN_SCHEMA_VERSION } from '../types';

describe('IndexedDB persistence', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  it('save→get roundtrip preserves windGrid.speedKn instanceof Float32Array and all values', async () => {
    const windGrid: WindGrid = {
      lats: [54.0, 54.5, 55.0],
      lons: [9.0, 9.5, 10.0],
      timesMs: [1000, 2000, 3000],
      speedKn: new Float32Array([5.1, 6.2, 7.3, 8.4, 9.5, 10.6, 11.7, 12.8, 13.9]),
      dirFromDeg: new Float32Array([90, 95, 100, 105, 110, 115, 120, 125, 130]),
      gustKn: new Float32Array([7.1, 8.2, 9.3, 10.4, 11.5, 12.6, 13.7, 14.8, 15.9]),
      fetchedAtMs: 1626340800000,
      model: 'open-meteo',
    };

    const plan: Plan = {
      id: 'test-plan-1',
      name: 'Flensburg to Marstal',
      createdAtMs: 1626340800000,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: { lat: 54.3, lon: 9.4 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1626340800000,
        settings: {
          safetyDepthM: 3.0,
          depthComfortMarginM: 2.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          sailPreferenceKn: 2.8,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid,
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

    await savePlan(plan);
    const retrieved = await getPlan('test-plan-1');

    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe('test-plan-1');

    // Verify Float32Arrays are preserved (not converted to plain arrays)
    // structured clone in vitest crosses VM realms, so instanceof fails even though the value is a
    // genuine Float32Array; the brand check is realm-independent (not a security-grade brand check —
    // a value could spoof this via its own Symbol.toStringTag — but no data on this path ever does)
    expect(Object.prototype.toString.call(retrieved?.windGrid.speedKn)).toBe(
      '[object Float32Array]',
    );
    expect(Array.from(retrieved?.windGrid.speedKn || [])).toEqual(Array.from(windGrid.speedKn));
    expect(Object.prototype.toString.call(retrieved?.windGrid.dirFromDeg)).toBe(
      '[object Float32Array]',
    );
    expect(Array.from(retrieved?.windGrid.dirFromDeg || [])).toEqual(
      Array.from(windGrid.dirFromDeg),
    );
    expect(Object.prototype.toString.call(retrieved?.windGrid.gustKn)).toBe(
      '[object Float32Array]',
    );
    expect(Array.from(retrieved?.windGrid.gustKn || [])).toEqual(Array.from(windGrid.gustKn));
  });

  it('save→get roundtrip preserves #53 shallow warnings (plan-level and per-leg) exactly', async () => {
    const windGrid: WindGrid = {
      lats: [54.0, 54.5],
      lons: [9.0, 9.5],
      timesMs: [1000, 2000],
      speedKn: new Float32Array([5.0, 6.0, 7.0, 8.0]),
      dirFromDeg: new Float32Array([90, 95, 100, 105]),
      gustKn: new Float32Array([7.0, 8.0, 9.0, 10.0]),
      fetchedAtMs: 1626340800000,
      model: 'open-meteo',
    };
    const legCommon = {
      start: { lat: 54.75, lon: 10.0 },
      end: { lat: 54.75, lon: 10.2 },
      startTimeMs: 1626340800000,
      endTimeMs: 1626344400000,
      headingDeg: 90,
      twsKn: 12,
      speedKn: 6,
      distanceNm: 6,
    };
    const plan: Plan = {
      id: 'shallow-plan-1',
      name: 'Flensburg → Marstal',
      createdAtMs: 1626340800000,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: { lat: 54.75, lon: 10.0 },
        destination: { lat: 54.75, lon: 10.4 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1626340800000,
        settings: {
          safetyDepthM: 3.0,
          depthComfortMarginM: 2.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          sailPreferenceKn: 2.8,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid,
      result: {
        status: 'ok',
        sails: [
          {
            sailId: 'genoa',
            reason: null,
            result: {
              sailId: 'genoa',
              legs: [
                // Both Leg variants carry the shallow flag; one leg stays unflagged.
                {
                  ...legCommon,
                  kind: 'sail',
                  board: 'starboard',
                  twaDeg: 90,
                  maneuverAtStart: null,
                  shallow: { minDepthM: 2.3 },
                },
                {
                  ...legCommon,
                  kind: 'motor',
                  board: null,
                  maneuverAtStart: null,
                  shallow: { minDepthM: 2.5 },
                },
                {
                  ...legCommon,
                  kind: 'sail',
                  board: 'port',
                  twaDeg: -90,
                  maneuverAtStart: 'tack',
                },
              ],
              etaMs: 1626344400000,
              durationMs: 3600000,
              distanceNm: 18,
              maneuverCount: 1,
              motorDistanceNm: 6,
            },
          },
          { sailId: 'fock', result: null, reason: null },
        ],
        recommended: 'genoa',
        comparisonComplete: true,
        snappedOrigin: { lat: 54.75, lon: 10.0 },
        snappedDestination: { lat: 54.75, lon: 10.4 },
        shallow: { requestedDepthM: 3.0, usedDepthM: 2.3, minGateDepthM: 2.3 },
      },
    };

    await savePlan(plan);
    const retrieved = await getPlan('shallow-plan-1');
    expect(retrieved?.result.shallow).toEqual({
      requestedDepthM: 3.0,
      usedDepthM: 2.3,
      minGateDepthM: 2.3,
    });
    const legs = retrieved?.result.sails.find((s) => s.sailId === 'genoa')?.result?.legs ?? [];
    expect(legs[0].shallow).toEqual({ minDepthM: 2.3 });
    expect(legs[1].shallow).toEqual({ minDepthM: 2.5 });
    expect('shallow' in legs[2]).toBe(false);
  });

  it('listPlans returns summaries newest-first without wind grids', async () => {
    const windGrid: WindGrid = {
      lats: [54.0, 54.5],
      lons: [9.0, 9.5],
      timesMs: [1000, 2000],
      speedKn: new Float32Array([5.0, 6.0, 7.0, 8.0]),
      dirFromDeg: new Float32Array([90, 95, 100, 105]),
      gustKn: new Float32Array([7.0, 8.0, 9.0, 10.0]),
      fetchedAtMs: 1626340800000,
      model: 'open-meteo',
    };

    const plan1: Plan = {
      id: 'plan-1',
      name: 'Plan 1',
      createdAtMs: 1000,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1000,
        settings: {
          safetyDepthM: 3.0,
          depthComfortMarginM: 2.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          sailPreferenceKn: 2.8,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid,
      result: {
        status: 'ok',
        sails: [
          {
            sailId: 'genoa',
            result: {
              sailId: 'genoa',
              legs: [],
              etaMs: 4000,
              durationMs: 3000,
              distanceNm: 40.0,
              maneuverCount: 1,
              motorDistanceNm: 0,
            },
            reason: null,
          },
          { sailId: 'fock', result: null, reason: null },
        ],
        recommended: 'genoa',
        comparisonComplete: true,
        snappedOrigin: { lat: 54.0, lon: 9.0 },
        snappedDestination: { lat: 55.0, lon: 10.0 },
      },
    };

    const plan2: Plan = {
      id: 'plan-2',
      name: 'Plan 2',
      createdAtMs: 2000,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 2000,
        settings: {
          safetyDepthM: 3.0,
          depthComfortMarginM: 2.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          sailPreferenceKn: 2.8,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid,
      result: {
        status: 'ok',
        sails: [
          { sailId: 'genoa', result: null, reason: null },
          {
            sailId: 'fock',
            result: {
              sailId: 'fock',
              legs: [],
              etaMs: 5000,
              durationMs: 3000,
              distanceNm: 41.0,
              maneuverCount: 2,
              motorDistanceNm: 0,
            },
            reason: null,
          },
        ],
        recommended: 'fock',
        comparisonComplete: true,
        snappedOrigin: { lat: 54.0, lon: 9.0 },
        snappedDestination: { lat: 55.0, lon: 10.0 },
      },
    };

    await savePlan(plan1);
    await savePlan(plan2);

    const summaries = await listPlans();

    expect(summaries).toHaveLength(2);
    // Newest first: plan2 (createdAtMs 2000) comes before plan1 (createdAtMs 1000)
    expect(summaries[0].id).toBe('plan-2');
    expect(summaries[1].id).toBe('plan-1');

    // Verify summary structure and that windGrid is not included
    expect(summaries[0]).toEqual({
      kind: 'ok',
      id: 'plan-2',
      name: 'Plan 2',
      createdAtMs: 2000,
      departureMs: 2000,
      recommended: 'fock',
      etaMs: 5000,
    });
    expect(summaries[1]).toEqual({
      kind: 'ok',
      id: 'plan-1',
      name: 'Plan 1',
      createdAtMs: 1000,
      departureMs: 1000,
      recommended: 'genoa',
      etaMs: 4000,
    });
  });

  it('savePlan upserts by id: saving the same id again keeps one entry with the latest data', async () => {
    const windGrid: WindGrid = {
      lats: [54.0],
      lons: [9.0],
      timesMs: [1000],
      speedKn: new Float32Array([5.0]),
      dirFromDeg: new Float32Array([90]),
      gustKn: new Float32Array([7.0]),
      fetchedAtMs: 1626340800000,
      model: 'open-meteo',
    };

    const basePlan: Plan = {
      id: 'upsert-me',
      name: 'Original Name',
      createdAtMs: 1000,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1000,
        settings: {
          safetyDepthM: 3.0,
          depthComfortMarginM: 2.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          sailPreferenceKn: 2.8,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid,
      result: {
        status: 'ok',
        sails: [
          {
            sailId: 'genoa',
            result: {
              sailId: 'genoa',
              legs: [],
              etaMs: 4000,
              durationMs: 3000,
              distanceNm: 40.0,
              maneuverCount: 1,
              motorDistanceNm: 0,
            },
            reason: null,
          },
          { sailId: 'fock', result: null, reason: null },
        ],
        recommended: 'genoa',
        comparisonComplete: true,
        snappedOrigin: { lat: 54.0, lon: 9.0 },
        snappedDestination: { lat: 55.0, lon: 10.0 },
      },
    };

    await savePlan(basePlan);
    await savePlan({ ...basePlan, name: 'Renamed' });

    const retrieved = await getPlan('upsert-me');
    expect(retrieved?.name).toBe('Renamed');

    const summaries = await listPlans();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('Renamed');
  });

  it('#54: listPlans LISTS an invariant-violating plan as unreadable — never skipped, never deleted', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const windGrid: WindGrid = {
      lats: [54.0],
      lons: [9.0],
      timesMs: [1000],
      speedKn: new Float32Array([5.0]),
      dirFromDeg: new Float32Array([90]),
      gustKn: new Float32Array([7.0]),
      fetchedAtMs: 1626340800000,
      model: 'open-meteo',
    };

    // Hand-built to violate the invariant status 'ok' is supposed to guarantee:
    // recommended === 'genoa' but genoa is null.
    const brokenPlan: Plan = {
      id: 'broken-invariant',
      name: 'Broken',
      createdAtMs: 500,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1000,
        settings: {
          safetyDepthM: 3.0,
          depthComfortMarginM: 2.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          sailPreferenceKn: 2.8,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid,
      result: {
        status: 'ok',
        sails: [
          { sailId: 'genoa', result: null, reason: 'unreachable' },
          {
            sailId: 'fock',
            result: {
              sailId: 'fock',
              legs: [],
              etaMs: 5000,
              durationMs: 3000,
              distanceNm: 41.0,
              maneuverCount: 2,
              motorDistanceNm: 0,
            },
            reason: null,
          },
        ],
        recommended: 'genoa',
        comparisonComplete: true,
        snappedOrigin: { lat: 54.0, lon: 9.0 },
        snappedDestination: { lat: 55.0, lon: 10.0 },
      },
    };

    const validPlan: Plan = {
      id: 'valid-plan',
      name: 'Valid',
      createdAtMs: 1500,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1500,
        settings: {
          safetyDepthM: 3.0,
          depthComfortMarginM: 2.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          sailPreferenceKn: 2.8,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid,
      result: {
        status: 'ok',
        sails: [
          {
            sailId: 'genoa',
            result: {
              sailId: 'genoa',
              legs: [],
              etaMs: 6000,
              durationMs: 3000,
              distanceNm: 20.0,
              maneuverCount: 0,
              motorDistanceNm: 0,
            },
            reason: null,
          },
          { sailId: 'fock', result: null, reason: null },
        ],
        recommended: 'genoa',
        comparisonComplete: true,
        snappedOrigin: { lat: 54.0, lon: 9.0 },
        snappedDestination: { lat: 55.0, lon: 10.0 },
      },
    };

    await savePlan(brokenPlan);
    await savePlan(validPlan);

    const summaries = await listPlans();

    // #54 spec §I.3: LISTED as unreadable, never skipped. Newest first, so
    // the valid plan (createdAtMs 1500) precedes the broken one (500).
    expect(summaries).toHaveLength(2);
    expect(summaries[0].id).toBe('valid-plan');
    expect(summaries[0].kind).toBe('ok');
    expect(summaries[1]).toEqual({
      kind: 'unreadable',
      reason: 'damaged',
      id: 'broken-invariant',
      name: 'Broken',
      createdAtMs: 500,
    });
    // The record is still in the store — listing it is a placeholder, never a
    // delete, so a second call sees exactly the same two rows.
    expect(await listPlans()).toEqual(summaries);
    // Nothing is logged: an unreadable record is a listed state now, not a
    // caught exception.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('deletePlan removes the plan', async () => {
    const windGrid: WindGrid = {
      lats: [54.0],
      lons: [9.0],
      timesMs: [1000],
      speedKn: new Float32Array([5.0]),
      dirFromDeg: new Float32Array([90]),
      gustKn: new Float32Array([7.0]),
      fetchedAtMs: 1626340800000,
      model: 'open-meteo',
    };

    const plan: Plan = {
      id: 'delete-me',
      name: 'Delete Me',
      createdAtMs: 1000,
      schemaVersion: PLAN_SCHEMA_VERSION,
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1000,
        settings: {
          safetyDepthM: 3.0,
          depthComfortMarginM: 2.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          sailPreferenceKn: 2.8,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      windGrid,
      result: {
        status: 'ok',
        sails: [
          {
            sailId: 'genoa',
            result: {
              sailId: 'genoa',
              legs: [],
              etaMs: 4000,
              durationMs: 3000,
              distanceNm: 40.0,
              maneuverCount: 1,
              motorDistanceNm: 0,
            },
            reason: null,
          },
          { sailId: 'fock', result: null, reason: null },
        ],
        recommended: 'genoa',
        comparisonComplete: true,
        snappedOrigin: { lat: 54.0, lon: 9.0 },
        snappedDestination: { lat: 55.0, lon: 10.0 },
      },
    };

    await savePlan(plan);
    let retrieved = await getPlan('delete-me');
    expect(retrieved).toBeDefined();

    await deletePlan('delete-me');
    retrieved = await getPlan('delete-me');
    expect(retrieved).toBeUndefined();
  });

  it('settings roundtrip preserves all values', async () => {
    const settings: Settings = {
      safetyDepthM: 2.5,
      // Non-default (DEFAULT_SETTINGS.depthComfortMarginM is 2.0): same
      // "distinguishes roundtrip from happens-to-equal-default" rationale as
      // showOwnship below.
      depthComfortMarginM: 1.5,
      motorSpeedKn: 7.0,
      motorThresholdKn: 3.0,
      sailPreferenceKn: 2.8,
      maneuverPenaltyS: 50,
      performanceFactor: 0.85,
      motorEnabled: false,
      // Non-default (DEFAULT_SETTINGS.showOwnship is false): distinguishes
      // "roundtrip preserves the field" from "field happens to equal the
      // default whether or not it round-trips at all".
      showOwnship: true,
    };

    await saveSettings(settings);
    const retrieved = await loadSettings();

    expect(retrieved).toEqual(settings);
  });

  it('settings roundtrip preserves the #25 AIS fields (aisApiKey, ownMmsi)', async () => {
    const settings: Settings = {
      safetyDepthM: 3.0,
      depthComfortMarginM: 2.0,
      motorSpeedKn: 6.5,
      motorThresholdKn: 2.5,
      sailPreferenceKn: 2.8,
      maneuverPenaltyS: 45,
      performanceFactor: 0.9,
      motorEnabled: true,
      showOwnship: false,
      aisApiKey: 'abc123-key',
      ownMmsi: '002110000',
    };

    await saveSettings(settings);
    const retrieved = await loadSettings();

    expect(retrieved).toEqual(settings);
    // Explicitly pin the leading-zero MMSI survives as a string, not a number.
    expect(retrieved?.ownMmsi).toBe('002110000');
  });

  it('loadSettings on fresh DB returns undefined', async () => {
    const retrieved = await loadSettings();
    expect(retrieved).toBeUndefined();
  });
});

// #54 spec §I.3: lazy read-time normalisation. A stored record is migrated on
// the way OUT, never by an IndexedDB version bump — the database is
// origin-scoped, so production and UAT share it and a bump would strand
// production's whole database for the session.
describe('#54 lazy plan migration at the read boundary', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  function legacyRecord(id: string, createdAtMs: number): Plan {
    const windGrid: WindGrid = {
      lats: [54.0],
      lons: [9.0],
      timesMs: [1000],
      speedKn: new Float32Array([5.0]),
      dirFromDeg: new Float32Array([90]),
      gustKn: new Float32Array([7.0]),
      fetchedAtMs: 1_626_340_800_000,
      model: 'open-meteo',
    };
    // Pre-#54 on the wire: no schemaVersion, no request.boat/sailIds, the
    // genoa/fock quartet on the result, and `rig` on the RigResult. Cast
    // because that shape deliberately does not satisfy today's Plan.
    return {
      id,
      name: 'Legacy',
      createdAtMs,
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1000,
        settings: {
          safetyDepthM: 3.0,
          depthComfortMarginM: 2.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          sailPreferenceKn: 2.8,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
      },
      windGrid,
      result: {
        status: 'ok',
        genoa: {
          rig: 'genoa',
          legs: [],
          etaMs: 4000,
          durationMs: 3000,
          distanceNm: 10,
          maneuverCount: 0,
          motorDistanceNm: 0,
        },
        fock: null,
        genoaReason: null,
        fockReason: 'unreachable',
        recommended: 'genoa',
        snappedOrigin: { lat: 54.0, lon: 9.0 },
        snappedDestination: { lat: 55.0, lon: 10.0 },
      },
    } as unknown as Plan;
  }

  it('getPlan migrates a pre-#54 record on read, wind grid intact', async () => {
    await savePlan(legacyRecord('legacy-1', 1000));
    const plan = await getPlan('legacy-1');
    expect(plan!.schemaVersion).toBe(PLAN_SCHEMA_VERSION);
    expect(plan!.request.boat.id).toBe('salona-45');
    expect(plan!.result.sails.map((s) => s.sailId)).toEqual(['genoa', 'fock']);
    // Realm-independent brand check: structured clone in vitest crosses VM
    // realms, so `instanceof` fails on a genuine Float32Array (see the
    // save→get roundtrip test above for the same reason).
    expect(Object.prototype.toString.call(plan!.windGrid.speedKn)).toBe('[object Float32Array]');
    expect(plan!.windGrid.speedKn[0]).toBe(5.0);
  });

  // Reads the record the way IndexedDB actually holds it, bypassing db.ts's
  // own normaliser — every path through getPlan/listPlans migrates on read,
  // so nothing routed through them can tell a written-back record from a
  // freshly-migrated one.
  async function rawStored(id: string): Promise<Record<string, unknown> | undefined> {
    const conn = await openDB('sailcommand', 1);
    try {
      return (await conn.get('plans', id)) as Record<string, unknown> | undefined;
    } finally {
      conn.close();
    }
  }

  // THE data-loss keeper. Prod and /uat/ share one origin-scoped database and
  // production still reads result.genoa/result.fock, so a write-back that
  // rebuilds the record — which migratePlan does, from named fields — would
  // make a production user's saved plans vanish from their Routes list on a
  // single unprompted /uat/ boot (useSessionRestore calls getPlan at boot).
  // See getPlan's own doc comment for the full chain.
  it('getPlan leaves the stored record byte-identical — a read never writes', async () => {
    await savePlan(legacyRecord('legacy-1', 1000));
    const before = await rawStored('legacy-1');

    const plan = await getPlan('legacy-1');

    // Control: the READ really did migrate, so this is not passing because
    // nothing happened.
    expect(plan!.schemaVersion).toBe(PLAN_SCHEMA_VERSION);
    expect(plan!.request.boat.id).toBe('salona-45');
    expect(await rawStored('legacy-1')).toEqual(before);
  });

  // The durable invariant, stated separately from the "writes nothing"
  // contract above so it still holds if a future ADDITIVE write-back is ever
  // introduced deliberately: whatever getPlan does, it must never REMOVE a
  // key the stored record had. The legacy quartet is what production reads.
  it.each([
    ['top level', (r: Record<string, unknown>) => r],
    ['result', (r: Record<string, unknown>) => r.result as Record<string, unknown>],
    ['request', (r: Record<string, unknown>) => r.request as Record<string, unknown>],
  ])('getPlan removes no stored key (%s)', async (_label, pick) => {
    await savePlan(legacyRecord('legacy-1', 1000));
    const before = Object.keys(pick((await rawStored('legacy-1'))!)).sort();

    await getPlan('legacy-1');

    expect(Object.keys(pick((await rawStored('legacy-1'))!)).sort()).toEqual(
      expect.arrayContaining(before),
    );
  });

  it('listPlans summarises a pre-#54 record as a readable row', async () => {
    await savePlan(legacyRecord('legacy-1', 1000));
    const summaries = await listPlans();
    expect(summaries).toEqual([
      {
        kind: 'ok',
        id: 'legacy-1',
        name: 'Legacy',
        createdAtMs: 1000,
        departureMs: 1000,
        recommended: 'genoa',
        etaMs: 4000,
      },
    ]);
  });

  it('getPlan reports an unreadable record as absent and leaves it in the store', async () => {
    const future = { ...legacyRecord('future-1', 1000), schemaVersion: 999 } as unknown as Plan;
    await savePlan(future);
    expect(await getPlan('future-1')).toBeUndefined();
    // Still listed — the read refused it, nothing deleted it.
    expect(await listPlans()).toEqual([
      {
        kind: 'unreadable',
        reason: 'newer-version',
        id: 'future-1',
        name: 'Legacy',
        createdAtMs: 1000,
      },
    ]);
  });

  it('lists a readable and an unreadable record side by side, newest first', async () => {
    await savePlan(legacyRecord('good-1', 2000));
    await savePlan({ ...legacyRecord('future-1', 1000), schemaVersion: 999 } as unknown as Plan);
    const summaries = await listPlans();
    expect(summaries.map((s) => [s.id, s.kind])).toEqual([
      ['good-1', 'ok'],
      ['future-1', 'unreadable'],
    ]);
  });

  // A record written by a newer build is INTACT and openable there; a damaged
  // one is not. The two get different copy, so the row must carry which.
  it('distinguishes a newer-version record from a damaged one', async () => {
    await savePlan({ ...legacyRecord('future-1', 3000), schemaVersion: 999 } as unknown as Plan);
    const damaged = legacyRecord('damaged-1', 2000) as unknown as Record<string, unknown>;
    delete (damaged.result as Record<string, unknown>).snappedOrigin;
    await savePlan(damaged as unknown as Plan);

    const rows = await listPlans();
    expect(rows.map((r) => [r.id, r.kind === 'unreadable' ? r.reason : 'ok'])).toEqual([
      ['future-1', 'newer-version'],
      ['damaged-1', 'damaged'],
    ]);
  });

  // The listing reads the OBJECT STORE, not the by-createdAt index.
  // IndexedDB drops a record from an index when its key path is absent or not
  // a valid key — and a missing/NaN createdAtMs is exactly what migratePlan
  // refuses, so an index-backed listing silently skipped precisely the
  // records the unreadable placeholder exists for.
  it.each([
    ['an absent createdAtMs', undefined],
    ['a null createdAtMs', null],
    ['a NaN createdAtMs', Number.NaN],
  ])('lists a record with %s instead of skipping it', async (_label, createdAtMs) => {
    const raw = legacyRecord('no-date', 0) as unknown as Record<string, unknown>;
    if (createdAtMs === undefined) delete raw.createdAtMs;
    else raw.createdAtMs = createdAtMs;
    // savePlan is a plain put and the store's keyPath is `id`, so a record
    // with no usable createdAtMs stores fine — it is only the INDEX that
    // drops it, which is the whole point of this row.
    await savePlan(raw as unknown as Plan);

    const rows = await listPlans();
    expect(rows.map((r) => [r.id, r.kind])).toEqual([['no-date', 'unreadable']]);
    expect(rows[0]!.createdAtMs).toBe(0);
  });
});
