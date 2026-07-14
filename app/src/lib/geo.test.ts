import { describe, expect, it } from 'vitest';
import {
  destinationPoint,
  haversineNm,
  initialBearingDeg,
  normalizeDeg180,
  normalizeDeg360,
} from './geo';

const flensburg = { lat: 54.7937, lon: 9.4327 };
const marstal = { lat: 54.8497, lon: 10.5177 };

describe('geo', () => {
  it('normalizes angles', () => {
    expect(normalizeDeg360(-90)).toBe(270);
    expect(normalizeDeg360(720)).toBe(0);
    expect(normalizeDeg180(270)).toBe(-90);
    expect(normalizeDeg180(180)).toBe(180);
    expect(normalizeDeg180(-180)).toBe(180);
  });

  it('computes haversine distance Flensburg→Marstal ≈ 37.7 nm', () => {
    expect(haversineNm(flensburg, marstal)).toBeGreaterThan(36);
    expect(haversineNm(flensburg, marstal)).toBeLessThan(39);
  });

  it('destinationPoint inverts haversine+bearing', () => {
    const brg = initialBearingDeg(flensburg, marstal);
    const d = haversineNm(flensburg, marstal);
    const p = destinationPoint(flensburg, brg, d);
    expect(haversineNm(p, marstal)).toBeLessThan(0.05);
  });

  it('bearing east at this latitude is ≈ 90°', () => {
    const p = destinationPoint(flensburg, 90, 5);
    expect(p.lat).toBeCloseTo(flensburg.lat, 2);
    expect(p.lon).toBeGreaterThan(flensburg.lon);
  });
});
