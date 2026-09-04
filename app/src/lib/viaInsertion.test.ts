import { describe, expect, it } from 'vitest';
import { nearestViaInsertIndex } from './viaInsertion';

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
