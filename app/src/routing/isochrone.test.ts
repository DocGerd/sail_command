import { describe, expect, it, vi } from 'vitest';
import { edgeFactor, solve, type SolveParams } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { makeMask, openWaterMask, TEST_POLAR, uniformWindGrid, wallMask } from '../test/fixtures';
import { DEFAULT_SETTINGS, type MaskMeta } from '../types';
import { haversineNm } from '../lib/geo';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines (2026-07-15 CI run: tests at ~1s locally took 30-44s). Fast test
// files keep vitest's 5s default so hang detection stays meaningful there.
vi.setConfig({ testTimeout: 120_000 });

const A = { lat: 54.75, lon: 10.0 };
const B_EAST = { lat: 54.75, lon: 10.4 }; // ~13.9 nm due east of A

function params(overrides: Partial<SolveParams>): SolveParams {
  return {
    origin: A,
    destination: B_EAST,
    departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
    polar: new Polar(TEST_POLAR, 1.0),
    wind: new WindField(uniformWindGrid(12, 0)), // 12 kn from north
    mask: openWaterMask(),
    settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
    ...overrides,
  };
}

describe('isochrone golden routes', () => {
  it('beam reach: sails ~straight with zero maneuvers', () => {
    const r = solve(params({}));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.legs.every((l) => l.kind === 'sail')).toBe(true);
    expect(r.legs.filter((l) => l.maneuverAtStart).length).toBe(0);
    const dist = r.legs.reduce((s, l) => s + l.distanceNm, 0);
    expect(dist).toBeLessThan(haversineNm(A, B_EAST) * 1.15);
    // ~13.9 nm at ~7.2 kn ≈ 1.9 h
    const hours = (r.etaMs - params({}).departureMs) / 3_600_000;
    expect(hours).toBeGreaterThan(1.5);
    expect(hours).toBeLessThan(2.6);
  });

  it('dead upwind: tacks a small, bounded number of times', () => {
    const r = solve(params({ wind: new WindField(uniformWindGrid(12, 90)) })); // wind FROM east
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const maneuvers = r.legs.filter((l) => l.maneuverAtStart).length;
    expect(maneuvers).toBeGreaterThanOrEqual(1);
    expect(maneuvers).toBeLessThanOrEqual(4); // penalty must suppress tack spam
    // VMG sanity: beat at ~42° at ~6.5 kn → VMG ~4.8 kn → ~2.9h for 13.9 nm; allow slack
    const hours = (r.etaMs - params({}).departureMs) / 3_600_000;
    expect(hours).toBeGreaterThan(2.2);
    expect(hours).toBeLessThan(4.2);
    // legs alternate boards only at flagged maneuvers
    for (let i = 1; i < r.legs.length; i++) {
      const prev = r.legs[i - 1];
      const cur = r.legs[i];
      if (prev.kind === 'sail' && cur.kind === 'sail' && prev.board !== cur.board) {
        expect(cur.maneuverAtStart).not.toBeNull();
      }
    }
  });

  it('rounds an island between the ports instead of crossing it', () => {
    // Wall at col 160 (lon≈10.2) with a gap only at rows 90–99 (lat 54.75–54.80).
    // Origin/destination sit at lat 54.60 — the direct track is blocked; the
    // route must climb ~9 nm north to the gap, thread it, and come back down.
    const detourA = { lat: 54.6, lon: 10.0 };
    const detourB = { lat: 54.6, lon: 10.4 };
    const m = wallMask();
    expect(m.segmentNavigable(detourA, detourB, 3)).toBe(false); // direct is blocked
    const r = solve(
      params({
        origin: detourA,
        destination: detourB,
        mask: m,
        wind: new WindField(uniformWindGrid(14, 0)),
      }),
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    for (const l of r.legs) expect(m.segmentNavigable(l.start, l.end, 3)).toBe(true);
    // the route genuinely detours through the gap
    const maxLat = Math.max(...r.legs.map((l) => Math.max(l.start.lat, l.end.lat)));
    expect(maxLat).toBeGreaterThan(54.74); // reached the gap band
    const dist = r.legs.reduce((s, l) => s + l.distanceNm, 0);
    expect(dist).toBeGreaterThan(20); // reviewer-verified detour ≈ 24.3 nm vs 13.9 direct
    expect(dist).toBeLessThan(30);
  });

  it('blocked destination → unreachable with reason', () => {
    // solid wall, no gap
    const solid = { ...params({}) };
    const r = solve({
      ...solid,
      mask: makeMask((_: number, c: number) => (c === 160 ? 0 : 200)),
    });
    expect(r).toEqual({ status: 'no-route', reason: 'unreachable' });
  });

  it('calm with motor off → calm-motor-off; beyond horizon reported', () => {
    // 0.1 kn TWS → polar speeds ~0.07 kn < MIN_SAIL_KN → every sail edge dies.
    // (At 0.5 kn the boat still "sails" at ~0.37 kn and would crawl in — not calm.)
    const calm = solve(params({ wind: new WindField(uniformWindGrid(0.1, 0)) }));
    expect(calm).toEqual({ status: 'no-route', reason: 'calm-motor-off' });

    const short = solve(
      params({
        wind: new WindField(uniformWindGrid(4, 90, { hours: 2 })), // 2h horizon, upwind, light
      }),
    );
    expect(short).toEqual({ status: 'no-route', reason: 'beyond-horizon' });
  });

  it('horizon boundary: eta just inside succeeds; one hour-bucket shorter reports beyond-horizon', () => {
    const departureMs = Date.UTC(2026, 6, 15, 8, 0, 0);
    // Generous reference horizon establishes the scenario's true (unconstrained) ETA.
    const reference = solve(
      params({
        departureMs,
        wind: new WindField(uniformWindGrid(12, 0, { hours: 24, t0Ms: departureMs })),
      }),
    );
    expect(reference.status).toBe('ok');
    if (reference.status !== 'ok') return;

    // Just inside: the smallest whole-hour grid horizon that still covers the ETA.
    // The result must be the identical (deterministic) solve as the reference.
    const hoursInside = Math.ceil((reference.etaMs - departureMs) / 3_600_000) + 1;
    const inside = solve(
      params({
        departureMs,
        wind: new WindField(uniformWindGrid(12, 0, { hours: hoursInside, t0Ms: departureMs })),
      }),
    );
    expect(inside.status).toBe('ok');
    if (inside.status === 'ok') expect(inside.etaMs).toBe(reference.etaMs);

    // Just outside: one hour-bucket shorter, so the same route no longer fits.
    const outside = solve(
      params({
        departureMs,
        wind: new WindField(uniformWindGrid(12, 0, { hours: hoursInside - 1, t0Ms: departureMs })),
      }),
    );
    expect(outside).toEqual({ status: 'no-route', reason: 'beyond-horizon' });
  });

  it('is deterministic', () => {
    const a = solve(params({ wind: new WindField(uniformWindGrid(12, 45)) }));
    const b = solve(params({ wind: new WindField(uniformWindGrid(12, 45)) }));
    expect(a).toEqual(b);
  });
});

// #243 depth comfort preference — G.2: the one place a literal can be
// hand-derived exactly, so pin the shortfall/derate arithmetic directly
// rather than through a full solve() run.
describe('#243 edgeFactor arithmetic', () => {
  // Shoal line at col 160 (lon ≈ 10.2), rest of the mask 20 m — same fixture
  // shape as mask.test.ts's segmentNavigable/segmentClearanceM tests.
  const a = { lat: 54.75, lon: 10.19 };
  const b = { lat: 54.75, lon: 10.22 }; // straddles col 160
  const gateM = 3.0;
  const comfortDepthM = 5.0; // gate 3.0 + margin 2.0

  it('hand-derived: clearance 4.0 m -> shortfall 0.5 -> factor 0.85', () => {
    // shortfall = (5.0 - 4.0) / (5.0 - 3.0) = 0.5
    // factor    = 1 - DEPTH_DERATE_MAX(0.30) * 0.5 = 0.85
    const m = makeMask((_, c) => (c === 160 ? 40 : 200));
    expect(edgeFactor(m, a, b, gateM, comfortDepthM)).toBeCloseTo(0.85, 6);
  });

  it('clearance at or above the comfort depth -> factor exactly 1 (free)', () => {
    const deep = makeMask(() => 200); // 20 m, well above 5.0 m comfort
    expect(edgeFactor(deep, a, b, gateM, comfortDepthM)).toBe(1);
    // Boundary: clearance exactly AT the comfort depth is also free.
    const atComfort = makeMask((_, c) => (c === 160 ? 50 : 200));
    expect(edgeFactor(atComfort, a, b, gateM, comfortDepthM)).toBe(1);
  });

  it('clearance exactly at the gate -> factor exactly 1 - DEPTH_DERATE_MAX (0.70)', () => {
    const atGate = makeMask((_, c) => (c === 160 ? 30 : 200)); // 3.0 m exactly
    expect(edgeFactor(atGate, a, b, gateM, comfortDepthM)).toBeCloseTo(0.7, 6);
  });

  it('blocked segment -> null, identical to segmentNavigable === false', () => {
    const wall = makeMask((_, c) => (c === 160 ? 0 : 200));
    expect(wall.segmentNavigable(a, b, gateM)).toBe(false);
    expect(edgeFactor(wall, a, b, gateM, comfortDepthM)).toBeNull();
  });

  it('comfortDepthM absent -> collapses to plain segmentNavigable (1 or null)', () => {
    const m = makeMask((_, c) => (c === 160 ? 40 : 200));
    expect(edgeFactor(m, a, b, gateM, undefined)).toBe(1); // 4.0 m clears a 3.0 m gate
    const wall = makeMask((_, c) => (c === 160 ? 0 : 200));
    expect(edgeFactor(wall, a, b, gateM, undefined)).toBeNull();
  });

  it('comfortDepthM not strictly above the gate -> degrades to plain segmentNavigable (defensive, never divides by <=0)', () => {
    const m = makeMask((_, c) => (c === 160 ? 40 : 200));
    expect(edgeFactor(m, a, b, gateM, gateM)).toBe(1); // comfort === gate
    expect(edgeFactor(m, a, b, gateM, gateM - 0.5)).toBe(1); // comfort < gate
  });
});

// #243 §D.5's correction, proven behaviorally: Node.costMs (the ranking
// clock) must never leak into Node.tMs (true elapsed time) or geometry.
describe('#243 depth comfort preference preserves true wall-clock time and geometry', () => {
  it('a UNIFORM depth-derate factor changes nothing observable', () => {
    // Every cell charted 4.0 m: below the 5.0 m comfort target (gate 3.0 +
    // margin 2.0) but above the gate, so EVERY edge anywhere in the search
    // gets the IDENTICAL factor (0.85, per the hand-derivation above).
    // Dividing every edge's cost by the same constant is an order-preserving
    // scaling — it cannot change which candidate wins any better()/
    // visitedDominates comparison, so the winning path (geometry AND true
    // elapsed time) must come out byte-identical to the no-preference solve.
    // If Node.costMs ever leaked into Node.tMs (the §D.1 bug §D.5 fixes),
    // this test would see legs/etaMs differ.
    const uniform4m = makeMask(() => 40);
    const withoutPref = solve(params({ mask: uniform4m }));
    const withPref = solve(params({ mask: uniform4m, comfortDepthM: 5.0 }));
    expect(withoutPref.status).toBe('ok');
    expect(withPref).toEqual(withoutPref);
  });

  it('an active, BITING preference (non-uniform depth) still reports true elapsed time, not an inflated one', () => {
    // A single shallow patch the direct track must cross: this DOES perturb
    // ranking (unlike the uniform case above), so this test only pins that
    // the reported etaMs stays a plausible TRUE time for the geometry
    // actually flown — never the inflated costMs. Load-bearing regression
    // guard for the exact "clock encoding breaks wall-clock semantics" bug
    // the design doc's §D.5 correction exists to prevent: if etaMs were ever
    // costMs instead of tMs, it would be measurably too large.
    // A→B_EAST spans cols 120..200 (lon 10.0..10.4 at 0.005°/cell); col 160
    // is the midpoint, so this shoal band sits mid-course, not near either end.
    const shoal = makeMask((_, c) => (c === 160 ? 40 : 200)); // 4.0 m band mid-course
    const r = solve(params({ mask: shoal, comfortDepthM: 5.0 }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // The direct great-circle distance lower-bounds true travel time at the
    // fastest speed TEST_POLAR ever offers (8.8 kn, 120° TWA @ 20 kn) — a
    // generous bound that only an inflated (costMs) etaMs could breach.
    const directNm = haversineNm(A, B_EAST);
    const fastestPossibleHours = directNm / 8.8;
    const hours = (r.etaMs - params({}).departureMs) / 3_600_000;
    expect(hours).toBeGreaterThan(fastestPossibleHours);
    expect(hours).toBeLessThan(6); // well under any plausible cost-inflated figure
  });
});

// #243 §D.4's residual risk, demonstrated with the REAL solver (no mocks):
// "the reachability argument is not a proof — the fallback ladder is."
// Reusing the SAME test-only maxFrontier injection #67 established (a
// deliberately tiny cap to stress the search's approximate frontier
// pruning) — the depth comfort preference can change which candidate wins a
// prune-cell bucket, and under a constrained frontier that can starve the
// only surviving path to a still-reachable destination. This is a search
// CAPACITY artifact, not a data property: the same mask solves fine under
// EITHER preference state at the default (30 000) cap.
describe('#243 search-capacity effect (why the tier-ladder fallback is mandatory, not decorative)', () => {
  const META: MaskMeta = { west: 9.9, south: 54.7, east: 10.1, north: 54.8, cols: 200, rows: 100 };
  const cell = (r: number, c: number) => ({
    lat: 54.7 + (r + 0.5) * 0.001,
    lon: 9.9 + (c + 0.5) * 0.001,
  });
  // Two corridors from a shared origin, reconverging through a connector
  // column into one shared final stretch to the destination: row 40 is a
  // 3.1 m shallow direct corridor (charted just above the 3.0 m gate, so it
  // gets derated under the preference); row 60 is a 20 m deep corridor of
  // the same length; both rejoin at col 150 into a shared deep stretch.
  const twoCorridorMask = () =>
    makeMask((r, c) => {
      if (r === 40 && c >= 5 && c <= 150) return 31;
      if (r === 60 && c >= 5 && c <= 150) return 200;
      if (r === 50 && c >= 150 && c <= 195) return 200;
      if (c === 150 && r >= 40 && r <= 60) return 200;
      return 0;
    }, META);
  const O = cell(40, 6);
  const D = cell(50, 190);
  const settings = { ...DEFAULT_SETTINGS, motorEnabled: true };
  const polar = new Polar(TEST_POLAR, 1.0);
  const wind = new WindField(uniformWindGrid(0.1, 0)); // calm + motor: purely geometric ring order
  const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);

  it('the mask is genuinely reachable under EITHER preference state at the default frontier cap', () => {
    const mask = twoCorridorMask();
    const withoutPref = solve({
      origin: O,
      destination: D,
      departureMs: T0,
      polar,
      wind,
      mask,
      settings,
    });
    const withPref = solve({
      origin: O,
      destination: D,
      departureMs: T0,
      polar,
      wind,
      mask,
      settings,
      comfortDepthM: 5.0,
    });
    expect(withoutPref.status).toBe('ok');
    expect(withPref.status).toBe('ok');
    // Same destination, same wind/settings, geometry-preserving preference:
    // both must arrive at the identical true clock (§D.5 invariant, reused
    // here as a sanity check on the fixture itself).
    if (withoutPref.status === 'ok' && withPref.status === 'ok') {
      expect(withPref.etaMs).toBe(withoutPref.etaMs);
    }
  });

  it('at a deliberately starved frontier cap, the preference alone flips ok -> unreachable', () => {
    const mask = twoCorridorMask();
    const cap = 5;
    const withoutPref = solve({
      origin: O,
      destination: D,
      departureMs: T0,
      polar,
      wind,
      mask,
      settings,
      maxFrontier: cap,
    });
    const withPref = solve({
      origin: O,
      destination: D,
      departureMs: T0,
      polar,
      wind,
      mask,
      settings,
      maxFrontier: cap,
      comfortDepthM: 5.0,
    });
    expect(withoutPref.status).toBe('ok');
    expect(withPref).toEqual({ status: 'no-route', reason: 'unreachable' });
  });
});
