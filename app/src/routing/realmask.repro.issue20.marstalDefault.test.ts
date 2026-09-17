import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { uniformGate } from '../lib/depthGate';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import {
  mask,
  SALONA_DEPS,
  FLENSBURG,
  MARSTAL,
  T0,
  sailResult,
  expectLegsNavigable,
  expectRelaxedWaterConfinedToPinch,
} from '../test/realmaskFixtures';

// #1261: split out of realmask.repro.issue20.test.ts (#878's own split of the
// former realmask.repro.test.ts) — this one `planRoute` call (~170-185 s on
// CI) was serializing behind its two Marstal siblings inside one file; each
// now gets its own worker. Pure relocation: same imports, same literals,
// same timeout as before the split. See realmask.repro.issue20.test.ts for
// the lightweight Gluecksburg/open-water cases and the shared #878 history.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

describe('real mask routing (issue #20)', () => {
  // Spec acceptance case for #53 (graceful degradation below safety depth):
  // Flensburg -> Marstal at DEFAULT_SETTINGS (3.0 m) returns a route WITH
  // shallow warnings instead of 'unreachable'. usedDepthM = 2.3 was derived
  // INDEPENDENTLY of the router: a standalone stack-based flood fill over the
  // raw committed mask.bin reports the Flensburg/Marstal snap cells connected
  // at every decimeter gate <= 2.3 m and disconnected at >= 2.4 m. That 2.3 m
  // is the measured reconnection threshold recorded in the PROSE comment of
  // pipeline/verify_mask.py's CONNECTIVITY_EXCEPTIONS_M["marstal"] entry; the
  // entry's actual gate VALUE is 2.0 m — a deliberate safety margin below the
  // 2.3 m, used only for the pipeline's connectivity self-check, never for
  // routing. The in-test cellsConnected assertions below cross-check the
  // shipped BFS against the 2.3 m reconnection literal. Runtime ≈ the 2.3 m
  // case (realmask.repro.issue20.marstal23.test.ts) — the disconnection fast
  // path skips the doomed 3.0 m solves; the relaxed solve does the same work
  // as a direct 2.3 m plan — hence the same generous timeout.
  it(
    'Flensburg -> Marstal at DEFAULT_SETTINGS degrades gracefully with shallow warnings (#53)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const o = mask.snapToNavigable(FLENSBURG, DEFAULT_SETTINGS.safetyDepthM);
      const d = mask.snapToNavigable(MARSTAL, DEFAULT_SETTINGS.safetyDepthM);
      expect(o).not.toBeNull();
      expect(d).not.toBeNull();
      // The independently-derived connectivity flip pinning usedDepthM = 2.3:
      expect(mask.cellsConnected(o!, d!, uniformGate(2.3))).toBe(true);
      expect(mask.cellsConnected(o!, d!, uniformGate(2.4))).toBe(false);

      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
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
      expect(res.shallow).toBeDefined();
      expect(res.shallow!.requestedDepthM).toBe(3.0);
      expect(res.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      // Every traversed cell is >= the 2.3 m gate, and the warning only exists
      // because something charted below 3.0 m was actually crossed.
      expect(res.shallow!.minGateDepthM).toBeGreaterThanOrEqual(2.3);
      expect(res.shallow!.minGateDepthM).toBeLessThan(3.0);
      for (const rig of [sailResult(res, 'genoa'), sailResult(res, 'fock')]) {
        expect(rig).not.toBeNull();
        expect(rig!.distanceNm).toBeGreaterThan(30);
        expect(rig!.durationMs).toBeLessThan(12 * 3_600_000);
        expectLegsNavigable(rig!.legs, res.shallow!.usedDepthM);
        // #494 §(a): `expectLegsNavigable` above checks the CHOSEN gate
        // (2.3 m), which by construction cannot see anything the relaxation
        // licensed. This is the missing per-leg half: the sub-requested water
        // it licensed is confined to the Marstal approach — the pinch the two
        // `cellsConnected` rows at the top of this test identify as the reason
        // the relaxation happened at all.
        expectRelaxedWaterConfinedToPinch(
          rig!.legs,
          res.shallow!.requestedDepthM,
          res.snappedDestination,
          'Flensburg -> Marstal: relaxed water away from the Marstal pinch',
        );
        const flagged = rig!.legs.filter((l) => l.shallow);
        expect(flagged.length).toBeGreaterThan(0);
        for (const leg of flagged) {
          expect(leg.shallow!.minDepthM).toBeGreaterThanOrEqual(res.shallow!.minGateDepthM);
          expect(leg.shallow!.minDepthM).toBeLessThan(3.0);
        }
      }
    },
  );
});
