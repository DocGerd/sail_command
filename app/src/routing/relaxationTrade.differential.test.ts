import { describe, expect, it, vi } from 'vitest';
import { BOATS } from '../data/boats';
import {
  mask,
  RELAXATION_TRADE_DEPTH_CASES,
  measureRelaxationTrade,
  relaxationTradeSnappedPairs,
  expectRelaxationTradeRadiusInvariant,
  expectRelaxationTradeSubsetConsistency,
} from '../test/realmaskFixtures';
import { makeMask, TEST_MASK_META } from '../test/fixtures';
import { solverTimeoutMs } from '../test/timeouts';
import type { LatLon } from '../types';

// Each probe runs `NavMask.cellsConnected`, whose BFS scratch is module-level
// and reused across calls since #1256 — stamped per call, not reallocated.
// The budget below was measured BEFORE that change and is not re-measured here.
// Budget: slowest row 62 s on CI before #295 (run 34967193450, 32 pairs per
// fixed origin), 138-149 s after it (runs 34991379729, 34997849572, 39 pairs);
// ~2x the slowest, via solverTimeoutMs, never a literal (`timeoutGuard.test.ts`).
vi.setConfig({ testTimeout: solverTimeoutMs(300_000) });

/**
 * #930 (R3, split from #649/#452): P3's named trade. A per-disc connectivity
 * search is harder to satisfy than the global one, so `findRelaxedGate` can
 * return a LOWER `usedDepthM` (or none) at the shipped radius than the global
 * search would. Findings and method: docs/spikes/930-relaxation-trade-measurement.md.
 *
 * Runs the SHIPPED `findRelaxedGate` twice per pair on the real committed mask,
 * changing only `approachRadiusM`:
 *   - LOCAL:  `APPROACH_RADIUS_M`, as `planRoute.ts` passes it.
 *   - GLOBAL: `Infinity`, `depthGate.ts`'s kill switch, which reproduces the
 *     pre-#452 route-wide search (pinned by `relaxedDepth.test.ts`).
 *
 * STRUCTURAL vs EMPIRICAL. Only `local <= global` (and "local relaxes =>
 * global relaxes") follows from the code: local's navigable set is a subset of
 * global's at every probe, and phase 2 only raises disc gates. Equality does
 * NOT follow — both positive controls below break it, on the real mask at a
 * tighter radius and on a synthetic mask — so the equality assertion is an
 * empirical pin of THIS mask, harbour set and catalogue over `POPULATIONS`
 * below; it reds only if a change makes the trade bite on one of those pairs.
 *
 * Waypoints are snapped at the requested gate first, exactly as `planRoute`
 * does before it calls `findRelaxedGate`. A raw `harbors.json` snap sitting
 * below the gate would otherwise read as disconnected at its own endpoint.
 *
 * Plan-level (solver) evidence is not attempted here: `planRoute` takes no
 * radius parameter. See the P3 record §7 sweep instead.
 *
 * #1261: the per-`POPULATIONS`-entry `describe.each(DEPTH_CASES)`/`it.each`
 * block (~728 s CI total, this file's biggest cost) was split into three
 * sibling files, one per population — realmask.repro.relaxationTrade.
 * originMarstal/originFlensburg/destinationMarstal.test.ts — so vitest can
 * schedule them on separate workers instead of serializing inside one file.
 * They are named with the `realmask.repro.` prefix (rather than
 * `relaxationTrade.differential.*`) so they fall inside the EXISTING
 * `realmask.repro*.test.ts` tsconfig glob (both `tsconfig.app.json`'s
 * exclude and `tsconfig.test.json`'s include use that wildcard, where this
 * file's own entry is an EXACT filename with no wildcard) — this split adds
 * zero tsconfig entries. The `describe.each`/`it.each` helpers (formerly
 * defined here and duplicated verbatim in each of those three files) moved
 * to `../test/realmaskFixtures.ts` — a plain, non-`.test.ts` module already
 * imported by every `realmask.repro.*` sibling, so importing it never
 * re-registers this file's `describe`/`it` calls (unlike importing a
 * `.test.ts` file directly, which vitest would collect AND execute a second
 * time). This file keeps the light "derives one depth case" test and both
 * POSITIVE CONTROLs, which never touch `POPULATIONS`.
 */

describe('#930 R3: P3 disc-vs-global relaxation trade (shipped findRelaxedGate, real mask)', () => {
  it('derives one depth case per distinct (gate, floor) pair across every catalogue boat', () => {
    expect(RELAXATION_TRADE_DEPTH_CASES.flatMap((c) => c.boatIds).sort()).toEqual(
      BOATS.map((b) => b.id).sort(),
    );
    console.log('#930 depth cases:', JSON.stringify(RELAXATION_TRADE_DEPTH_CASES));
  });

  it('POSITIVE CONTROL (real mask): at 1000 m, below the ~1060 m Marstal cliff, the tripwire reds with BOTH a lost route and a different depth', () => {
    // Compared against Infinity, not APPROACH_RADIUS_M, so the control does
    // not move with the constant it guards. Measured: at 1000 m Marstal's
    // pinch falls outside its disc, so a 2.1 m floor loses the route while a
    // 1.9 m floor relaxes further, to a 1.9 m detour, against global's 2.3 m.
    // The different-depth half needs a catalogue boat with a 1.9 m floor.
    const TIGHT_RADIUS_M = 1000;
    const rows = RELAXATION_TRADE_DEPTH_CASES.flatMap((c) =>
      measureRelaxationTrade(
        mask,
        relaxationTradeSnappedPairs('marstal', c.requestedM).pairs.map((p) => ({
          ...p,
          id: `[${c.boatIds.join(',')}] ${p.id}`,
        })),
        c.requestedM,
        c.floorM,
        TIGHT_RADIUS_M,
      ),
    );
    const lost = rows.filter((r) => r.localUsedDepthM === null && r.globalUsedDepthM !== null);
    const deeper = rows.filter(
      (r) =>
        r.localUsedDepthM !== null &&
        r.globalUsedDepthM !== null &&
        r.localUsedDepthM !== r.globalUsedDepthM,
    );
    const diag = JSON.stringify(rows);
    expect(
      lost.length,
      `no lost-route divergence at ${TIGHT_RADIUS_M} m.\n${diag}`,
    ).toBeGreaterThan(0);
    expect(
      deeper.length,
      `no different-depth divergence at ${TIGHT_RADIUS_M} m.\n${diag}`,
    ).toBeGreaterThan(0);
    expectRelaxationTradeSubsetConsistency(rows, 'control');
    expect(() => expectRelaxationTradeRadiusInvariant(lost, 'control')).toThrow(/trade bites/);
    expect(() => expectRelaxationTradeRadiusInvariant(deeper, 'control')).toThrow(/trade bites/);
  });

  it('POSITIVE CONTROL (synthetic): on a two-channel mask local relaxes DEEPER than global, and the tripwire reds', () => {
    // Mask-independent twin of the real-mask control: shows the divergence is
    // a property of the mechanism, not of Marstal's geometry. Waypoints A and B share a deep (5.0 m) corridor with a
    // 2.5 m pinch midway, far outside both discs; a detour leaves A through a
    // 2.3 m pinch inside A's disc. Global relaxes to 2.5 (midway pinch);
    // local must use the detour, 2.3.
    const DEEP = 50;
    const A = { row: 100, col: 50 };
    const B = { row: 100, col: 250 };
    const water = new Map<number, number>();
    const cols = TEST_MASK_META.cols;
    const set = (row: number, col: number, byte: number) => water.set(row * cols + col, byte);
    for (let c = A.col; c <= B.col; c++) set(100, c, DEEP); // direct corridor
    set(100, 150, 25); // midway pinch, 2.5 m
    for (let r = 101; r <= 140; r++) set(r, 53, DEEP); // detour north from col 53
    for (let c = 53; c <= B.col; c++) set(140, c, DEEP); // detour east
    for (let r = 101; r <= 140; r++) set(r, B.col, DEEP); // detour south into B
    set(101, 53, 23); // detour pinch inside A's disc, 2.3 m
    const synthetic = makeMask((row, col) => water.get(row * cols + col) ?? 0);
    const centre = (p: { row: number; col: number }): LatLon => ({
      lat: TEST_MASK_META.south + (p.row + 0.5) * 0.005,
      lon: TEST_MASK_META.west + (p.col + 0.5) * 0.005,
    });

    // ~3.6 rows / ~6.2 cols on this 0.005-degree grid: covers the detour
    // pinch (1 row, 3 cols from A), nowhere near the midway pinch (100 cols).
    const RADIUS_M = 2000;
    const rows = measureRelaxationTrade(
      synthetic,
      [{ id: 'synthetic-A-B', waypoints: [centre(A), centre(B)] }],
      3.0,
      2.1,
      RADIUS_M,
    );
    expect(rows[0]).toEqual({
      id: 'synthetic-A-B',
      relevant: true,
      localUsedDepthM: 2.3,
      globalUsedDepthM: 2.5,
    });
    expectRelaxationTradeSubsetConsistency(rows, 'synthetic');
    expect(() => expectRelaxationTradeRadiusInvariant(rows, 'synthetic')).toThrow(/trade bites/);
    expect(() => expectRelaxationTradeRadiusInvariant([], 'synthetic')).toThrow(/nothing measured/);
  });
});
