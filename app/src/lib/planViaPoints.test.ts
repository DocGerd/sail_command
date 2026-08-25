import { describe, expect, it } from 'vitest';
import { planViaPoints } from './planViaPoints';
import type { PlanRequest } from '../types';

describe('planViaPoints (#654)', () => {
  it('returns the array unchanged when viaPoints is a real array', () => {
    const viaPoints = [
      { lat: 54.83, lon: 9.9 },
      { lat: 54.9, lon: 10.2 },
    ];
    expect(planViaPoints({ viaPoints })).toBe(viaPoints);
  });

  it('returns [] when viaPoints is undefined (a hand-edited/corrupted stored record — no legitimate one can lack this key, see planViaPoints.ts)', () => {
    // PlanRequest.viaPoints is a required LatLon[], so the missing-key shape
    // this guards against can only be represented by stepping outside the
    // type — exactly what `services/migratePlan.ts`'s pre-#654
    // `as unknown as PlanRequest` cast did for a foreign/corrupted record.
    const request = {} as Pick<PlanRequest, 'viaPoints'>;
    expect(planViaPoints(request)).toEqual([]);
  });

  it('returns [] when viaPoints is null', () => {
    const request = { viaPoints: null } as unknown as Pick<PlanRequest, 'viaPoints'>;
    expect(planViaPoints(request)).toEqual([]);
  });

  it('returns [] when viaPoints is present but not an array', () => {
    const request = { viaPoints: 'not-an-array' } as unknown as Pick<PlanRequest, 'viaPoints'>;
    expect(planViaPoints(request)).toEqual([]);
  });

  it('returns a genuinely empty stored list as-is (not a fresh [])', () => {
    const viaPoints: PlanRequest['viaPoints'] = [];
    expect(planViaPoints({ viaPoints })).toBe(viaPoints);
  });
});
