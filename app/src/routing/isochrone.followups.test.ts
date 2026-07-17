import { describe, expect, it, vi } from 'vitest';
import { solve, stampVisited, visitedDominates, type VisitedStamp } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { makeMask, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import type { MaskMeta } from '../types';
import { destinationPoint, haversineNm } from '../lib/geo';

// Regression tests for issue #21 — three follow-up gaps from the #20 review.
// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower
// than dev machines; keep the generous file-level timeout.
vi.setConfig({ testTimeout: 120_000 });

// Fine synthetic mask: 0.00078125° cells (≈50 m lon × 87 m lat at 54.75°N),
// bounded region so an exhaustive search saturates quickly.
const FINE_META: MaskMeta = {
  west: 9.9,
  south: 54.7,
  east: 10.1,
  north: 54.8,
  cols: 256,
  rows: 128,
};
const CELL = 0.00078125;
// Origin at the center of col 128 / row 64 so substep endpoints sit mid-cell.
const O = { lat: 54.7 + 64.5 * CELL, lon: 9.9 + 128.5 * CELL };
const colCenterLon = (col: number) => 9.9 + (col + 0.5) * CELL;
/** All 20 m water except a full-height 1-cell land wall at col 135. */
const wallCol135Mask = () => makeMask((_r, c) => (c === 135 ? 0 : 200), FINE_META);

// Shared scenario math, derived from fixtures (NOT from running the solver):
// wind 12 kn from north; heading 090 → TWA −90 → TEST_POLAR grid point
// (90°, 12 kn) = 7.2 kn exactly. Destination < 2 nm → dtS = 150 s, so the
// full step is 7.2 kn × 150 s = 0.3 nm = 556 m and the first (dtS/2) substep
// is 0.15 nm = 278 m. The wall's west face lies 326 m east of O
// (0.005078125° × ≈64 175 m/°): the full step crosses it, the substep fits
// with 48 m to spare.
const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);
const polar = new Polar(TEST_POLAR, 1.0);
const wind = new WindField(uniformWindGrid(12, 0));
const settings = { ...DEFAULT_SETTINGS, motorEnabled: false };

describe('issue #21 gap 1: visited pruning is clock-aware', () => {
  // A later-clock full-step arrival must not prune a later-ring but
  // earlier-clock substepped thread that reaches the same prune cell.
  it('visitedDominates prunes only when the stamp is no later AND no more maneuvers', () => {
    const seen: VisitedStamp = { tMs: 1_200_000, maneuvers: 1 };
    expect(visitedDominates(seen, { tMs: 1_200_000, maneuvers: 1 })).toBe(true);
    expect(visitedDominates(seen, { tMs: 1_500_000, maneuvers: 2 })).toBe(true);
    // The desynchronized-clock case the maneuvers-only rule got wrong:
    // an earlier arrival survives even with more maneuvers.
    expect(visitedDominates(seen, { tMs: 450_000, maneuvers: 3 })).toBe(false);
    // Fewer maneuvers survives even when it arrives later.
    expect(visitedDominates(seen, { tMs: 1_500_000, maneuvers: 0 })).toBe(false);
  });

  it('stampVisited keeps componentwise minima and never raises either one', () => {
    const visited = new Map<string, VisitedStamp>();
    stampVisited(visited, 'k', { tMs: 1_200_000, maneuvers: 0 });
    expect(visited.get('k')).toEqual({ tMs: 1_200_000, maneuvers: 0 });
    stampVisited(visited, 'k', { tMs: 450_000, maneuvers: 2 });
    expect(visited.get('k')).toEqual({ tMs: 450_000, maneuvers: 0 });
    stampVisited(visited, 'k', { tMs: 2_000_000, maneuvers: 5 });
    expect(visited.get('k')).toEqual({ tMs: 450_000, maneuvers: 0 });
    expect(visited.size).toBe(1);
  });
});

describe('issue #21 gap 2: blocked direct arrivals get the substep retry', () => {
  it('retries the direct heading with substeps when the arrival leg is blocked', () => {
    // D at col-138 center, same lat as O: 0.2707 nm ≤ 0.3 nm, so the direct
    // candidate (heading 090, dead at the wall) takes the arrival branch.
    const D = { lat: O.lat, lon: colCenterLon(138) };
    const mask = wallCol135Mask();

    // Fixture preconditions, checked with the independent geo/mask libs.
    expect(haversineNm(O, D)).toBeGreaterThan(0.26);
    expect(haversineNm(O, D)).toBeLessThan(0.3);
    expect(mask.segmentNavigable(O, D, settings.safetyDepthM)).toBe(false);
    const sub = destinationPoint(O, 90, 0.15); // 7.2 kn × 75 s substep endpoint
    expect(mask.segmentNavigable(O, sub, settings.safetyDepthM)).toBe(true);

    const spy = vi.spyOn(mask, 'segmentNavigable');
    const r = solve({ origin: O, destination: D, departureMs: T0, polar, wind, mask, settings });
    // The wall is full-height: the pocket stays correctly unreachable.
    expect(r).toEqual({ status: 'no-route', reason: 'unreachable' });

    const fromOrigin = spy.mock.calls.filter(([a]) => a.lat === O.lat && a.lon === O.lon);
    // The blocked arrival probe itself (origin → exact destination) ran…
    expect(fromOrigin.some(([, b]) => b.lat === D.lat && b.lon === D.lon)).toBe(true);
    // …and the same heading was then retried at substep length instead of
    // being consumed. Heading 090 exists only as the direct candidate
    // (EXTRA_TWAS has ±85/±95, beat 42°, gybe 165° at 12 kn), and the nearest
    // non-direct substep endpoint (heading 085) lies 24 m away, so the
    // 0.005 nm (9 m) tolerance uniquely identifies the direct retry.
    expect(fromOrigin.some(([, b]) => haversineNm(b, sub) < 0.005)).toBe(true);
  });
});

describe('issue #21 gap 3: the endpoint-capture hop is mask-validated', () => {
  it('does not capture a destination across a land wall', () => {
    // D at col-137 center: 451 m east of O, 75 m east of the wall. The hand
    // probe below (destinationPoint(O, 85, 0.15), a fixed 0.15 nm substep) ends
    // 176 m from D; the real solver heading-085 child instead advances at the
    // interpolated polar speed speedKn(85, 12) = 7.0833 kn and ends 180.5 m from
    // D. All real ring-1 children (173.4 / 177.4 / 180.5 m from D) stay inside
    // the 0.1 nm (185.2 m) capture radius — but every line from that water to D
    // crosses the wall. Before the fix the capture hop skipped mask validation
    // and returned an 'ok' route whose final hop crossed land.
    const D = { lat: O.lat, lon: colCenterLon(137) };
    const mask = wallCol135Mask();

    const child85 = destinationPoint(O, 85, 0.15);
    expect(mask.segmentNavigable(O, child85, settings.safetyDepthM)).toBe(true);
    expect(haversineNm(child85, D)).toBeLessThan(0.1);
    expect(haversineNm(child85, D)).toBeGreaterThan(0.09); // outside a ring-1 direct arrival
    expect(mask.segmentNavigable(child85, D, settings.safetyDepthM)).toBe(false);

    const r = solve({ origin: O, destination: D, departureMs: T0, polar, wind, mask, settings });
    expect(r).toEqual({ status: 'no-route', reason: 'unreachable' });
  });
});
