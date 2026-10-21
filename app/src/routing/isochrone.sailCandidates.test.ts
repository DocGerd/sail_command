import { describe, expect, it } from 'vitest';
import { Polar } from '../lib/polar';
import type { PolarTable } from '../types';
import { sailCandidates } from './isochrone';

const polarTables = Object.values(
  import.meta.glob<PolarTable>('../../public/data/polars/*.json', {
    eager: true,
    import: 'default',
  }),
);

const EXTRA_TWAS = [45, 55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155, 165, 175];
const MOTOR_TWAS = [0, 20, 35];

/** Verbatim pre-template builder. */
function referenceCandidates(
  beatDeg: number,
  gybeDeg: number,
  motorEnabled: boolean,
  directTwa: number,
): number[] {
  const mags = [beatDeg, gybeDeg, ...EXTRA_TWAS, ...(motorEnabled ? MOTOR_TWAS : [])];
  const twas: number[] = [];
  for (const m of mags)
    for (const s of [1, -1]) {
      const t = s * m;
      if (!twas.some((x) => Math.abs(x - t) < 1)) twas.push(t);
    }
  if (!twas.includes(180)) twas.push(180);
  if (!twas.some((x) => Math.abs(x - directTwa) < 0.5)) twas.push(directTwa);
  return twas;
}

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

function sameArray(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

describe('sailCandidates', () => {
  const rnd = mulberry32(0xa11ce);
  const angles: number[] = [
    -0, 0, 0.5, 1, 19.2, 20, 20.9, 34.1, 35, 36, 44.1, 45, 45.99, 46, 54.5, 66, 99.5, 134.2, 135,
    174.5, 175, 175.9, 176, 179, 179.5, 180, 181, 90, 150.7,
  ];
  for (let k = 0; k < 300; k++) angles.push(rnd() * 190);
  const directs: number[] = [
    -0, 0, 180, -180, 179.8, -179.8, 45.3, -45.3, 20.4, -34.6, 0.2, 175.4, 90, -90, 33, 150.2,
  ];

  it('is entry-for-entry bit-identical to the pre-template builder', () => {
    let n = 0;
    for (const motor of [true, false])
      for (const beat of angles)
        for (const gybe of angles.slice(0, 80)) {
          const direct = n % 7 === 0 ? rnd() * 360 - 180 : directs[n % directs.length];
          const want = referenceCandidates(beat, gybe, motor, direct);
          const got = sailCandidates(beat, gybe, motor, direct);
          if (!sameArray(got, want)) expect(got).toEqual(want);
          n++;
        }
    expect(n).toBeGreaterThan(40_000);
  });

  it('matches on the beat and gybe angles of every shipped polar, and on NaN', () => {
    expect(polarTables.length).toBeGreaterThanOrEqual(8);
    const pairs: Array<[number, number]> = [[NaN, NaN]];
    for (const table of polarTables) {
      const polar = new Polar(table);
      for (let k = 0; k <= 800; k++)
        pairs.push([polar.beatAngleDeg(k / 20), polar.gybeAngleDeg(k / 20)]);
    }
    let n = 0;
    for (const [beat, gybe] of pairs)
      for (const motor of [true, false]) {
        const direct = directs[n % directs.length];
        const want = referenceCandidates(beat, gybe, motor, direct);
        const got = sailCandidates(beat, gybe, motor, direct);
        if (!sameArray(got, want)) expect(got).toEqual(want);
        n++;
      }
    expect(n).toBeGreaterThan(10_000);
  });

  it('keeps +0 and drops -0 for the motor TWA, and covers beat/gybe collisions', () => {
    const got = sailCandidates(47.2, 142.3, true, 10);
    expect(got.some((x) => Object.is(x, 0))).toBe(true);
    expect(got.some((x) => Object.is(x, -0))).toBe(false);
    expect(sameArray(got, referenceCandidates(47.2, 142.3, true, 10))).toBe(true);
    // 45.4 sits within 1 deg of the fixed 45, 175.2 of 175.
    const c = sailCandidates(45.4, 175.2, false, 10);
    expect(c.includes(45)).toBe(false);
    expect(c.includes(175)).toBe(false);
    expect(c.includes(180)).toBe(true);
  });
});
