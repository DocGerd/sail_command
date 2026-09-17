import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { LatLon, Settings } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import {
  mask,
  SALONA_DEPS,
  FLENSBURG,
  MARSTAL,
  T0,
  sailResult,
  metresBetween,
  centreOf,
  APPROACH_LIMIT_M,
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
  // #452's INVARIANT, asserted directly against the real mask: no leg of a
  // returned plan crosses a cell charted below the requested depth unless
  // that cell lies within APPROACH_RADIUS_M of a snapped waypoint.
  //
  // WHY depthComfortMarginM: 0 SPECIFICALLY, and why this test is worthless
  // at DEFAULT_SETTINGS. The maintainer's own measurement on issue #452
  // (2026-08-07T21:04:54Z) records that at DEFAULT settings the sub-requested
  // crossings on this passage are ALREADY "all inside ~1 km of the Marstal
  // approach" — so at DEFAULT the assertion below holds with or without the
  // fix, and the kill-switch mutation would not red it. At margin 0 that same
  // measurement records "5 separate sites spread along the whole passage",
  // two of them inside Flensburg Fjord roughly 40 nm from the pinch. Margin 0
  // is therefore the only configuration in which this assertion has teeth.
  //
  // The geometry here is computed from the leg polylines and the plan's own
  // snapped waypoints with a local haversine — it never calls into
  // depthGate.ts, so needle and haystack are independently sourced.
  it(
    '#452: at margin 0, every sub-requested cell the route crosses lies within one approach disc',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 0 };
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings,
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(12, 270),
        SALONA_DEPS,
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;

      const anchors = [res.snappedOrigin, res.snappedDestination];
      // `metresBetween`, `centreOf` and `APPROACH_LIMIT_M` moved to module
      // scope in #494 so the two relaxed-path call sites share this exact
      // geometry instead of re-deriving it. The 2% allowance they carry
      // absorbs the grid-ellipse vs. haversine difference without weakening
      // anything that matters here: reverting to the pre-#452 route-wide gate
      // (spike §3, M8) reds this test with offenders 7.46-8.01 nm from the
      // nearest waypoint — 12.0-13.0 km past the 1852 m radius, against a
      // 37 m allowance.
      const LIMIT_M = APPROACH_LIMIT_M;

      const offenders: string[] = [];
      for (const rig of [sailResult(res, 'genoa'), sailResult(res, 'fock')]) {
        if (!rig) continue;
        for (const leg of rig.legs) {
          // Sample well below the ~46 m cell pitch, so any cell crossed for
          // more than a step is seen; a corner-clip shorter than one step can
          // still be missed, which is why this test is sized to catch gross
          // violations kilometres out rather than to certify an exact zero.
          const legM = metresBetween(leg.start, leg.end);
          const steps = Math.max(2, Math.ceil(legM / 10));
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const p: LatLon = {
              lat: leg.start.lat + (leg.end.lat - leg.start.lat) * t,
              lon: leg.start.lon + (leg.end.lon - leg.start.lon) * t,
            };
            const info = mask.depthInfoM(p);
            // Deep-capped cells are a floor, never a shallow reading (#53).
            if (info.capped || info.depthM >= settings.safetyDepthM) continue;
            const centre = centreOf(p);
            const nearestM = Math.min(...anchors.map((a) => metresBetween(a, centre)));
            if (nearestM > LIMIT_M)
              offenders.push(
                `${info.depthM.toFixed(1)} m at ${centre.lat.toFixed(4)},${centre.lon.toFixed(4)} — ${(nearestM / 1852).toFixed(2)} nm from the nearest waypoint`,
              );
          }
        }
        // #494 review F1/F2: the PINCH-anchored form of the same bound, at the
        // ONE configuration in this file where it can red — and the licence row
        // this test otherwise lacks entirely (`offenders` empty because nothing
        // was crossed reads identically to `offenders` empty because everything
        // was confined; MEASURED 172 crossings at baseline, but nothing pinned
        // that).
        //
        // NOT redundant with the `nearestM` bound above, and not a second copy
        // of it. `gateAtCell` returns the requested depth outside EVERY disc,
        // so "inside SOME disc" is a theorem of the shipped gate and the
        // `nearestM` form can never red for a stray the ORIGIN disc absorbs.
        // Anchoring on the destination alone removes that absorber, which is
        // the residual #494 §(a) actually names. No NEW knife-edge — every
        // baseline crossing here is nearer the destination than the origin, so
        // this bound and the `nearestM` one above are the SAME number on
        // correct behaviour — but the shared headroom is thin in the unit that
        // matters, and that predates #494: MEASURED 83 crossings on the first
        // rig (172 across both), spanning 0.079-0.997 nm from the Marstal snap
        // against the 1.02 nm bound. That leaves 1.02 - 0.997 = 0.023 nm, i.e.
        // ~42 m — which sounds comfortable until it is read against the ~46 m
        // mask cell this file samples below: the margin is under ONE CELL, so a
        // single cell of outward drift at the farthest crossing reds it. State
        // it that way rather than as a bare metre count, which invites exactly
        // the widening the paragraph above rules out. Widening the bound would
        // forfeit the teeth, and the drift would red BOTH assertions anyway,
        // not just this one.
        expectRelaxedWaterConfinedToPinch(
          rig.legs,
          settings.safetyDepthM,
          res.snappedDestination,
          'margin 0: relaxed water away from the Marstal pinch',
        );
      }
      // Report the actual offending cells, not a bare boolean: at 3am in CI
      // the depth and the distance are the whole diagnostic.
      expect(offenders.slice(0, 10)).toEqual([]);
    },
  );
});
