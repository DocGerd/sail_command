import { describe, it, expect } from 'vitest';
import {
  ceilToDecimetre,
  defaultSafetyDepthM,
  minSafetyDepthM,
  relaxationFloorM,
} from './boatDepth';
import { MASK_TOLERANCE_M } from './mask';
import { boatById } from '../data/boats';

const boat = (draftM: number) => ({
  id: 'x',
  name: 'X',
  draftM,
  motorSpeedKn: 6.5,
  maneuverPenaltyS: 45,
  sails: [],
});

describe('ceilToDecimetre', () => {
  it('rounds UP, never to nearest', () => {
    expect(ceilToDecimetre(1.73)).toBe(1.8); // Math.round would give 1.7
    expect(ceilToDecimetre(2.25)).toBe(2.3);
  });

  it('leaves an exact decimetre alone despite float error', () => {
    expect(ceilToDecimetre(2.1)).toBe(2.1);
    expect(ceilToDecimetre(3.0)).toBe(3.0);
  });
});

describe('derived gates', () => {
  it('derives the default gate as ceil to decimetre of draft + tolerance', () => {
    expect(defaultSafetyDepthM(boat(2.1))).toBe(3.0); // today's DEFAULT_SETTINGS value
    expect(defaultSafetyDepthM(boat(1.73))).toBe(2.7);
    expect(defaultSafetyDepthM(boat(2.3))).toBe(3.2);
  });

  it('satisfies the C.3 invariant for every derived gate', () => {
    // 2.05 is the ONLY draft in [1.00, 4.00] (0.01 steps) where this invariant
    // discriminates a Math.round quantiser from Math.ceil — every other draft
    // listed here passes under Math.round too. MEASURED 2026-08-14.
    for (const d of [1.6, 1.73, 1.9, 2.0, 2.05, 2.1, 2.25, 2.3, 2.8]) {
      const g = defaultSafetyDepthM(boat(d));
      expect(Math.round((g - MASK_TOLERANCE_M) * 10)).toBeGreaterThanOrEqual(Math.round(d * 10));
    }
  });

  it('sets the UI minimum to draft + 0.1 (OQ-1), reproducing today for the Salona 45', () => {
    expect(minSafetyDepthM(boatById('salona-45'))).toBe(2.2);
  });

  it('quantises the relaxation floor UP, so it is never under the keel', () => {
    expect(relaxationFloorM(boatById('salona-45'))).toBe(2.1);
    expect(relaxationFloorM(boat(1.73))).toBe(1.8); // NOT 1.7
  });

  it('keeps the relaxation window exactly T wide for every boat (C.4c)', () => {
    // This is an identity for ANY decimetre quantiser: T is exactly 9 dm, so
    // Q(d+0.9) - Q(d) = 9 whether Q is ceil, round or floor. It does not pin
    // the rounding DIRECTION — that is pinned by the exact-value 1.73 m rows
    // above ("rounds UP, never to nearest" / "NOT 1.7").
    for (const d of [1.6, 1.73, 1.9, 2.1, 2.25, 2.3]) {
      const lo = Math.round(relaxationFloorM(boat(d)) * 10);
      const hi = Math.round(defaultSafetyDepthM(boat(d)) * 10);
      expect(hi - lo).toBe(Math.round(MASK_TOLERANCE_M * 10)); // 9 decimetres, always
    }
  });
});
