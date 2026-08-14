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
