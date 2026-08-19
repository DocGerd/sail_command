import { describe, expect, it } from 'vitest';
import { mergeCollinearLegs } from './postprocess';
import { WindField } from '../lib/wind';
import { openWaterMask, uniformWindGrid, makeMask } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Leg } from '../types';
import { destinationPoint, initialBearingDeg } from '../lib/geo';
import { APPROACH_RADIUS_M, approachGate, uniformGate } from '../lib/depthGate';
import { TEST_MASK_META } from '../test/fixtures';

const t0 = Date.UTC(2026, 6, 15, 8, 0, 0);

// legFrom only ever builds sail legs; narrowed to the sail arm (rather than the
// full Leg union) so spreading its result below doesn't distribute over the
// motor arm too — a fixture-only artifact of Leg becoming a discriminated union.
type SailLeg = Extract<Leg, { kind: 'sail' }>;

function legFrom(
  start: { lat: number; lon: number },
  headingDeg: number,
  distNm: number,
  startMs: number,
  speedKn = 6,
): SailLeg {
  const end = destinationPoint(start, headingDeg, distNm);
  const durMs = (distNm / speedKn) * 3_600_000;
  return {
    kind: 'sail',
    board: 'starboard',
    start,
    end,
    startTimeMs: startMs,
    endTimeMs: startMs + durMs,
    headingDeg,
    twaDeg: 90,
    twsKn: 12,
    speedKn,
    distanceNm: distNm,
    maneuverAtStart: null,
  };
}

describe('mergeCollinearLegs', () => {
  // Wind FROM SOUTH: eastbound headings (~90°) give twa = +90 → starboard,
  // matching legFrom's board fixture. (Wind from north would make them port.)
  const wind = new WindField(uniformWindGrid(12, 180));

  it('merges a slightly dog-legged pair into one leg', () => {
    const a = legFrom({ lat: 54.7, lon: 10.0 }, 88, 2, t0);
    const b = legFrom(a.end, 92, 2, a.endTimeMs);
    const merged = mergeCollinearLegs(
      [a, b],
      openWaterMask(),
      wind,
      uniformGate(DEFAULT_SETTINGS.safetyDepthM),
    );
    expect(merged.length).toBe(1);
    expect(merged[0].start).toEqual(a.start);
    expect(merged[0].end).toEqual(b.end);
    expect(merged[0].headingDeg).toBeCloseTo(initialBearingDeg(a.start, b.end), 0);
    expect(merged[0].endTimeMs).toBe(b.endTimeMs);
  });

  it('does not merge across a maneuver, board change, or kind change', () => {
    const a = legFrom({ lat: 54.7, lon: 10.0 }, 90, 2, t0);
    const b = { ...legFrom(a.end, 91, 2, a.endTimeMs), maneuverAtStart: 'tack' as const };
    expect(
      mergeCollinearLegs([a, b], openWaterMask(), wind, uniformGate(DEFAULT_SETTINGS.safetyDepthM))
        .length,
    ).toBe(2);
    const c = { ...legFrom(a.end, 91, 2, a.endTimeMs), board: 'port' as const };
    expect(
      mergeCollinearLegs([a, c], openWaterMask(), wind, uniformGate(DEFAULT_SETTINGS.safetyDepthM))
        .length,
    ).toBe(2);
    const d = {
      ...legFrom(a.end, 91, 2, a.endTimeMs),
      kind: 'motor' as const,
      board: null,
      maneuverAtStart: null,
    };
    expect(
      mergeCollinearLegs([a, d], openWaterMask(), wind, uniformGate(DEFAULT_SETTINGS.safetyDepthM))
        .length,
    ).toBe(2);
  });

  it('does not merge when the straight chord would clip land the dogleg avoids', () => {
    // Northbound dogleg: 7 nm at 005°, then 7 nm at 355° (10° turn — mergeable).
    // The straight chord runs due north through a shoal ridge at row 90
    // (lat 54.75–54.755, cols 140–165) whose gap (cols 152–156) only the
    // dogleg's eastward bulge passes through.
    // Wind FROM EAST so all headings ~0° are starboard (twa ≈ +90).
    const windE = new WindField(uniformWindGrid(12, 90));
    const ridge = makeMask((r, c) =>
      r === 90 && c >= 140 && c <= 165 && !(c >= 152 && c <= 156) ? 0 : 200,
    );
    const a = { ...legFrom({ lat: 54.6, lon: 10.1525 }, 5, 7, t0), twaDeg: 85 };
    const b = { ...legFrom(a.end, 355, 7, a.endTimeMs), twaDeg: 95 };
    // sanity: the dogleg itself is clean, the chord is not
    expect(ridge.segmentNavigable(a.start, a.end, uniformGate(3))).toBe(true);
    expect(ridge.segmentNavigable(b.start, b.end, uniformGate(3))).toBe(true);
    expect(ridge.segmentNavigable(a.start, b.end, uniformGate(3))).toBe(false);
    expect(
      mergeCollinearLegs([a, b], ridge, windE, uniformGate(DEFAULT_SETTINGS.safetyDepthM)).length,
    ).toBe(2);
    // control: same legs over open water DO merge
    expect(
      mergeCollinearLegs([a, b], openWaterMask(), windE, uniformGate(DEFAULT_SETTINGS.safetyDepthM))
        .length,
    ).toBe(1);
  });

  // #243 §D.4: mergeCollinearLegs's quality gap — straightening a dogleg can
  // cut a corner neither original leg touched, silently undoing some of the
  // depth comfort preference even though the merge stays gate-valid.
  it('does not merge when the straight chord clips SHALLOWER (but still navigable) water than either leg individually crossed', () => {
    // Same ridge/gap geometry as the land-clipping test above, but the ridge
    // is charted 3.2 m (navigable at the 3.0 m gate — segmentNavigable alone
    // would NOT reject this merge) instead of land. Both legs individually
    // stay in 20 m water (routed through the gap, exactly like the land
    // case); only the straight chord actually touches the ridge.
    const windE = new WindField(uniformWindGrid(12, 90));
    const ridge = makeMask((r, c) =>
      r === 90 && c >= 140 && c <= 165 && !(c >= 152 && c <= 156) ? 32 : 200,
    );
    const a = { ...legFrom({ lat: 54.6, lon: 10.1525 }, 5, 7, t0), twaDeg: 85 };
    const b = { ...legFrom(a.end, 355, 7, a.endTimeMs), twaDeg: 95 };
    // sanity: unlike the land case, the chord IS gate-navigable now — only
    // the NEW clearance-comparison check can reject this merge.
    expect(ridge.segmentNavigable(a.start, b.end, uniformGate(3))).toBe(true);
    expect(ridge.segmentClearanceM(a.start, a.end, uniformGate(3))).toBeCloseTo(20, 6);
    expect(ridge.segmentClearanceM(b.start, b.end, uniformGate(3))).toBeCloseTo(20, 6);
    expect(ridge.segmentClearanceM(a.start, b.end, uniformGate(3))).toBeCloseTo(3.2, 6);

    // Preference active (DEFAULT_SETTINGS.depthComfortMarginM = 2.0): the
    // merged span's 3.2 m clearance is worse than either leg's own 20 m, so
    // the merge is rejected.
    expect(
      mergeCollinearLegs([a, b], ridge, windE, uniformGate(DEFAULT_SETTINGS.safetyDepthM), 5.0)
        .length,
    ).toBe(2);
    // Preference OFF (comfortDepthM omitted): byte-identical to the pre-#243
    // behavior — the hard gate alone governs, and the merge proceeds.
    expect(
      mergeCollinearLegs([a, b], ridge, windE, uniformGate(DEFAULT_SETTINGS.safetyDepthM)).length,
    ).toBe(1);
  });

  it('merges two adjacent motor legs within tolerance (endTimeMs/distanceNm summed)', () => {
    const a = {
      ...legFrom({ lat: 54.7, lon: 10.0 }, 90, 2, t0, 6.5),
      kind: 'motor' as const,
      board: null,
      maneuverAtStart: null,
    };
    const b = {
      ...legFrom(a.end, 90, 2, a.endTimeMs, 6.5),
      kind: 'motor' as const,
      board: null,
      maneuverAtStart: null,
    };
    const merged = mergeCollinearLegs(
      [a, b],
      openWaterMask(),
      wind,
      uniformGate(DEFAULT_SETTINGS.safetyDepthM),
    );
    expect(merged.length).toBe(1);
    expect(merged[0].start).toEqual(a.start);
    expect(merged[0].end).toEqual(b.end);
    expect(merged[0].endTimeMs).toBe(b.endTimeMs);
    expect(merged[0].distanceNm).toBeCloseTo(a.distanceNm + b.distanceNm, 3);
  });

  it('heading-delta merge tolerance is inclusive at exactly 10°, exclusive just over', () => {
    const a = legFrom({ lat: 54.7, lon: 10.0 }, 90, 2, t0);
    const bAt10 = legFrom(a.end, 100, 2, a.endTimeMs); // exactly MAX_MERGE_DEG — merges
    expect(
      mergeCollinearLegs(
        [a, bAt10],
        openWaterMask(),
        wind,
        uniformGate(DEFAULT_SETTINGS.safetyDepthM),
      ).length,
    ).toBe(1);
    const bOver10 = legFrom(a.end, 100.5, 2, a.endTimeMs); // just over — does not merge
    expect(
      mergeCollinearLegs(
        [a, bOver10],
        openWaterMask(),
        wind,
        uniformGate(DEFAULT_SETTINGS.safetyDepthM),
      ).length,
    ).toBe(2);
  });
});

// #452 graft 5. The spike names mergeCollinearLegs as the seam an
// edgeFactor-only fix would silently miss: this pass RE-VALIDATES the
// straightened span, so if it is handed a route-wide relaxed gate a merge can
// re-cross relaxed water anywhere on the passage, outside every disc. Without
// a test at THIS level, forgetting graft 5 is invisible — the solver's own
// legs would all be correctly confined and only the merged output would not.
describe('#452 graft 5: mergeCollinearLegs re-validates against the per-cell gate', () => {
  const windE = new WindField(uniformWindGrid(12, 90));
  // A ridge across row 90 charted 2.5 m — BELOW the 3.0 m requested gate —
  // with a 20 m gap at cols 152..156. Same geometry as the #243 §D.4 case
  // above, only shallower, so the hard gate alone decides every assertion
  // here and the comfort preference stays out of it (comfortDepthM omitted).
  const ridge = makeMask((r, c) =>
    r === 90 && c >= 140 && c <= 165 && !(c >= 152 && c <= 156) ? 25 : 200,
  );
  const a = { ...legFrom({ lat: 54.6, lon: 10.1525 }, 5, 7, t0), twaDeg: 85 };
  const b = { ...legFrom(a.end, 355, 7, a.endTimeMs), twaDeg: 95 };

  // The straightened chord runs almost due north along lon 10.1525, crossing
  // row 90 at col 150 — a ridge cell, not the gap. Cell (90, 150)'s centre is
  // lat 54.3 + 90.5*0.005 = 54.7525, lon 9.4 + 150.5*0.005 = 10.1525.
  const CHORD_CROSSING = { lat: 54.7525, lon: 10.1525 };
  // 30 columns east of the crossing (col 180): at ~321 m per column that is
  // ~9.6 km, far outside a 1852 m disc.
  const FAR_AWAY = { lat: 54.7525, lon: 10.3025 };

  it('sanity: the chord crosses the 2.5 m ridge, and both legs individually stay in the gap', () => {
    expect(ridge.segmentNavigable(a.start, a.end, uniformGate(3.0))).toBe(true);
    expect(ridge.segmentNavigable(b.start, b.end, uniformGate(3.0))).toBe(true);
    expect(ridge.segmentNavigable(a.start, b.end, uniformGate(3.0))).toBe(false);
    expect(ridge.segmentNavigable(a.start, b.end, uniformGate(2.3))).toBe(true);
  });

  it('ACCEPTS the merge when a disc covers the crossing', () => {
    const covering = approachGate(TEST_MASK_META, [CHORD_CROSSING], 3.0, [2.3], APPROACH_RADIUS_M);
    expect(mergeCollinearLegs([a, b], ridge, windE, covering).length).toBe(1);
  });

  it('REJECTS the same merge when the identical relaxed gate sits elsewhere', () => {
    // Same 2.3 m relaxation, same legs, same mask — only the DISC MOVES. A
    // merge pass handed a route-wide scalar cannot tell these two apart, so
    // this pair is the whole graft: it fails only if mergeCollinearLegs
    // consults a per-cell field.
    const elsewhere = approachGate(TEST_MASK_META, [FAR_AWAY], 3.0, [2.3], APPROACH_RADIUS_M);
    expect(mergeCollinearLegs([a, b], ridge, windE, elsewhere).length).toBe(2);
    // And a plain requested-depth gate rejects it too, which is what the
    // relaxation is being asked to override in the accepting case above.
    expect(mergeCollinearLegs([a, b], ridge, windE, uniformGate(3.0)).length).toBe(2);
  });
});
