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
import { solverTimeoutMs } from '../test/timeouts';
import type { LatLon } from '../types';

// #1261: split out of relaxationTrade.differential.test.ts (~728 s CI total
// there) — the ORIGIN MARSTAL population row of its `describe.each(DEPTH_CASES)`
// / `it.each(POPULATIONS)` block, given its own file so vitest can schedule
// it on a separate worker instead of serializing behind its two population
// siblings. Named with the `realmask.repro.` prefix (not
// `relaxationTrade.differential.*`) so it falls inside the EXISTING
// `realmask.repro*.test.ts` tsconfig glob without adding any tsconfig entry
// — see relaxationTrade.differential.test.ts's own #1261 comment for why.
// The helper functions below are DUPLICATED verbatim from that file rather
// than imported from it, because importing a `.test.ts` file re-registers
// its `describe`/`it` calls in the importer (vitest collects both files
// independently) — see that file's #1261 comment. Pure relocation of the
// logic and literals otherwise; see relaxationTrade.differential.test.ts for
// the full #930 R3 design note, the "derives one depth case" test and both
// POSITIVE CONTROLs.
vi.setConfig({ testTimeout: solverTimeoutMs(300_000) });

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
// Marstal-origin population, measured because phase 2 walks waypoints in
// order. This file carries only the ONE 'origin marstal' entry from
// relaxationTrade.differential.test.ts's original `POPULATIONS` array — the
// other two ('origin flensburg', 'destination marstal') live in their own
// sibling files.
const POPULATIONS = [{ name: 'origin marstal', fixedId: 'marstal', reversed: false }] as const;

describe('#930 R3: P3 disc-vs-global relaxation trade (shipped findRelaxedGate, real mask)', () => {
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
});
