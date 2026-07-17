import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { makeMask, openWaterMask, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PlanRequest, type PolarTable, type Settings } from '../types';
import type { ProbeInfo } from './relaxedDepth';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines. Fast test files keep vitest's 5s default so hang detection
// stays meaningful there.
vi.setConfig({ testTimeout: 120_000 });

/** Fock fixture: uniformly 12% slower than TEST_POLAR (genoa must win). */
const SLOW_FOCK: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.88)),
};

// An E-W corridor (rows 85..105, ~11.5 km wide) walled by land, split by a
// wall at col 160 (lon ≈ 10.2) whose only opening (rows 90..99) is charted
// `gapDm` decimeters. The land frame keeps the doomed-frontier region small so
// the unreachable solves stay cheap.
const corridorGapMask = (gapDm: number) =>
  makeMask((r, c) => {
    if (r < 85 || r > 105) return 0;
    if (c === 160) return r >= 90 && r <= 99 ? gapDm : 0;
    return 200;
  });

// Cell centers (grid step 0.005°): row 90 (lat 54.7525), cols 120 / 200.
const req: PlanRequest = {
  origin: { lat: 54.7525, lon: 10.0025 },
  destination: { lat: 54.7525, lon: 10.4025 },
  viaPoints: [],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
  settings: DEFAULT_SETTINGS,
};

const depsWith = (mask: ReturnType<typeof makeMask>) => ({
  polarGenoa: TEST_POLAR,
  polarFock: SLOW_FOCK,
  mask,
});

describe('planRoute graceful shallow degradation (#53)', () => {
  it('relaxes an unreachable 3.0 m plan to the highest connecting gate and flags shallow legs', () => {
    const mask = corridorGapMask(25); // gap charted 2.5 m
    const probes: ProbeInfo[] = [];
    const settings = { ...DEFAULT_SETTINGS };
    const r = planRoute(
      { ...req, settings },
      uniformWindGrid(12, 0),
      depsWith(mask),
      undefined,
      (p) => probes.push(p),
    );

    // Hand-derived probe sequence over candidates dm 21..29: 2.5 connects
    // (lo=26), 2.7 fails (hi=26), 2.6 fails (hi=25) → relaxed gate 2.5.
    expect(probes.map((p) => p.probeDepthM)).toEqual([2.5, 2.7, 2.6]);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.shallow).toEqual({ requestedDepthM: 3.0, usedDepthM: 2.5, minGateDepthM: 2.5 });

    // Both rigs relax to the SAME gate (apples-to-apples rig comparison).
    for (const rig of [r.genoa, r.fock]) {
      expect(rig).not.toBeNull();
      const flagged = rig!.legs.filter((l) => l.shallow);
      expect(flagged.length).toBeGreaterThan(0);
      // The only sub-3.0 cells in this mask are the 2.5 m gap cells.
      for (const leg of flagged) expect(leg.shallow!.minDepthM).toBeCloseTo(2.5, 6);
      for (const leg of rig!.legs) {
        expect(mask.segmentNavigable(leg.start, leg.end, 2.5)).toBe(true);
        // Unflagged legs really don't cross sub-requested water.
        if (!leg.shallow) expect(mask.segmentShallowestBelow(leg.start, leg.end, 3.0)).toBeNull();
      }
      // The route genuinely uses the relaxed gate (some leg fails at 3.0 m).
      expect(rig!.legs.some((l) => !mask.segmentNavigable(l.start, l.end, 3.0))).toBe(true);
    }

    // The user's settings object is NEVER mutated by relaxation.
    expect(settings.safetyDepthM).toBe(3.0);
    expect(req.settings.safetyDepthM).toBe(3.0);
  });

  it('a plan that never relaxed carries no shallow fields at all (omitted, not undefined)', () => {
    const r = planRoute(req, uniformWindGrid(12, 0), depsWith(openWaterMask()));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect('shallow' in r).toBe(false);
    for (const leg of r.genoa!.legs) expect('shallow' in leg).toBe(false);
  });

  it('calm + motor off keeps its own error class — relaxation never fires', () => {
    const probes: ProbeInfo[] = [];
    const settings: Settings = { ...DEFAULT_SETTINGS, motorEnabled: false };
    const r = planRoute(
      { ...req, settings },
      uniformWindGrid(0, 0),
      depsWith(openWaterMask()),
      undefined,
      (p) => probes.push(p),
    );
    expect(r).toEqual({ status: 'error', reason: 'calm-motor-off' });
    expect(probes).toEqual([]);
  });

  it('beyond-horizon keeps its own error class — relaxation never fires', () => {
    const probes: ProbeInfo[] = [];
    // Grid hours 06..08 UTC; departure 08:00 → the very first step would
    // already overrun the horizon.
    const r = planRoute(
      req,
      uniformWindGrid(12, 0, { hours: 3 }),
      depsWith(openWaterMask()),
      undefined,
      (p) => probes.push(p),
    );
    expect(r).toEqual({ status: 'error', reason: 'beyond-horizon' });
    expect(probes).toEqual([]);
  });

  it('a genuinely unreachable destination still errors unreachable after the probe descent', () => {
    const probes: ProbeInfo[] = [];
    // Gap charted 1.5 m — below every candidate gate, nothing connects.
    const r = planRoute(
      req,
      uniformWindGrid(12, 0),
      depsWith(corridorGapMask(15)),
      undefined,
      (p) => probes.push(p),
    );
    expect(r).toEqual({ status: 'error', reason: 'unreachable' });
    // Hand-derived failing descent: 2.5, 2.2, 2.1 → null.
    expect(probes.map((p) => p.probeDepthM)).toEqual([2.5, 2.2, 2.1]);
  });

  it('requested depth at the boat draft floor never relaxes', () => {
    const probes: ProbeInfo[] = [];
    const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 2.1 };
    const r = planRoute(
      { ...req, settings },
      uniformWindGrid(12, 0),
      depsWith(corridorGapMask(19)), // 1.9 m gap: blocked even at 2.1
      undefined,
      (p) => probes.push(p),
    );
    expect(r).toEqual({ status: 'error', reason: 'unreachable' });
    expect(probes).toEqual([]);
  });
});
