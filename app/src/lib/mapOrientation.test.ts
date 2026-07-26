import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  FREE_SNAP_NORTH_DEG,
  SCALE_SAMPLE_PX,
  TRACK_DEADBAND_DEG,
  TRACK_DEADBAND_REDUCED_DEG,
  compassLabelKey,
  nextOrientation,
  orientationVisual,
  pickScaleBar,
  scaleUnitAbbrevKey,
  scaleUnitWordKey,
  shouldEaseToCourse,
  shouldSnapNorth,
  trackUpAvailable,
  type OrientationMode,
  type OrientationVisual,
} from './mapOrientation';
import { OWNSHIP_VECTOR_MIN_SOG_KN } from './ownshipVector';

// #155. Every expectation below is hand-derived from the state machine as
// specified in the issue, or from Web-Mercator/nautical arithmetic worked out
// independently of the implementation — never by running the function under
// test and copying its output (the #50/#145 tautology trap).

describe('nextOrientation', () => {
  // Exhaustive: 3 modes x 2 availabilities. Written out row by row rather than
  // generated, so a table this small can be read against the issue text.
  const TABLE: {
    mode: OrientationMode;
    trackAvailable: boolean;
    mode_: OrientationMode;
    action: string;
  }[] = [
    { mode: 'north', trackAvailable: true, mode_: 'track', action: 'ease-track' },
    { mode: 'north', trackAvailable: false, mode_: 'north', action: 'reject' },
    { mode: 'track', trackAvailable: true, mode_: 'north', action: 'ease-north' },
    { mode: 'track', trackAvailable: false, mode_: 'north', action: 'ease-north' },
    { mode: 'free', trackAvailable: true, mode_: 'north', action: 'ease-north' },
    { mode: 'free', trackAvailable: false, mode_: 'north', action: 'ease-north' },
  ];

  for (const row of TABLE) {
    it(`${row.mode} + ${row.trackAvailable ? 'available' : 'unavailable'} -> ${row.mode_}/${row.action}`, () => {
      expect(nextOrientation(row.mode, row.trackAvailable)).toEqual({
        mode: row.mode_,
        action: row.action,
      });
    });
  }

  it('never leaves the user stuck in track or free (both always escape to north)', () => {
    for (const mode of ['track', 'free'] as const) {
      for (const available of [true, false]) {
        expect(nextOrientation(mode, available).mode).toBe('north');
      }
    }
  });

  it('is the only path INTO track, and only when a course is available', () => {
    const entering = TABLE.filter((r) => r.mode_ === 'track');
    expect(entering).toHaveLength(1);
    expect(entering[0]).toMatchObject({ mode: 'north', trackAvailable: true });
  });
});

describe('orientationVisual', () => {
  it('maps mode + staleness onto the four painted states', () => {
    expect(orientationVisual('north', false)).toBe('north-up');
    expect(orientationVisual('track', false)).toBe('track-up');
    expect(orientationVisual('track', true)).toBe('track-up-stale');
    expect(orientationVisual('free', false)).toBe('free');
  });

  it('ignores staleness outside track mode (nothing is being held there)', () => {
    expect(orientationVisual('north', true)).toBe('north-up');
    expect(orientationVisual('free', true)).toBe('free');
  });
});

describe('compassLabelKey', () => {
  it('splits north-up on availability so the reason is announced before the tap', () => {
    expect(compassLabelKey('north-up', true)).toBe('map.compass.northUp');
    expect(compassLabelKey('north-up', false)).toBe('map.compass.northUp.noTrack');
  });

  it('carries the held-bearing state in the track-up label', () => {
    expect(compassLabelKey('track-up', true)).toBe('map.compass.trackUp');
    expect(compassLabelKey('track-up-stale', true)).toBe('map.compass.trackUp.stale');
  });

  it('labels free as a reset-to-north action', () => {
    expect(compassLabelKey('free', true)).toBe('map.compass.free');
    expect(compassLabelKey('free', false)).toBe('map.compass.free');
  });

  it('gives every visual state a distinct label', () => {
    const states: OrientationVisual[] = ['north-up', 'track-up', 'track-up-stale', 'free'];
    const keys = states.map((s) => compassLabelKey(s, true));
    expect(new Set(keys).size).toBe(states.length);
  });
});

describe('trackUpAvailable', () => {
  const moving = { cogDeg: 90, sogKn: 6 };

  it('requires the ownship setting (no setting, no COG source at all)', () => {
    expect(trackUpAvailable(false, moving)).toBe(false);
    expect(trackUpAvailable(true, moving)).toBe(true);
  });

  it('requires a fix carrying both COG and SOG', () => {
    expect(trackUpAvailable(true, null)).toBe(false);
    expect(trackUpAvailable(true, { cogDeg: null, sogKn: 6 })).toBe(false);
    expect(trackUpAvailable(true, { cogDeg: 90, sogKn: null })).toBe(false);
  });

  it('treats a course of 000 as a real course, not a falsy one', () => {
    expect(trackUpAvailable(true, { cogDeg: 0, sogKn: 6 })).toBe(true);
  });

  it('uses #141 ownship SOG floor inclusively', () => {
    // Pinned against the imported constant, not a re-typed 0.5: the whole
    // point of importing it is that the app has ONE "is she moving" threshold.
    expect(OWNSHIP_VECTOR_MIN_SOG_KN).toBe(0.5);
    expect(trackUpAvailable(true, { cogDeg: 90, sogKn: OWNSHIP_VECTOR_MIN_SOG_KN })).toBe(true);
    expect(trackUpAvailable(true, { cogDeg: 90, sogKn: 0.49 })).toBe(false);
    expect(trackUpAvailable(true, { cogDeg: 90, sogKn: 0 })).toBe(false);
  });
});

describe('shouldEaseToCourse', () => {
  it('skips turns inside the deadband and takes them at or beyond it', () => {
    expect(TRACK_DEADBAND_DEG).toBe(2);
    // bearing 10 -> COG 11 is a 1 deg turn: inside the deadband.
    expect(shouldEaseToCourse(10, 11, TRACK_DEADBAND_DEG)).toBe(false);
    // bearing 10 -> COG 12 is exactly 2 deg: the deadband is inclusive.
    expect(shouldEaseToCourse(10, 12, TRACK_DEADBAND_DEG)).toBe(true);
  });

  it('measures the SHORTEST path across the 000 wrap', () => {
    // 359 -> 001 is +2 deg the short way (not 358 the long way).
    expect(shouldEaseToCourse(359, 1, TRACK_DEADBAND_DEG)).toBe(true);
    expect(shouldEaseToCourse(359, 0.5, TRACK_DEADBAND_DEG)).toBe(false);
    // 350 -> 010 is +20 deg the short way.
    expect(shouldEaseToCourse(350, 10, TRACK_DEADBAND_DEG)).toBe(true);
  });

  it('is direction-agnostic (a port turn counts like a starboard one)', () => {
    expect(shouldEaseToCourse(100, 97, TRACK_DEADBAND_DEG)).toBe(true);
    expect(shouldEaseToCourse(100, 103, TRACK_DEADBAND_DEG)).toBe(true);
  });

  it('widens under reduced motion', () => {
    expect(TRACK_DEADBAND_REDUCED_DEG).toBe(5);
    // A 3 deg turn: taken normally, skipped under reduced motion.
    expect(shouldEaseToCourse(10, 13, TRACK_DEADBAND_DEG)).toBe(true);
    expect(shouldEaseToCourse(10, 13, TRACK_DEADBAND_REDUCED_DEG)).toBe(false);
    expect(shouldEaseToCourse(10, 15, TRACK_DEADBAND_REDUCED_DEG)).toBe(true);
  });
});

describe('shouldSnapNorth', () => {
  it('snaps within a degree either side of north, inclusively', () => {
    expect(FREE_SNAP_NORTH_DEG).toBe(1);
    expect(shouldSnapNorth(0)).toBe(true);
    expect(shouldSnapNorth(1)).toBe(true);
    expect(shouldSnapNorth(359)).toBe(true);
    expect(shouldSnapNorth(0.4)).toBe(true);
    expect(shouldSnapNorth(359.6)).toBe(true);
  });

  it('leaves a deliberate rotation alone', () => {
    expect(shouldSnapNorth(1.1)).toBe(false);
    expect(shouldSnapNorth(358.9)).toBe(false);
    expect(shouldSnapNorth(45)).toBe(false);
    expect(shouldSnapNorth(180)).toBe(false);
    expect(shouldSnapNorth(270)).toBe(false);
  });
});

// --------------------------------------------------------------- scale bar

/**
 * Ground resolution at a MapLibre zoom, worked out independently of the app:
 * MapLibre's zoom is 512-px-tile based, so the Web-Mercator world is
 * 512 * 2^z px wide and one pixel spans
 *   40075016.6856 m * cos(lat) / (512 * 2^z).
 * This is the arithmetic that showed the #155 design's fixed 0.05 NM floor
 * ran out of rungs above z ~ 15.6 — it must stay hand-written here, never
 * borrowed from the implementation.
 */
function metresPerPixel(zoom: number, latDeg: number): number {
  return (40075016.6856 * Math.cos((latDeg * Math.PI) / 180)) / (512 * Math.pow(2, zoom));
}

/** Ground distance, in NM, spanned by the bar's 100 px reference at a zoom. */
function referenceNm(zoom: number, latDeg: number): number {
  return (metresPerPixel(zoom, latDeg) * SCALE_SAMPLE_PX) / 1852;
}

describe('pickScaleBar — nautical-mile branch (the approved ladder, unchanged)', () => {
  it('takes the rung exactly when the span IS a rung (full-width bar)', () => {
    // 100 px spans 5 NM -> rung 5 NM -> the bar is the whole 100 px reference.
    expect(pickScaleBar(5, 100)).toEqual({ unit: 'nm', value: 5, nm: 5, widthPx: 100 });
    expect(pickScaleBar(1, 100)).toEqual({ unit: 'nm', value: 1, nm: 1, widthPx: 100 });
  });

  it('steps down the 1-2-5 ladder below a rung', () => {
    // 4.999 NM: the largest 1-2-5 rung at or below it is 2 NM.
    // width = 2 / 4.999 * 100 = 40.008 px — the worst case in the whole
    // design, and still inside the 40-100 px band.
    const bar = pickScaleBar(4.999, 100);
    expect(bar?.unit).toBe('nm');
    expect(bar?.value).toBe(2);
    expect(bar?.widthPx).toBeCloseTo(40.008, 3);
  });

  it('handles a zoomed-out fjord view', () => {
    // 100 px spans 24 NM -> rung 20 NM, width = 20 / 24 * 100 = 83.333 px.
    const bar = pickScaleBar(24, 100);
    expect(bar?.value).toBe(20);
    expect(bar?.unit).toBe('nm');
    expect(bar?.widthPx).toBeCloseTo(83.3333, 4);
  });
});

describe('pickScaleBar — cable branch', () => {
  it('labels tenths of a mile as cables, not fractional miles', () => {
    // 0.5 NM = 5 cables exactly -> full-width bar. The approved design would
    // have labelled this "0,5 sm"; cables make it an integer.
    expect(pickScaleBar(0.5, 100)).toEqual({ unit: 'cbl', value: 5, nm: 0.5, widthPx: 100 });
  });

  it('holds at the 1-cable lower boundary', () => {
    // 0.1 NM is exactly 1 cable — the last span before the metre branch.
    const bar = pickScaleBar(0.1, 100);
    expect(bar?.unit).toBe('cbl');
    expect(bar?.value).toBe(1);
    expect(bar?.nm).toBeCloseTo(0.1, 12);
    expect(bar?.widthPx).toBeCloseTo(100, 9);
  });

  it('steps down inside the branch', () => {
    // 0.9999 NM = 9.999 cables -> rung 5 cbl (0.5 NM);
    // width = 0.5 / 0.9999 * 100 = 50.005 px.
    const bar = pickScaleBar(0.9999, 100);
    expect(bar?.unit).toBe('cbl');
    expect(bar?.value).toBe(5);
    expect(bar?.widthPx).toBeCloseTo(50.005, 3);
  });
});

describe('pickScaleBar — metre branch (the span the approved ladder could not answer)', () => {
  it('crosses from cables to metres just under 0.1 NM', () => {
    // 0.099 NM = 183.348 m -> rung 100 m;
    // width = (100 / 1852) / 0.099 * 100 = 10000 / 183.348 = 54.5411 px.
    const bar = pickScaleBar(0.099, 100);
    expect(bar?.unit).toBe('m');
    expect(bar?.value).toBe(100);
    expect(bar?.widthPx).toBeCloseTo(54.5411, 3);

    // 0.0999 NM = 185.0148 m -> still rung 100 m;
    // width = 10000 / 185.0148 = 54.0497 px.
    const justUnder = pickScaleBar(0.0999, 100);
    expect(justUnder?.unit).toBe('m');
    expect(justUnder?.value).toBe(100);
    expect(justUnder?.widthPx).toBeCloseTo(54.0497, 3);
  });

  it('answers the span the approved fixed ladder had no rung for', () => {
    // 0.05 NM was the approved ladder's SMALLEST rung, so a span of exactly
    // 0.05 NM was its last defined input. 0.05 NM = 92.6 m -> rung 50 m;
    // width = (50 / 1852) / 0.05 * 100 = 5000 / 92.6 = 53.9957 px.
    const bar = pickScaleBar(0.05, 100);
    expect(bar?.unit).toBe('m');
    expect(bar?.value).toBe(50);
    expect(bar?.widthPx).toBeCloseTo(53.9957, 3);
  });

  it('still answers at MapLibre max zoom, where the approved ladder was empty', () => {
    // z = 22 (MapLibre's default maxZoom; the app sets none) at 54.85 N:
    //   m/px  = 40075016.6856 * cos(54.85 deg) / (512 * 2^22) = 0.0107437
    //   100px = 1.07437 m  ->  rung 1 m
    //   width = 1 / 1.07437 * 100 = 93.08 px
    const maxNm = referenceNm(22, 54.85);
    expect(maxNm * 1852).toBeCloseTo(1.0744, 3); // the derivation above, pinned
    const bar = pickScaleBar(maxNm, 100);
    expect(bar?.unit).toBe('m');
    expect(bar?.value).toBe(1);
    expect(bar?.widthPx).toBeCloseTo(93.08, 1);
  });

  it('is null for a degenerate viewport rather than painting NaN', () => {
    expect(pickScaleBar(0, 100)).toBeNull();
    expect(pickScaleBar(-1, 100)).toBeNull();
    expect(pickScaleBar(Number.NaN, 100)).toBeNull();
    expect(pickScaleBar(1, 0)).toBeNull();
  });
});

describe('pickScaleBar — unit-selection boundaries', () => {
  it('switches unit exactly at 1 NM and 0.1 NM', () => {
    expect(pickScaleBar(1, 100)?.unit).toBe('nm');
    expect(pickScaleBar(0.999999, 100)?.unit).toBe('cbl');
    expect(pickScaleBar(0.1, 100)?.unit).toBe('cbl');
    expect(pickScaleBar(0.0999999, 100)?.unit).toBe('m');
  });
});

describe('pickScaleBar — invariants across the app region and zoom range', () => {
  // The app's chart region is 54.3-55.3 N (CLAUDE.md). Zoom is swept from 4
  // (far below anything MapLibre's maxBounds constraint permits — the narrow
  // 375x667 viewport bottoms out near z 7.5) up to MapLibre's default maxZoom
  // of 22, which the app does not override.
  const arbView = fc.record({
    lat: fc.double({ min: 54.3, max: 55.3, noNaN: true }),
    zoom: fc.double({ min: 4, max: 22, noNaN: true }),
  });

  it('always draws a 40-100 px bar whose label is its true ground length', () => {
    fc.assert(
      fc.property(arbView, ({ lat, zoom }) => {
        const maxNm = referenceNm(zoom, lat);
        const bar = pickScaleBar(maxNm, SCALE_SAMPLE_PX);
        expect(bar).not.toBeNull();
        if (!bar) return;

        // 1. The bar always reads as a bar: never a sliver, never overflowing
        //    its own 100 px reference.
        expect(bar.widthPx).toBeGreaterThanOrEqual(40);
        expect(bar.widthPx).toBeLessThanOrEqual(SCALE_SAMPLE_PX);

        // 2. The LABEL is the truth: converting the labelled magnitude with
        //    this test's own unit factors must reproduce the ground length the
        //    drawn bar actually covers. A wrong factor in the implementation
        //    (e.g. 100 cables to the mile) fails here.
        const nmPerUnit = { nm: 1, cbl: 1 / 10, m: 1 / 1852 }[bar.unit];
        const labelledNm = bar.value * nmPerUnit;
        const drawnGroundNm = (bar.widthPx / SCALE_SAMPLE_PX) * maxNm;
        expect(labelledNm).toBeCloseTo(drawnGroundNm, 12);

        // 3. The bar never claims more ground than its reference span.
        expect(bar.nm).toBeLessThanOrEqual(maxNm * (1 + 1e-12));

        // 4. Rungs stay on the 1-2-5 ladder ...
        const mantissa = bar.value / Math.pow(10, Math.floor(Math.log10(bar.value) + 1e-9));
        expect(Math.abs(mantissa - Math.round(mantissa))).toBeLessThan(1e-9);
        expect([1, 2, 5]).toContain(Math.round(mantissa));

        // 5. ... and are INTEGERS everywhere the app can be zoomed, which is
        //    what lets the label skip decimal formatting entirely.
        expect(Number.isInteger(bar.value)).toBe(true);

        // 6. Unit follows the span, not the other way round.
        if (maxNm >= 1) expect(bar.unit).toBe('nm');
        else if (maxNm >= 0.1) expect(bar.unit).toBe('cbl');
        else expect(bar.unit).toBe('m');
      }),
      { numRuns: 2000 },
    );
  });
});

describe('scale unit message keys', () => {
  it('uses abbreviations for the visible label', () => {
    expect(scaleUnitAbbrevKey('nm')).toBe('map.scale.unit.nm');
    expect(scaleUnitAbbrevKey('cbl')).toBe('map.scale.unit.cbl');
    expect(scaleUnitAbbrevKey('m')).toBe('map.scale.unit.m');
  });

  it('uses full words for the aria-label, singular only at a rung of 1', () => {
    expect(scaleUnitWordKey('nm', 1)).toBe('map.scale.unit.nm.one');
    expect(scaleUnitWordKey('nm', 2)).toBe('map.scale.unit.nm.other');
    expect(scaleUnitWordKey('cbl', 1)).toBe('map.scale.unit.cbl.one');
    expect(scaleUnitWordKey('cbl', 5)).toBe('map.scale.unit.cbl.other');
    expect(scaleUnitWordKey('m', 1)).toBe('map.scale.unit.m.one');
    expect(scaleUnitWordKey('m', 50)).toBe('map.scale.unit.m.other');
  });
});
