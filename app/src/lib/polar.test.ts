import { describe, expect, it } from 'vitest';
import { Polar } from './polar';
import { TEST_POLAR } from '../test/fixtures';

describe('Polar', () => {
  const p = new Polar(TEST_POLAR, 1.0);

  it('returns exact grid values at grid points', () => {
    expect(p.speedKn(90, 12)).toBeCloseTo(7.2, 5);
    expect(p.speedKn(180, 4)).toBeCloseTo(1.6, 5);
  });

  it('is symmetric in signed TWA', () => {
    expect(p.speedKn(-90, 12)).toBeCloseTo(p.speedKn(90, 12), 10);
  });

  it('bilinearly interpolates between grid points', () => {
    // midway 90..120 TWA, 12..16 TWS: mean of 7.2, 8.2, 7.0, 8.4 = 7.7
    expect(p.speedKn(105, 14)).toBeCloseTo(7.7, 5);
  });

  it('clamps TWS above table max and scales below min', () => {
    expect(p.speedKn(90, 30)).toBeCloseTo(8.6, 5);
    expect(p.speedKn(90, 2)).toBeCloseTo(3.0 * (2 / 4), 5);
    expect(p.speedKn(90, 0)).toBe(0);
  });

  it('tapers to zero inside the no-go zone', () => {
    expect(p.speedKn(0, 12)).toBe(0);
    expect(p.speedKn(20, 12)).toBeCloseTo(5.5 * (20 / 40), 5);
    expect(p.speedKn(40, 12)).toBeCloseTo(5.5, 5);
  });

  it('applies the performance factor', () => {
    const p09 = new Polar(TEST_POLAR, 0.9);
    expect(p09.speedKn(90, 12)).toBeCloseTo(7.2 * 0.9, 5);
  });

  it('interpolates beat and gybe angles over TWS', () => {
    expect(p.beatAngleDeg(4)).toBeCloseTo(47, 5);
    expect(p.beatAngleDeg(6)).toBeCloseTo(45.5, 5);
    expect(p.beatAngleDeg(99)).toBeCloseTo(40, 5);
    expect(p.gybeAngleDeg(12)).toBeCloseTo(165, 5);
  });

  it('clamps beat and gybe angles below the table TWS minimum', () => {
    expect(p.beatAngleDeg(1)).toBeCloseTo(47, 5); // below min (4) clamps to the first table entry
    expect(p.gybeAngleDeg(1)).toBeCloseTo(150, 5);
  });

  it('clamps gybe angle above the table TWS maximum', () => {
    expect(p.gybeAngleDeg(99)).toBeCloseTo(175, 5);
  });
});
