import { describe, it, expect } from 'vitest';
import { recalcRequest } from './recalc';
import { uniformWindGrid } from '../test/fixtures';
import type { Plan, PlanRequest } from '../types';

// Literal request values (mutation-check rule: expectations are pinned
// literals, never derived from the function under test).
const ORIGINAL_REQUEST: PlanRequest = {
  origin: { lat: 54.81, lon: 9.44 },
  destination: { lat: 54.85, lon: 10.51 },
  viaPoints: [{ lat: 54.83, lon: 9.9 }],
  originHarborId: 'flensburg',
  destinationHarborId: null,
  departureMs: 1_780_000_000_000,
  settings: {
    safetyDepthM: 2.3,
    motorSpeedKn: 6.5,
    motorThresholdKn: 2.5,
    maneuverPenaltyS: 45,
    performanceFactor: 0.9,
    motorEnabled: false,
    showOwnship: true,
  },
};

function makePlan(): Plan {
  return {
    id: 'plan-original',
    name: 'Flensburg → Ærøskøbing',
    createdAtMs: 1_779_990_000_000,
    request: ORIGINAL_REQUEST,
    windGrid: uniformWindGrid(12, 225),
    result: {
      status: 'ok',
      genoa: {
        rig: 'genoa',
        legs: [],
        etaMs: 1_780_010_000_000,
        durationMs: 10_000_000,
        distanceNm: 30,
        maneuverCount: 2,
        motorDistanceNm: 0,
      },
      fock: null,
      genoaReason: null,
      fockReason: 'calm-motor-off',
      recommended: 'genoa',
      snappedOrigin: { lat: 54.81, lon: 9.44 },
      snappedDestination: { lat: 54.85, lon: 10.51 },
    },
  };
}

describe('recalcRequest (#114 seed-from-plan)', () => {
  it('keeps origin/destination/vias/harbors/settings and swaps only the departure', () => {
    const plan = makePlan();

    const seeded = recalcRequest(plan, 1_780_086_400_000);

    expect(seeded).toEqual({
      origin: { lat: 54.81, lon: 9.44 },
      destination: { lat: 54.85, lon: 10.51 },
      viaPoints: [{ lat: 54.83, lon: 9.9 }],
      originHarborId: 'flensburg',
      destinationHarborId: null,
      departureMs: 1_780_086_400_000, // the edited departure, NOT the stored 1_780_000_000_000
      settings: {
        safetyDepthM: 2.3,
        motorSpeedKn: 6.5,
        motorThresholdKn: 2.5,
        maneuverPenaltyS: 45,
        performanceFactor: 0.9,
        motorEnabled: false,
        showOwnship: true,
      },
    });
  });

  it('never aliases the plan mutable sub-objects, and leaves the plan request untouched', () => {
    const plan = makePlan();

    const seeded = recalcRequest(plan, 1_780_086_400_000);

    // Copies, not shared references — nothing downstream of the run can
    // reach back into the saved plan's own request.
    expect(seeded.origin).not.toBe(plan.request.origin);
    expect(seeded.destination).not.toBe(plan.request.destination);
    expect(seeded.viaPoints).not.toBe(plan.request.viaPoints);
    expect(seeded.viaPoints[0]).not.toBe(plan.request.viaPoints[0]);
    expect(seeded.settings).not.toBe(plan.request.settings);

    // The original request still holds its literal pre-seed values.
    expect(plan.request.departureMs).toBe(1_780_000_000_000);
    expect(plan.request.viaPoints).toEqual([{ lat: 54.83, lon: 9.9 }]);
    expect(plan.request.settings.safetyDepthM).toBe(2.3);
  });
});
