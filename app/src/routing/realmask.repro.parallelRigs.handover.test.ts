import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  planRouteWithRecord,
  planRouteWithRecordAsync,
  solveRig,
  type Pass1Record,
  type Pass2Outcome,
  type RigStep,
  type RunOut,
} from './planRoute';
import { planWithHarborHandover, planWithHarborHandoverAsync } from './harborHandover';
import { mask, polars, T0 } from '../test/realmaskFixtures';
import { uniformWindGrid } from '../test/fixtures';
import { boatById, sailIdsOf } from '../data/boats';
import { DEFAULT_SETTINGS, boatSnapshot, type LatLon, type PlanRequest } from '../types';
import { defaultSafetyDepthM } from '../lib/boatDepth';
import type { PlanResultWithHandover } from '../lib/harborHandover';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

/** Rigs in reverse order with an await between, so placement must be by index. */
async function reverseRunner(step: RigStep): Promise<RunOut[]> {
  const { ctx } = step;
  const out: RunOut[] = [];
  for (let i = ctx.sailIds.length - 1; i >= 0; i--) {
    await Promise.resolve();
    out[i] = solveRig(
      ctx,
      ctx.sailIds[i],
      ctx.polarFor(ctx.sailIds[i]),
      step.gate,
      step.comfortDepthM,
      step.pass2 !== null,
      step.deadline,
    );
  }
  return out;
}

interface HarborRow {
  id: string;
  snap: LatLon;
  knownDisconnected?: boolean;
}
const rows = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data/harbors.json'),
    'utf8',
  ),
) as HarborRow[];
const harbor = (id: string): HarborRow => {
  const h = rows.find((x) => x.id === id);
  if (!h) throw new Error(`fixture drift: '${id}' missing from harbors.json`);
  return h;
};
const KD: ReadonlySet<string> = new Set(
  rows.filter((h) => h.knownDisconnected === true).map((h) => h.id),
);

describe('parallel-rig ladder through the harbour handover (real mask)', () => {
  it(
    'Augustenborg -> Hoeruphav: the handover re-plan runs, and async equals sync per plan call',
    { timeout: solverTimeoutMs(900_000) },
    async () => {
      const boat = boatById('salona-44-easy-go');
      const from = harbor('augustenborg');
      const to = harbor('hoeruphav');
      const req: PlanRequest = {
        origin: from.snap,
        destination: to.snap,
        viaPoints: [],
        originHarborId: from.id,
        destinationHarborId: to.id,
        departureMs: T0,
        settings: { ...DEFAULT_SETTINGS, safetyDepthM: defaultSafetyDepthM(boat) },
        sailIds: [...sailIdsOf(boat)],
        boat: boatSnapshot(boat),
      };
      const wind = uniformWindGrid(12, 225);
      const deps = { polars, boat, mask };

      type Rec = { record: Pass1Record; pass2: Pass2Outcome };
      const syncRecs: Rec[] = [];
      const syncPlan = vi.fn((r: PlanRequest) => {
        const x = planRouteWithRecord(r, wind, deps);
        syncRecs.push({ record: x.record, pass2: x.pass2 });
        return x.result;
      });
      const sync = planWithHarborHandover(
        req,
        wind,
        deps,
        undefined,
        undefined,
        undefined,
        KD,
        syncPlan,
      );

      const asyncRecs: Rec[] = [];
      const asyncPlan = vi.fn(async (r: PlanRequest) => {
        const x = await planRouteWithRecordAsync(r, wind, deps, reverseRunner);
        asyncRecs.push({ record: x.record, pass2: x.pass2 });
        return x.result;
      });
      const async = await planWithHarborHandoverAsync(req, deps, undefined, KD, asyncPlan);

      // The handover branch was reached: a second plan call, with flagged ends.
      expect(syncPlan).toHaveBeenCalledTimes(2);
      expect(asyncPlan).toHaveBeenCalledTimes(2);
      expect((sync as PlanResultWithHandover).harborHandovers).toEqual({ origin: true });
      expect(async).toEqual(sync);
      expect(asyncRecs).toEqual(syncRecs);
      expect(asyncPlan.mock.calls[1][0]).toEqual(syncPlan.mock.calls[1][0]);
    },
  );
});
