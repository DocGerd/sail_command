import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { savePlan, getPlan, listPlans, deletePlan, saveSettings, loadSettings, __resetDbForTests } from './db';
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
    expect(Object.prototype.toString.call(retrieved?.windGrid.speedKn)).toBe('[object Float32Array]');
    expect(Array.from(retrieved?.windGrid.speedKn || [])).toEqual(Array.from(windGrid.speedKn));
    expect(Object.prototype.toString.call(retrieved?.windGrid.dirFromDeg)).toBe('[object Float32Array]');
    expect(Array.from(retrieved?.windGrid.dirFromDeg || [])).toEqual(Array.from(windGrid.dirFromDeg));
    expect(Object.prototype.toString.call(retrieved?.windGrid.gustKn)).toBe('[object Float32Array]');
    expect(Array.from(retrieved?.windGrid.gustKn || [])).toEqual(Array.from(windGrid.gustKn));
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
        settings: { safetyDepthM: 3.0, motorSpeedKn: 6.5, motorThresholdKn: 2.5, maneuverPenaltyS: 45, performanceFactor: 0.9, motorEnabled: true },
      },
      windGrid,
      result: {
        status: 'ok',
        genoa: { rig: 'genoa', legs: [], etaMs: 4000, durationMs: 3000, distanceNm: 40.0, maneuverCount: 1, motorDistanceNm: 0 },
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
        settings: { safetyDepthM: 3.0, motorSpeedKn: 6.5, motorThresholdKn: 2.5, maneuverPenaltyS: 45, performanceFactor: 0.9, motorEnabled: true },
      },
      windGrid,
      result: {
        status: 'ok',
        genoa: null,
        fock: { rig: 'fock', legs: [], etaMs: 5000, durationMs: 3000, distanceNm: 41.0, maneuverCount: 2, motorDistanceNm: 0 },
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
        settings: { safetyDepthM: 3.0, motorSpeedKn: 6.5, motorThresholdKn: 2.5, maneuverPenaltyS: 45, performanceFactor: 0.9, motorEnabled: true },
      },
      windGrid,
      result: {
        status: 'ok',
        genoa: { rig: 'genoa', legs: [], etaMs: 4000, durationMs: 3000, distanceNm: 40.0, maneuverCount: 1, motorDistanceNm: 0 },
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
    };

    await saveSettings(settings);
    const retrieved = await loadSettings();

    expect(retrieved).toEqual(settings);
  });

  it('loadSettings on fresh DB returns undefined', async () => {
    const retrieved = await loadSettings();
    expect(retrieved).toBeUndefined();
  });
});
