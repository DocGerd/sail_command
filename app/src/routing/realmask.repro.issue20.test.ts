import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { uniformGate } from '../lib/depthGate';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { LatLon, Settings } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import {
  mask,
  SALONA_DEPS,
  FLENSBURG,
  GLUECKSBURG,
  MARSTAL,
  FJORD_MOUTH,
  OPEN_BALTIC,
  T0,
  sailResult,
  solveGenoa,
  expectLegsNavigable,
  metresBetween,
  centreOf,
  APPROACH_LIMIT_M,
  expectRelaxedWaterConfinedToPinch,
} from '../test/realmaskFixtures';

// #878: split out of the former realmask.repro.test.ts (~1286 lines, five
// top-level describe blocks) so vitest can parallelise the real-mask suite
// across files/cores — one monopolizing file previously set the whole `app`
// job's wall clock while other cores idled. Pure relocation of this
// describe block; shared setup lives in ../test/realmaskFixtures.ts. These run
// against the real shipped mask and polars, unlike the synthetic masks used
// everywhere else in the suite.
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

  // Direct-request case (Flensburg -> Marstal at an explicit 2.3 m),
  // runtime-heavy: ~45 s locally (~40 s before #21's clock-aware visited
  // pruning deliberately widened the search; CI is measurably slower than
  // dev machines, hence the generous timeout — the 600 s base budget below
  // has ample headroom over 45 s regardless of the exact ratio).
  //
  // Runs at safetyDepthM 2.3: in the shipped mask Marstal's snap cell sits in
  // a 119-cell pocket that only 4-connects to open water at gate depths
  // <= 2.3 m (EMODnet can't resolve the dredged approach channel at 46 m
  // cells; see CONNECTIVITY_EXCEPTIONS_M in pipeline/verify_mask.py and PR
  // #8). A user explicitly planning at 2.3 m gets a plain route with no
  // shallow warnings — nothing was relaxed. The former note here ("at 3.0 m
  // 'unreachable' is the CORRECT answer for this data") is superseded by
  // #53's graceful degradation: the DEFAULT_SETTINGS spec acceptance case
  // below now expects a route WITH shallow warnings instead.
  it(
    'Flensburg -> Marstal (direct request at 2.3 m safety depth)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 2.3 };
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
      // Explicitly-requested 2.3 m needs no relaxation: no shallow warnings.
      expect('shallow' in res).toBe(false);
      const rig = sailResult(res, res.recommended);
      expect(rig).not.toBeNull();
      // ~38 nm great-circle; sane plans stay inside these envelopes
      expect(rig!.distanceNm).toBeGreaterThan(30);
      expect(rig!.durationMs).toBeLessThan(12 * 3_600_000);
      expectLegsNavigable(rig!.legs, settings.safetyDepthM);
    },
  );

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
  // case above (the disconnection fast path skips the doomed 3.0 m solves;
  // the relaxed solve does the same work as a direct 2.3 m plan), hence the
  // same generous timeout.
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

