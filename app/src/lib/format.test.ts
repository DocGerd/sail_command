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
  // All timestamps below use the local-time Date constructor (matching
  // formatTime/formatDateTime and the other tests in this file), so
  // calendar-day comparisons are stable regardless of the host/CI machine's
  // timezone offset -- both the "day" input and the formatter interpret the
  // same instant in the same local zone.
  it('renders bare HH:MM when every slider hour falls on the same calendar day (#292)', () => {
    const departure = new Date(2026, 7, 4, 18, 0).getTime(); // Tue 04 Aug 2026, 18:00
    const selected = new Date(2026, 7, 4, 21, 0).getTime(); // same day, 21:00
    const hourOptions = [
      departure,
      new Date(2026, 7, 4, 19, 0).getTime(),
      new Date(2026, 7, 4, 20, 0).getTime(),
      selected,
      new Date(2026, 7, 4, 22, 0).getTime(),
    ];
    expect(formatSliderTime(selected, hourOptions, 'de')).toBe('21:00');
    expect(formatSliderTime(selected, hourOptions, 'en')).toBe('21:00');
  });

  it('prefixes a short locale weekday once the slider hours cross midnight (#292)', () => {
    const departure = new Date(2026, 7, 4, 22, 0).getTime(); // Tue 04 Aug 2026, 22:00
    const selected = new Date(2026, 7, 5, 3, 0).getTime(); // Wed 05 Aug 2026, 03:00
    const hourOptions = [departure, new Date(2026, 7, 4, 23, 0).getTime(), selected];
    // 05 Aug 2026 is a Wednesday -- "Mi" (de) / "Wed" (en) hand-derived from
    // the calendar, not from Intl output re-fed into the assertion.
    expect(formatSliderTime(selected, hourOptions, 'de')).toBe('Mi 03:00');
    expect(formatSliderTime(selected, hourOptions, 'en')).toBe('Wed 03:00');
  });

  it('still prefixes the weekday for an hour ON the first (departure) day once the range spans midnight (#292)', () => {
    // The day indicator is driven by whether the WHOLE hourOptions range
    // spans multiple days, not by whether this particular hour differs from
    // the first entry -- so the departure-day hour itself also gets the
    // weekday prefix once a later hour crosses into the next day. This
    // keeps the label's width/shape constant as the user drags the slider.
    const departure = new Date(2026, 7, 4, 22, 0).getTime(); // Tue 04 Aug 2026, 22:00
    const nextDay = new Date(2026, 7, 5, 3, 0).getTime(); // Wed 05 Aug 2026, 03:00
    const hourOptions = [departure, nextDay];
    expect(formatSliderTime(departure, hourOptions, 'de')).toBe('Di 22:00');
    expect(formatSliderTime(departure, hourOptions, 'en')).toBe('Tue 22:00');
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
