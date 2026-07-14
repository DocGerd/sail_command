import { describe, expect, it } from 'vitest';
import {
  alongTrackFraction,
  crossTrackNm,
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

  it('crossTrack is signed and zero on-track', () => {
    const a = { lat: 54.7, lon: 9.5 };
    const b = { lat: 54.7, lon: 10.5 }; // ~due east at constant latitude
    const mid = destinationPoint(a, initialBearingDeg(a, b), haversineNm(a, b) / 2);
    expect(Math.abs(crossTrackNm(mid, a, b))).toBeLessThan(0.01);
    const north = { lat: mid.lat + 0.05, lon: mid.lon }; // ~3 nm left of track
    const south = { lat: mid.lat - 0.05, lon: mid.lon };
    expect(crossTrackNm(north, a, b)).toBeLessThan(-2.5);
    expect(crossTrackNm(south, a, b)).toBeGreaterThan(2.5);
    expect(Math.abs(crossTrackNm(north, a, b) + crossTrackNm(south, a, b))).toBeLessThan(0.2);
  });

  it('alongTrackFraction spans 0..1 on the segment and extends beyond', () => {
    const a = { lat: 54.7, lon: 9.5 };
    const b = { lat: 54.7, lon: 10.5 };
    const brg = initialBearingDeg(a, b);
    const d = haversineNm(a, b);
    expect(alongTrackFraction(a, a, b)).toBeCloseTo(0, 3);
    expect(alongTrackFraction(destinationPoint(a, brg, d / 4), a, b)).toBeCloseTo(0.25, 2);
    expect(alongTrackFraction(b, a, b)).toBeCloseTo(1, 2);
    // behind the start → negative
    expect(alongTrackFraction(destinationPoint(a, (brg + 180) % 360, 2), a, b)).toBeLessThan(0);
    // past the end → > 1
    expect(alongTrackFraction(destinationPoint(a, brg, d + 2), a, b)).toBeGreaterThan(1);
  });
});
