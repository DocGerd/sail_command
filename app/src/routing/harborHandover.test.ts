import { describe, expect, it, vi } from 'vitest';
import { planWithHarborHandover, type PlanFn } from './harborHandover';
import {
  makeMask,
  testPlanDeps,
  TEST_MASK_META,
  TEST_POLAR,
  uniformWindGrid,
} from '../test/fixtures';
import { findHarborHandover } from '../lib/harborReachability';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  type LatLon,
  type PlanRequest,
  type PlanResult,
  type PlanResultOk,
} from '../types';
import type { PlanDeadline } from './planRoute';

// Synthetic pockets on TEST_MASK_META (row 0 = south, 0.005° cells): 20 m water
// everywhere except rings around three harbour cells.
//   A: a 1.0 m ring one cell wide — `unreachable`, handover three cells out.
//   B: a 1.0 m block six cells wide — `unreachable`, no handover within 1852 m.
//   C: a 2.5 m ring — `shallow-approach` (the default boat's floor is 2.1 m).
const A = { row: 100, col: 200 };
const B = { row: 40, col: 80 };
const C = { row: 160, col: 250 };
const OPEN = { row: 100, col: 280 };

function cheb(a: { row: number; col: number }, row: number, col: number): number {
  return Math.max(Math.abs(row - a.row), Math.abs(col - a.col));
}

const mask = makeMask((row, col) => {
  const dA = cheb(A, row, col);
  if (dA === 1) return 10;
  const dB = cheb(B, row, col);
  if (dB >= 1 && dB <= 6) return 10;
  if (cheb(C, row, col) === 1) return 25;
  return 200;
});

function centre(c: { row: number; col: number }): LatLon {
  return {
    lat: TEST_MASK_META.south + (c.row + 0.5) / 200,
    lon: TEST_MASK_META.west + (c.col + 0.5) / 200,
  };
}

const deps = testPlanDeps(mask, { genoa: TEST_POLAR, fock: { ...TEST_POLAR, rig: 'fock' } });
const wind = uniformWindGrid(12, 270);
const GATE = DEFAULT_SETTINGS.safetyDepthM;
const HANDOVER_A = findHarborHandover(mask, centre(A), GATE)!;

function request(over: Partial<PlanRequest> = {}): PlanRequest {
  return {
    origin: centre(A),
    destination: centre(OPEN),
    viaPoints: [],
    originHarborId: 'a',
    destinationHarborId: null,
    departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
    settings: DEFAULT_SETTINGS,
    sailIds: ['genoa', 'fock'],
    boat: defaultBoatSnapshot(),
    ...over,
  };
}

function okResult(): PlanResultOk {
  return {
    status: 'ok',
    sails: [],
    recommended: 'genoa',
    comparisonComplete: true,
    snappedOrigin: { lat: 0, lon: 0 },
    snappedDestination: { lat: 0, lon: 0 },
  };
}

const errorResult = (): PlanResult => ({ status: 'error', reason: 'unreachable' });

function spy(...results: PlanResult[]) {
  const fn = vi.fn<PlanFn>();
  for (const r of results) fn.mockReturnValueOnce(r);
  return fn;
}

const NONE = new Set<string>();

function run(req: PlanRequest, plan: PlanFn, kd = NONE, deadline?: PlanDeadline) {
  return planWithHarborHandover(req, wind, deps, undefined, undefined, deadline, kd, plan);
}

describe('#1721 planWithHarborHandover gate', () => {
  it('fixture: A has a handover, B has none', () => {
    expect(HANDOVER_A).not.toBeNull();
    expect(findHarborHandover(mask, centre(B), GATE)).toBeNull();
  });

  it('returns an ok first pass as the identical object after one call', () => {
    const r1 = okResult();
    const plan = spy(r1);
    expect(run(request(), plan)).toBe(r1);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('a tapped end (no harbour id) is never substituted', () => {
    const r1 = errorResult();
    const plan = spy(r1, okResult());
    expect(run(request({ originHarborId: null }), plan)).toBe(r1);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('a known-disconnected harbour is never substituted', () => {
    const r1 = errorResult();
    const plan = spy(r1, okResult());
    expect(run(request(), plan, new Set(['a']))).toBe(r1);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('a shallow-approach end keeps its relaxed solve', () => {
    const r1 = errorResult();
    const plan = spy(r1, okResult());
    expect(run(request({ origin: centre(C), originHarborId: 'c' }), plan)).toBe(r1);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('a harbour end the grid connects is not substituted', () => {
    const r1 = errorResult();
    const plan = spy(r1, okResult());
    expect(run(request({ origin: centre(OPEN), originHarborId: 'open' }), plan)).toBe(r1);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('returns the first pass when an eligible end has no handover within 1852 m', () => {
    const r1 = errorResult();
    const plan = spy(r1, okResult());
    expect(run(request({ origin: centre(B), originHarborId: 'b' }), plan)).toBe(r1);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('returns the first pass when the deadline has expired', () => {
    const r1 = errorResult();
    const plan = spy(r1, okResult());
    expect(run(request(), plan, NONE, { expired: () => true })).toBe(r1);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('returns the first pass when a via lies within 60 m of a handover', () => {
    const r1 = errorResult();
    const plan = spy(r1, okResult());
    const via = { lat: HANDOVER_A.lat + 30 / 111_320, lon: HANDOVER_A.lon };
    expect(run(request({ viaPoints: [via] }), plan)).toBe(r1);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('flags only the substituted end and changes nothing else in the request', () => {
    const r2 = okResult();
    const plan = spy(errorResult(), r2);
    const req = request({
      origin: centre(OPEN),
      originHarborId: null,
      destination: centre(A),
      destinationHarborId: 'a',
    });
    const out = run(req, plan);
    expect(out).toEqual({ ...r2, harborHandovers: { destination: true } });
    if (out.status !== 'ok') throw new Error('expected ok');
    const hh = (out as { harborHandovers?: object }).harborHandovers!;
    expect('origin' in hh).toBe(false);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan.mock.calls[1][0]).toEqual({ ...req, destination: HANDOVER_A });
  });

  it('a second-pass failure with time left returns the first pass', () => {
    const r1 = errorResult();
    const plan = spy(r1, errorResult());
    expect(run(request(), plan, NONE, { expired: () => false })).toBe(r1);
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('a second-pass failure after the deadline expired returns the second pass', () => {
    const r1 = errorResult();
    const r2 = errorResult();
    const plan = spy(r1, r2);
    const expired = vi.fn<() => boolean>().mockReturnValueOnce(false).mockReturnValue(true);
    expect(run(request(), plan, NONE, { expired })).toBe(r2);
    expect(plan).toHaveBeenCalledTimes(2);
  });
});
