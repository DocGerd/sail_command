import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformGate } from '../lib/depthGate';
import { haversineNm } from '../lib/geo';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  type LatLon,
  type Leg,
  type PlanRequest,
  type PlanResult,
  type PlanResultOk,
  type WindGrid,
} from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { FLENSBURG, GLUECKSBURG, MARSTAL, mask, SALONA_DEPS, T0 } from '../test/realmaskFixtures';

// #885 §7: forced motor against the real committed mask and polars. Two vias
// bracket the inner-fjord bend north of Flensburg (~1 km wide).
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// Lattice derived from the real mask's own bounds, never from literals:
// planRoute's WindField refuses a grid that does not cover them (#1178), and
// #295 widened the mask, which is exactly how a pinned copy goes stale.
function axis(min: number, max: number, step: number): number[] {
  const out = [min];
  for (let v = min + step; v < max - 1e-9; v += step) out.push(Number(v.toFixed(6)));
  out.push(max);
  return out;
}

function windGrid(speedKn: number, dirFromDeg: number): WindGrid {
  const lats = axis(mask.meta.south, mask.meta.north, 0.1);
  const lons = axis(mask.meta.west, mask.meta.east, 0.1);
  const timesMs = Array.from({ length: 48 }, (_, i) => T0 + i * 3_600_000);
  const n = timesMs.length * lats.length * lons.length;
  return {
    lats,
    lons,
    timesMs,
    speedKn: new Float32Array(n).fill(speedKn),
    dirFromDeg: new Float32Array(n).fill(dirFromDeg),
    gustKn: new Float32Array(n).fill(speedKn * 1.3),
    fetchedAtMs: T0,
    model: 'test',
  };
}

const VIA_A: LatLon = { lat: 54.821, lon: 9.45 };
const VIA_B: LatLon = { lat: 54.843, lon: 9.495 };
const req: PlanRequest = {
  origin: FLENSBURG,
  destination: GLUECKSBURG,
  viaPoints: [VIA_A, VIA_B],
  originHarborId: 'flensburg',
  destinationHarborId: 'gluecksburg',
  departureMs: T0,
  settings: DEFAULT_SETTINGS,
  sailIds: ['genoa', 'fock'],
  boat: defaultBoatSnapshot(),
};
// A 12 kn south-westerly: the unforced plan sails up the bend.
const WIND = windGrid(12, 225);

function ok(r: PlanResult): PlanResultOk {
  expect(r.status, r.status === 'error' ? r.reason : '').toBe('ok');
  if (r.status !== 'ok') throw new Error('unreachable');
  return r;
}
const same = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon;

/** The legs of segment i, split where a leg ends on a snapped via. */
function segmentLegs(legs: readonly Leg[], waypoints: readonly LatLon[], i: number): Leg[] {
  const out: Leg[][] = [[]];
  let seg = 0;
  for (const l of legs) {
    out[seg].push(l);
    if (seg < waypoints.length - 2 && same(l.end, waypoints[seg + 1])) out[++seg] = [];
  }
  expect(out.length, 'every via joint was found in the leg chain').toBe(waypoints.length - 1);
  return out[i];
}

describe('#885 forced motor on the real mask', () => {
  const snapped = [FLENSBURG, VIA_A, VIA_B, GLUECKSBURG].map((p) =>
    mask.snapToNavigable(p, DEFAULT_SETTINGS.safetyDepthM)!,
  );

  it('control: the unforced plan sails part of segment 1 on both rigs', () => {
    const r = ok(planRoute(req, WIND, SALONA_DEPS));
    for (const s of r.sails) {
      expect(segmentLegs(s.result!.legs, snapped, 1).some((l) => l.kind === 'sail')).toBe(true);
    }
  });

  it('forced motor: segment 1 is all motor and forced on both rigs; straightness and rig geometry measured', () => {
    const r = ok(planRoute({ ...req, segmentModes: [null, 'motor', null] }, WIND, SALONA_DEPS));
    const geometry: string[] = [];
    for (const s of r.sails) {
      const legs = s.result!.legs;
      const seg1 = segmentLegs(legs, snapped, 1);
      expect(seg1.length).toBeGreaterThan(0);
      expect(seg1.every((l) => l.kind === 'motor' && l.forced === true)).toBe(true);
      for (const i of [0, 2]) {
        expect(segmentLegs(legs, snapped, i).some((l) => 'forced' in l)).toBe(false);
      }
      const travelled = seg1.reduce((d, l) => d + l.distanceNm, 0);
      const chord = haversineNm(snapped[1], snapped[2]);
      const chordNavigable = mask.segmentNavigable(
        snapped[1],
        snapped[2],
        uniformGate(DEFAULT_SETTINGS.safetyDepthM),
      );
      // Measured, not pinned (§7); reported in the PR.
      console.log(
        `#885 ${s.sailId}: ${seg1.length} legs, ${travelled.toFixed(3)} nm vs chord ${chord.toFixed(3)} nm ` +
          `(ratio ${(travelled / chord).toFixed(3)}, chord navigable ${chordNavigable})`,
      );
      geometry.push(
        JSON.stringify(seg1.map((l) => [l.start.lat, l.start.lon, l.end.lat, l.end.lon])),
      );
    }
    console.log(`#885 forced-motor geometry identical across rigs: ${geometry[0] === geometry[1]}`);
  });

  // #1330: this plan runs two segments x two rigs at the #53 relaxed tier, so
  // it is one of the file's most expensive inputs, and #1303's confined-water
  // grid made it more so: measured solo on one dev machine, 30.5 s at
  // CONFINED_PRUNE_DIV = 1 against 43.6 s at 2 (+43%), while the plan itself
  // got 2.2 h faster (genoa 10.163 h -> 7.929 h). At roughly 2x for CI plus
  // shard contention the shared 120 s file budget no longer covered it (CI run
  // 35318244674). The explicit override is the documented shape for a
  // single expensive test (`invariants.property.test.ts` uses the same one at
  // 900_000); 300 s is ~3.4x the ~87 s a 2x CI factor predicts.
  it(
    'survives a relaxed-tier plan: Marstal origin, one via, forced motor on the relaxed approach',
    { timeout: solverTimeoutMs(300_000) },
    () => {
    const marstal: PlanRequest = {
      ...req,
      origin: MARSTAL,
      // Short on purpose: a Marstal-origin passage to another harbour costs
      // minutes on the real mask. Both points sit in >= 3.8 m charted water.
      destination: { lat: 54.884, lon: 10.529 },
      viaPoints: [{ lat: 54.873, lon: 10.543 }],
      originHarborId: 'marstal',
      destinationHarborId: null,
      segmentModes: ['motor', null],
    };
    const r = ok(planRoute(marstal, windGrid(12, 270), SALONA_DEPS));
    expect(r.shallow, 'the plan must actually take a relaxed tier').toBeDefined();
    const via = mask.snapToNavigable(marstal.viaPoints[0], DEFAULT_SETTINGS.safetyDepthM)!;
    for (const s of r.sails) {
      const seg0 = segmentLegs(s.result!.legs, [r.snappedOrigin, via, r.snappedDestination], 0);
      expect(seg0.length).toBeGreaterThan(0);
      expect(seg0.every((l) => l.kind === 'motor' && l.forced === true)).toBe(true);
    }
    },
  );
});
