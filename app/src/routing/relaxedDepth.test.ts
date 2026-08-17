import { describe, expect, it } from 'vitest';
import { BOAT_DRAFT_M, findRelaxedGate, type ProbeInfo } from './relaxedDepth';
import { makeMask } from '../test/fixtures';
import { ceilToDecimetre } from '../lib/boatDepth';

// Wall at col 160 (lon ≈ 10.2) except a gap (rows 90..99) charted `gapDm`
// decimeters; everything else 20 m water.
const gapMask = (gapDm: number) =>
  makeMask((r, c) => (c !== 160 ? 200 : r >= 90 && r <= 99 ? gapDm : 0));
// Cell centers (grid step 0.005°): row 90, cols 140 / 180 / 220.
const WEST = { lat: 54.7525, lon: 10.1025 };
const EAST = { lat: 54.7525, lon: 10.3025 };
const FAR_EAST = { lat: 54.7525, lon: 10.5025 };

/**
 * #452 KILL SWITCH REGRESSION SUITE. Every case in this describe block is the
 * pre-#452 `findRelaxedDepthM` test verbatim — the same fixtures, the same
 * probe sequences, the same expected gates, not one literal touched. What
 * they assert now is that `approachRadiusM = Infinity` reproduces the
 * pre-#452 route-wide behaviour EXACTLY, which is the whole value of running
 * them unchanged: an updated expectation here would delete that evidence.
 *
 * `Infinity` is passed positionally rather than through `APPROACH_RADIUS_M`
 * deliberately — these cases must keep testing the neutralized state even if
 * the production radius changes.
 */
const relaxedM = (
  mask: Parameters<typeof findRelaxedGate>[0],
  waypoints: Parameters<typeof findRelaxedGate>[1],
  requestedDepthM: number,
  onProbe?: Parameters<typeof findRelaxedGate>[5],
): number | null =>
  findRelaxedGate(mask, waypoints, requestedDepthM, Infinity, BOAT_DRAFT_M, onProbe)?.usedDepthM ??
  null;

describe('findRelaxedGate under the #452 kill switch (#53 behaviour, unchanged)', () => {
  it('finds the highest decimeter gate that still connects (2.4 m gap, 3.0 m requested)', () => {
    expect(relaxedM(gapMask(24), [WEST, EAST], 3.0)).toBeCloseTo(2.4, 6);
  });

  it('probes exactly the binary-search sequence 2.5, 2.2, 2.3, 2.4 for that case', () => {
    // Hand-derived over candidates dm 21..29: mid 25 → gap 2.4 < 2.5 fails,
    // hi=24; mid 22 → connects, lo=23; mid 23 → connects, lo=24; mid 24 →
    // connects → answer 2.4 after exactly 4 probes.
    const probes: ProbeInfo[] = [];
    relaxedM(gapMask(24), [WEST, EAST], 3.0, (p) => probes.push(p));
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
    expect(relaxedM(m, [WEST, FAR_EAST], 3.0)).toBeCloseTo(2.2, 6);
  });

  it('candidate ceiling is exclusive of the requested depth', () => {
    // requested 2.5 → candidates 2.1..2.4; gap charted 2.4 → 2.4 (never 2.5)
    expect(relaxedM(gapMask(24), [WEST, EAST], 2.5)).toBeCloseTo(2.4, 6);
  });

  it('floating-point requested values quantize safely (requested 2.2 → only candidate 2.1)', () => {
    // 2.2 * 10 = 22.000000000000004 in IEEE 754 — the ceiling computation must
    // not let the rounding error admit 2.2 itself as a candidate.
    expect(relaxedM(gapMask(30), [WEST, EAST], 2.2)).toBeCloseTo(2.1, 6);
  });

  it('never relaxes below boat draft: requested <= 2.1 yields null without probing', () => {
    const probes: ProbeInfo[] = [];
    expect(relaxedM(gapMask(24), [WEST, EAST], BOAT_DRAFT_M, (p) => probes.push(p))).toBeNull();
    expect(relaxedM(gapMask(24), [WEST, EAST], 2.0)).toBeNull();
    expect(probes).toEqual([]);
  });

  it('a gap below draft depth never connects: null after the failing probe descent', () => {
    // Hand-derived: 2.5 fails (hi=24), 2.2 fails (hi=21), 2.1 fails → null.
    const probes: ProbeInfo[] = [];
    expect(relaxedM(gapMask(15), [WEST, EAST], 3.0, (p) => probes.push(p))).toBeNull();
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
    expect(relaxedM(m, [WEST, EAST], 3.0)).toBeCloseTo(2.5, 6);
    expect(relaxedM(m, [WEST, EAST, FAR_EAST], 3.0)).toBeNull();
  });
});

it('#54: findRelaxedGate searches from the given floor, not a module constant', () => {
  // Gap charted 2.0 m: a 1.8 m floor connects at 2.0 (the gap's own depth,
  // capped by hiDm); a 2.3 m floor starts its search ABOVE the gap and finds
  // nothing. A build that still reads the module constant (BOAT_DRAFT_M =
  // 2.1 m) instead of this parameter would ignore both floors and return the
  // same answer either way.
  const mask = gapMask(20);
  const waypoints = [WEST, EAST];
  const shallow = findRelaxedGate(mask, waypoints, 3.0, Infinity, 1.8);
  const deep = findRelaxedGate(mask, waypoints, 3.0, Infinity, 2.3);
  expect(shallow?.usedDepthM).toBeCloseTo(2.0, 6);
  expect(deep).toBeNull();
  expect(deep?.usedDepthM).not.toBe(shallow?.usedDepthM);
});

// #54 fix round 1: `findRelaxedGate` quantises `floorM` up with an INLINE
// `Math.ceil(f * 10 - 1e-9)` rather than by importing `ceilToDecimetre`,
// which is metres->metres while the search works in integer decimetres. The
// reasons are unit symmetry with the `hiDm` line directly below it, and
// avoiding a dm->m->dm round trip.
//
// The expression is therefore duplicated across two files and nothing in the
// compiler spans them. This guard READS BOTH SHIPPED SOURCES rather than
// retyping either, following useBannerHeight.test.ts literally: a retyped
// copy compared against `ceilToDecimetre` would hold by construction AND
// would stay green when relaxedDepth.ts itself drifted — MEASURED, an earlier
// draft of this guard did exactly that (whole file green with `loDm` reverted
// to Math.round).
//
// `import.meta.glob(..., '?raw')` rather than node:fs — the browser-safe form
// used by sailLiteralCallSites.test.ts / timeoutGuard.test.ts, which needs no
// tsconfig.app.json exclusion (useBannerHeight.test.ts reads a NON-TypeScript
// asset, which is the only reason it needs node builtins).
const QUANTISER_SOURCES = import.meta.glob<string>(['./relaxedDepth.ts', '../lib/boatDepth.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// NOTE the key shape: import.meta.glob keys are relative to THIS file's own
// directory, so they read './relaxedDepth.ts' and '../lib/boatDepth.ts' — NOT
// 'src/routing/...'. The first draft matched on 'routing/relaxedDepth.ts' and
// the fail-closed check below caught it on the very first run, which is the
// whole reason that check exists (sailLiteralCallSites.test.ts documents the
// same trap).
function sourceOf(suffix: string): string {
  const hit = Object.entries(QUANTISER_SOURCES).find(([k]) => k.endsWith(suffix));
  // Fail CLOSED: a glob that stops matching must red, not silently pass.
  expect(hit, `drift guard cannot read ${suffix} — the glob no longer matches it`).toBeDefined();
  return hit![1];
}

/**
 * The one expression both sites must spell: ceil, with the IEEE nudge, never
 * round.
 *
 * SHAPE only. A drift that keeps `Math.ceil(... - 1e-9)` while changing the
 * surrounding arithmetic passes every row here — this is a drift pin between
 * the two spellings, not a correctness pin on either. The behavioural pin for
 * the callee is realmask.repro.test.ts's (a2) row; every floor in THIS file is
 * already decimetre-quantised and so cannot see ceil-vs-round at all.
 *
 * SCOPE of the no-Math.round rule, because the over-broad reading would
 * reject a correct change: the C.8 hazard is rounding a RAW draft, which is
 * what both expressions below take. Rounding an ALREADY-QUANTISED decimetre
 * is harmless — `Math.round(ceilToDecimetre(f) * 10)` agrees with the inline
 * form 4501/4501 and is exactly what this file's own oracle row uses.
 */
function expectCeilsUp(expr: string, where: string): void {
  expect(expr, `${where} must ceil`).toMatch(/Math\.ceil\(/);
  expect(expr, `${where} must carry the 1e-9 nudge`).toMatch(/-\s*1e-9/);
  expect(expr, `${where}: Math.round quantises a draft BELOW its own keel (spec C.8)`).not.toMatch(
    /Math\.round\(/,
  );
}

describe('#54: the decimetre quantiser is duplicated across two files — pin both SHIPPED sites', () => {
  it("relaxedDepth.ts's own loDm line ceils", () => {
    const src = sourceOf('/relaxedDepth.ts');
    const m = src.match(/const loDm = ([^;\n]+);/);
    expect(
      m,
      'relaxedDepth.ts no longer declares `const loDm = ...` — guard is blind',
    ).not.toBeNull();
    expectCeilsUp(m![1], 'relaxedDepth.ts loDm');
  });

  it("lib/boatDepth.ts's ceilToDecimetre body ceils", () => {
    const src = sourceOf('/boatDepth.ts');
    const m = src.match(/export function ceilToDecimetre[^{]*\{\s*return ([^;\n]+);/);
    expect(
      m,
      'boatDepth.ts no longer declares ceilToDecimetre as one return — guard is blind',
    ).not.toBeNull();
    expectCeilsUp(m![1], 'boatDepth.ts ceilToDecimetre');
  });

  // The two rows above pin the SHAPE of each shipped site. These two pin the
  // BEHAVIOUR, which is the separate claim that licenses "no #282 sweep owed":
  // the retyped expression is legitimate here only because the rows above
  // establish the shipped one spells the same rule.
  const rule = (f: number) => Math.ceil(f * 10 - 1e-9);

  it('agrees with ceilToDecimetre across [0.5, 5.0] at millimetre spacing', () => {
    const disagreements: number[] = [];
    for (let x = 500; x <= 5000; x++) {
      const f = x / 1000;
      // ceilToDecimetre returns METRES, loDm DECIMETRES; compare in decimetres.
      if (rule(f) !== Math.round(ceilToDecimetre(f) * 10)) disagreements.push(f);
    }
    expect(disagreements, 'the two quantisers disagree').toEqual([]);
  });

  it('rounds UP, never down — the spec C.8 property both sites exist to hold', () => {
    for (const [draft, expectedDm] of [
      [1.73, 18],
      [2.14, 22],
      [2.24, 23],
    ] as const) {
      expect(rule(draft), `${draft} m must not quantise below its own keel`).toBe(expectedDm);
      // Control: these are exactly the drafts where round goes under the keel,
      // so a guard that accepted round could not pass this row.
      expect(Math.round(draft * 10), 'control: round is the forbidden form').toBeLessThan(
        expectedDm,
      );
    }
  });
});
