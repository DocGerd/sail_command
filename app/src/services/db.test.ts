import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
      request: {
        origin: { lat: 54.3, lon: 9.4 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1626340800000,
        settings: {
          safetyDepthM: 3.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
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
          etaMs: 1626344400000,
          durationMs: 3600000,
          distanceNm: 42.5,
          maneuverCount: 2,
          motorDistanceNm: 0,
        },
        fock: null,
        genoaReason: null,
        fockReason: null,
        recommended: 'genoa',
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
      request: {
        origin: { lat: 54.75, lon: 10.0 },
        destination: { lat: 54.75, lon: 10.4 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1626340800000,
        settings: {
          safetyDepthM: 3.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
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
            { ...legCommon, kind: 'sail', board: 'port', twaDeg: -90, maneuverAtStart: 'tack' },
          ],
          etaMs: 1626344400000,
          durationMs: 3600000,
          distanceNm: 18,
          maneuverCount: 1,
          motorDistanceNm: 6,
        },
        fock: null,
        genoaReason: null,
        fockReason: null,
        recommended: 'genoa',
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
    const legs = retrieved?.result.genoa?.legs ?? [];
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
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1000,
        settings: {
          safetyDepthM: 3.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
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
          distanceNm: 40.0,
          maneuverCount: 1,
          motorDistanceNm: 0,
        },
        fock: null,
        genoaReason: null,
        fockReason: null,
        recommended: 'genoa',
        snappedOrigin: { lat: 54.0, lon: 9.0 },
        snappedDestination: { lat: 55.0, lon: 10.0 },
      },
    };

    const plan2: Plan = {
      id: 'plan-2',
      name: 'Plan 2',
      createdAtMs: 2000,
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 2000,
        settings: {
          safetyDepthM: 3.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
      },
      windGrid,
      result: {
        status: 'ok',
        genoa: null,
        fock: {
          rig: 'fock',
          legs: [],
          etaMs: 5000,
          durationMs: 3000,
          distanceNm: 41.0,
          maneuverCount: 2,
          motorDistanceNm: 0,
        },
        genoaReason: null,
        fockReason: null,
        recommended: 'fock',
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
      id: 'plan-2',
      name: 'Plan 2',
      createdAtMs: 2000,
      departureMs: 2000,
      recommended: 'fock',
      etaMs: 5000,
    });
    expect(summaries[1]).toEqual({
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
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1000,
        settings: {
          safetyDepthM: 3.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
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
          distanceNm: 40.0,
          maneuverCount: 1,
          motorDistanceNm: 0,
        },
        fock: null,
        genoaReason: null,
        fockReason: null,
        recommended: 'genoa',
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

  it('listPlans isolates a corrupt plan (recommendedResult throws): skips it with console.error, still returns the valid rows', async () => {
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
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1000,
        settings: {
          safetyDepthM: 3.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
      },
      windGrid,
      result: {
        status: 'ok',
        genoa: null,
        fock: {
          rig: 'fock',
          legs: [],
          etaMs: 5000,
          durationMs: 3000,
          distanceNm: 41.0,
          maneuverCount: 2,
          motorDistanceNm: 0,
        },
        genoaReason: 'unreachable',
        fockReason: null,
        recommended: 'genoa',
        snappedOrigin: { lat: 54.0, lon: 9.0 },
        snappedDestination: { lat: 55.0, lon: 10.0 },
      },
    };

    const validPlan: Plan = {
      id: 'valid-plan',
      name: 'Valid',
      createdAtMs: 1500,
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1500,
        settings: {
          safetyDepthM: 3.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
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
          etaMs: 6000,
          durationMs: 3000,
          distanceNm: 20.0,
          maneuverCount: 0,
          motorDistanceNm: 0,
        },
        fock: null,
        genoaReason: null,
        fockReason: null,
        recommended: 'genoa',
        snappedOrigin: { lat: 54.0, lon: 9.0 },
        snappedDestination: { lat: 55.0, lon: 10.0 },
      },
    };

    await savePlan(brokenPlan);
    await savePlan(validPlan);

    const summaries = await listPlans();

    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe('valid-plan');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('broken-invariant'),
      expect.any(Error),
    );
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
      request: {
        origin: { lat: 54.0, lon: 9.0 },
        destination: { lat: 55.0, lon: 10.0 },
        viaPoints: [],
        originHarborId: null,
        destinationHarborId: null,
        departureMs: 1000,
        settings: {
          safetyDepthM: 3.0,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
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
          distanceNm: 40.0,
          maneuverCount: 1,
          motorDistanceNm: 0,
        },
        fock: null,
        genoaReason: null,
        fockReason: null,
        recommended: 'genoa',
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
      motorSpeedKn: 7.0,
      motorThresholdKn: 3.0,
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
      motorSpeedKn: 6.5,
      motorThresholdKn: 2.5,
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
