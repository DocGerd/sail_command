import { describe, expect, it, vi } from 'vitest';
import { backtrack, solve } from './isochrone';
import { approachGate, APPROACH_RADIUS_M, gateFloorM, uniformGate } from '../lib/depthGate';
import { initialBearingDeg, normalizeDeg180 } from '../lib/geo';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { makeMask, openWaterMask, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { DEFAULT_SETTINGS, type MaskMeta } from '../types';

vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// #1705: backtrack's collinear merge must not emit a chord the gate rejects.
const META: MaskMeta = { west: 9.9, south: 54.7, east: 10.1, north: 54.8, cols: 256, rows: 128 };
const CELL = 0.00078125;

// 3.5 m requested outside the disc, 2.6 m inside it; the disc is far from the scenario.
const FAR = { lat: META.south + 10.5 * CELL, lon: META.west + 5.5 * CELL };
const GATE = approachGate(META, [FAR], 3.5, [2.6], APPROACH_RADIUS_M);

type Chain = Parameters<typeof backtrack>[0];

/**
 * A -> B -> C eastward, B bent north of the A-C chord so the two headings
 * differ by ~0.45 deg. The chord runs ~1 m south of a row boundary; the cells
 * under its midpoint are 3.0 m deep: below the requested 3.5 m gate outside the
 * disc, yet at or above the field's 2.6 m floor, so only the per-cell gate rejects
 * them. Both sub-steps clear them by rising into the next row first.
 */
function scenario(blockerByte = 30) {
  const row = 64;
  const boundaryLat = META.south + (row + 1) * CELL;
  const lat0 = boundaryLat - 9e-6;
  const midCol = 128;
  const lonAt = (col: number) => META.west + (col + 0.5) * CELL;
  const A = { lat: lat0, lon: lonAt(midCol - 40) };
  const C = { lat: lat0, lon: lonAt(midCol + 40) };
  const B = { lat: lat0 + 7.07e-5, lon: lonAt(midCol) };
  const mask = makeMask(
    (r, c) => (r === row && Math.abs(c - midCol) <= 1 ? blockerByte : 200),
    META,
  );

  const node = (p: { lat: number; lon: number }, parent: Chain | null, tMs: number): Chain => ({
    lat: p.lat,
    lon: p.lon,
    tMs,
    costMs: tMs,
    kind: parent === null ? 'start' : 'motor',
    board: null,
    headingDeg: parent === null ? 0 : initialBearingDeg(parent, p),
    twaSigned: NaN,
    stepSpeedKn: 6,
    twsKn: 5,
    maneuverAtStart: null,
    maneuvers: 0,
    distToDestNm: 0,
    parent,
  });
  const start = node(A, null, 0);
  const b = node(B, start, 600_000);
  const c = node(C, b, 1_200_000);
  return { A, B, C, mask, c, b };
}

describe('backtrack collinear merge (#1705)', () => {
  it('scenario preconditions: sub-steps pass, chord fails, headings merge-eligible', () => {
    const { A, B, C, mask, b, c } = scenario();
    expect(mask.segmentNavigable(A, B, GATE)).toBe(true);
    expect(mask.segmentNavigable(B, C, GATE)).toBe(true);
    expect(mask.segmentNavigable(A, C, GATE)).toBe(false);
    expect(mask.segmentNavigable(A, C, uniformGate(gateFloorM(GATE)))).toBe(true);
    const diff = Math.abs(normalizeDeg180(b.headingDeg - c.headingDeg));
    expect(diff).toBeGreaterThan(0.4);
    expect(diff).toBeLessThan(0.5);
  });

  it('keeps the steps separate when the merged chord fails the gate', () => {
    const { A, B, C, mask, c } = scenario();
    const legs = backtrack(c, 0, mask, GATE);
    expect(legs.map((l) => [l.start, l.end])).toEqual([
      [A, B],
      [B, C],
    ]);
  });

  it('also keeps the steps separate when the blocker is land', () => {
    const { c, mask } = scenario(0);
    expect(backtrack(c, 0, mask, GATE)).toHaveLength(2);
  });

  it('still merges collinear steps whose chord passes the gate', () => {
    const { A, C, c } = scenario();
    const open = makeMask(() => 200, META);
    const legs = backtrack(c, 0, open, GATE);
    expect(legs).toHaveLength(1);
    expect(legs[0].start).toEqual(A);
    expect(legs[0].end).toEqual(C);
  });
});

// #1753: a backtrack handed any gate but the solve's own would silently disable the
// merge check above, and open-water results would not show it.
describe('solve hands backtrack its own gate (#1753)', () => {
  it('every mask query, merge checks included, uses the gate solve was given', () => {
    const mask = openWaterMask();
    // Distinct from settings.safetyDepthM so a settings-derived substitute differs by value too.
    const gate = uniformGate(2.5);
    let calls = 0;
    let foreign = 0;
    const navigable = mask.segmentNavigable.bind(mask);
    const clearance = mask.segmentClearanceM.bind(mask);
    mask.segmentNavigable = (a, b, g) => {
      calls++;
      if (g !== gate) foreign++;
      return navigable(a, b, g);
    };
    mask.segmentClearanceM = (a, b, g) => {
      calls++;
      if (g !== gate) foreign++;
      return clearance(a, b, g);
    };

    const r = solve({
      origin: { lat: 54.75, lon: 10.0 },
      destination: { lat: 54.75, lon: 10.115 },
      departureMs: Date.UTC(2026, 6, 15, 8),
      polar: new Polar(TEST_POLAR, 1.0),
      wind: new WindField(uniformWindGrid(12, 0)),
      mask,
      settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
      gate,
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(calls).toBeGreaterThan(0);
    // Longer than the solver's longest step (dtS): only backtrack's merge, which must
    // pass segmentNavigable, can produce it, so backtrack's queries were recorded.
    expect(Math.max(...r.legs.map((l) => l.endTimeMs - l.startTimeMs))).toBeGreaterThan(600_000);
    expect(foreign).toBe(0);
  });
});
