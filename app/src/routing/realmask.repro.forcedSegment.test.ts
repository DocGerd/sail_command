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
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { FLENSBURG, GLUECKSBURG, MARSTAL, mask, SALONA_DEPS, T0 } from '../test/realmaskFixtures';

// #885 §7: forced motor against the real committed mask and polars. Two vias
// bracket the inner-fjord bend north of Flensburg (~1 km wide).
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// Built here rather than from test/fixtures' defaults, which another change moves.
function windGrid(speedKn: number, dirFromDeg: number): WindGrid {
  const lats: number[] = [];
  const lons: number[] = [];
  for (let la = 54.3; la <= 55.3 + 1e-9; la += 0.1) lats.push(Number(la.toFixed(6)));
  for (let lo = 9.4; lo <= 11.0 + 1e-9; lo += 0.1) lons.push(Number(lo.toFixed(6)));
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

  it('survives a relaxed-tier plan: Marstal origin, one via, forced motor on the relaxed approach', () => {
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
  });
});
