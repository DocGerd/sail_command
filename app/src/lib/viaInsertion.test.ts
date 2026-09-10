import { describe, expect, it } from 'vitest';
import { nearestViaInsertIndex, segmentMidpoint } from './viaInsertion';

// #845: pins the insertion-index algebra design spec §2.6 requires — a point
// lands at the segment of the origin -> viaPoints -> destination chain it
// projects closest to, expressed as an Array#splice-ready index.
describe('nearestViaInsertIndex (#845)', () => {
  const origin = { lat: 54.8, lon: 9.9 };
  const destination = { lat: 55.0, lon: 10.3 };

  it('returns 0 for an empty via list — the only segment is origin->destination', () => {
    const point = { lat: 54.9, lon: 10.1 }; // roughly midway
    expect(nearestViaInsertIndex(point, origin, destination, [])).toBe(0);
  });

  it('inserts BEFORE the first via point when nearest the origin->via1 segment', () => {
    const via1 = { lat: 55.0, lon: 10.3 }; // == destination, degenerate but fine
    const point = { lat: 54.81, lon: 9.92 }; // hugs the origin end
    expect(nearestViaInsertIndex(point, origin, destination, [via1])).toBe(0);
  });

  it('inserts AFTER the last via point when nearest the last via->destination segment', () => {
    const via1 = { lat: 54.82, lon: 9.94 }; // near origin
    const point = { lat: 54.99, lon: 10.28 }; // hugs the destination end
    expect(nearestViaInsertIndex(point, origin, destination, [via1])).toBe(1);
  });

  it('inserts BETWEEN two existing via points when nearest the middle segment', () => {
    const via1 = { lat: 54.85, lon: 9.98 };
    const via2 = { lat: 54.95, lon: 10.22 };
    // A point that projects onto the via1->via2 segment, not either flank.
    const point = { lat: 54.9, lon: 10.1 };
    expect(nearestViaInsertIndex(point, origin, destination, [via1, via2])).toBe(1);
  });
});

// #1171: the default coordinate for the keyboard "insert between waypoint N
// and N+1" control — no pointer-release point exists for it, unlike #850's
// drag gesture, so it needs a real great-circle midpoint. Every expected
// value below was computed independently in Python (the standard
// atan2-based spherical midpoint formula), never read off this function's
// own output — CLAUDE.md's equivalence-test trap.
describe('segmentMidpoint (#1171)', () => {
  it('returns the point itself for two identical points', () => {
    const p = { lat: 54.3, lon: 9.5 };
    const mid = segmentMidpoint(p, p);
    expect(mid.lat).toBeCloseTo(54.3, 9);
    expect(mid.lon).toBeCloseTo(9.5, 9);
  });

  it('computes the great-circle midpoint of two distinct points', () => {
    const mid = segmentMidpoint({ lat: 54.85, lon: 10.1 }, { lat: 54.95, lon: 10.3 });
    expect(mid.lat).toBeCloseTo(54.900041053615176, 9);
    expect(mid.lon).toBeCloseTo(10.199875832225757, 9);
  });

  it('is symmetric — order of the two endpoints does not matter', () => {
    const a = { lat: 54.85, lon: 10.1 };
    const b = { lat: 54.95, lon: 10.3 };
    const forward = segmentMidpoint(a, b);
    const backward = segmentMidpoint(b, a);
    expect(forward.lat).toBeCloseTo(backward.lat, 9);
    expect(forward.lon).toBeCloseTo(backward.lon, 9);
  });

  it('normalises a segment crossing the antimeridian into (-180, 180]', () => {
    const mid = segmentMidpoint({ lat: 0, lon: 179 }, { lat: 0, lon: -179 });
    expect(mid.lat).toBeCloseTo(0, 9);
    expect(mid.lon).toBeCloseTo(-180, 9);
    expect(mid.lon).toBeGreaterThan(-180.0000001);
    expect(mid.lon).toBeLessThanOrEqual(180);
  });
});
