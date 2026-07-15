import { describe, expect, it } from 'vitest';
import { mergeCollinearLegs } from './postprocess';
import { WindField } from '../lib/wind';
import { openWaterMask, uniformWindGrid, makeMask } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Leg } from '../types';
import { destinationPoint, initialBearingDeg } from '../lib/geo';

const t0 = Date.UTC(2026, 6, 15, 8, 0, 0);

// legFrom only ever builds sail legs; narrowed to the sail arm (rather than the
// full Leg union) so spreading its result below doesn't distribute over the
// motor arm too — a fixture-only artifact of Leg becoming a discriminated union.
type SailLeg = Extract<Leg, { kind: 'sail' }>;

function legFrom(start: { lat: number; lon: number }, headingDeg: number, distNm: number, startMs: number, speedKn = 6): SailLeg {
  const end = destinationPoint(start, headingDeg, distNm);
  const durMs = (distNm / speedKn) * 3_600_000;
  return {
    kind: 'sail', board: 'starboard', start, end,
    startTimeMs: startMs, endTimeMs: startMs + durMs,
    headingDeg, twaDeg: 90, twsKn: 12, speedKn, distanceNm: distNm, maneuverAtStart: null,
  };
}

describe('mergeCollinearLegs', () => {
  // Wind FROM SOUTH: eastbound headings (~90°) give twa = +90 → starboard,
  // matching legFrom's board fixture. (Wind from north would make them port.)
  const wind = new WindField(uniformWindGrid(12, 180));

  it('merges a slightly dog-legged pair into one leg', () => {
    const a = legFrom({ lat: 54.7, lon: 10.0 }, 88, 2, t0);
    const b = legFrom(a.end, 92, 2, a.endTimeMs);
    const merged = mergeCollinearLegs([a, b], openWaterMask(), wind, DEFAULT_SETTINGS);
    expect(merged.length).toBe(1);
    expect(merged[0].start).toEqual(a.start);
    expect(merged[0].end).toEqual(b.end);
    expect(merged[0].headingDeg).toBeCloseTo(initialBearingDeg(a.start, b.end), 0);
    expect(merged[0].endTimeMs).toBe(b.endTimeMs);
  });

  it('does not merge across a maneuver, board change, or kind change', () => {
    const a = legFrom({ lat: 54.7, lon: 10.0 }, 90, 2, t0);
    const b = { ...legFrom(a.end, 91, 2, a.endTimeMs), maneuverAtStart: 'tack' as const };
    expect(mergeCollinearLegs([a, b], openWaterMask(), wind, DEFAULT_SETTINGS).length).toBe(2);
    const c = { ...legFrom(a.end, 91, 2, a.endTimeMs), board: 'port' as const };
    expect(mergeCollinearLegs([a, c], openWaterMask(), wind, DEFAULT_SETTINGS).length).toBe(2);
    const d = { ...legFrom(a.end, 91, 2, a.endTimeMs), kind: 'motor' as const, board: null };
    expect(mergeCollinearLegs([a, d], openWaterMask(), wind, DEFAULT_SETTINGS).length).toBe(2);
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
    expect(ridge.segmentNavigable(a.start, a.end, 3)).toBe(true);
    expect(ridge.segmentNavigable(b.start, b.end, 3)).toBe(true);
    expect(ridge.segmentNavigable(a.start, b.end, 3)).toBe(false);
    expect(mergeCollinearLegs([a, b], ridge, windE, DEFAULT_SETTINGS).length).toBe(2);
    // control: same legs over open water DO merge
    expect(mergeCollinearLegs([a, b], openWaterMask(), windE, DEFAULT_SETTINGS).length).toBe(1);
  });

  it('merges two adjacent motor legs within tolerance (endTimeMs/distanceNm summed)', () => {
    const a = { ...legFrom({ lat: 54.7, lon: 10.0 }, 90, 2, t0, 6.5), kind: 'motor' as const, board: null };
    const b = { ...legFrom(a.end, 90, 2, a.endTimeMs, 6.5), kind: 'motor' as const, board: null };
    const merged = mergeCollinearLegs([a, b], openWaterMask(), wind, DEFAULT_SETTINGS);
    expect(merged.length).toBe(1);
    expect(merged[0].start).toEqual(a.start);
    expect(merged[0].end).toEqual(b.end);
    expect(merged[0].endTimeMs).toBe(b.endTimeMs);
    expect(merged[0].distanceNm).toBeCloseTo(a.distanceNm + b.distanceNm, 3);
  });

  it('heading-delta merge tolerance is inclusive at exactly 10°, exclusive just over', () => {
    const a = legFrom({ lat: 54.7, lon: 10.0 }, 90, 2, t0);
    const bAt10 = legFrom(a.end, 100, 2, a.endTimeMs); // exactly MAX_MERGE_DEG — merges
    expect(mergeCollinearLegs([a, bAt10], openWaterMask(), wind, DEFAULT_SETTINGS).length).toBe(1);
    const bOver10 = legFrom(a.end, 100.5, 2, a.endTimeMs); // just over — does not merge
    expect(mergeCollinearLegs([a, bOver10], openWaterMask(), wind, DEFAULT_SETTINGS).length).toBe(2);
  });
});
