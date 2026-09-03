import { describe, expect, it, vi } from 'vitest';
import { solve } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { openWaterMask, TEST_POLAR, uniformWindGrid, makeWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import { haversineNm } from '../lib/geo';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

// Solver-heavy file: CI runners execute the isochrone solver materially slower
// than dev machines — see test/timeouts.ts for the shared budget and the
// coverage multiplier's derivation. Fast test files keep vitest's 5s default
// so hang detection stays meaningful there.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const A = { lat: 54.75, lon: 10.0 };
const B = { lat: 54.75, lon: 10.4 };
const dep = Date.UTC(2026, 6, 15, 8, 0, 0);
const base = {
  origin: A,
  destination: B,
  departureMs: dep,
  polar: new Polar(TEST_POLAR, 1.0),
  mask: openWaterMask(),
  settings: DEFAULT_SETTINGS,
};

describe('motor fallback', () => {
  it('calm + motor on → one straight motor leg at motor speed', () => {
    const r = solve({ ...base, wind: new WindField(uniformWindGrid(0.5, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.legs.every((l) => l.kind === 'motor' && l.board === null)).toBe(true);
    expect(r.legs.length).toBe(1); // collinear motor steps merge in backtrack
    const hours = (r.etaMs - dep) / 3_600_000;
    expect(hours).toBeCloseTo(haversineNm(A, B) / DEFAULT_SETTINGS.motorSpeedKn, 1);
  });

  it('wind dying en route → sail first, flagged motor leg after', () => {
    const wind = new WindField(
      makeWindGrid((_la, lon) => ({ speedKn: lon < 10.2 ? 14 : 0.5, dirFromDeg: 0 })),
    );
    const r = solve({ ...base, wind });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const kinds = r.legs.map((l) => l.kind);
    expect(kinds[0]).toBe('sail');
    expect(kinds[kinds.length - 1]).toBe('motor');
  });

  // #254: at TWS 6 the DIRECT heading (TWA 90) makes 4.3 kn in TEST_POLAR,
  // still above the 3.7 kn floor, so it still sails. What the floor changes is
  // that off-axis headings (TWA 40-55 -> 3.0-3.6 kn, hand-derived from
  // TEST_POLAR's tws 4/8 columns) may now motor at 6.5 kn, so the solver can
  // take a faster dogleg than the all-sail rhumb line.
  it('marginal wind: off-axis headings may motor when that is faster', () => {
    const r = solve({ ...base, wind: new WindField(uniformWindGrid(6, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    // The property under test is that the route is MIXED, and it guards BOTH
    // edges of the floor: at 3.6 this route collapses to [motor x4] and at 3.8
    // to [motor x2], so "a sail leg survives" is the single assertion covering
    // both. Deliberately NOT toContain('motor') alone — membership of 'motor'
    // passes for an all-motor route, which left the LOWER edge unguarded, and
    // that is the direction of the original #254 defect (spec 9.2 calls floor
    // 3.5 the trap: 135 deg max turn, worse than the 100 that filed the issue).
    // Deliberately NOT toEqual on the exact sequence either: leg COUNT and
    // ORDER are products of the collinear merge (MAX_MERGE_DEG) and geometry,
    // not of the floor rule, so a merge or polar change could break it without
    // any kind decision changing — and the failure would point at the wrong
    // subsystem. Both kinds are hand-checkable against TEST_POLAR at TWS 6:
    // motor legs sail 3.600 and 3.699 kn below the 3.7 floor, the sail leg
    // makes 4.250 above it.
    const kinds = r.legs.map((l) => l.kind);
    expect(kinds).toContain('motor');
    expect(kinds).toContain('sail');

    // Every motor leg must be one the rule actually permits: its sailing
    // speed at that leg's own TWA must be below the floor. Motor legs carry
    // board: null and no twaDeg, so the TWA is recovered from headingDeg and
    // the known uniform wind direction (0, i.e. wind FROM north):
    // twa = 0 - headingDeg. polar.speedKn normalizes internally, so the raw
    // subtraction (any sign, any range) is safe to pass straight through.
    const floorKn = DEFAULT_SETTINGS.motorSpeedKn - DEFAULT_SETTINGS.sailPreferenceKn;
    expect(floorKn).toBeCloseTo(3.7, 10);
    const offenders = r.legs
      .filter((l) => l.kind === 'motor')
      .map((l) => ({
        heading: l.headingDeg,
        sailSpeedAtTwa: base.polar.speedKn(-l.headingDeg, 6),
      }))
      .filter((l) => l.sailSpeedAtTwa >= floorKn);
    expect(offenders).toEqual([]);

    // And it must be FASTER than the all-sail baseline, which is hand-derived:
    // TWA 90 at TWS 6 is the mean of TEST_POLAR's tws-4 (3.0) and tws-8 (5.6)
    // values = 4.3 kn over the rhumb line. Never pin the solver's own output.
    const hours = (r.etaMs - dep) / 3_600_000;
    const allSailHours = haversineNm(A, B) / 4.3;
    expect(hours).toBeLessThan(allSailHours);
  });

  // #254: at or above motorSpeedKn - motorThresholdKn the floor collapses to
  // motorThresholdKn and the solve takes the byte-identical pre-#254 path.
  it('sailPreferenceKn at the disabling value restores pre-#254 routing', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      sailPreferenceKn: DEFAULT_SETTINGS.motorSpeedKn - DEFAULT_SETTINGS.motorThresholdKn,
    };
    const r = solve({ ...base, settings, wind: new WindField(uniformWindGrid(6, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    expect(r.legs.map((l) => l.kind)).toEqual(['sail']);
    // 4.3 kn hand-derived: TEST_POLAR TWA 90, mean of the tws-4 and tws-8 columns.
    const hours = (r.etaMs - dep) / 3_600_000;
    expect(hours).toBeCloseTo(haversineNm(A, B) / 4.3, 1);
  });

  // #254: motorThresholdKn survives as the seaworthiness floor. With a small
  // engine, motorSpeedKn - sailPreferenceKn = 3.0 - 2.8 = 0.2, well below the
  // 2.5 threshold, so Math.max must clamp the floor to 2.5.
  //
  // Wind FROM the west (uniformWindGrid(4, 270)), route A->B due east: the
  // direct heading is a dead run, TWA 180, TEST_POLAR TWS-4/TWA-180 = 1.6 kn
  // (an exact table cell, no interpolation) -- below the clamped floor (2.5)
  // but above the unclamped one (0.2). At TWS 6 (the other tests' wind) the
  // direct heading sails at 4.3 kn either way, so that fixture cannot tell
  // the clamped and unclamped worlds apart; TWS 4/270 was chosen because it
  // can.
  //
  // Mutation-checked directly against isochrone.ts: removing the Math.max
  // clamp (`sailFloorKn = settings.motorSpeedKn - settings.sailPreferenceKn`)
  // makes the solver reject the 1.6 kn dead run for sail (1.6 >= 0.2) and
  // hunt for a faster angle, producing a long all-sail gybing zigzag at
  // 8.03 h; restoring the clamp returns the single 4.62 h motor leg below.
  // Both were measured on this exact fixture (PR #260 review thread).
  it('small engine: the floor never drops below motorThresholdKn', () => {
    const settings = { ...DEFAULT_SETTINGS, motorSpeedKn: 3.0, sailPreferenceKn: 2.8 };
    const r = solve({ ...base, settings, wind: new WindField(uniformWindGrid(4, 270)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    expect(r.legs.map((l) => l.kind)).toEqual(['motor']);
    const hours = (r.etaMs - dep) / 3_600_000;
    expect(hours).toBeCloseTo(haversineNm(A, B) / 3.0, 1);

    // spec §7 item 3: no emitted motor leg anywhere may be slower than
    // sailing would be, on that leg's own TWA. Motor legs carry board: null
    // and no twaDeg, so the TWA is recovered from headingDeg and the known
    // uniform wind direction (270): twa = 270 - headingDeg.
    const slowerThanSailing = r.legs
      .filter((l) => l.kind === 'motor')
      .map((l) => ({
        heading: l.headingDeg,
        motorSpeed: l.speedKn,
        sailSpeedAtTwa: base.polar.speedKn(270 - l.headingDeg, 4),
      }))
      .filter((l) => l.sailSpeedAtTwa > l.motorSpeed);
    expect(slowerThanSailing).toEqual([]);
  });
});
