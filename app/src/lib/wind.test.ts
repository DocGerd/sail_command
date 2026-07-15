import { describe, expect, it } from 'vitest';
import { WindField } from './wind';
import { makeWindGrid, uniformWindGrid } from '../test/fixtures';

describe('WindField', () => {
  it('returns the uniform value everywhere, any time', () => {
    const wf = new WindField(uniformWindGrid(12, 270));
    const s = wf.sample({ lat: 54.75, lon: 10.123 }, wf.startMs() + 90 * 60_000);
    expect(s.speedKn).toBeCloseTo(12, 4);
    expect(s.dirFromDeg).toBeCloseTo(270, 3);
  });

  it('interpolates direction across the 0°/360° wrap via vectors', () => {
    // Two adjacent columns: 350° and 10° — the midpoint must be 0°, never 180°.
    const wf = new WindField(
      makeWindGrid((_, lon) => ({ speedKn: 10, dirFromDeg: lon < 10.2 ? 350 : 10 }), {
        lonStep: 0.1, latStep: 0.5,
      }),
    );
    const mid = wf.sample({ lat: 54.8, lon: 10.15 }, wf.startMs());
    expect(Math.abs(((mid.dirFromDeg + 180) % 360) - 180)).toBeLessThan(1); // ≈ 0°/360°
    expect(mid.speedKn).toBeGreaterThan(9); // vector mean of same-speed near-parallel winds
  });

  it('interpolates linearly in time', () => {
    const wf = new WindField(makeWindGrid((_la, _lo, h) => ({ speedKn: 10 + h, dirFromDeg: 180 })));
    const s = wf.sample({ lat: 54.8, lon: 10.2 }, wf.startMs() + 30 * 60_000);
    expect(s.speedKn).toBeCloseTo(10.5, 3);
  });

  it('clamps outside the grid spatially and temporally', () => {
    const wf = new WindField(uniformWindGrid(8, 90));
    expect(wf.sample({ lat: 60, lon: 20 }, wf.startMs() - 3_600_000).speedKn).toBeCloseTo(8, 4);
    expect(wf.sample({ lat: 54.8, lon: 10 }, wf.horizonMs() + 3_600_000).speedKn).toBeCloseTo(8, 4);
  });

  it('interpolates gustKn linearly in time, independent of the speed/direction vector math', () => {
    // makeWindGrid's fixture generator sets gustKn = speedKn * 1.3 per sample.
    const wf = new WindField(makeWindGrid((_la, _lo, h) => ({ speedKn: 10 + h, dirFromDeg: 180 })));
    const s = wf.sample({ lat: 54.8, lon: 10.2 }, wf.startMs() + 30 * 60_000);
    expect(s.speedKn).toBeCloseTo(10.5, 3); // pins the existing time-interpolation test's value
    expect(s.gustKn).toBeCloseTo(10.5 * 1.3, 3);
  });

  it('samples without error on a single-lat/single-lon grid (bracket n===1 branch)', () => {
    const wf = new WindField(
      makeWindGrid(() => ({ speedKn: 9, dirFromDeg: 45 }), {
        south: 54.75, north: 54.75, west: 10.2, east: 10.2, hours: 2,
      }),
    );
    // Query far from the grid's single point — with only one lat/lon bracket,
    // every query must clamp to that single point's value without error.
    const s = wf.sample({ lat: 10, lon: -5 }, wf.startMs());
    expect(s.speedKn).toBeCloseTo(9, 4);
    expect(s.dirFromDeg).toBeCloseTo(45, 3);
  });
});
