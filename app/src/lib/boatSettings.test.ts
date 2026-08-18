import { describe, it, expect } from 'vitest';
import { settingsDefaultsForBoat, clampSettingsToBoat } from './boatSettings';
import { minSafetyDepthM } from './boatDepth';
import { boatById } from '../data/boats';
import { DEFAULT_SETTINGS } from '../types';

describe('settingsDefaultsForBoat', () => {
  it("reproduces today's DEFAULT_SETTINGS for the Salona 45", () => {
    const d = settingsDefaultsForBoat(boatById('salona-45'));
    expect(d.safetyDepthM).toBe(3.0);
    expect(d.motorSpeedKn).toBe(6.5);
    expect(d.maneuverPenaltyS).toBe(45);
  });

  // The row above is the CONTROL and cannot discriminate: the Salona 45 is
  // the one catalogue boat whose three derived values all coincide with
  // DEFAULT_SETTINGS, so replacing this function's whole body with the
  // literals `{ 3.0, 6.5, 45 }` left the file 3 passed / 3, and
  // `settingsDefaultsForBoat` has no production call site yet, so no other
  // test could red it either. This row exercises it at a draft and a pair of
  // boat fields where per-boat and global DISAGREE on all three — 2.3 + the
  // 0.9 mask tolerance quantises UP to a 3.2 m gate (boatDepth.ts), against
  // the global 3.0.
  it('derives all three values from the BOAT, not from DEFAULT_SETTINGS', () => {
    const d = settingsDefaultsForBoat({
      ...boatById('salona-45'),
      id: 'deep-45',
      draftM: 2.3,
      motorSpeedKn: 5.0,
      maneuverPenaltyS: 60,
    });
    expect(d.safetyDepthM).toBe(3.2);
    expect(d.motorSpeedKn).toBe(5.0);
    expect(d.maneuverPenaltyS).toBe(60);
  });
});

describe('clampSettingsToBoat', () => {
  it('clamps a stored safety depth UP on a boat switch, and reports it', () => {
    const deep = { ...boatById('salona-45'), id: 'deep', draftM: 2.3 };
    const { settings, clamped } = clampSettingsToBoat(
      { ...DEFAULT_SETTINGS, safetyDepthM: 2.2 },
      deep,
    );
    expect(clamped).toBe(true);
    expect(settings.safetyDepthM).toBe(minSafetyDepthM(deep)); // 2.4
  });

  // The `>=` BOUNDARY itself. Every other row here sits strictly above or
  // strictly below the floor, so flipping `>=` to `>` — which reports a
  // spurious `clamped: true` on a value that was never changed — passed.
  it('reports no clamp when the stored depth sits EXACTLY on the new floor', () => {
    const deep = { ...boatById('salona-45'), id: 'deep', draftM: 2.3 };
    const stored = { ...DEFAULT_SETTINGS, safetyDepthM: minSafetyDepthM(deep) };
    const { settings, clamped } = clampSettingsToBoat(stored, deep);
    expect(clamped).toBe(false);
    // "returned unchanged" is identity, not equality: a `{ ...s }` copy that
    // happens to carry the same numbers would satisfy toEqual.
    expect(settings).toBe(stored);
  });

  it('NEVER clamps down', () => {
    const shoal = { ...boatById('salona-45'), id: 'shoal', draftM: 1.6 };
    const { settings, clamped } = clampSettingsToBoat(
      { ...DEFAULT_SETTINGS, safetyDepthM: 4.0 },
      shoal,
    );
    expect(clamped).toBe(false);
    expect(settings.safetyDepthM).toBe(4.0);
  });
});
