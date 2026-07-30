import { describe, expect, it, vi } from 'vitest';
import { solve } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { openWaterMask, TEST_POLAR, uniformWindGrid, makeWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import { haversineNm } from '../lib/geo';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines (2026-07-15 CI run: tests at ~1s locally took 30-44s). Fast test
// files keep vitest's 5s default so hang detection stays meaningful there.
vi.setConfig({ testTimeout: 120_000 });

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

    // Assert the kind SEQUENCE, so a failure prints both arrays.
    expect(r.legs.map((l) => l.kind)).toContain('motor');

    // Every motor leg must be one the rule actually permits: its sailing speed
    // at that leg's own TWA must be below the floor. Mapping to objects keeps
    // the offending leg visible in the failure message.
    const floorKn = DEFAULT_SETTINGS.motorSpeedKn - DEFAULT_SETTINGS.sailPreferenceKn;
    const offenders = r.legs
      .filter((l) => l.kind === 'motor')
      .map((l) => ({ heading: l.headingDeg, speed: l.speedKn }))
      // Motor legs pick up floating-point drift from geometry/leg-merging
      // (observed 6.500000000000744 / 6.499999999951773), so compare with a
      // tight tolerance rather than exact equality against motorSpeedKn.
      .filter((l) => Math.abs(l.speed - DEFAULT_SETTINGS.motorSpeedKn) > 1e-6);
    expect(offenders).toEqual([]);
    expect(floorKn).toBeCloseTo(3.7, 10);

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
  // 2.5 threshold, so Math.max must clamp the floor to 2.5. Without the clamp
  // the floor would be 0.2 and nothing would ever motor; worse, a floor above
  // motorSpeedKn would hand out motor legs SLOWER than sailing.
  it('small engine: the floor never drops below motorThresholdKn', () => {
    const settings = { ...DEFAULT_SETTINGS, motorSpeedKn: 3.0 };
    const r = solve({ ...base, settings, wind: new WindField(uniformWindGrid(6, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    // At TWS 6 the direct heading sails at 4.3 kn, faster than this 3.0 kn
    // engine, so the route is all sail -- exactly as before #254.
    expect(r.legs.map((l) => l.kind)).toEqual(['sail']);

    // And no emitted motor leg anywhere may be slower than sailing would be.
    const slowerThanSailing = r.legs
      .filter((l) => l.kind === 'motor')
      .map((l) => ({ heading: l.headingDeg, motorSpeed: l.speedKn }));
    expect(slowerThanSailing).toEqual([]);
  });
});
