import { describe, it, expect } from 'vitest';
import { formatNm, formatKn, formatHeading, formatTime, formatDateTime, formatDuration } from './format';

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
