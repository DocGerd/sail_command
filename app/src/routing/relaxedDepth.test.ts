import { describe, expect, it } from 'vitest';
import { BOAT_DRAFT_M, findRelaxedDepthM, type ProbeInfo } from './relaxedDepth';
import { makeMask } from '../test/fixtures';

// Wall at col 160 (lon ≈ 10.2) except a gap (rows 90..99) charted `gapDm`
// decimeters; everything else 20 m water.
const gapMask = (gapDm: number) =>
  makeMask((r, c) => (c !== 160 ? 200 : r >= 90 && r <= 99 ? gapDm : 0));
// Cell centers (grid step 0.005°): row 90, cols 140 / 180 / 220.
const WEST = { lat: 54.7525, lon: 10.1025 };
const EAST = { lat: 54.7525, lon: 10.3025 };
const FAR_EAST = { lat: 54.7525, lon: 10.5025 };

describe('findRelaxedDepthM (#53)', () => {
  it('finds the highest decimeter gate that still connects (2.4 m gap, 3.0 m requested)', () => {
    expect(findRelaxedDepthM(gapMask(24), [WEST, EAST], 3.0)).toBeCloseTo(2.4, 6);
  });

  it('probes exactly the binary-search sequence 2.5, 2.2, 2.3, 2.4 for that case', () => {
    // Hand-derived over candidates dm 21..29: mid 25 → gap 2.4 < 2.5 fails,
    // hi=24; mid 22 → connects, lo=23; mid 23 → connects, lo=24; mid 24 →
    // connects → answer 2.4 after exactly 4 probes.
    const probes: ProbeInfo[] = [];
    findRelaxedDepthM(gapMask(24), [WEST, EAST], 3.0, (p) => probes.push(p));
    expect(probes.map((p) => p.probeDepthM)).toEqual([2.5, 2.2, 2.3, 2.4]);
    expect(probes.map((p) => p.done)).toEqual([1, 2, 3, 4]);
    // ceil(log2(9 candidates + 1)) = 4 — the reported upper bound
    for (const p of probes) expect(p.total).toBe(4);
  });

  it('serial bottlenecks: the shallowest gate on the chain controls the answer', () => {
    // Second wall at col 200 with a 2.2 m gap; first gap 2.6 m → 2.2 controls.
    const m = makeMask((r, c) => {
      if (c === 160) return r >= 90 && r <= 99 ? 26 : 0;
      if (c === 200) return r >= 90 && r <= 99 ? 22 : 0;
      return 200;
    });
    expect(findRelaxedDepthM(m, [WEST, FAR_EAST], 3.0)).toBeCloseTo(2.2, 6);
  });

  it('candidate ceiling is exclusive of the requested depth', () => {
    // requested 2.5 → candidates 2.1..2.4; gap charted 2.4 → 2.4 (never 2.5)
    expect(findRelaxedDepthM(gapMask(24), [WEST, EAST], 2.5)).toBeCloseTo(2.4, 6);
  });

  it('floating-point requested values quantize safely (requested 2.2 → only candidate 2.1)', () => {
    // 2.2 * 10 = 22.000000000000004 in IEEE 754 — the ceiling computation must
    // not let the rounding error admit 2.2 itself as a candidate.
    expect(findRelaxedDepthM(gapMask(30), [WEST, EAST], 2.2)).toBeCloseTo(2.1, 6);
  });

  it('never relaxes below boat draft: requested <= 2.1 yields null without probing', () => {
    const probes: ProbeInfo[] = [];
    expect(
      findRelaxedDepthM(gapMask(24), [WEST, EAST], BOAT_DRAFT_M, (p) => probes.push(p)),
    ).toBeNull();
    expect(findRelaxedDepthM(gapMask(24), [WEST, EAST], 2.0)).toBeNull();
    expect(probes).toEqual([]);
  });

  it('a gap below draft depth never connects: null after the failing probe descent', () => {
    // Hand-derived: 2.5 fails (hi=24), 2.2 fails (hi=21), 2.1 fails → null.
    const probes: ProbeInfo[] = [];
    expect(findRelaxedDepthM(gapMask(15), [WEST, EAST], 3.0, (p) => probes.push(p))).toBeNull();
    expect(probes.map((p) => p.probeDepthM)).toEqual([2.5, 2.2, 2.1]);
  });

  it('a via chain probes every consecutive pair: a disconnected middle pair yields null', () => {
    // The col-200 wall has NO gap at all: WEST↔EAST connects below 2.6 but
    // EAST↔FAR_EAST never does.
    const m = makeMask((r, c) => {
      if (c === 160) return r >= 90 && r <= 99 ? 25 : 0;
      if (c === 200) return 0;
      return 200;
    });
    expect(findRelaxedDepthM(m, [WEST, EAST], 3.0)).toBeCloseTo(2.5, 6);
    expect(findRelaxedDepthM(m, [WEST, EAST, FAR_EAST], 3.0)).toBeNull();
  });
});
