import { describe, expect, it } from 'vitest';
import { mergeCollinearLegs } from './postprocess';
import { WindField } from '../lib/wind';
import { openWaterMask, uniformWindGrid, makeMask } from '../test/fixtures';
import { DEFAULT_SETTINGS, type LatLon, type Leg } from '../types';
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
// #1842: tryMerge judged a merge against the clearance of the ACCUMULATED leg,
// so one shallow step anywhere in it lowered the comfort bar for the whole
// chord. Each original step must now keep its own clearance, capped at the
// comfort depth, along the part of the chord that replaces it.
// Grid: 0.005° per row/col, row 0 at lat 54.3.
describe('#1842: merge comfort is judged per original step', () => {
  const gate = uniformGate(DEFAULT_SETTINGS.safetyDepthM);
  // Above the 10 m deep water, as at margin-extreme on Damp (comfort 10.9 m,
  // step 6.1 m), so the comfort cap never binds in these cases.
  const deepComfort = 11.0;
  const wind = new WindField(uniformWindGrid(12, 180));
  const motor = (leg: SailLeg): Leg => ({
    ...leg,
    kind: 'motor',
    board: null,
    maneuverAtStart: null,
  });

  // Three motor legs eastbound along row 80. A crosses a 3.5 m shoal at
  // (80, 130); B is collinear; C turns 9.5° south, so the straight A→C chord
  // dips into row 78 in C's share of it, where a 5.0 m patch sits. C itself
  // stays in row 80 there, in deep water (`deep` byte, 10 m by default).
  const legsOver = (shoal: boolean, deep = 100) => {
    const mask = makeMask((r, c) => {
      if (shoal && r === 80 && c === 130) return 35;
      if (r === 78 && c >= 190 && c <= 193) return 50;
      return deep;
    });
    const a = motor(legFrom({ lat: 54.7025, lon: 10.0 }, 90, 6, t0));
    const b = motor(legFrom(a.end, 90, 6, a.endTimeMs));
    const c = motor(legFrom(b.end, 99.5, 6, b.endTimeMs));
    return { mask, a, b, c };
  };
  const chordAt = (from: LatLon, to: LatLon, x: number): LatLon => ({
    lat: from.lat + (to.lat - from.lat) * x,
    lon: from.lon + (to.lon - from.lon) * x,
  });

  it('fixture: the A→C chord crosses the 5.0 m patch that no step touches', () => {
    const { mask, a, b, c } = legsOver(true);
    expect(mask.segmentClearanceM(a.start, a.end, gate)).toBeCloseTo(3.5, 6);
    expect(mask.segmentClearanceM(b.start, b.end, gate)).toBeCloseTo(10, 6);
    expect(mask.segmentClearanceM(c.start, c.end, gate)).toBeCloseTo(10, 6);
    expect(mask.segmentClearanceM(a.start, b.end, gate)).toBeCloseTo(3.5, 6);
    expect(mask.segmentClearanceM(a.start, c.end, gate)).toBeCloseTo(3.5, 6);
    // C's share of the chord (from two thirds on) holds the patch.
    expect(mask.segmentClearanceM(chordAt(a.start, c.end, 2 / 3), c.end, gate)).toBeCloseTo(5.0, 6);
    const { mask: clean } = legsOver(false);
    expect(clean.segmentClearanceM(a.start, c.end, gate)).toBeCloseTo(5.0, 6);
  });

  it('control: without the far shoal, cutting C onto the 5.0 m patch is rejected', () => {
    const { mask, a, b, c } = legsOver(false);
    const out = mergeCollinearLegs([a, b, c], mask, wind, gate, deepComfort);
    expect(out.map((l) => l.end)).toEqual([b.end, c.end]);
  });

  it('a shallow step early in the run does not license a shallower cut later', () => {
    const { mask, a, b, c } = legsOver(true);
    const out = mergeCollinearLegs([a, b, c], mask, wind, gate, deepComfort);
    expect(out.map((l) => l.end)).toEqual([b.end, c.end]);
  });

  // The maintainer's clamp (#1842 issue comment 6381338942): a share at or
  // above the comfort depth is free water, however much deeper the step was.
  // C reads 20 m, its share 5.0 m, the comfort depth 5.0 m.
  it('a share at or above the comfort depth is accepted even if shallower than its step', () => {
    const { mask, a, b, c } = legsOver(true, 200);
    expect(mask.segmentClearanceM(c.start, c.end, gate)).toBeCloseTo(20, 6);
    expect(mask.segmentClearanceM(chordAt(a.start, c.end, 2 / 3), c.end, gate)).toBeCloseTo(5.0, 6);
    expect(mergeCollinearLegs([a, b, c], mask, wind, gate, 5.0).map((l) => l.end)).toEqual([c.end]);
    // Control: a comfort depth above the share brings the refusal back.
    expect(mergeCollinearLegs([a, b, c], mask, wind, gate, 5.5).map((l) => l.end)).toEqual([
      b.end,
      c.end,
    ]);
  });

  // Same legs, but the 5.0 m patch sits in B's share of the A→C chord
  // (row 79). B was already absorbed into A's leg, whose own chord reads
  // 3.5 m, so treating that merged leg as one step would accept this cut.
  it('an already-absorbed deep step keeps its own clearance', () => {
    const mask = makeMask((r, c) => {
      if (r === 80 && c === 130) return 35;
      if (r === 79 && c >= 158 && c <= 163) return 50;
      return 100;
    });
    const { a, b, c } = legsOver(true);
    const f = (x: number) => chordAt(a.start, c.end, x);
    expect(mask.segmentClearanceM(a.start, b.end, gate)).toBeCloseTo(3.5, 6);
    expect(mask.segmentClearanceM(b.start, b.end, gate)).toBeCloseTo(10, 6);
    expect(mask.segmentClearanceM(c.start, c.end, gate)).toBeCloseTo(10, 6);
    expect(mask.segmentClearanceM(f(1 / 3), f(2 / 3), gate)).toBeCloseTo(5.0, 6);
    expect(mask.segmentClearanceM(f(0), f(1 / 3), gate)).toBeCloseTo(3.5, 6);
    expect(mask.segmentClearanceM(f(2 / 3), f(1), gate)).toBeCloseTo(10, 6);
    const out = mergeCollinearLegs([a, b, c], mask, wind, gate, deepComfort);
    expect(out.map((l) => l.end)).toEqual([b.end, c.end]);
  });

  // Shares follow step LENGTH. A (2 nm, 080°) crosses a 4.0 m shoal at its
  // start; B (8 nm, 090°) is deep. Their chord dips south of the bend into
  // row 80, where a 6.0 m patch sits at 25-45% of the chord. By length that
  // is B's share (from 20%), judged against B's 10 m: refused. An equal split
  // would put it in A's share (to 50%), judged against A's 4.0 m: accepted.
  it('splits the chord by step length, not by step count', () => {
    const mask = makeMask((r, c) => {
      if (r === 80 && (c === 120 || c === 121)) return 40;
      if (r === 80 && c >= 136 && c <= 144) return 60;
      return 100;
    });
    const a = motor(legFrom({ lat: 54.7005, lon: 10.0025 }, 80, 2, t0));
    const b = motor(legFrom(a.end, 90, 8, a.endTimeMs));
    const f = (x: number) => chordAt(a.start, b.end, x);
    expect(mask.segmentClearanceM(a.start, a.end, gate)).toBeCloseTo(4.0, 6);
    expect(mask.segmentClearanceM(b.start, b.end, gate)).toBeCloseTo(10, 6);
    expect(mask.segmentClearanceM(a.start, b.end, gate)).toBeCloseTo(4.0, 6);
    // Length split: A's share has only the shoal, B's holds the patch.
    expect(mask.segmentClearanceM(f(0), f(0.2), gate)).toBeCloseTo(4.0, 6);
    expect(mask.segmentClearanceM(f(0.2), f(1), gate)).toBeCloseTo(6.0, 6);
    // Equal split: the patch falls in A's half; B's half is clean.
    expect(mask.segmentClearanceM(f(0), f(0.5), gate)).toBeCloseTo(4.0, 6);
    expect(mask.segmentClearanceM(f(0.5), f(1), gate)).toBeCloseTo(10, 6);
    const out = mergeCollinearLegs([a, b], mask, wind, gate, deepComfort);
    expect(out.map((l) => l.end)).toEqual([a.end, b.end]);
  });

  it('comfort preference off: unchanged, the gate alone governs', () => {
    const { mask, a, b, c } = legsOver(true);
    expect(mergeCollinearLegs([a, b, c], mask, wind, gate).length).toBe(1);
  });

  // Never looser: the old whole-chord check stays. Here the per-step check
  // alone would accept, and only the old check rejects. A1/A2 bulge north
  // through 4.0 m water while their chord A stays in 20 m. B turns south, so
  // the A1→B chord crosses a 10.0 m patch in A2's share: deeper than A2's own
  // 4.0 m, shallower than chord A's 20 m.
  it('keeps the whole-chord check: a merge it rejects stays rejected', () => {
    const mask = makeMask((r, c) => {
      if ((r === 81 || r === 82) && c >= 120 && c <= 189) return 40;
      if (r === 79 && c >= 164 && c <= 180) return 100;
      return 200;
    });
    const a1 = motor(legFrom({ lat: 54.7025, lon: 10.0 }, 85, 6, t0));
    const a2 = motor(legFrom(a1.end, 95, 6, a1.endTimeMs));
    const b = motor(legFrom(a2.end, 95, 6, a2.endTimeMs));
    expect(mask.segmentClearanceM(a1.start, a1.end, gate)).toBeCloseTo(4.0, 6);
    expect(mask.segmentClearanceM(a2.start, a2.end, gate)).toBeCloseTo(4.0, 6);
    expect(mask.segmentClearanceM(a1.start, a2.end, gate)).toBeCloseTo(20, 6);
    expect(mask.segmentClearanceM(b.start, b.end, gate)).toBeCloseTo(20, 6);
    expect(mask.segmentClearanceM(a1.start, b.end, gate)).toBeCloseTo(10.0, 6);
    // A1+A2 merge (chord 20 m >= 4 m); the merge with B is refused.
    expect(mergeCollinearLegs([a1, a2], mask, wind, gate, 5.0).length).toBe(1);
    const out = mergeCollinearLegs([a1, a2, b], mask, wind, gate, 5.0);
    expect(out.map((l) => l.end)).toEqual([a2.end, b.end]);
  });
});
