// @ts-expect-error process is not typed in browser context
process.env.TZ = 'Europe/Berlin';

import { describe, it, expect } from 'vitest';
import { nextPassageDepartureMs } from './planForm';

// Same pin-verification as PlannerPanel.dst.test.tsx: fails loudly when TZ did not take.
const tzVerifyHour = new Date(2026, 9, 25, 2, 23).getHours();
if (tzVerifyHour !== 2) {
  throw new Error(`TZ pinning failed: expected hour 2 at DST fold, got ${tzVerifyHour}.`);
}

describe('#1707 nextPassageDepartureMs across DST', () => {
  it('spring-forward: an ETA at 00:30 on 2026-03-29 departs 10:00 CEST that morning', () => {
    const eta = new Date(2026, 2, 29, 0, 30).getTime();
    const dep = nextPassageDepartureMs(eta, eta - 3_600_000);
    expect(new Date(dep).getHours()).toBe(10);
    expect((dep - eta) / 3_600_000).toBe(8.5);
  });
  it.each([
    ['spring-forward', new Date(2026, 2, 28, 20, 0), 29],
    ['fall-back', new Date(2026, 9, 24, 20, 0), 25],
  ])('%s: an evening ETA rolls by calendar day, not by 24 h', (_name, eta, day) => {
    const dep = new Date(nextPassageDepartureMs(eta.getTime(), eta.getTime() - 3_600_000));
    expect([dep.getDate(), dep.getHours(), dep.getMinutes()]).toEqual([day, 10, 0]);
  });
  it('fall-back: an ETA at 23:30 on 2026-10-24 departs 10:00 CET on the 25th', () => {
    const eta = new Date(2026, 9, 24, 23, 30).getTime();
    const dep = nextPassageDepartureMs(eta, eta - 3_600_000);
    expect([new Date(dep).getDate(), new Date(dep).getHours()]).toEqual([25, 10]);
    expect((dep - eta) / 3_600_000).toBe(11.5);
  });
});
