import { describe, expect, it, vi } from 'vitest';
import { APPROACH_RADIUS_M, approachGate, uniformGate, type DepthGate } from '../lib/depthGate';
import {
  AEROESKOEBING,
  BAGENKOP,
  DREJOE,
  FLENSBURG,
  GLUECKSBURG,
  MARSTAL,
  mask,
  SOENDERBORG,
} from './realmaskFixtures';
import { expectWalkersMatchOracle, seededRandom } from './maskWalkerOracle';
import { SOLVER_TEST_TIMEOUT_MS } from './timeouts';
import type { LatLon } from '../types';

// Differential keeper for NavMask's closure-free segmentNavigable and
// segmentClearanceM against the walkCells-based originals, on the real
// committed mask. Synthetic shapes and exact ties live in
// lib/mask.walkers.test.ts. The name keeps it in the `node:fs` tsconfig
// program. It sits outside routing/ on purpose: CI's realmask exclude does
// not reach it, so it runs on every PR, and from routing/ classify-realmask.sh's
// drift check would flag its maskWalkerOracle.ts import.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

function gatesFor(a: LatLon, b: LatLon): DepthGate[] {
  const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  return [
    uniformGate(2.0),
    uniformGate(2.3),
    uniformGate(3.0),
    uniformGate(4.2),
    approachGate(mask.meta, [a, b], 3.0, [2.3, 2.3], APPROACH_RADIUS_M),
    approachGate(mask.meta, [mid], 3.0, [2.0], 600),
    approachGate(mask.meta, [a, mid, b], 4.2, [3.0, 3.5, 2.3], APPROACH_RADIUS_M),
  ];
}

interface Tally {
  checks: number;
  navTrue: number;
  navFalse: number;
  clearNull: number;
  clearValue: number;
  cells: number;
}

function runAll(a: LatLon, b: LatLon, label: string, t: Tally): void {
  for (const [i, gate] of gatesFor(a, b).entries()) {
    const o = expectWalkersMatchOracle(mask, a, b, gate, `${label} gate#${i}`);
    t.checks++;
    if (o.navigable) t.navTrue++;
    else t.navFalse++;
    if (o.clearance === null) t.clearNull++;
    else t.clearValue++;
    t.cells += o.cells;
  }
}

const newTally = (): Tally => ({
  checks: 0,
  navTrue: 0,
  navFalse: 0,
  clearNull: 0,
  clearValue: 0,
  cells: 0,
});

describe('NavMask closure-free walkers vs the walkCells originals on the real mask', () => {
  it('match on harbour-to-harbour segments', () => {
    const harbours: Array<[string, LatLon]> = [
      ['flensburg', FLENSBURG],
      ['gluecksburg', GLUECKSBURG],
      ['marstal', MARSTAL],
      ['soenderborg', SOENDERBORG],
      ['bagenkop', BAGENKOP],
      ['aeroeskoebing', AEROESKOEBING],
      ['drejoe', DREJOE],
    ];
    const t = newTally();
    for (const [na, a] of harbours)
      for (const [nb, b] of harbours) if (na !== nb) runAll(a, b, `${na}->${nb}`, t);
    expect(t.cells).toBeGreaterThan(1000);
    expect(t.navFalse).toBeGreaterThan(0);
  });

  it('match on seeded random segments starting in deep water', () => {
    const rand = seededRandom(20261021);
    const { south, north, west, east } = mask.meta;
    const t = newTally();
    let segments = 0;
    while (segments < 150) {
      const a = {
        lat: south + 0.1 + rand() * (north - south - 0.2),
        lon: west + 0.1 + rand() * (east - west - 0.2),
      };
      if (mask.depthM(a) < 8) continue;
      const reach = segments % 3 === 0 ? 0.4 : 0.05;
      const b = { lat: a.lat + (rand() - 0.5) * reach, lon: a.lon + (rand() - 0.5) * reach };
      runAll(a, b, `random#${segments}`, t);
      segments++;
    }
    expect(t.cells).toBeGreaterThan(5000);
    expect(t.navTrue).toBeGreaterThan(0);
    expect(t.navFalse).toBeGreaterThan(0);
    expect(t.clearNull).toBeGreaterThan(0);
    expect(t.clearValue).toBeGreaterThan(0);
  });

  it('match on segments that leave the mask', () => {
    const { south, north, west, east } = mask.meta;
    const inside = { lat: (south + north) / 2, lon: (west + east) / 2 };
    const t = newTally();
    runAll(inside, { lat: north + 0.2, lon: inside.lon }, 'north exit', t);
    runAll({ lat: south - 0.2, lon: west - 0.2 }, inside, 'south-west entry', t);
    runAll(FLENSBURG, { lat: FLENSBURG.lat, lon: west - 0.3 }, 'west exit', t);
    expect(t.checks).toBe(21);
  });
});
