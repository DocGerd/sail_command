import { expect } from 'vitest';
import { gateAtCell, type DepthGate } from '../lib/depthGate';
import type { NavMask } from '../lib/mask';
import type { LatLon } from '../types';

// Oracle for NavMask's closure-free segment walkers: the pre-specialisation
// bodies, run over the unchanged private `walkCells`/`cellNavigable` (ordinary
// methods at runtime; the casts reach TypeScript-only `private`).

interface MaskInternals {
  readonly meta: { rows: number; cols: number };
  data: Uint8Array;
  walkCells(a: LatLon, b: LatLon, visit: (row: number, col: number) => boolean): boolean;
  cellNavigable(row: number, col: number, gate: DepthGate): boolean;
  depthByte(row: number, col: number): number;
  byteToDepthM(b: number): number;
  navigableTable(gateM: number): Uint8Array;
}

const internals = (m: NavMask) => m as unknown as MaskInternals;

export function oracleNavigable(m: NavMask, a: LatLon, b: LatLon, gate: DepthGate): boolean {
  const self = internals(m);
  return self.walkCells(a, b, (row, col) => self.cellNavigable(row, col, gate));
}

export function oracleClearance(m: NavMask, a: LatLon, b: LatLon, gate: DepthGate): number | null {
  const self = internals(m);
  const { rows, cols } = self.meta;
  let min = Infinity;
  const completed = self.walkCells(a, b, (row, col) => {
    if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
    const byte = self.depthByte(row, col);
    if (byte === 0) return false;
    const depthM = self.byteToDepthM(byte);
    if (depthM < gateAtCell(gate, row, col)) return false;
    if (depthM < min) min = depthM;
    return true;
  });
  return completed ? min : null;
}

export function oracleAccepts(m: NavMask, gate: DepthGate): (row: number, col: number) => boolean {
  const self = internals(m);
  return (row, col) => self.cellNavigable(row, col, gate);
}

export function oracleAcceptsClearance(
  m: NavMask,
  gate: DepthGate,
): (row: number, col: number) => boolean {
  const self = internals(m);
  const { rows, cols } = self.meta;
  return (row, col) => {
    if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
    const byte = self.depthByte(row, col);
    if (byte === 0) return false;
    return !(self.byteToDepthM(byte) < gateAtCell(gate, row, col));
  };
}

/**
 * In-bounds cells `walkCells` visits until `accept` first returns false (that
 * cell included), as `row,col` strings. Out-of-bounds visits are dropped: a
 * walker that aborts there never reads the byte.
 */
export function oracleVisited(
  m: NavMask,
  a: LatLon,
  b: LatLon,
  accept: (row: number, col: number) => boolean,
): string[] {
  const self = internals(m);
  const { rows, cols } = self.meta;
  const seq: string[] = [];
  self.walkCells(a, b, (row, col) => {
    if (row >= 0 && row < rows && col >= 0 && col < cols) seq.push(`${row},${col}`);
    return accept(row, col);
  });
  return seq;
}

/** Run `fn` with every in-range byte read of the mask's grid recorded as `row,col`. */
export function recordReads<T>(m: NavMask, fn: () => T): { result: T; reads: string[] } {
  const self = internals(m);
  const original = self.data;
  const { cols } = self.meta;
  const reads: string[] = [];
  self.data = new Proxy(original, {
    get(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        const idx = Number(prop);
        reads.push(`${Math.floor(idx / cols)},${idx % cols}`);
      }
      return Reflect.get(target, prop, target) as unknown;
    },
  });
  try {
    return { result: fn(), reads };
  } finally {
    self.data = original;
  }
}

export function referenceByteToDepthM(b: number): number {
  return b === 0 ? 0 : b === 255 ? 25.4 : b / 10;
}

export function navigableTableOf(m: NavMask, gateM: number): Uint8Array {
  return internals(m).navigableTable(gateM);
}

/** mulberry32: small seeded PRNG for deterministic random segments. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WalkerOutcome {
  readonly navigable: boolean;
  readonly clearance: number | null;
  readonly cells: number;
}

/** Fails if either walker differs from the oracle in result or in cells read, in order. */
export function expectWalkersMatchOracle(
  m: NavMask,
  a: LatLon,
  b: LatLon,
  gate: DepthGate,
  label: string,
): WalkerOutcome {
  const nav = recordReads(m, () => m.segmentNavigable(a, b, gate));
  expect(nav.result, `${label}: segmentNavigable`).toBe(oracleNavigable(m, a, b, gate));
  expect(nav.reads, `${label}: segmentNavigable cells`).toEqual(
    oracleVisited(m, a, b, oracleAccepts(m, gate)),
  );
  const clr = recordReads(m, () => m.segmentClearanceM(a, b, gate));
  expect(clr.result, `${label}: segmentClearanceM`).toBe(oracleClearance(m, a, b, gate));
  expect(clr.reads, `${label}: segmentClearanceM cells`).toEqual(
    oracleVisited(m, a, b, oracleAcceptsClearance(m, gate)),
  );
  return { navigable: nav.result, clearance: clr.result, cells: nav.reads.length };
}
