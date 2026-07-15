import { describe, expect, it } from 'vitest';
import { planRoute } from './planRoute';
import { solve } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { openWaterMask, TEST_POLAR, uniformWindGrid, makeMask } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PlanRequest } from '../types';
import { haversineNm } from '../lib/geo';

const baseReq: PlanRequest = {
  origin: { lat: 54.7525, lon: 10.0025 },
  destination: { lat: 54.7525, lon: 10.4025 },
  originHarborId: null,
  destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
  settings: DEFAULT_SETTINGS,
  viaPoints: [],
};
const deps = { polarGenoa: TEST_POLAR, polarFock: TEST_POLAR, mask: openWaterMask() };

describe('planRoute via-waypoints', () => {
  it('(a) routes through a via waypoint sequentially, with a continuous joint', () => {
    const via = { lat: 54.9025, lon: 10.2025 }; // well north of the direct (same-latitude) line
    const wind = uniformWindGrid(12, 0); // 12 kn from N

    const direct = planRoute(baseReq, wind, deps);
    expect(direct.status).toBe('ok');
    if (direct.status !== 'ok') return;

    const req: PlanRequest = { ...baseReq, viaPoints: [via] };
    const r = planRoute(req, wind, deps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const rig = r.genoa!;
    expect(rig).not.toBeNull();

    // the route actually visits the (snapped) via point
    const nearVia = rig.legs.some(
      (l) => haversineNm(l.start, via) < 0.05 || haversineNm(l.end, via) < 0.05,
    );
    expect(nearVia).toBe(true);

    // legs are continuous end-to-end, including across the via joint, and time
    // strictly advances through every leg (in particular across the joint).
    for (let i = 0; i < rig.legs.length; i++) {
      expect(rig.legs[i].endTimeMs).toBeGreaterThan(rig.legs[i].startTimeMs);
      if (i > 0) {
        expect(rig.legs[i].start).toEqual(rig.legs[i - 1].end);
        expect(rig.legs[i].startTimeMs).toBe(rig.legs[i - 1].endTimeMs);
      }
    }

    // detouring via a point well off the direct line meaningfully lengthens the route
    expect(rig.distanceNm).toBeGreaterThan(direct.genoa!.distanceNm + 5);
  }, 30_000); // six full isochrone solves (two direct-comparison rigs + two rigs x two segments)

  it('(b) viaPoints: [] behaves exactly as before (regression: equal ETA to a direct single-segment solve)', () => {
    // origin/destination sit exactly on mask cell centers, so snapping is a
    // no-op and the bare solve() comparison below is exact.
    const wind = uniformWindGrid(12, 0);
    const req: PlanRequest = { ...baseReq, viaPoints: [] };
    const r = planRoute(req, wind, deps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    // Reproduce the pre-viaPoints behavior directly: a single solve() call
    // from origin straight to destination.
    const direct = solve({
      origin: baseReq.origin,
      destination: baseReq.destination,
      departureMs: baseReq.departureMs,
      polar: new Polar(TEST_POLAR, DEFAULT_SETTINGS.performanceFactor),
      wind: new WindField(wind),
      mask: deps.mask,
      settings: DEFAULT_SETTINGS,
    });
    expect(direct.status).toBe('ok');
    if (direct.status !== 'ok') return;

    expect(r.genoa!.etaMs).toBe(direct.etaMs);
  }, 20_000); // three full isochrone solves (two rigs + the direct comparison)

  it('(c) a via point that fails to snap fails the whole plan with snap-failed-via', () => {
    // land west of col 162 (lon ≈ 10.21); via deep inland, far past the 300 m snap radius
    const mask = makeMask((_, c) => (c < 162 ? 0 : 200));
    const req: PlanRequest = {
      ...baseReq,
      origin: { lat: 54.7525, lon: 10.3025 },
      destination: { lat: 54.7525, lon: 10.6025 },
      viaPoints: [{ lat: 54.7525, lon: 9.6 }],
    };
    const r = planRoute(req, uniformWindGrid(12, 0), { ...deps, mask });
    expect(r).toEqual({ status: 'error', reason: 'snap-failed-via' });
  });
});
