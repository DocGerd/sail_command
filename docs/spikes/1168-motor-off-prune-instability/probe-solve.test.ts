import { it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { solve as prodSolve } from './isochrone';
import { solve, DIAG } from './scratch1168iso';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { uniformGate } from '../lib/depthGate';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import { mask, polarGenoa, polarFock, FLENSBURG, BAGENKOP, T0 } from '../test/realmaskFixtures';

const OUT = process.env.SC_OUT ?? '/dev/null';
const TWS = (process.env.SC_TWS ?? '2.4,2.6,2.8,3.0').split(',').map(Number);
const SNAPS = (process.env.SC_SNAP ?? 'unsnap,snap').split(',');
const RIG = process.env.SC_RIG ?? 'genoa';
const MOTOR = process.env.SC_MOTOR === '1';
const MODE = (process.env.SC_MODE ?? 'prod') as 'prod' | 'pareto' | 'nodom';
const SALVAGE = process.env.SC_SALVAGE === '1';
const CONTROL = process.env.SC_CONTROL === '1';
const DUMP = process.env.SC_DUMP === '1';

it('diag', () => {
  const dest = mask.snapToNavigable(BAGENKOP, 3)!;
  for (const snap of SNAPS)
    for (const tws of TWS) {
      const origin = snap === 'snap' ? mask.snapToNavigable(FLENSBURG, 3)! : FLENSBURG;
      const params = {
        origin,
        destination: dest,
        departureMs: T0,
        polar: new Polar(RIG === 'genoa' ? polarGenoa : polarFock, 1),
        wind: new WindField(uniformWindGrid(tws, 0)),
        mask,
        settings: { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: MOTOR },
        gate: uniformGate(3),
        ...(SALVAGE ? { salvage: true } : {}),
      };
      DIAG.mode = MODE;
      DIAG.div = Number(process.env.SC_DIV ?? '2');
      DIAG.record = true;
      DIAG.rings = [];
      const r = solve(params);
      const rings = DIAG.rings;
      const row: Record<string, unknown> = {
        snap,
        tws,
        rig: RIG,
        mode: MODE,
        div: DIAG.div,
        salvage: SALVAGE,
        status: r.status,
        cause: r.status === 'no-route' ? r.cause : null,
        rings: rings.length,
        peak: Math.max(0, ...rings.map((x) => x.next)),
        etaH: r.status === 'ok' ? (r.etaMs - T0) / 3.6e6 : null,
        costMs: r.status === 'ok' ? r.costMs - T0 : null,
        legs: r.status === 'ok' ? r.legs.length : null,
        totDom: rings.reduce((s, x) => s + x.dominated, 0),
        totSynth: rings.reduce((s, x) => s + x.domSynthetic, 0),
      };
      if (DUMP) row.ringDump = rings.slice(0, 8);
      if (CONTROL) {
        const sizes: number[] = [];
        const q = prodSolve({ ...params, onProgress: (i) => sizes.push(i.frontierSize) });
        row.control = {
          status: q.status,
          rings: sizes.length,
          peak: Math.max(0, ...sizes),
          costMs: q.status === 'ok' ? q.costMs - T0 : null,
          same:
            q.status === r.status &&
            (q.status !== 'ok' ||
              r.status !== 'ok' ||
              (q.costMs === r.costMs && q.etaMs === r.etaMs)),
        };
      }
      appendFileSync(OUT, JSON.stringify(row) + '\n');
    }
}, 3_600_000);
