import { describe, expect, it } from 'vitest';
import { APPROACH_RADIUS_M, approachGate, uniformGate, type DepthGate } from './depthGate';
import { NavMask } from './mask';
import { toRad } from './geo';
import {
  expectWalkersMatchOracle,
  navigableTableOf,
  referenceByteToDepthM,
  seededRandom,
  type WalkerOutcome,
} from '../test/maskWalkerOracle';
import { makeMask, TEST_MASK_META } from '../test/fixtures';
import type { LatLon, MaskMeta } from '../types';

// Differential keeper for NavMask's closure-free segmentNavigable and
// segmentClearanceM against the walkCells-based originals. The walkers expose
// no visited-cell sequence, so the oracle helper records every byte read of
// the grid through a Proxy and compares that sequence with walkCells' own.

const CELL = 0.005;
const pointAt = (row: number, col: number): LatLon => ({
  lat: TEST_MASK_META.south + row * CELL,
  lon: TEST_MASK_META.west + col * CELL,
});

// Power-of-two steps: a 45-degree segment has tMaxX === tMaxY at every step.
const TIE_META: MaskMeta = { west: 8, south: 54, east: 10, north: 56, cols: 256, rows: 256 };
const TIE_STEP = (TIE_META.east - TIE_META.west) / TIE_META.cols;
const tiePoint = (k: number): LatLon => ({
  lat: TIE_META.south + k * TIE_STEP,
  lon: TIE_META.west + k * TIE_STEP,
});

const BYTES = [...Array(60).fill(200), 0, 25, 29, 30, 31, 100, 254, 255];
const hashByte = (row: number, col: number): number => {
  const h = Math.imul(row * 73856093 + col * 19349663, 2654435761) >>> 0;
  return BYTES[(h >>> 7) % BYTES.length];
};

const mixed = makeMask(hashByte);
const tieMixed = makeMask(hashByte, TIE_META);
const allWater = makeMask(() => 200);

const UNIFORM_GATES: readonly number[] = [-1, 0, 2.5, 2.9, 3.0, 3.1, 20, 25.4, 26, Infinity, NaN];

function gatesFor(m: NavMask, a: LatLon, b: LatLon): DepthGate[] {
  const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  return [
    ...UNIFORM_GATES.map(uniformGate),
    approachGate(m.meta, [a, b], 3.0, [2.3, 2.3], APPROACH_RADIUS_M),
    approachGate(m.meta, [mid], 3.0, [2.5], 400),
    approachGate(m.meta, [a, mid, b], 3.1, [2.9, 3.0, 2.5], 700),
    approachGate(m.meta, [mid], 2.9, [3.1], 400),
  ];
}

interface Tally {
  segments: number;
  checks: number;
  navTrue: number;
  navFalse: number;
  clearNull: number;
  clearValue: number;
  cells: number;
}

function runAll(m: NavMask, a: LatLon, b: LatLon, label: string, t: Tally): void {
  t.segments++;
  for (const [i, gate] of gatesFor(m, a, b).entries()) {
    const o: WalkerOutcome = expectWalkersMatchOracle(m, a, b, gate, `${label} gate#${i}`);
    t.checks++;
    if (o.navigable) t.navTrue++;
    else t.navFalse++;
    if (o.clearance === null) t.clearNull++;
    else t.clearValue++;
    t.cells += o.cells;
  }
}

const newTally = (): Tally => ({
  segments: 0,
  checks: 0,
  navTrue: 0,
  navFalse: 0,
  clearNull: 0,
  clearValue: 0,
  cells: 0,
});

describe('NavMask closure-free walkers vs the walkCells originals', () => {
  const shapes: Array<[string, NavMask, LatLon, LatLon]> = [
    ['pure longitude', mixed, pointAt(100.5, 50.3), pointAt(100.5, 70.7)],
    ['pure latitude', mixed, pointAt(40.3, 60.5), pointAt(90.7, 60.5)],
    ['single cell', mixed, pointAt(30.2, 30.2), pointAt(30.8, 30.8)],
    ['zero length', mixed, pointAt(30.5, 30.5), pointAt(30.5, 30.5)],
    ['near a cell boundary', mixed, pointAt(20, 20), pointAt(35.4, 48.9)],
    ['near a cell boundary, reversed', mixed, pointAt(35.4, 48.9), pointAt(20, 20)],
    ['steep', mixed, pointAt(10.3, 100.4), pointAt(180.6, 103.1)],
    ['shallow slope', mixed, pointAt(80.3, 10.4), pointAt(83.1, 300.6)],
    ['both axes negative', mixed, pointAt(150.6, 250.7), pointAt(20.2, 30.1)],
    ['start outside the grid', mixed, pointAt(-5.5, 50.5), pointAt(40.5, 60.5)],
    ['end outside the grid', mixed, pointAt(40.5, 60.5), pointAt(40.5, 400.5)],
    ['both outside the grid', mixed, pointAt(-20.5, -20.5), pointAt(250.5, 400.5)],
    ['NaN start', mixed, { lat: NaN, lon: NaN }, pointAt(40.5, 60.5)],
    ['NaN end', mixed, pointAt(40.5, 60.5), { lat: 54.5, lon: NaN }],
    ['infinite end', mixed, pointAt(40.5, 60.5), { lat: Infinity, lon: 10 }],
    // Never moves, so with an accepted start cell only the iteration guard ends it.
    ['stuck walk', allWater, pointAt(50.5, 50.5), { lat: pointAt(50.5, 50.5).lat, lon: NaN }],
    ['exact ties, ascending', tieMixed, tiePoint(10), tiePoint(60)],
    ['exact ties, descending', tieMixed, tiePoint(60), tiePoint(10)],
    ['exact ties, long', tieMixed, tiePoint(2), tiePoint(250)],
    ['exact ties, offset by half a cell', tieMixed, tiePoint(10.5), tiePoint(80.5)],
  ];

  it('TIE_META really produces exact ties (precondition for the tie rows)', () => {
    const a = tiePoint(10);
    const b = tiePoint(60);
    const x0 = (a.lon - TIE_META.west) / TIE_STEP;
    const y0 = (a.lat - TIE_META.south) / TIE_STEP;
    expect(x0).toBe(y0);
    expect(Number.isInteger(x0)).toBe(true);
    expect((b.lon - TIE_META.west) / TIE_STEP - x0).toBe((b.lat - TIE_META.south) / TIE_STEP - y0);
  });

  it('matches on named shapes under uniform and approach gates', () => {
    const t = newTally();
    for (const [name, m, a, b] of shapes) runAll(m, a, b, name, t);
    expect(t.cells).toBeGreaterThan(1000);
    expect(t.navTrue).toBeGreaterThan(0);
    expect(t.navFalse).toBeGreaterThan(0);
    expect(t.clearNull).toBeGreaterThan(0);
    expect(t.clearValue).toBeGreaterThan(0);
  });

  it('matches on seeded random segments, including ones that leave the grid', () => {
    const rand = seededRandom(1234);
    const t = newTally();
    const pick = (lo: number, hi: number) => lo + rand() * (hi - lo);
    for (let i = 0; i < 300; i++) {
      const m = i % 3 === 0 ? tieMixed : mixed;
      const meta = m.meta;
      const spanLat = meta.north - meta.south;
      const spanLon = meta.east - meta.west;
      const a = {
        lat: pick(meta.south - 0.03 * spanLat, meta.north + 0.03 * spanLat),
        lon: pick(meta.west - 0.03 * spanLon, meta.east + 0.03 * spanLon),
      };
      const local = i % 2 === 0;
      const b = local
        ? { lat: a.lat + pick(-0.15, 0.15), lon: a.lon + pick(-0.15, 0.15) }
        : {
            lat: pick(meta.south - 0.03 * spanLat, meta.north + 0.03 * spanLat),
            lon: pick(meta.west - 0.03 * spanLon, meta.east + 0.03 * spanLon),
          };
      runAll(m, a, b, `random#${i}`, t);
    }
    expect(t.segments).toBe(300);
    expect(t.navTrue).toBeGreaterThan(0);
    expect(t.navFalse).toBeGreaterThan(0);
    expect(t.clearNull).toBeGreaterThan(0);
    expect(t.clearValue).toBeGreaterThan(0);
    expect(t.cells).toBeGreaterThan(5000);
  });

  it('matches on an all-water mask where the walk runs to the end cell', () => {
    const open = makeMask(() => 200);
    const t = newTally();
    runAll(open, pointAt(10.5, 10.5), pointAt(180.5, 300.5), 'open water', t);
    expect(t.navTrue).toBeGreaterThan(0);
    expect(t.clearValue).toBeGreaterThan(0);
  });
});

describe('NavMask walkers across an approach gate bounding-box edge', () => {
  const centre = pointAt(100.5, 160.5);
  const gate = approachGate(TEST_MASK_META, [centre], 3.0, [2.3], APPROACH_RADIUS_M);
  const cellCentre = (row: number, col: number) => pointAt(row + 0.5, col + 0.5);

  it('keeps the requested gate for bbox cells outside every disc and the relaxed gate inside one', () => {
    if (gate.kind !== 'approach') throw new Error('expected an approach gate');
    // Row 97 / col 155 is inside the union bbox but outside the ellipse.
    expect(gate.rowLo).toBeLessThanOrEqual(97);
    expect(gate.colLo).toBeLessThanOrEqual(155);
    expect(gate.colLo).toBeGreaterThan(140);
    const corner = makeMask((r, c) => (r === 97 && c === 155 ? 25 : 200));
    const inDisc = makeMask((r, c) => (r === 100 && c === 160 ? 25 : 200));

    const cornerOutcome = expectWalkersMatchOracle(
      corner,
      cellCentre(97, 140),
      cellCentre(97, 180),
      gate,
      'bbox corner shoal',
    );
    expect(cornerOutcome.navigable).toBe(false);
    expect(cornerOutcome.clearance).toBeNull();

    const discOutcome = expectWalkersMatchOracle(
      inDisc,
      cellCentre(100, 140),
      cellCentre(100, 180),
      gate,
      'in-disc shoal',
    );
    expect(discOutcome.navigable).toBe(true);
    expect(discOutcome.clearance).toBe(2.5);
  });
});

describe('NavMask walkers on approach-gate edge cases gateAtCell decides', () => {
  // Power-of-two grid: a whole-cell radius along an axis is exact, so the bbox
  // edge cell on the disc's own row or column lies ON the ellipse and relaxes.
  const step = 1 / 128;
  const w = { lat: TIE_META.south + 100.5 * step, lon: TIE_META.west + 160.5 * step };
  const at = (row: number, col: number): LatLon => ({
    lat: TIE_META.south + (row + 0.5) * step,
    lon: TIE_META.west + (col + 0.5) * step,
  });
  const rowGate = approachGate(TIE_META, [w], 3.0, [2.3], 3 * 111_320 * step);
  const colGate = approachGate(
    TIE_META,
    [w],
    3.0,
    [2.3],
    4 * 111_320 * step * Math.cos(toRad(w.lat)),
  );

  it('relaxes a shoal on each bbox edge', () => {
    if (rowGate.kind !== 'approach' || colGate.kind !== 'approach')
      throw new Error('expected approach gates');
    expect([rowGate.rowLo, rowGate.rowHi, colGate.colLo, colGate.colHi]).toEqual([
      97, 103, 156, 164,
    ]);
    const edges: Array<[DepthGate, number, number, LatLon, LatLon]> = [
      [rowGate, 97, 160, at(90, 160), at(110, 160)],
      [rowGate, 103, 160, at(90, 160), at(110, 160)],
      [colGate, 100, 156, at(100, 150), at(100, 170)],
      [colGate, 100, 164, at(100, 150), at(100, 170)],
    ];
    for (const [gate, r, c, a, b] of edges) {
      const m = makeMask((rr, cc) => (rr === r && cc === c ? 25 : 200), TIE_META);
      const o = expectWalkersMatchOracle(m, a, b, gate, `edge ${r},${c}`);
      expect(o.navigable, `edge ${r},${c}`).toBe(true);
      expect(o.clearance, `edge ${r},${c}`).toBe(2.5);
    }
  });

  it('rejects land inside a disc whose gate is not above zero', () => {
    const m = makeMask((r, c) => (r === 100 && c === 160 ? 0 : 200), TIE_META);
    for (const g of [0, -0, -1]) {
      const gate = approachGate(TIE_META, [w], 3.0, [g], APPROACH_RADIUS_M);
      const o = expectWalkersMatchOracle(m, at(100, 150), at(100, 170), gate, `disc gate ${g}`);
      expect(o.navigable).toBe(false);
      expect(o.clearance).toBeNull();
    }
  });

  it('lets the discs decide when a bbox bound is NaN', () => {
    const m = makeMask((r, c) => (r === 100 && c === 160 ? 25 : 200), TIE_META);
    const gate = approachGate(
      TIE_META,
      [w, { lat: NaN, lon: NaN }],
      3.0,
      [2.3, 2.3],
      APPROACH_RADIUS_M,
    );
    const o = expectWalkersMatchOracle(m, at(100, 150), at(100, 170), gate, 'NaN bbox');
    expect(o.navigable).toBe(true);
  });
});

describe('NavMask per-gate byte tables', () => {
  const gates: number[] = [
    -Infinity,
    -1,
    -0,
    0,
    Infinity,
    NaN,
    25.4,
    25.5,
    ...Array.from({ length: 256 }, (_, b) => referenceByteToDepthM(b)),
    ...Array.from({ length: 256 }, (_, b) => referenceByteToDepthM(b) + 1e-9),
    ...Array.from({ length: 256 }, (_, b) => referenceByteToDepthM(b) - 1e-9),
  ];

  it('agree with the byteToDepthM comparison for every byte and gate', () => {
    let accepted = 0;
    let rejected = 0;
    for (const g of gates) {
      const expected = new Array<number>(512);
      for (let b = 0; b < 256; b++) {
        const nav = b !== 0 && referenceByteToDepthM(b) >= g;
        expected[b] = nav ? 1 : 0;
        expected[256 + b] = b !== 0 && !(referenceByteToDepthM(b) < g) ? 1 : 0;
        if (nav) accepted++;
        else rejected++;
      }
      // One expect per gate, not per byte: keeps this under the default test timeout.
      expect(Array.from(navigableTableOf(mixed, g)), `gate ${g}`).toEqual(expected);
    }
    expect(accepted).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(1000);
  });

  it('keep answering correctly after the per-mask cache overflows', () => {
    const m = makeMask(() => 200);
    for (let i = 0; i < 200; i++) {
      const g = i / 7;
      const table = navigableTableOf(m, g);
      expect(table[200]).toBe(20 >= g ? 1 : 0);
    }
  });

  it('decode each byte as byteToDepthM does (255 is 25.4, 254 reserved)', () => {
    const meta: MaskMeta = { west: 9, south: 54, east: 10, north: 55, cols: 16, rows: 16 };
    const a = { lat: 54.5, lon: 9.2 };
    const b = { lat: 54.5, lon: 9.7 };
    for (let byte = 0; byte < 256; byte++) {
      const m = new NavMask(meta, new Uint8Array(16 * 16).fill(byte));
      expect(m.segmentClearanceM(a, b, uniformGate(-Infinity)), `byte ${byte}`).toBe(
        byte === 0 ? null : referenceByteToDepthM(byte),
      );
    }
  });
});
