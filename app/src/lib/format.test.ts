// TZ pin: the DST-transition tests below hand-derive expected strings for
// specific Europe/Berlin wall-clock instants, so they are only deterministic
// if formatSliderTime's ambient Date/Intl timezone is fixed to that same
// zone regardless of the host/CI machine's own TZ (measured: CI runs UTC,
// this repo's dev sandbox runs Europe/Berlin, and the two disagree by
// exactly the DST offset — reproduced locally with `TZ=UTC npm --prefix app
// run test -- src/lib/format.test.ts`).
//
// The actual requirement is narrower than "before the imports": this
// assignment must run before any Date/Intl call in this file EXECUTES, not
// merely before any import STATEMENT. vitest registers every `describe`/
// `it` callback synchronously while this file's module body evaluates, but
// the callback BODIES — the only place a Date/Intl call in this file lives —
// run in a later phase, strictly after module evaluation (i.e. every
// top-level statement, including this one) has finished; `format.ts` itself
// has no top-level Date/Intl call either. So any top-level position for this
// assignment satisfies the real requirement — CONFIRMED, not assumed: moving
// it to after the imports below, and separately to the very last line of
// this file after every describe block, both stayed 37/37 green under
// ambient UTC. Position among top-level statements is NOT what makes this
// work; do not read the position of the line below as load-bearing.
//
// What WOULD break it: assigning `process.env.TZ` from INSIDE a test body
// (an `it()` callback) instead of at the top level. Test bodies run in that
// same later phase, in file order — a test declared BEFORE the assignment
// would already have executed its Date/Intl calls under whatever TZ was
// ambient before the assignment ran, unaffected by it. Never move this pin
// into a test.
//
// The one thing that WOULD invalidate "any top-level position is safe": a
// future top-level (module-evaluation-time, not inside a describe/it
// callback) Date/Intl call added ABOVE this assignment in this file. None
// exists today — if one is ever added, this assignment must move above it.
// @ts-expect-error process is not typed in browser context
process.env.TZ = 'Europe/Berlin';

import { describe, it, expect } from 'vitest';
import {
  formatNm,
  formatKn,
  formatLegNm,
  formatHeading,
  formatTime,
  formatDateTime,
  formatDuration,
  formatLegDuration,
  formatDriftMin,
  formatLatLon,
  formatSliderTime,
  parseHemisphereCoord,
  resolveHemisphereCoordCommit,
} from './format';

describe('formatNm', () => {
  it('formats with one decimal and unit suffix, English locale', () => {
    expect(formatNm(12.34, 'en')).toBe('12.3 nm');
  });

  it('rounds to one decimal, English locale', () => {
    expect(formatNm(0.05, 'en')).toBe('0.1 nm');
  });

  it('formats zero, English locale', () => {
    expect(formatNm(0, 'en')).toBe('0.0 nm');
  });

  // #525: German uses a decimal COMMA, not the point English/toFixed(1) emit.
  it('formats with a comma decimal separator in German', () => {
    expect(formatNm(12.34, 'de')).toBe('12,3 nm');
  });

  it('rounds to one decimal in German, comma separator', () => {
    expect(formatNm(0.05, 'de')).toBe('0,1 nm');
  });

  it('formats zero in German, comma separator', () => {
    expect(formatNm(0, 'de')).toBe('0,0 nm');
  });

  // `Intl.NumberFormat` groups by THOUSANDS by default (`useGrouping` is not
  // set here, so it defaults to `'auto'`) — a German value >= 1000 renders a
  // THOUSANDS-separator point alongside the decimal COMMA (e.g.
  // "1.234,5 nm"), the exact inverse of English's thousands-comma /
  // decimal-point pairing. Unreachable in-region today (SailCommand's whole
  // Flensburg Fjord / Danish South Sea planning area is well under 1000 nm
  // end to end), so no plan distance can trigger it — but a future region
  // change could, silently, without this pin. Verified via
  // `Intl.NumberFormat('de-DE', {...}).format(1234.5)`.
  it('groups by thousands for a value >= 1000 (unreachable in-region today, pinned for a future region change)', () => {
    expect(formatNm(1234.5, 'en')).toBe('1,234.5 nm');
    expect(formatNm(1234.5, 'de')).toBe('1.234,5 nm');
  });
});

describe('formatKn', () => {
  it('formats with one decimal and unit suffix, English locale', () => {
    expect(formatKn(6.5, 'en')).toBe('6.5 kn');
  });

  it('rounds to one decimal, English locale', () => {
    expect(formatKn(6.449, 'en')).toBe('6.4 kn');
  });

  it('formats with a comma decimal separator in German', () => {
    expect(formatKn(6.5, 'de')).toBe('6,5 kn');
  });

  it('rounds to one decimal in German, comma separator', () => {
    expect(formatKn(6.449, 'de')).toBe('6,4 kn');
  });
});

describe('formatLegNm', () => {
  // #439: the motivating case — two DISTINCT legs that round to the SAME
  // one-decimal formatNm output must render DIFFERENTLY at two decimals.
  it('distinguishes two legs that formatNm collapses to the same string', () => {
    expect(formatNm(0.5, 'en')).toBe('0.5 nm');
    expect(formatNm(0.549, 'en')).toBe('0.5 nm'); // same as above under formatNm
    expect(formatLegNm(0.5, 'en')).toBe('0.50 nm');
    expect(formatLegNm(0.549, 'en')).toBe('0.55 nm'); // now distinct
  });

  it('formats zero at two decimals, English locale', () => {
    expect(formatLegNm(0, 'en')).toBe('0.00 nm');
  });

  it('rounds to two decimals, English locale', () => {
    // NOT a round-half tie-break: 12.345 is not exactly representable as an
    // IEEE754 double, and the nearest representable value is
    // 12.345000000000000639... — strictly ABOVE 12.345 — so this rounds up
    // to 12.35 as an ordinary (non-tied) round, without exercising any
    // half-way rounding rule at all. Verified via
    // `(12.345).toPrecision(20)`.
    expect(formatLegNm(12.345, 'en')).toBe('12.35 nm');
  });

  // PR #590 review round 2: the case above deliberately does NOT exercise a
  // real half-way tie-break — 0.125 is the case that does. Unlike 12.345,
  // 0.125 (1/8) IS exactly representable as an IEEE754 double
  // (`(0.125).toPrecision(20)` === '0.12500000000000000000'), so this is a
  // genuine tie between 0.12 and 0.13, and `Intl.NumberFormat`'s default
  // rounding mode (`halfExpand`) rounds it away from zero, up to 0.13.
  it('rounds a genuine IEEE754-exact half-way tie up (halfExpand), English locale', () => {
    expect(formatLegNm(0.125, 'en')).toBe('0.13 nm');
  });

  it('formats with a comma decimal separator in German', () => {
    expect(formatLegNm(0.549, 'de')).toBe('0,55 nm');
  });

  it('formats zero at two decimals in German, comma separator', () => {
    expect(formatLegNm(0, 'de')).toBe('0,00 nm');
  });
});

describe('formatHeading', () => {
  it('pads single-digit degrees to three digits', () => {
    expect(formatHeading(5)).toBe('005°');
  });

  it('pads double-digit degrees to three digits', () => {
    expect(formatHeading(87)).toBe('087°');
  });

  it('does not pad three-digit degrees', () => {
    expect(formatHeading(342)).toBe('342°');
  });

  it('rounds fractional degrees', () => {
    expect(formatHeading(87.6)).toBe('088°');
  });

  it('normalizes 360 to 000', () => {
    expect(formatHeading(360)).toBe('000°');
  });

  it('normalizes negative degrees into 0..359', () => {
    expect(formatHeading(-10)).toBe('350°');
  });
});

describe('formatDuration', () => {
  it('formats hours and minutes, zero-padded', () => {
    expect(formatDuration(14700000)).toBe('4 h 05 min');
  });

  it('formats zero duration', () => {
    expect(formatDuration(0)).toBe('0 h 00 min');
  });

  it('formats sub-hour durations with a 0 h prefix', () => {
    expect(formatDuration(25 * 60 * 1000)).toBe('0 h 25 min');
  });

  it('rounds to the nearest minute', () => {
    expect(formatDuration(3661000)).toBe('1 h 01 min');
  });
});

describe('formatLegDuration', () => {
  it('formats zero duration without an hours prefix', () => {
    expect(formatLegDuration(0)).toBe('0 min');
  });

  it('rounds sub-minute durations up to the nearest minute (59 s)', () => {
    // Math.round(59_000 / 60_000) = Math.round(0.9833) = 1, not 0 — a
    // floor-based implementation would wrongly report "0 min" here.
    expect(formatLegDuration(59_000)).toBe('1 min');
  });

  it('formats a short manoeuvring leg with no hours prefix (47 min)', () => {
    // This is the motivating case: formatDuration(47 * 60_000) would render
    // "0 h 47 min", which reads as "basically nothing" for a 47-minute leg.
    expect(formatLegDuration(47 * 60_000)).toBe('47 min');
  });

  it('stays hours-free right up to the 60-minute tier boundary', () => {
    expect(formatLegDuration(59 * 60_000)).toBe('59 min');
  });

  it('crosses the tier boundary at exactly 60 minutes', () => {
    expect(formatLegDuration(60 * 60_000)).toBe('1 h 00 min');
  });

  it('formats just past the tier boundary, zero-padded', () => {
    expect(formatLegDuration(61 * 60_000)).toBe('1 h 01 min');
  });

  it('formats a multi-hour leg the same way formatDuration would', () => {
    expect(formatLegDuration(125 * 60_000)).toBe('2 h 05 min');
  });

  it('does not cap at 24 hours', () => {
    expect(formatLegDuration(25 * 60 * 60_000)).toBe('25 h 00 min');
  });
});

describe('formatDriftMin', () => {
  it('formats positive drift (behind schedule) with an explicit + sign', () => {
    expect(formatDriftMin(12 * 60_000)).toBe('+12 min');
  });

  it('formats negative drift (ahead of schedule) with a - sign', () => {
    expect(formatDriftMin(-10 * 60_000)).toBe('-10 min');
  });

  it('formats zero drift without a sign', () => {
    expect(formatDriftMin(0)).toBe('0 min');
  });

  it('rounds to the nearest minute', () => {
    expect(formatDriftMin(89_000)).toBe('+1 min'); // 1.48 min
    expect(formatDriftMin(-89_000)).toBe('-1 min');
  });

  it('rounds a sub-30s drift down to zero (no sign)', () => {
    expect(formatDriftMin(20_000)).toBe('0 min');
  });
});

describe('formatTime', () => {
  it('formats a padded 24-hour HH:MM in German', () => {
    const ms = new Date(2026, 6, 15, 14, 5).getTime();
    expect(formatTime(ms, 'de')).toBe('14:05');
  });

  it('formats a padded 24-hour HH:MM in English', () => {
    const ms = new Date(2026, 6, 15, 14, 5).getTime();
    expect(formatTime(ms, 'en')).toBe('14:05');
  });

  it('renders midnight as 00:00, not 24:00', () => {
    const ms = new Date(2026, 6, 15, 0, 0).getTime();
    expect(formatTime(ms, 'de')).toBe('00:00');
  });
});

describe('formatLatLon', () => {
  it('formats a NE point with three decimals and N/E suffixes', () => {
    expect(formatLatLon({ lat: 54.789, lon: 9.433 })).toBe('54.789°N 9.433°E');
  });

  it('formats a southern/western point with S/W suffixes', () => {
    expect(formatLatLon({ lat: -12.5, lon: -3.1 })).toBe('12.500°S 3.100°W');
  });

  it('treats exactly zero as N/E (non-negative)', () => {
    expect(formatLatLon({ lat: 0, lon: 0 })).toBe('0.000°N 0.000°E');
  });

  it('rounds to three decimals', () => {
    expect(formatLatLon({ lat: 54.78949, lon: 9.43349 })).toBe('54.789°N 9.433°E');
  });
});

// #886 residual 1: charts and almanacs write the hemisphere letter; this
// pins the parser accepting it back, and its axis-mismatch/sign-conflict
// rejections.
describe('parseHemisphereCoord', () => {
  it('parses a bare signed decimal with no letter (unchanged prior behaviour)', () => {
    expect(parseHemisphereCoord('54.8', 'lat')).toBe(54.8);
    expect(parseHemisphereCoord('-54.8', 'lat')).toBe(-54.8);
  });

  it('applies a positive hemisphere letter as-is', () => {
    expect(parseHemisphereCoord('54.8N', 'lat')).toBe(54.8);
    expect(parseHemisphereCoord('10.1E', 'lon')).toBe(10.1);
  });

  // MUTATION CHECK (non-vacuity): this is the row a broken sign-flip
  // (e.g. `letter === 'S' || letter === 'W' ? magnitude : -magnitude`,
  // the exact negation of the correct line) would red — the row above
  // (positive letters) stays green either way, since flipping "do nothing"
  // into "negate" only changes S/W.
  it('negates the magnitude for a negative hemisphere letter', () => {
    expect(parseHemisphereCoord('54.8S', 'lat')).toBe(-54.8);
    expect(parseHemisphereCoord('10.1W', 'lon')).toBe(-10.1);
  });

  it('is case-insensitive on the letter', () => {
    expect(parseHemisphereCoord('54.8s', 'lat')).toBe(-54.8);
  });

  it('tolerates a degree sign and/or whitespace before the letter', () => {
    expect(parseHemisphereCoord('54.8° N', 'lat')).toBe(54.8);
    expect(parseHemisphereCoord('54.8°S', 'lat')).toBe(-54.8);
  });

  it('treats zero as positive regardless of axis (matches formatLatLon)', () => {
    expect(parseHemisphereCoord('0N', 'lat')).toBe(0);
    expect(parseHemisphereCoord('0', 'lat')).toBe(0);
  });

  // #1086: `applyHemisphereSign` negates via `-magnitude` on BOTH the
  // negative-hemisphere-letter branch and the explicit-leading-minus branch —
  // over a zero magnitude that yields `-0`, and `Object.is(-0, 0)` is
  // `false` (Playwright's `toBe` uses `Object.is`, same as vitest's own
  // `toBe`), so a future assertion written the natural way would fail
  // silently on exactly this input. `.toBe(0)` above only ever exercises the
  // POSITIVE-zero spellings ('0N', a bare '0'); these rows are the
  // NEGATIVE-zero spellings the row above cannot reach: a negative letter
  // (S/W) and an explicit leading '-', each over a zero magnitude, plus the
  // same explicit-minus branch reached through the DM/DMS regex instead of
  // the decimal one. `.toBe(0)` (Object.is) is the load-bearing assertion
  // here — `toEqual`/`===` cannot tell `-0` from `0` and would pass on the
  // unfixed code too.
  //
  // MUTATION CHECK: reverting the `+ 0` normalisation in `applyHemisphereSign`
  // (both return sites) reds every row below with `Received: -0`.
  it('normalises -0 to +0 for a negative hemisphere letter over a zero magnitude', () => {
    expect(parseHemisphereCoord('0S', 'lat')).toBe(0);
    expect(parseHemisphereCoord('0W', 'lon')).toBe(0);
  });

  it('normalises -0 to +0 for an explicit leading minus over a zero magnitude', () => {
    expect(parseHemisphereCoord('-0', 'lat')).toBe(0);
    // Same branch (`isExplicitlyNegative` with no hemisphere letter), reached
    // via the DM/DMS regex ("degrees + minutes") instead of the plain
    // decimal one — a different input shape hitting the identical code path.
    expect(parseHemisphereCoord('-0 0', 'lat')).toBe(0);
  });

  // The axis-mismatch guard: E/W on a latitude field, N/S on a longitude
  // field, are BOTH rejected — neither axis accepts the other's letters.
  it('rejects a letter that belongs to the OTHER axis', () => {
    expect(parseHemisphereCoord('54.8E', 'lat')).toBeNull();
    expect(parseHemisphereCoord('54.8W', 'lat')).toBeNull();
    expect(parseHemisphereCoord('10.1N', 'lon')).toBeNull();
    expect(parseHemisphereCoord('10.1S', 'lon')).toBeNull();
  });

  it('rejects a letter outside N/S/E/W entirely', () => {
    expect(parseHemisphereCoord('54.8Q', 'lat')).toBeNull();
  });

  // Deliberate rejection: an explicit '-' sign combined with a hemisphere
  // letter is self-contradictory ("-54.8N" — which one wins?), so this
  // parser refuses rather than silently pick a convention.
  it('rejects a sign+letter conflict rather than guessing', () => {
    expect(parseHemisphereCoord('-54.8N', 'lat')).toBeNull();
    expect(parseHemisphereCoord('-10.1E', 'lon')).toBeNull();
  });

  it('rejects garbage and empty input', () => {
    expect(parseHemisphereCoord('', 'lat')).toBeNull();
    expect(parseHemisphereCoord('   ', 'lat')).toBeNull();
    expect(parseHemisphereCoord('abc', 'lat')).toBeNull();
    expect(parseHemisphereCoord('54.8NN', 'lat')).toBeNull();
  });

  // #1005: decimal-comma degrees, alongside the existing decimal-point form.
  // Hand-derived: '54,8' names the same magnitude as '54.8' (tested above),
  // just with the German locale's decimal separator instead of the point.
  describe('decimal comma as the decimal separator', () => {
    it('accepts a bare comma-decimal degree value', () => {
      expect(parseHemisphereCoord('54,8', 'lat')).toBeCloseTo(54.8, 9);
      expect(parseHemisphereCoord('-54,8', 'lat')).toBeCloseTo(-54.8, 9);
    });

    it('accepts a comma-decimal degree value with a hemisphere letter', () => {
      expect(parseHemisphereCoord('54,8S', 'lat')).toBeCloseTo(-54.8, 9);
      expect(parseHemisphereCoord('10,1E', 'lon')).toBeCloseTo(10.1, 9);
    });
  });

  // #1005: degrees + decimal minutes ("54° 48.74'") and degrees + minutes +
  // seconds ("54° 48' 44.4\""), the forms a marine GPS or almanac actually
  // displays. Every expected value below is HAND-DERIVED from the DM/DMS
  // definition (degrees + minutes/60 + seconds/3600), not copied from the
  // implementation's own output:
  //   54° 48.74'        = 54 + 48.74/60        = 54 + 0.81233333... = 54.81233333...
  //   54° 48' 44"        = 54 + 48/60 + 44/3600  = 54.8 + 0.01222222... = 54.81222222...
  //   54° 48' 44.4" N    = 54 + 48/60 + 44.4/3600 = 54.8 + 0.01233333... = 54.81233333...
  // (44.4" is exactly 0.74' expressed in seconds — 0.74 * 60 = 44.4 — so the
  // DM and DMS forms of the SAME angle land on the same value; that
  // agreement is itself part of what a mutated seconds/minutes term would
  // break, per the mutation check below.)
  describe('degrees + minutes, and degrees + minutes + seconds', () => {
    it('parses degrees + decimal minutes with no symbols', () => {
      expect(parseHemisphereCoord('54 48.74', 'lat')).toBeCloseTo(54.812333333, 8);
    });

    it('parses degrees + decimal minutes with degree/minute marks', () => {
      expect(parseHemisphereCoord("54° 48.74'", 'lat')).toBeCloseTo(54.812333333, 8);
    });

    it('parses degrees + decimal minutes with a trailing hemisphere letter', () => {
      expect(parseHemisphereCoord("54 48.74' N", 'lat')).toBeCloseTo(54.812333333, 8);
      expect(parseHemisphereCoord("54 48.74' S", 'lat')).toBeCloseTo(-54.812333333, 8);
    });

    it('parses degrees + minutes + whole seconds with no symbols', () => {
      expect(parseHemisphereCoord('54 48 44', 'lat')).toBeCloseTo(54.812222222, 8);
    });

    it('parses degrees + minutes + whole seconds with degree/minute/second marks', () => {
      expect(parseHemisphereCoord('54° 48\' 44"', 'lat')).toBeCloseTo(54.812222222, 8);
    });

    it('parses degrees + minutes + decimal seconds with a trailing hemisphere letter', () => {
      expect(parseHemisphereCoord('54° 48\' 44.4" N', 'lat')).toBeCloseTo(54.812333333, 8);
    });

    it('accepts a comma as the decimal separator inside minutes', () => {
      expect(parseHemisphereCoord("54° 48,74'", 'lat')).toBeCloseTo(54.812333333, 8);
    });

    it('accepts degrees + decimal minutes for the longitude axis', () => {
      // 9 + 25.5/60 = 9 + 0.425 = 9.425 exactly.
      expect(parseHemisphereCoord('9 25.5', 'lon')).toBeCloseTo(9.425, 9);
      expect(parseHemisphereCoord("9° 25.5' E", 'lon')).toBeCloseTo(9.425, 9);
    });

    it('rejects a DM hemisphere letter that belongs to the OTHER axis', () => {
      expect(parseHemisphereCoord("54 48.74' E", 'lat')).toBeNull();
      expect(parseHemisphereCoord("10 25.5' N", 'lon')).toBeNull();
    });

    // Real marine GPS units and almanacs (and a paste from a PDF) commonly
    // render the typographically correct PRIME (U+2032 ′) and DOUBLE PRIME
    // (U+2033 ″) rather than the ASCII apostrophe/quote — accepted as
    // equivalent. Expected values are the SAME as the ASCII-mark rows above
    // (same angle, different mark), which is itself part of the check: this
    // isn't a new numeric path, only a wider set of separator characters.
    it('accepts the Unicode PRIME/DOUBLE PRIME minute/second marks', () => {
      expect(parseHemisphereCoord('54° 48′ 44″', 'lat')).toBeCloseTo(54.812222222, 8);
      expect(parseHemisphereCoord('54° 48′ 44.4″ N', 'lat')).toBeCloseTo(54.812333333, 8);
    });
  });

  // #1005 safety-critical negative cases: a widened parser must still reject
  // garbage rather than silently returning a wrong number. Each row below
  // is a distinct way the DM/DMS shape can be malformed or out of range.
  describe('DM/DMS range and shape rejections', () => {
    // MUTATION CHECK (non-vacuity): removing the `minInt >= 60` guard makes
    // this row return a (wrong) number instead of null — see the report for
    // the measured red/green transition.
    it('rejects minutes >= 60', () => {
      expect(parseHemisphereCoord('54 61.5', 'lat')).toBeNull();
      expect(parseHemisphereCoord('54 60.0', 'lat')).toBeNull();
    });

    // MUTATION CHECK (non-vacuity): removing the `secondsValue >= 60` guard
    // makes this row return a (wrong) number instead of null.
    it('rejects seconds >= 60', () => {
      expect(parseHemisphereCoord('54 48 75', 'lat')).toBeNull();
      expect(parseHemisphereCoord('54 48 60', 'lat')).toBeNull();
    });

    it('rejects non-numeric garbage', () => {
      expect(parseHemisphereCoord('abc', 'lat')).toBeNull();
    });

    it('rejects a second decimal point that makes the shape ambiguous', () => {
      expect(parseHemisphereCoord('54 48.74.5', 'lat')).toBeNull();
    });

    it('rejects empty input', () => {
      expect(parseHemisphereCoord('', 'lat')).toBeNull();
    });

    it('rejects a lone hemisphere letter with no numeric part', () => {
      expect(parseHemisphereCoord('N', 'lat')).toBeNull();
    });

    // MUTATION CHECK (non-vacuity): removing the
    // `minFrac !== undefined && secInt !== undefined` conflict guard makes
    // this row return a (wrong) number instead of null — decimal minutes
    // AND a separate seconds field is a self-contradictory shape (are the
    // decimal minutes already inclusive of the seconds, or not?), so it is
    // rejected rather than guessed at, the same policy this file already
    // applies to a sign+letter conflict.
    it('rejects decimal minutes combined with a separate seconds field', () => {
      expect(parseHemisphereCoord('54 48.5 44', 'lat')).toBeNull();
    });

    // MAJOR fix-wave 1: a degrees string long enough overflows `Number()`
    // to `Infinity` rather than throwing, and `degreesMagnitude +
    // totalMinutes / 60` inherits that `Infinity`. Unguarded, this is the
    // hazard class the whole parser exists to avoid: NOT rejected input,
    // but a plausible-looking (though impossible) coordinate that
    // `resolveHemisphereCoordCommit` would then CLAMP to the axis boundary
    // and report 'clamped' -- "valid, just out of range" -- when it was
    // actually unparseable garbage. `finiteMagnitudeOrNull` closes this on
    // the FINAL combined magnitude, so it protects the sum regardless of
    // which term would have overflowed it.
    //
    // MUTATION CHECK (non-vacuity): removing the `finiteMagnitudeOrNull`
    // guard on the DM/DMS branch turns the degrees-overflow row's result
    // from `null` into `Infinity` -- see the report for the measured
    // red/green transition, confirmed at BASE (the guard did not exist
    // there either, so this exact input already returned `Infinity` on
    // the pre-fix-wave tree) as well as at HEAD.
    it('rejects a degrees-position overflow (returns null, not Infinity)', () => {
      expect(parseHemisphereCoord(`${'9'.repeat(400)} 48.74`, 'lat')).toBeNull();
    });

    // The minutes and seconds CAPTURE GROUPS in `DM_DMS_RE` are limited to
    // 1-2 digits each (`\d{1,2}`), so `Number()` on either can never exceed
    // 99 and therefore can never overflow to `Infinity` -- an "overflowing"
    // minutes or seconds string is rejected because the REGEX doesn't match
    // at all, not because of `finiteMagnitudeOrNull`. Pinned anyway as
    // defense-in-depth (the whole input must still come back `null`, for
    // whichever reason), and to record explicitly that these two positions
    // are NOT a second way to reach the finiteness guard -- degrees is the
    // only reachable overflow vector in this parser today.
    it('rejects an overflowing minutes or seconds position (regex-length-capped, not the finiteness guard)', () => {
      expect(parseHemisphereCoord(`54 ${'9'.repeat(400)}.74`, 'lat')).toBeNull();
      expect(parseHemisphereCoord(`54 48 ${'9'.repeat(400)}`, 'lat')).toBeNull();
    });
  });
});

describe('resolveHemisphereCoordCommit', () => {
  it('commits a valid in-range value with no correction', () => {
    expect(resolveHemisphereCoordCommit('54.8N', 10, -90, 90, 'lat')).toEqual({
      next: 54.8,
      correction: null,
    });
  });

  it('clamps an out-of-range value and reports "clamped"', () => {
    expect(resolveHemisphereCoordCommit('95', 10, -90, 90, 'lat')).toEqual({
      next: 90,
      correction: 'clamped',
    });
  });

  // A hemisphere letter can push an in-range MAGNITUDE out of range once
  // the sign is applied — e.g. entering the southern letter for a value
  // whose magnitude alone would have been fine.
  it('clamps a value that only goes out of range AFTER the hemisphere sign is applied', () => {
    expect(resolveHemisphereCoordCommit('95S', 10, -90, 90, 'lat')).toEqual({
      next: -90,
      correction: 'clamped',
    });
  });

  // MUTATION CHECK (non-vacuity): reverts to lastCommitted, not 0 or the
  // unparsed string coerced to a number — a mutant returning
  // `{ next: 0, correction: 'invalid' }` would red this row (0 !== 10)
  // while every other row here is silent about what "reverted" resolves
  // to.
  it('reverts to lastCommitted and reports "invalid" for unparseable input', () => {
    expect(resolveHemisphereCoordCommit('garbage', 10, -90, 90, 'lat')).toEqual({
      next: 10,
      correction: 'invalid',
    });
  });

  it('reverts and reports "invalid" for an axis-mismatched letter', () => {
    expect(resolveHemisphereCoordCommit('54.8E', 10, -90, 90, 'lat')).toEqual({
      next: 10,
      correction: 'invalid',
    });
  });

  // REVIEW FIX WAVE (MAJOR): an EMPTIED field is a distinct user intent from
  // unparseable garbage — clearing a field is deliberate, typing `nope` is a
  // mistake — and must revert SILENTLY (correction: null), never report
  // 'invalid'. `parseHemisphereCoord` itself returns `null` for both empty
  // and garbage (asserted in that describe block above), so this pair pins
  // that the DISTINCTION is made one layer up, in this function, not in the
  // parser.
  // MUTATION CHECK (non-vacuity): removing the `draft.trim() === ''` early
  // return above (so an empty draft falls through to
  // `parseHemisphereCoord`, which also returns null for '') makes this row
  // red with `Received: {"next": 10, "correction": "invalid"}` while the
  // "reverts to lastCommitted and reports 'invalid' for unparseable input"
  // row above stays green — the mutation is isolated to exactly the empty
  // case, not to unparseable input in general.
  it('reverts SILENTLY (no correction) when the draft is empty', () => {
    expect(resolveHemisphereCoordCommit('', 10, -90, 90, 'lat')).toEqual({
      next: 10,
      correction: null,
    });
  });

  it('reverts SILENTLY (no correction) when the draft is only whitespace', () => {
    expect(resolveHemisphereCoordCommit('   ', 10, -90, 90, 'lat')).toEqual({
      next: 10,
      correction: null,
    });
  });

  // MAJOR fix-wave 1: this is the USER-VISIBLE half of the DM/DMS overflow
  // guard, and the part that actually matters. Before the fix,
  // `parseHemisphereCoord` returned `Infinity` for this input, and this
  // function's `Math.min(max, Math.max(min, parsed))` clamp turned that
  // into `{ next: 90, correction: 'clamped' }` -- "your entry was a valid
  // coordinate, just out of range" -- for what was actually unparseable
  // garbage. Pinned here, not only on the parser, because 'clamped' vs
  // 'invalid' is the message a captain actually sees.
  it('reports "invalid", not "clamped", for a DM/DMS degrees-position overflow', () => {
    expect(resolveHemisphereCoordCommit(`${'9'.repeat(400)} 48.74`, 10, -90, 90, 'lat')).toEqual({
      next: 10,
      correction: 'invalid',
    });
  });
});

describe('formatSliderTime', () => {
  // Two different guarantees are in play below, and they are NOT the same
  // property -- do not read one as implying the other.
  //
  // The tier tests (1/2/3 describe blocks just below, non-DST) build BOTH
  // their input timestamp AND their expected string from the SAME local-time
  // `Date` constructor (`new Date(y, m, d, h, min)`), never from a fixed UTC
  // instant. That makes them genuinely zone-AGNOSTIC: whatever the ambient
  // ICU zone is, the input and the expectation are computed IN that same
  // zone, so they agree regardless of which zone it is. These tests would
  // pass under this file's Europe/Berlin pin, under UTC, or under any other
  // zone, unchanged.
  //
  // The "DST transitions" describe block further down is DELIBERATELY THE
  // OPPOSITE: it hand-derives literals (`'02:00'`, `'30. März 00:30'`, etc.)
  // for SPECIFIC Europe/Berlin 2026 transition instants, so those literals
  // are only correct under Europe/Berlin specifically -- they are
  // zone-SPECIFIC by design, not zone-agnostic, and depend entirely on the
  // file-level `process.env.TZ = 'Europe/Berlin'` pin at the top of this
  // file. A PREVIOUS version of this comment claimed "stable regardless of
  // the host/CI machine's timezone offset" for the whole describe block --
  // that was true only for the tier tests and FALSE for the DST tests, and
  // this file shipped without the pin as a result: CI (UTC) and this
  // author's dev sandbox (Europe/Berlin) produced different DST-test
  // results until the pin was added. Do not delete the pin as
  // "unnecessary", and do not add a new zone-specific literal here without
  // either deriving it the tier-test way (input and expectation from the
  // same local `Date` call) or relying on the pin the DST tests already use.

  describe('tier 1: today-only forecast -> bare HH:MM', () => {
    it('renders bare HH:MM when every slider hour AND now fall on the same calendar day (#292)', () => {
      const now = new Date(2026, 7, 4, 18, 0).getTime(); // Tue 04 Aug 2026, 18:00 (= departure)
      const departure = now;
      const selected = new Date(2026, 7, 4, 21, 0).getTime(); // same day, 21:00
      const hourOptions = [
        departure,
        new Date(2026, 7, 4, 19, 0).getTime(),
        new Date(2026, 7, 4, 20, 0).getTime(),
        selected,
        new Date(2026, 7, 4, 22, 0).getTime(),
      ];
      expect(formatSliderTime(selected, hourOptions, 'de', now)).toBe('21:00');
      expect(formatSliderTime(selected, hourOptions, 'en', now)).toBe('21:00');
    });
  });

  describe('tier 2: within 6 calendar days of now -> short weekday + time', () => {
    it('prefixes a short locale weekday once the slider hours cross midnight (#292)', () => {
      const now = new Date(2026, 7, 4, 22, 0).getTime(); // Tue 04 Aug 2026, 22:00 (= departure)
      const departure = now;
      const selected = new Date(2026, 7, 5, 3, 0).getTime(); // Wed 05 Aug 2026, 03:00
      const hourOptions = [departure, new Date(2026, 7, 4, 23, 0).getTime(), selected];
      // 05 Aug 2026 is a Wednesday -- "Mi" (de) / "Wed" (en) hand-derived
      // from the calendar, not from Intl output re-fed into the assertion.
      expect(formatSliderTime(selected, hourOptions, 'de', now)).toBe('Mi 03:00');
      expect(formatSliderTime(selected, hourOptions, 'en', now)).toBe('Wed 03:00');
    });

    it('still prefixes the weekday for an hour ON the departure day once the range spans midnight (#292)', () => {
      // The day indicator is driven by whether the WHOLE hourOptions range
      // spans multiple days, not by whether this particular hour differs
      // from the first entry -- so the departure-day hour itself also gets
      // the weekday prefix once a later hour crosses into the next day.
      // This keeps the label's width/shape constant as the user drags.
      const now = new Date(2026, 7, 4, 22, 0).getTime(); // Tue 04 Aug 2026, 22:00
      const departure = now;
      const nextDay = new Date(2026, 7, 5, 3, 0).getTime(); // Wed 05 Aug 2026, 03:00
      const hourOptions = [departure, nextDay];
      expect(formatSliderTime(departure, hourOptions, 'de', now)).toBe('Di 22:00');
      expect(formatSliderTime(departure, hourOptions, 'en', now)).toBe('Tue 22:00');
    });

    it('Major fix (#292): a stale single-day plan within 6 days still gets a weekday, not bare time', () => {
      // The bug this closes: the OLD implementation only compared calendar
      // days WITHIN hourOptions, so a saved plan whose entire stored
      // windGrid sits on a single day rendered bare HH:MM forever, even
      // days after the plan was computed -- exactly the "03:00 tonight vs
      // 03:00 three days ago" ambiguity #292's own issue text names as a
      // second, compounding case alongside the midnight-crossing one.
      const now = new Date(2026, 7, 4, 12, 0).getTime(); // Tue 04 Aug 2026 (today)
      const staleHour = new Date(2026, 7, 1, 8, 0).getTime(); // Sat 01 Aug 2026, 08:00
      const staleNoon = new Date(2026, 7, 1, 14, 0).getTime(); // Sat 01 Aug 2026, 14:00 -- selected
      // Both hourOptions entries sit on Sat 01 Aug 2026 alone (a plan
      // computed and saved 3 days before `now`); the OLD code's
      // hourOptions-only comparison would call this "single day" and print
      // bare "14:00". Sat 01 Aug 2026 is 3 calendar days before Tue 04 Aug
      // 2026, hand-counted: Sat(01) -> Sun(02) -> Mon(03) -> Tue(04).
      const hourOptions = [staleHour, staleNoon];
      // 01 Aug 2026 is a Saturday -- "Sa" (de) / "Sat" (en) hand-derived
      // from the calendar.
      expect(formatSliderTime(staleNoon, hourOptions, 'de', now)).toBe('Sa 14:00');
      expect(formatSliderTime(staleNoon, hourOptions, 'en', now)).toBe('Sat 14:00');
    });
  });

  describe('tier 3: more than 6 calendar days from now -> short date + time', () => {
    it('Major fix (#292): a stale single-day plan beyond 6 days gets a short date, not a weekday', () => {
      // A bare weekday cannot disambiguate "Monday this week" from "Monday
      // three weeks ago" -- the whole point of this tier. 20 Jul 2026 is a
      // Monday, hand-counted 15 calendar days before 04 Aug 2026 (Jul has
      // 31 days: 20->31 is 11 days, plus 4 days into August = 15).
      const now = new Date(2026, 7, 4, 12, 0).getTime(); // Tue 04 Aug 2026
      const staleMs = new Date(2026, 6, 20, 14, 0).getTime(); // Mon 20 Jul 2026, 14:00
      const hourOptions = [staleMs];
      expect(formatSliderTime(staleMs, hourOptions, 'de', now)).toBe('20. Juli 14:00');
      expect(formatSliderTime(staleMs, hourOptions, 'en', now)).toBe('20 Jul 14:00');
    });
  });

  describe('DST transitions (Europe/Berlin, 2026) -- calendar-day arithmetic, never fixed 24h', () => {
    it('spring-forward 23h day (2026-03-29): hours either side of the skipped 02:00-03:00 stay tier 1', () => {
      const now = new Date(2026, 2, 29, 12, 0).getTime(); // Sun 29 Mar 2026, 12:00 (post-transition)
      const before = new Date(2026, 2, 29, 1, 30).getTime(); // 01:30 CET, pre-transition
      const after = new Date(2026, 2, 29, 4, 0).getTime(); // 04:00 CEST, post-transition
      const hourOptions = [before, after];
      // Both instants are still 29 Mar 2026 in local wall-clock terms
      // despite the day itself being only 23 real hours -- tier 1 (bare
      // time) must hold for both, not fall through to tier 2 as it would
      // if day comparison used elapsed-ms/24h arithmetic instead of civil
      // Y/M/D.
      expect(formatSliderTime(after, hourOptions, 'de', now)).toBe('04:00');
      expect(formatSliderTime(after, hourOptions, 'en', now)).toBe('04:00');
    });

    it('fall-back 25h day (2026-10-25): both occurrences of the repeated 02:00 stay tier 1', () => {
      const now = new Date(2026, 9, 25, 12, 0).getTime(); // Sun 25 Oct 2026, 12:00
      const firstTwoAm = Date.parse('2026-10-25T00:00:00Z'); // 02:00 CEST (first occurrence)
      const secondTwoAm = Date.parse('2026-10-25T01:00:00Z'); // 02:00 CET (second occurrence)
      const hourOptions = [firstTwoAm, secondTwoAm, now];
      // The fall-back day is 25 real hours long and contains 02:00 TWICE
      // (once before the fold, once after); both instants are still one
      // calendar day, 25 Oct 2026, so both must render bare "02:00".
      expect(formatSliderTime(firstTwoAm, hourOptions, 'de', now)).toBe('02:00');
      expect(formatSliderTime(secondTwoAm, hourOptions, 'de', now)).toBe('02:00');
      expect(formatSliderTime(firstTwoAm, hourOptions, 'en', now)).toBe('02:00');
      expect(formatSliderTime(secondTwoAm, hourOptions, 'en', now)).toBe('02:00');
    });

    it('the 6-day tier boundary is a calendar-day count, not a fixed 6*24h window, across spring-forward', () => {
      // Construct the exact discrepancy a naive `Math.abs(ms - now) <=
      // 6 * 86_400_000` check would get wrong: `now` sits 4.5 hours before
      // midnight, and adding exactly 6*24h of RAW elapsed milliseconds
      // crosses the 2026-03-29 spring-forward, which loses an hour --
      // pushing the wall-clock landing time past midnight into a 7th
      // calendar day (Mon 23 Mar 2026, 23:30 -> Mon 30 Mar 2026, 00:30).
      // A raw-ms check would see 6*86_400_000 exactly and call this tier 2
      // (in range); the correct civil-day count is 7, which must fall
      // through to tier 3.
      const now = new Date(2026, 2, 23, 23, 30).getTime(); // Mon 23 Mar 2026, 23:30
      const ms = now + 6 * 86_400_000; // raw +6*24h, lands Mon 30 Mar 2026, 00:30 CEST
      const hourOptions = [ms];
      expect(formatSliderTime(ms, hourOptions, 'de', now)).toBe('30. März 00:30');
      expect(formatSliderTime(ms, hourOptions, 'en', now)).toBe('30 Mar 00:30');
    });
  });
});

describe('formatDateTime', () => {
  it('formats DD.MM.YYYY, HH:MM for German', () => {
    const ms = new Date(2026, 0, 5, 9, 5).getTime();
    expect(formatDateTime(ms, 'de')).toBe('05.01.2026, 09:05');
  });

  it('formats DD/MM/YYYY, HH:MM for English', () => {
    const ms = new Date(2026, 0, 5, 9, 5).getTime();
    expect(formatDateTime(ms, 'en')).toBe('05/01/2026, 09:05');
  });
});
