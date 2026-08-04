// TZ pinned BEFORE any other import (matching PlannerPanel.dst.test.tsx's
// convention): the DST-transition tests below hand-derive expected strings
// for specific Europe/Berlin wall-clock instants, so they are only
// deterministic if formatSliderTime's ambient Date/Intl timezone is fixed
// to that same zone regardless of the host/CI machine's own TZ (measured:
// CI runs UTC, this repo's dev sandbox runs Europe/Berlin, and the two
// disagree by exactly the DST offset — reproduced locally with `TZ=UTC npm
// --prefix app run test -- src/lib/format.test.ts`). Assigning
// `process.env.TZ` LATER (e.g. inside a test body) does not reliably
// re-anchor Node's already-initialized Intl/Date internals; setting it here,
// before `vitest`/`./format` are imported, is what makes it take effect for
// the whole file. Every other test in this file (formatTime, formatDateTime,
// the non-DST formatSliderTime tiers) already builds both its input AND its
// expected string from the SAME local-time `Date` constructor, so those stay
// correct under any TZ this pin could plausibly be — this only makes the
// DST-specific hand-derived literals stop depending on which machine runs
// them.
// @ts-expect-error process is not typed in browser context
process.env.TZ = 'Europe/Berlin';

import { describe, it, expect } from 'vitest';
import {
  formatNm,
  formatKn,
  formatHeading,
  formatTime,
  formatDateTime,
  formatDuration,
  formatDriftMin,
  formatLatLon,
  formatSliderTime,
} from './format';

describe('formatNm', () => {
  it('formats with one decimal and unit suffix', () => {
    expect(formatNm(12.34)).toBe('12.3 nm');
  });

  it('rounds to one decimal', () => {
    expect(formatNm(0.05)).toBe('0.1 nm');
  });

  it('formats zero', () => {
    expect(formatNm(0)).toBe('0.0 nm');
  });
});

describe('formatKn', () => {
  it('formats with one decimal and unit suffix', () => {
    expect(formatKn(6.5)).toBe('6.5 kn');
  });

  it('rounds to one decimal', () => {
    expect(formatKn(6.449)).toBe('6.4 kn');
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
