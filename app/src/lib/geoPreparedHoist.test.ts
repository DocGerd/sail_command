import { describe, expect, it } from 'vitest';
import type { LatLon } from '../types';
import {
  destinationPoint,
  destinationPointFrom,
  haversineNm,
  haversineNmTo,
  initialBearingDeg,
  initialBearingDegFrom,
  preparePoint,
} from './geo';

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Regional extremes of the routing area plus pole-adjacent and equatorial points.
function points(): LatLon[] {
  const rnd = mulberry32(0x5eed);
  const out: LatLon[] = [
    { lat: 54.3, lon: 9.4 },
    { lat: 55.6, lon: 11.6 },
    { lat: 54.79, lon: 9.43 },
    { lat: 0, lon: 0 },
    { lat: -0, lon: -0 },
    { lat: 89.999, lon: 10 },
    { lat: -89.999, lon: -170 },
    { lat: 90, lon: 0 },
    { lat: 60, lon: 179.9 },
    { lat: 60, lon: -179.9 },
  ];
  for (let k = 0; k < 120; k++) out.push({ lat: 54.3 + rnd() * 1.3, lon: 9.4 + rnd() * 2.2 });
  for (let k = 0; k < 40; k++) out.push({ lat: (rnd() - 0.5) * 179.9, lon: (rnd() - 0.5) * 359 });
  return out;
}

const BEARINGS = [-0, 0, 45, 90, 135, 180, 225, 270, 315, 359.999, -45, 720, 1e-9, NaN];
const DISTS = [0, 1e-9, 0.05, 0.5, 1.7, 10, 400, 5000];

describe('prepared-point geo helpers are bit-identical to the originals', () => {
  const pts = points();
  const prepared = pts.map(preparePoint);

  it('destinationPointFrom', () => {
    const rnd = mulberry32(1);
    let n = 0;
    for (const a of prepared) {
      const b = [...BEARINGS, rnd() * 360, rnd() * 360];
      const d = [...DISTS, rnd() * 3];
      for (const brg of b)
        for (const dist of d) {
          const want = destinationPoint(a, brg, dist);
          const got = destinationPointFrom(a, brg, dist);
          expect(Object.is(got.lat, want.lat) && Object.is(got.lon, want.lon)).toBe(true);
          n++;
        }
    }
    expect(n).toBeGreaterThan(20_000);
  });

  it('haversineNmTo', () => {
    let n = 0;
    for (const a of pts)
      for (const b of prepared) {
        expect(Object.is(haversineNmTo(a, b), haversineNm(a, b))).toBe(true);
        n++;
      }
    expect(n).toBeGreaterThan(20_000);
  });

  it('initialBearingDegFrom', () => {
    let n = 0;
    for (const a of prepared)
      for (const b of prepared) {
        expect(Object.is(initialBearingDegFrom(a, b), initialBearingDeg(a, b))).toBe(true);
        n++;
      }
    expect(n).toBeGreaterThan(20_000);
  });

  it('preparePoint carries the raw coordinates through unchanged', () => {
    for (const p of pts) {
      const q = preparePoint(p);
      expect(Object.is(q.lat, p.lat) && Object.is(q.lon, p.lon)).toBe(true);
    }
  });
});
