import { describe, expect, it } from 'vitest';
import type { PolarTable } from '../types';
import { normalizeDeg180 } from './geo';
import { Polar } from './polar';

const modules = import.meta.glob<PolarTable>('../../public/data/polars/*.json', {
  eager: true,
  import: 'default',
});
const tables = Object.entries(modules)
  .sort(([x], [y]) => (x < y ? -1 : 1))
  .map(([path, table]) => ({ f: path.slice(path.lastIndexOf('/') + 1), table }));

/** Verbatim pre-hoist `Polar.speedKn`. */
function referenceSpeedKn(
  table: PolarTable,
  performanceFactor: number,
  twaDeg: number,
  twsKn: number,
): number {
  const { tws, twa, speeds } = table;
  const a = Math.abs(normalizeDeg180(twaDeg));
  if (twsKn <= 0) return 0;

  let twsFactor = 1;
  let w = twsKn;
  if (w > tws[tws.length - 1]) w = tws[tws.length - 1];
  if (w < tws[0]) {
    twsFactor = w / tws[0];
    w = tws[0];
  }
  let j = 1;
  while (j < tws.length - 1 && tws[j] < w) j++;
  const fw = (w - tws[j - 1]) / (tws[j] - tws[j - 1]);

  const speedAtTwa = (rowLo: number, rowHi: number, fa: number): number => {
    const lo = speeds[rowLo][j - 1] + fw * (speeds[rowLo][j] - speeds[rowLo][j - 1]);
    const hi = speeds[rowHi][j - 1] + fw * (speeds[rowHi][j] - speeds[rowHi][j - 1]);
    return lo + fa * (hi - lo);
  };

  let v: number;
  if (a <= twa[0]) {
    v = speedAtTwa(0, 0, 0) * (a / twa[0]);
  } else if (a >= twa[twa.length - 1]) {
    v = speedAtTwa(twa.length - 1, twa.length - 1, 0);
  } else {
    let i = 1;
    while (twa[i] < a) i++;
    const fa = (a - twa[i - 1]) / (twa[i] - twa[i - 1]);
    v = speedAtTwa(i - 1, i, fa);
  }
  return v * twsFactor * performanceFactor;
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

function twaProbes(table: PolarTable, rnd: () => number): number[] {
  const out: number[] = [-0, 0, 180, -180, 360, -360, 540, 179.999, -179.999, 0.001, NaN];
  for (const a of table.twa) out.push(a, -a, a + 1e-9, a - 1e-9, 360 - a);
  for (let d = -400; d <= 400; d += 2.5) out.push(d);
  for (let k = 0; k < 400; k++) out.push((rnd() - 0.5) * 900);
  return out;
}

function twsProbes(table: PolarTable, rnd: () => number): number[] {
  const out: number[] = [-5, -0, 0, 1e-9, 0.5, 1000, Infinity, NaN];
  const first = table.tws[0];
  const last = table.tws[table.tws.length - 1];
  out.push(first / 2, first - 1e-9, last + 1e-9, last * 3);
  for (const w of table.tws) out.push(w, w - 1e-9, w + 1e-9);
  for (let w = 0; w <= last + 6; w += 0.25) out.push(w);
  for (let k = 0; k < 300; k++) out.push(rnd() * (last + 10));
  return out;
}

describe('Polar.bracketTws / speedKnAt (hoisted TWS bracket)', () => {
  it('finds the shipped polar tables', () => {
    expect(tables.length).toBeGreaterThanOrEqual(8);
  });

  for (const { f, table } of tables) {
    for (const pf of [1, 0.93]) {
      it(`${f} (performanceFactor ${pf}): bit-identical to the pre-hoist speedKn`, () => {
        const polar = new Polar(table, pf);
        const rnd = mulberry32(0xc0ffee);
        const twas = twaProbes(table, rnd);
        const twss = twsProbes(table, rnd);
        let checked = 0;
        const mismatches: string[] = [];
        for (const w of twss) {
          const bracket = polar.bracketTws(w);
          for (const a of twas) {
            const expected = referenceSpeedKn(table, pf, a, w);
            if (!Object.is(polar.speedKnAt(a, bracket), expected))
              mismatches.push(`speedKnAt(${a}, ${w})`);
            if (!Object.is(polar.speedKn(a, w), expected)) mismatches.push(`speedKn(${a}, ${w})`);
            checked++;
          }
        }
        expect(mismatches.slice(0, 5)).toEqual([]);
        expect(checked).toBeGreaterThan(100_000);
      });
    }
  }

  it('a bracket is reusable across TWAs and does not carry state between calls', () => {
    const { table } = tables[0];
    const polar = new Polar(table);
    const b = polar.bracketTws(9.3);
    const first = polar.speedKnAt(75, b);
    polar.speedKnAt(130, b);
    polar.speedKnAt(10, b);
    expect(Object.is(polar.speedKnAt(75, b), first)).toBe(true);
  });
});
