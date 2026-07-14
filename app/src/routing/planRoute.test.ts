import { describe, expect, it } from 'vitest';
import { planRoute } from './planRoute';
import { openWaterMask, TEST_POLAR, uniformWindGrid, makeMask } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PlanRequest, type PolarTable } from '../types';

/** Fock fixture: uniformly 12% slower than TEST_POLAR (genoa must win). */
const SLOW_FOCK: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.88)),
};

const req: PlanRequest = {
  origin: { lat: 54.75, lon: 10.0 },
  destination: { lat: 54.75, lon: 10.4 },
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
      { ...req, origin: { lat: 54.75, lon: 10.207 }, destination: { lat: 54.75, lon: 10.6 } },
      uniformWindGrid(12, 0),
      { ...deps, mask },
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.snappedOrigin.lon).toBeGreaterThan(10.207);
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
});
