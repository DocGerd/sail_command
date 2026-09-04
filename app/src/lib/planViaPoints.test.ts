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

  // #846 review Minor: the LatLon[] -> ViaPoint[] widening of this
  // function's return type has NO runtime effect on its own — the function
  // body (`Array.isArray(...) ? request.viaPoints : []`) is byte-identical
  // either way, so a plain runtime assertion that `.name` survives a call
  // CANNOT discriminate the return-type revert this test exists to guard
  // (reverting it changes zero bytes of compiled JS). The load-bearing half
  // is the TYPE-LEVEL access below: `result[0].name` only type-checks
  // because the declared return type is ViaPoint[]. Reverting the return
  // type annotation to LatLon[] makes this line TS2339 ("Property 'name'
  // does not exist on type 'LatLon'"), caught by `npm run typecheck`
  // (tsc -b) — this file sits inside tsconfig.app.json's plain `src`
  // include (not one of its node:fs-only exclusions), so that check runs on
  // ordinary `npm run typecheck`, no separate `vitest --typecheck` needed.
  it('#846: the return type carries `name` — type-level backstop for the LatLon[] -> ViaPoint[] widening (no runtime effect exists to assert on)', () => {
    const request: Pick<PlanRequest, 'viaPoints'> = {
      viaPoints: [{ lat: 54.83, lon: 9.9, name: 'Kalkgrund' }],
    };
    const result = planViaPoints(request);
    const name: string | undefined = result[0].name;
    expect(name).toBe('Kalkgrund');
  });
});
