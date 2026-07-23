import { describe, it, expect } from 'vitest';
import { isValidMmsi } from './mmsi';

describe('isValidMmsi', () => {
  it('accepts exactly nine decimal digits', () => {
    expect(isValidMmsi('211234560')).toBe(true);
  });

  it('accepts nine digits with significant leading zeros (coast-station form)', () => {
    expect(isValidMmsi('002110000')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidMmsi('')).toBe(false);
  });

  it('rejects eight digits (too short)', () => {
    expect(isValidMmsi('21123456')).toBe(false);
  });

  it('rejects ten digits (too long)', () => {
    expect(isValidMmsi('2112345601')).toBe(false);
  });

  it('rejects non-digit characters', () => {
    expect(isValidMmsi('21123456a')).toBe(false);
  });

  it('rejects embedded whitespace', () => {
    expect(isValidMmsi('211 234 56')).toBe(false);
  });
});
