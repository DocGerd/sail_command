import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { openWaterMask, TEST_POLAR, uniformWindGrid, makeMask } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PlanRequest, type PolarTable } from '../types';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines (2026-07-15 CI run: tests at ~1s locally took 30-44s). Fast test
// files keep vitest's 5s default so hang detection stays meaningful there.
vi.setConfig({ testTimeout: 120_000 });

/** Fock fixture: uniformly 12% slower than TEST_POLAR (genoa must win). */
const SLOW_FOCK: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.88)),
};

const req: PlanRequest = {
  origin: { lat: 54.7525, lon: 10.0025 },
  destination: { lat: 54.7525, lon: 10.4025 },
  viaPoints: [],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
  settings: DEFAULT_SETTINGS,
};
const deps = { polarGenoa: TEST_POLAR, polarFock: SLOW_FOCK, mask: openWaterMask() };

describe('planRoute', () => {
  it('runs both rigs and recommends the faster one', () => {
    const r = planRoute(req, uniformWindGrid(12, 0), deps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.genoa).not.toBeNull();
    expect(r.fock).not.toBeNull();
    expect(r.recommended).toBe('genoa');
    expect(r.genoa!.etaMs).toBeLessThanOrEqual(r.fock!.etaMs);
    expect(r.genoa!.maneuverCount).toBe(r.genoa!.legs.filter((l) => l.maneuverAtStart).length);
  });

  it('snaps origin off land and reports snapped coordinates', () => {
    // land west of col 162 (lon ≈ 10.21); origin on land near the edge
    const mask = makeMask((_, c) => (c < 162 ? 0 : 200));
    const r = planRoute(
      { ...req, origin: { lat: 54.7525, lon: 10.2095 }, destination: { lat: 54.7525, lon: 10.6025 } },
      uniformWindGrid(12, 0),
      { ...deps, mask },
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.snappedOrigin.lon).toBeGreaterThan(10.2095);
    expect(mask.isNavigable(r.snappedOrigin, DEFAULT_SETTINGS.safetyDepthM)).toBe(true);
  });

  it('fails with snap-failed-origin when origin is deep inland', () => {
    const mask = makeMask((_, c) => (c < 162 ? 0 : 200));
    const r = planRoute(
      { ...req, origin: { lat: 54.75, lon: 9.6 } },
      uniformWindGrid(12, 0),
      { ...deps, mask },
    );
    expect(r).toEqual({ status: 'error', reason: 'snap-failed-origin' });
  });

  it('reports progress per rig', () => {
    const seen = new Set<string>();
    planRoute(req, uniformWindGrid(12, 0), deps, (rig) => seen.add(rig));
    expect(seen).toEqual(new Set(['genoa', 'fock']));
  });

  it('recommends genoa on an exact ETA tie between rigs', () => {
    const tieDeps = { ...deps, polarFock: TEST_POLAR }; // identical polar table → identical solve
    const r = planRoute(req, uniformWindGrid(12, 0), tieDeps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.genoa!.etaMs).toBe(r.fock!.etaMs);
    expect(r.recommended).toBe('genoa');
  }, 60_000); // full two-rig solve measures ~5.5s — vitest's 5s default is borderline under load

  it('a single-rig failure surfaces that rig no-route reason; the surviving rig reason stays null', () => {
    // Fock's polar is scaled far below MIN_SAIL_KN at any realistic TWS, so with
    // the motor disabled it can never produce a sailing candidate — calm-motor-off —
    // while genoa's normal polar still solves fine in the same 12 kn wind.
    const calmFock: PolarTable = {
      ...TEST_POLAR,
      rig: 'fock',
      speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.01)),
    };
    const calmDeps = { ...deps, polarFock: calmFock };
    const settings = { ...DEFAULT_SETTINGS, motorEnabled: false };
    const r = planRoute({ ...req, settings }, uniformWindGrid(12, 0), calmDeps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.genoa).not.toBeNull();
    expect(r.genoaReason).toBeNull();
    expect(r.fock).toBeNull();
    expect(r.fockReason).toBe('calm-motor-off');
  }, 60_000); // full two-rig solve measures ~5.5s — vitest's 5s default is borderline under load
});
