import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import {
  SALONA_DEPS,
  FLENSBURG,
  GLUECKSBURG,
  FJORD_MOUTH,
  OPEN_BALTIC,
  T0,
  sailResult,
  solveGenoa,
  expectLegsNavigable,
} from '../test/realmaskFixtures';

// #878: split out of the former realmask.repro.test.ts (~1286 lines, five
// top-level describe blocks) so vitest can parallelise the real-mask suite
// across files/cores — one monopolizing file previously set the whole `app`
// job's wall clock while other cores idled. Pure relocation of this
// describe block; shared setup lives in ../test/realmaskFixtures.ts. These run
// against the real shipped mask and polars, unlike the synthetic masks used
// everywhere else in the suite.
//
// #1261: the three heavy Flensburg -> Marstal `planRoute` cases (~170-185 s
// each on CI) were split into their own sibling files —
// realmask.repro.issue20.marstal23.test.ts,
// realmask.repro.issue20.marstalDefault.test.ts,
// realmask.repro.issue20.marstalMargin0.test.ts — so vitest can schedule
// them on separate workers instead of serializing inside one file. Pure
// relocation of each `it(...)` block, imports included; only the
// lightweight Gluecksburg/open-water cases remain here.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

describe('real mask routing (issue #20)', () => {
  it('open water sanity: fjord mouth -> open baltic', () => {
    const res = solveGenoa(FJORD_MOUTH, OPEN_BALTIC, 270, DEFAULT_SETTINGS);
    expect(res.status).toBe('ok');
  });

  it('Flensburg -> Gluecksburg routes at default settings (the issue #20 repro)', () => {
    const res = planRoute(
      {
        origin: FLENSBURG,
        destination: GLUECKSBURG,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'gluecksburg',
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      uniformWindGrid(12, 270),
      SALONA_DEPS,
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    for (const rig of [sailResult(res, 'genoa'), sailResult(res, 'fock')]) {
      expect(rig).not.toBeNull();
      // ~4 nm; anything over 1.5 h means the solver padded its way out
      expect(rig!.durationMs).toBeLessThan(1.5 * 3_600_000);
      expectLegsNavigable(rig!.legs, DEFAULT_SETTINGS.safetyDepthM);
    }
  });

  it('progress reports the true frontier clock, not the ring clock, under substeps', () => {
    // Out of Flensburg every full-step candidate is blocked (that was the bug),
    // so the entire first frontier consists of substepped children with clocks
    // at most dtS/2 = 150 s past departure. The ring clock would report
    // T0 + 300 s here; the frontier clock must not.
    const reports: number[] = [];
    const res = solveGenoa(FLENSBURG, GLUECKSBURG, 270, DEFAULT_SETTINGS, ({ tMs }) =>
      reports.push(tMs),
    );
    expect(res.status).toBe('ok');
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toBeGreaterThan(T0);
    expect(reports[0]).toBeLessThan(T0 + 300_000);
    for (let i = 1; i < reports.length; i++)
      expect(reports[i]).toBeGreaterThanOrEqual(reports[i - 1]);
  });

  it('Flensburg -> Gluecksburg routes under any wind direction', () => {
    for (const dir of [0, 90, 135, 180, 315]) {
      const res = solveGenoa(FLENSBURG, GLUECKSBURG, dir, DEFAULT_SETTINGS);
      expect(res.status, `wind from ${dir}`).toBe('ok');
    }
  });
});
