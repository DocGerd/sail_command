import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { findRelaxedGate } from './relaxedDepth';
import { APPROACH_RADIUS_M, uniformGate } from '../lib/depthGate';
import { defaultSafetyDepthM, relaxationFloorM } from '../lib/boatDepth';
import type { NavMask } from '../lib/mask';
import { BOATS } from '../data/boats';
import { mask } from '../test/realmaskFixtures';
import { makeMask, TEST_MASK_META } from '../test/fixtures';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import type { LatLon } from '../types';

// Each probe allocates a fresh 5.28M-cell BFS buffer (`NavMask.cellsConnected`).
// Shared budget, never a literal (`timeoutGuard.test.ts`).
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

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
 */

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');

interface Harbor {
  id: string;
  snap: LatLon;
}

const harbors = JSON.parse(readFileSync(resolve(dataDir, 'harbors.json'), 'utf8')) as Harbor[];

/**
 * `planRoute`'s own snap at the requested gate; null means `planRoute` returns
 * `snap-failed-*` and never reaches relaxation.
 */
function snapAt(h: Harbor, requestedM: number): LatLon | null {
  return mask.snapToNavigable(h.snap, requestedM);
}

/**
 * Snapped (origin, harbour) pairs for every other harbour. Pairs whose snap
 * fails are returned separately so the caller logs them — never dropped silently.
 */
function snappedPairs(
  originId: string,
  requestedM: number,
  reversed = false,
): { pairs: { id: string; waypoints: LatLon[] }[]; snapFailed: string[] } {
  const origin = snapAt(harbor(originId), requestedM);
  if (!origin) throw new Error(`origin '${originId}' fails to snap at ${requestedM} m`);
  const pairs: { id: string; waypoints: LatLon[] }[] = [];
  const snapFailed: string[] = [];
  for (const h of harbors) {
    if (h.id === originId) continue;
    const dest = snapAt(h, requestedM);
    if (dest) pairs.push({ id: h.id, waypoints: reversed ? [dest, origin] : [origin, dest] });
    else snapFailed.push(h.id);
  }
  return { pairs, snapFailed };
}

function harbor(id: string): Harbor {
  const h = harbors.find((x) => x.id === id);
  if (!h) throw new Error(`fixture drift: '${id}' missing from harbors.json`);
  return h;
}

interface DepthCase {
  /** Catalogue boats sharing this (gate, floor) pair — deduplicated, never dropped. */
  readonly boatIds: readonly string[];
  readonly requestedM: number;
  readonly floorM: number;
}

// Each boat's OWN default gate and relaxation floor, derived from the
// catalogue. Boats with an identical pair would repeat the same computation,
// so they share one case; the merge is logged, not silent.
const DEPTH_CASES: readonly DepthCase[] = (() => {
  const byKey = new Map<string, { boatIds: string[]; requestedM: number; floorM: number }>();
  for (const b of BOATS) {
    const requestedM = defaultSafetyDepthM(b);
    const floorM = relaxationFloorM(b);
    const key = `${requestedM}/${floorM}`;
    const existing = byKey.get(key);
    if (existing) existing.boatIds.push(b.id);
    else byKey.set(key, { boatIds: [b.id], requestedM, floorM });
  }
  return [...byKey.values()];
})();

function usedDepthM(
  m: NavMask,
  waypoints: readonly LatLon[],
  requestedM: number,
  radiusM: number,
  floorM: number,
): number | null {
  return findRelaxedGate(m, [...waypoints], requestedM, radiusM, floorM)?.usedDepthM ?? null;
}

interface Row {
  id: string;
  /** Snapped pair disconnected at the requested gate (BFS). */
  relevant: boolean;
  localUsedDepthM: number | null;
  globalUsedDepthM: number | null;
}

function measure(
  m: NavMask,
  pairs: readonly { id: string; waypoints: readonly LatLon[] }[],
  requestedM: number,
  floorM: number,
  localRadiusM: number,
): Row[] {
  return pairs.map(({ id, waypoints }) => ({
    id,
    relevant: !m.cellsConnected(waypoints[0], waypoints[1], uniformGate(requestedM)),
    localUsedDepthM: usedDepthM(m, waypoints, requestedM, localRadiusM, floorM),
    globalUsedDepthM: usedDepthM(m, waypoints, requestedM, Infinity, floorM),
  }));
}

/**
 * THE TRIPWIRE: per pair, the shipped radius must give the same outcome
 * (null vs non-null) and the same relaxed gate as the global search. The gate
 * FIELD necessarily differs (approach vs uniform); `usedDepthM` is what the
 * plan reports.
 */
function expectRadiusInvariant(rows: readonly Row[], label: string): void {
  if (rows.length === 0) throw new Error(`${label}: empty population — nothing measured`);
  for (const r of rows) {
    expect(
      r.localUsedDepthM,
      `${label} ${r.id}: local usedDepthM ${r.localUsedDepthM} != global ${r.globalUsedDepthM} — ` +
        `the per-disc trade bites here.\n${JSON.stringify(rows)}`,
    ).toBe(r.globalUsedDepthM);
  }
}

/** Consistency checks only: both CANNOT fail given the code (subset argument above). */
function expectSubsetConsistency(rows: readonly Row[], label: string): void {
  for (const r of rows) {
    if (r.localUsedDepthM === null) continue;
    expect(r.globalUsedDepthM, `${label} ${r.id}: local relaxed, global did not`).not.toBeNull();
    expect(r.localUsedDepthM, `${label} ${r.id}: local <= global`).toBeLessThanOrEqual(
      r.globalUsedDepthM as number,
    );
  }
}

// `reversed` puts the fixed harbour LAST: [X, Marstal] is the mirror of the
// Marstal-origin population, measured because phase 2 walks waypoints in order.
const POPULATIONS = [
  { name: 'origin marstal', fixedId: 'marstal', reversed: false },
  { name: 'origin flensburg', fixedId: 'flensburg', reversed: false },
  { name: 'destination marstal', fixedId: 'marstal', reversed: true },
] as const;

describe('#930 R3: P3 disc-vs-global relaxation trade (shipped findRelaxedGate, real mask)', () => {
  it('derives one depth case per distinct (gate, floor) pair across every catalogue boat', () => {
    expect(DEPTH_CASES.flatMap((c) => c.boatIds).sort()).toEqual(BOATS.map((b) => b.id).sort());
    console.log('#930 depth cases:', JSON.stringify(DEPTH_CASES));
  });

  describe.each(DEPTH_CASES)('boats $boatIds (gate $requestedM m, floor $floorM m)', (c) => {
    it.each(POPULATIONS)('$name: shipped radius == global search on every pair', (pop) => {
      const { pairs, snapFailed } = snappedPairs(pop.fixedId, c.requestedM, pop.reversed);
      expect(pairs.length + snapFailed.length, 'harbour pairs per fixed origin').toBe(39);

      const rows = measure(mask, pairs, c.requestedM, c.floorM, APPROACH_RADIUS_M);
      const label = `[${c.boatIds.join(',')}] ${pop.name}`;

      // LICENCE: equality over pairs where nothing relaxes proves nothing, so
      // at least one relevant pair must actually relax.
      const relaxedRelevant = rows.filter((r) => r.relevant && r.globalUsedDepthM !== null);
      expect(
        relaxedRelevant.length,
        `${label}: no relevant pair relaxed — nothing measured.\n${JSON.stringify(rows)}`,
      ).toBeGreaterThan(0);

      expectSubsetConsistency(rows, label);
      expectRadiusInvariant(rows, label);

      console.log(
        `#930 ${label}: ${rows.length} pairs, ${rows.filter((r) => r.relevant).length} relevant, ` +
          `${relaxedRelevant.length} relevant+relaxed, snap-failed ${JSON.stringify(snapFailed)}:`,
        JSON.stringify(rows),
      );
    });
  });

  it('POSITIVE CONTROL (real mask): at 1000 m, below the ~1060 m Marstal cliff, the tripwire reds with BOTH a lost route and a different depth', () => {
    // Compared against Infinity, not APPROACH_RADIUS_M, so the control does
    // not move with the constant it guards. Measured: at 1000 m Marstal's
    // pinch falls outside its disc, so a 2.1 m floor loses the route while a
    // 1.9 m floor relaxes further, to a 1.9 m detour, against global's 2.3 m.
    // The different-depth half needs a catalogue boat with a 1.9 m floor.
    const TIGHT_RADIUS_M = 1000;
    const rows = DEPTH_CASES.flatMap((c) =>
      measure(
        mask,
        snappedPairs('marstal', c.requestedM).pairs.map((p) => ({
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
    expectSubsetConsistency(rows, 'control');
    expect(() => expectRadiusInvariant(lost, 'control')).toThrow(/trade bites/);
    expect(() => expectRadiusInvariant(deeper, 'control')).toThrow(/trade bites/);
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
    const rows = measure(
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
    expectSubsetConsistency(rows, 'synthetic');
    expect(() => expectRadiusInvariant(rows, 'synthetic')).toThrow(/trade bites/);
    expect(() => expectRadiusInvariant([], 'synthetic')).toThrow(/nothing measured/);
  });
});
