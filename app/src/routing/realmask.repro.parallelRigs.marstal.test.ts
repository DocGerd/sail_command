import { describe, expect, it, vi } from 'vitest';
import {
  planRouteWithRecord,
  planRouteWithRecordAsync,
  solveRig,
  type RigStep,
  type RunOut,
} from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { SALONA_DEPS, FLENSBURG, MARSTAL, T0 } from '../test/realmaskFixtures';

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

describe('parallel-rig ladder on the real mask', () => {
  it(
    'Flensburg -> Marstal at DEFAULT_SETTINGS (relaxed route): async equals sync, record included',
    { timeout: solverTimeoutMs(600_000) },
    async () => {
      const req = {
        origin: FLENSBURG,
        destination: MARSTAL,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'marstal',
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'] as const,
        boat: defaultBoatSnapshot(),
      };
      const wind = uniformWindGrid(12, 270);
      const sync = planRouteWithRecord(req, wind, SALONA_DEPS);
      const steps: RigStep[] = [];
      const async = await planRouteWithRecordAsync(req, wind, SALONA_DEPS, (step) => {
        steps.push(step);
        return reverseRunner(step);
      });

      // The relaxed tier ran: this is not the requested-gate shortcut.
      expect(sync.result.status).toBe('ok');
      expect(sync.result.status === 'ok' && sync.result.shallow?.usedDepthM).toBeCloseTo(2.3, 6);
      expect(steps.length).toBeGreaterThan(0);
      expect(sync.record.tiers.some((t) => t.tier >= 3)).toBe(true);
      expect(async).toEqual(sync);
    },
  );
});
