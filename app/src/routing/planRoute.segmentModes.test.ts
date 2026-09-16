import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { makeMask, openWaterMask, TEST_POLAR, testPlanDeps } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  type Leg,
  type PlanRequest,
  type PlanResult,
  type PolarTable,
  type WindGrid,
} from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// #885. Wind built here, not from test/fixtures' defaults, so these rows do not
// move when that fixture's default lattice does.
const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);
function wind(speedKn: number, dirFromDeg: number): WindGrid {
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

const SLOW_FOCK: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.88)),
};

// Eastbound on open water, via halfway: a 12 kn northerly is a beam reach, so
// the unforced plan sails every segment.
const VIA = { lat: 54.7525, lon: 10.2025 };
const req: PlanRequest = {
  origin: { lat: 54.7525, lon: 10.0025 },
  destination: { lat: 54.7525, lon: 10.4025 },
  viaPoints: [VIA],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: T0,
  settings: DEFAULT_SETTINGS,
  sailIds: ['genoa', 'fock'],
  boat: defaultBoatSnapshot(),
};
const deps = testPlanDeps(openWaterMask(), { genoa: TEST_POLAR, fock: SLOW_FOCK });

function ok(r: PlanResult) {
  expect(r.status, r.status === 'error' ? r.reason : '').toBe('ok');
  if (r.status !== 'ok') throw new Error('unreachable');
  return r;
}
/** Legs east of the via belong to segment 1 (the route is monotone eastbound). */
const inSegment1 = (l: Leg) => l.start.lon >= VIA.lon - 1e-6;

describe('#885 forced segment modes: solver semantics', () => {
  it('control: the unforced plan sails segment 1 and marks nothing forced', () => {
    const r = ok(planRoute(req, wind(12, 0), deps));
    for (const s of r.sails) {
      const seg1 = s.result!.legs.filter(inSegment1);
      expect(seg1.some((l) => l.kind === 'sail')).toBe(true);
      expect(s.result!.legs.some((l) => 'forced' in l)).toBe(false);
    }
  });

  it('forced motor: every segment-1 leg is motor and forced, on both rigs; segment 0 is untouched', () => {
    const r = ok(planRoute({ ...req, segmentModes: [null, 'motor'] }, wind(12, 0), deps));
    expect(r.sails.map((s) => s.sailId)).toEqual(['genoa', 'fock']);
    for (const s of r.sails) {
      const legs = s.result!.legs;
      const seg1 = legs.filter(inSegment1);
      expect(seg1.length).toBeGreaterThan(0);
      expect(seg1.every((l) => l.kind === 'motor' && l.forced === true)).toBe(true);
      const seg0 = legs.filter((l) => !inSegment1(l));
      expect(seg0.length).toBeGreaterThan(0);
      expect(seg0.some((l) => 'forced' in l)).toBe(false);
    }
  });

  it('forced sail: in 4 kn, where the unforced plan motors, segment 1 sails and is forced', () => {
    const unforced = ok(planRoute(req, wind(4, 0), deps));
    expect(unforced.sails[0].result!.legs.filter(inSegment1).every((l) => l.kind === 'motor')).toBe(
      true,
    );
    const r = ok(planRoute({ ...req, segmentModes: [null, 'sail'] }, wind(4, 0), deps));
    for (const s of r.sails) {
      const seg1 = s.result!.legs.filter(inSegment1);
      expect(seg1.length).toBeGreaterThan(0);
      expect(seg1.every((l) => l.kind === 'sail' && l.forced === true)).toBe(true);
    }
  });

  it('forced sail in a calm fails as calm-sail-only, where the unforced plan motors through', () => {
    expect(planRoute(req, wind(0, 0), deps).status).toBe('ok');
    const r = planRoute({ ...req, segmentModes: [null, 'sail'] }, wind(0, 0), deps);
    expect(r).toEqual({ status: 'error', reason: 'calm-sail-only' });
  });

  it('an all-null segmentModes plans byte-identically to an absent one', () => {
    const absent = planRoute(req, wind(12, 0), deps);
    const nulls = planRoute({ ...req, segmentModes: [null, null] }, wind(12, 0), deps);
    expect(JSON.stringify(nulls)).toBe(JSON.stringify(absent));
  });

  it('survives a relaxed-tier plan: the forced segment crosses the relaxed pinch under motor', () => {
    // Corridor with a single 2.5 m gap at col 160, ~1.6 km from the destination
    // (inside its approach disc), so the 3.0 m request relaxes (#53/#452).
    const mask = makeMask((row, col) => {
      if (row < 85 || row > 105) return 0;
      if (col === 160) return row >= 90 && row <= 99 ? 25 : 0;
      return 200;
    });
    const relaxedReq: PlanRequest = {
      ...req,
      origin: { lat: 54.7525, lon: 10.0025 },
      viaPoints: [{ lat: 54.7525, lon: 10.1525 }],
      destination: { lat: 54.7525, lon: 10.2275 },
      segmentModes: [null, 'motor'],
    };
    const r = ok(
      planRoute(
        relaxedReq,
        wind(12, 0),
        testPlanDeps(mask, { genoa: TEST_POLAR, fock: SLOW_FOCK }),
      ),
    );
    expect(r.shallow?.usedDepthM).toBeLessThan(3.0);
    for (const s of r.sails) {
      const seg1 = s.result!.legs.filter((l) => l.start.lon >= 10.1525 - 0.003);
      expect(seg1.length).toBeGreaterThan(0);
      expect(seg1.every((l) => l.kind === 'motor' && l.forced === true)).toBe(true);
    }
  });
});

describe('#885 §3.3 pre-solve validation', () => {
  // An origin on land would fail snap; validation must refuse first.
  const onLand = testPlanDeps(
    makeMask(() => 0),
    { genoa: TEST_POLAR, fock: SLOW_FOCK },
  );

  it.each([
    ['too short', [null]],
    ['too long', [null, null, null]],
    ['empty', []],
  ] as const)(
    'refuses a %s segmentModes as segment-modes-invalid, before snapping',
    (_n, modes) => {
      expect(planRoute({ ...req, segmentModes: modes }, wind(12, 0), onLand)).toEqual({
        status: 'error',
        reason: 'segment-modes-invalid',
      });
    },
  );

  it('refuses an unknown mode value as segment-modes-invalid', () => {
    const modes = [null, 'engine'] as unknown as PlanRequest['segmentModes'];
    expect(
      planRoute({ ...req, ...(modes ? { segmentModes: modes } : {}) }, wind(12, 0), onLand),
    ).toEqual({ status: 'error', reason: 'segment-modes-invalid' });
  });

  it('R4: forced motor with the motor disabled is refused as segment-mode-conflict', () => {
    const settings = { ...DEFAULT_SETTINGS, motorEnabled: false };
    expect(
      planRoute({ ...req, settings, segmentModes: [null, 'motor'] }, wind(12, 0), onLand),
    ).toEqual({ status: 'error', reason: 'segment-mode-conflict' });
  });

  it('forced sail with the motor disabled is not a conflict', () => {
    const settings = { ...DEFAULT_SETTINGS, motorEnabled: false };
    const r = planRoute({ ...req, settings, segmentModes: [null, 'sail'] }, wind(12, 0), deps);
    expect(r.status).toBe('ok');
  });
});
