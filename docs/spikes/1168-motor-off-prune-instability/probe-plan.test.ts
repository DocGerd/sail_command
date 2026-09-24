import { it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import { planRouteWithRecord } from './planRoute';
import { DIAG } from './scratch1168iso';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { PlanRequest } from '../types';
import { SALONA_DEPS, FLENSBURG, BAGENKOP, T0 } from '../test/realmaskFixtures';

const ALT = process.env.SC_ALT ?? 'none';

vi.mock('./isochrone', async () => {
  const m = await import('./scratch1168iso');
  return {
    ...m,
    solve: (p: Parameters<typeof m.solve>[0]) =>
      m.solve(process.env.SC_ALT === 'salvage' ? { ...p, salvage: true } : p),
  };
});

const OUT = process.env.SC_OUT ?? '/dev/null';
const TWS = (process.env.SC_TWS ?? '2.0,2.2,2.4').split(',').map(Number);

it('planalt', () => {
  DIAG.mode = 'prod';
  DIAG.record = false;
  DIAG.div = ALT === 'div4' ? 4 : 2;
  for (const tws of TWS) {
    const req: PlanRequest = {
      origin: FLENSBURG,
      destination: BAGENKOP,
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'bagenkop',
      departureMs: T0,
      settings: { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: false },
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    };
    const { result, record } = planRouteWithRecord(req, uniformWindGrid(tws, 0), SALONA_DEPS);
    const row: Record<string, unknown> = {
      alt: ALT,
      tws,
      status: result.status,
      tiers: record.tiers.map((t) => `${t.tier}:${t.causes.join('/')}`),
    };
    if (result.status === 'ok') {
      row.sails = result.sails.map((s) =>
        s.result === null
          ? `${s.sailId}:FAILED:${s.reason}`
          : `${s.sailId}:${((s.result.etaMs - T0) / 3.6e6).toFixed(3)}h`,
      );
      row.recommended = result.recommended;
    } else {
      row.reason = result.reason;
    }
    appendFileSync(OUT, JSON.stringify(row) + '\n');
  }
}, 3_600_000);
