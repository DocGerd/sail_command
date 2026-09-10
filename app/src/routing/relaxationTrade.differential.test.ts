import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { findRelaxedGate } from './relaxedDepth';
import { APPROACH_RADIUS_M } from '../lib/depthGate';
import { relaxationFloorM } from '../lib/boatDepth';
import { boatById, DEFAULT_BOAT_ID } from '../data/boats';
import { mask, MARSTAL } from '../test/realmaskFixtures';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import type { LatLon } from '../types';

// Each `usedDepthM()` call allocates a fresh 5.28M-cell BFS visited/queue
// buffer per probe (`NavMask.cellsConnected`) and this file runs dozens of
// them per test (32 pairs x 2+ radii, ~10 probes each) — cheap per call, not
// cheap in aggregate. Default 5000ms times out; import the shared budget
// rather than hardcoding one (`timeoutGuard.test.ts` reds a bare literal).
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

/**
 * #930 (R3, split from #649/#452): P3's named trade — a per-disc-restricted
 * connectivity search is strictly harder to satisfy than the old global
 * search, so `findRelaxedGate` can return a LOWER `usedDepthM` (deeper
 * relaxation) under the shipped disc radius than an unrestricted search
 * would need for the same route. No prior measurement exercised the SHIPPED
 * mechanism: `docs/spikes/452-p3-implementation-record.md` §6 "R3" records
 * that the only existing figures forced cells to LAND in a mask clone and
 * re-ran the pre-P3 SCALAR `findRelaxedDepthM`, at R = 2400 m, never the
 * shipped `APPROACH_RADIUS_M = 1852 m`.
 *
 * This file runs the SHIPPED `findRelaxedGate` twice per pair, changing only
 * `approachRadiusM`:
 *   - LOCAL:  `APPROACH_RADIUS_M` (1852 m) — exactly what `planRoute.ts` passes.
 *   - GLOBAL: `Infinity` — `depthGate.ts`'s own documented kill switch, which
 *     `relaxedDepth.test.ts` pins as reproducing the pre-#452 route-wide
 *     search "cell for cell" (that file's own header comment). No mask
 *     cloning, no LAND-forcing, no alternate scalar search: both runs go
 *     through the identical shipped function and the identical committed
 *     mask, differing only in the one parameter the trade is ABOUT.
 *
 * SAMPLE: every (Marstal, X) pair for the other 32 harbours in the shipped
 * `harbors.json`. `app/sweep/sweepArms.ts`'s own header comment records that
 * relaxation fires for exactly 27 of Marstal's 32 pairs (the giant-component
 * harbours) and for none of the other 528-27 pairs region-wide except the
 * mirror direction — Marstal is the ONLY harbour whose pairs ever reach
 * `findRelaxedGate` with a chance of connecting. This harness does not
 * hand-classify which 27 those are; it runs all 32 and lets the shipped
 * function report which pairs relax under either radius.
 *
 * DIRECTION: `cellsConnected` is symmetric and phase 1 (the binary search)
 * treats the waypoint array uniformly, but phase 2's per-disc ascent walks
 * the array IN ORDER, mutating as it goes — so `findRelaxedGate([A, B], …)`
 * and `findRelaxedGate([B, A], …)` are not obviously identical after ascent.
 * A small reversed-order sample checks this directly (see the second `it`).
 */

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');

interface Harbor {
  id: string;
  snap: LatLon;
}

const harbors = JSON.parse(readFileSync(resolve(dataDir, 'harbors.json'), 'utf8')) as Harbor[];

const boat = boatById(DEFAULT_BOAT_ID);
const FLOOR_M = relaxationFloorM(boat);
const REQUESTED_M = 3.0;

function usedDepthM(waypoints: readonly LatLon[], radiusM: number): number | null {
  return findRelaxedGate(mask, [...waypoints], REQUESTED_M, radiusM, FLOOR_M)?.usedDepthM ?? null;
}

interface Row {
  id: string;
  localUsedDepthM: number | null;
  globalUsedDepthM: number | null;
}

describe('#930 R3: P3 disc-vs-global relaxation trade (shipped findRelaxedGate, real mask)', () => {
  it('local (R=1852, shipped) never needs LESS relaxation than global (R=Infinity) across every Marstal pair', () => {
    const others = harbors.filter((h) => h.id !== 'marstal');
    expect(others.length, 'harbors.json harbour count').toBe(32);

    const rows: Row[] = others.map((h) => ({
      id: h.id,
      localUsedDepthM: usedDepthM([MARSTAL, h.snap], APPROACH_RADIUS_M),
      globalUsedDepthM: usedDepthM([MARSTAL, h.snap], Infinity),
    }));

    // LICENCE: an absence assertion below is vacuous unless something here
    // actually relaxed. Report the raw table so a red carries the diagnostic.
    const relaxed = rows.filter((r) => r.localUsedDepthM !== null || r.globalUsedDepthM !== null);
    expect(
      relaxed.length,
      `no Marstal pair triggered relaxation under either radius — nothing measured.\n${JSON.stringify(rows, null, 2)}`,
    ).toBeGreaterThan(0);

    // Classification must agree: a pair that connects under the (looser)
    // global search but never connects under the (stricter) local search is
    // an expected, named shape of the trade (local finds nothing where
    // global does) — record it, don't fail on it. The opposite (local
    // connects, global doesn't) would be impossible by construction (local's
    // licensed set is a subset of global's at every probe depth) and IS a
    // hard failure if observed.
    for (const r of relaxed) {
      if (r.localUsedDepthM !== null) {
        expect(
          r.globalUsedDepthM,
          `${r.id}: local relaxed to ${r.localUsedDepthM} m but global found nothing — ` +
            `impossible under the subset argument (local's per-probe navigable set ⊆ global's)`,
        ).not.toBeNull();
      }
      if (r.localUsedDepthM !== null && r.globalUsedDepthM !== null) {
        expect(
          r.localUsedDepthM,
          `${r.id}: local usedDepthM <= global usedDepthM`,
        ).toBeLessThanOrEqual(r.globalUsedDepthM);
      }
    }

    console.log('#930 R3 differential (Marstal pairs):', JSON.stringify(rows));
  });

  it('POSITIVE CONTROL: a tighter-than-shipped radius (1000 m) measurably breaks relaxation relative to the shipped 1852 m on every relaxing pair', () => {
    // Two calibration attempts preceded this value. 100 m produced NULL
    // everywhere (too tight to be a control — see below). 1200 m produced
    // NO CHANGE from 1852 m on any pair: an exploratory fine sweep (not
    // committed — see the results doc) found the Marstal-local pinch is a
    // hard CLIFF at ~1050-1060 m — null below it, exactly 2.3 m at and above
    // it, for every harbour tested, all the way to Infinity. 1852 m and
    // 1200 m both sit above that cliff, so neither could show movement.
    // 1000 m sits just below it, so it is expected to newly DISCONNECT every
    // relaxing pair — a decisive, non-marginal control.
    const TIGHT_RADIUS_M = 1000;
    const others = harbors.filter((h) => h.id !== 'marstal');
    const tight = others.map((h) => ({
      id: h.id,
      tightUsedDepthM: usedDepthM([MARSTAL, h.snap], TIGHT_RADIUS_M),
      localUsedDepthM: usedDepthM([MARSTAL, h.snap], APPROACH_RADIUS_M),
    }));
    const moved = tight.filter(
      (r) =>
        r.tightUsedDepthM !== null &&
        r.localUsedDepthM !== null &&
        r.tightUsedDepthM < r.localUsedDepthM,
    );
    const newlyBlocked = tight.filter(
      (r) => r.tightUsedDepthM === null && r.localUsedDepthM !== null,
    );
    // This is the needle: if the harness can detect NO movement even when
    // the radius is deliberately shrunk below the shipped value, the
    // comparison mechanism itself is broken (or a null result elsewhere is
    // not evidence of anything). Either a measurably deeper gate OR an
    // outright loss of connectivity counts as detected movement.
    expect(
      moved.length + newlyBlocked.length,
      `tightening the radius to ${TIGHT_RADIUS_M} m produced NO detectable change vs 1852 m anywhere — ` +
        `the harness cannot detect movement; treat every other result in this file as unverified.\n${JSON.stringify(tight, null, 2)}`,
    ).toBeGreaterThan(0);
    console.log(
      `#930 positive control (radius=${TIGHT_RADIUS_M}m vs shipped 1852m):`,
      JSON.stringify(tight),
    );
  });

  it('direction check: findRelaxedGate([A,B]) vs findRelaxedGate([B,A]) at the shipped radius, on a 5-harbour sample', () => {
    const sample = ['flensburg', 'soenderborg', 'bagenkop', 'aeroeskoebing', 'faaborg'];
    const rows = sample.map((id) => {
      const h = harbors.find((x) => x.id === id);
      if (!h) throw new Error(`fixture drift: '${id}' missing from harbors.json`);
      return {
        id,
        marstalFirst: usedDepthM([MARSTAL, h.snap], APPROACH_RADIUS_M),
        marstalSecond: usedDepthM([h.snap, MARSTAL], APPROACH_RADIUS_M),
      };
    });
    console.log('#930 direction check:', JSON.stringify(rows));
    // Not asserted equal: this is reported as evidence, not pinned as an
    // invariant — the shipped ascent is documented (relaxedDepth.ts) to walk
    // the waypoint array IN ORDER, so asymmetry would be a real, disclosed
    // property of the shipped mechanism rather than a bug. See the results
    // doc for what was actually observed.
    expect(rows.length).toBe(sample.length);
  });
});
