import { describe, expect, it, vi } from 'vitest';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { solve } from './isochrone';
import { mergeCollinearLegs } from './postprocess';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { uniformGate } from '../lib/depthGate';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { PolarTable, Settings } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import {
  mask,
  polarGenoa,
  polarFock,
  SALONA_DEPS,
  FLENSBURG,
  MARSTAL,
  SOENDERBORG,
  BAGENKOP,
  AEROESKOEBING,
  DREJOE,
  T0,
  sailResult,
  expectLegsNavigable,
  exposureNm,
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

describe('#243 depth comfort preference (real mask)', () => {
  // Pre-change (baseline, before #243) literals for Flensburg -> Sonderborg
  // at 270 deg / DEFAULT_SETTINGS, measured independently by running the
  // PRE-#243 planRoute (git show 14fea97:app/src/routing/planRoute.ts)
  // against this exact mask/polar/wind fixture — never copied from this PR's
  // own implementation output (the #50 tautology rule).
  const BASELINE_DURATION_MS = 10_724_310.589355469; // genoa, 2.9790 h

  it('Flensburg -> Sonderborg 270: pins the min-clearance and shallow-exposure change against pre-change literals (G.1)', () => {
    const res = planRoute(
      {
        origin: FLENSBURG,
        destination: SOENDERBORG,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'soenderborg',
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
    const rig = sailResult(res, res.recommended);
    expect(rig).not.toBeNull();
    expectLegsNavigable(rig!.legs, DEFAULT_SETTINGS.safetyDepthM);

    // Today's (pre-#243) route measures 3.1 m minimum and 1.32 nm below
    // 4.0 m. Both thresholds sit far from that baseline AND far from this
    // PR's own measured value (4.1 m / 0.00 nm) — pinning the CHANGE, not
    // either implementation's exact arithmetic (§E.3: the search is
    // heuristic and non-monotone in the tuning constant, so pinning an exact
    // value would convert any future retune into a test edit).
    let min = Infinity;
    for (const leg of rig!.legs) {
      const m = mask.segmentShallowestBelow(leg.start, leg.end, 1e6);
      min = Math.min(min, m === null ? 25.4 : m);
    }
    expect(min).toBeGreaterThan(3.5);
    expect(exposureNm(rig!.legs, 4.0)).toBeLessThan(0.4);

    // Time envelope from independent arithmetic: the pre-change baseline is
    // 2.9790 h; a gate-only (different mechanism) alternative independently
    // measures +1.55%, this PR's own measurement +1.39%. 8% sits far above
    // every measured cost and far below anything indicating the solver
    // started padding.
    expect(rig!.durationMs).toBeGreaterThan(BASELINE_DURATION_MS * 0.92);
    expect(rig!.durationMs).toBeLessThan(BASELINE_DURATION_MS * 1.08);
  });

  // #243 §C.1's regression guard — the most important test in this plan. An
  // earlier (superseded) distance-encoded form of this fix turned this exact
  // passage into 'unreachable': reshuffling which candidate wins a prune
  // bucket in Bagenkop's approach pocket stranded the only surviving path.
  // The shipped (pre-#243) solver itself already only finds genoa here (fock
  // dies) — this test pins the REQUIRED property (still routes, #53's
  // contract intact), not the bonus (this implementation, measured,
  // recovers fock too).
  it(
    'Bagenkop -> Marstal at DEFAULT_SETTINGS still routes (the regression a superseded encoding introduced)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const res = planRoute(
        {
          origin: BAGENKOP,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'bagenkop',
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
      expect(res.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      const rig = sailResult(res, res.recommended);
      expect(rig).not.toBeNull();
      expectLegsNavigable(rig!.legs, res.shallow!.usedDepthM);
      // #494 §(a): the second RELAXED-path call site. Same pinch as the
      // Flensburg case — Marstal's pocket is what only 4-connects below
      // 2.4 m — reached from the opposite side of the fjord, so the origin
      // anchor is 7.3 nm away here against 38.4 nm there.
      expectRelaxedWaterConfinedToPinch(
        rig!.legs,
        res.shallow!.requestedDepthM,
        res.snappedDestination,
        'Bagenkop -> Marstal: relaxed water away from the Marstal pinch',
      );
    },
  );

  // #243 mechanism-2 assertion (G.4): the relaxed gate no longer licenses
  // sub-requested-depth water along the WHOLE passage — only where the pinch
  // actually forces it. usedDepthM===2.3 proves the relaxation was not
  // removed; the tightened exposure bound proves it was localized.
  // Pre-change literal (measured on develop before #243 existed): 1.33 nm.
  // This PR's own measured value: ~0.23 nm. The 0.6 nm threshold sits
  // strictly between the two.
  it(
    'Flensburg -> Marstal at DEFAULT_SETTINGS: the relaxed gate is localized to the pinch, not the whole passage (G.4, #243 mechanism 2)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
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
      expect(res.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      const rig = sailResult(res, res.recommended);
      expect(rig).not.toBeNull();
      expect(exposureNm(rig!.legs, 3.0)).toBeLessThan(0.6);
    },
  );

  // §G.5: the strongest available guard against the preference leaking into
  // the no-preference path.
  //
  // #455 CHANGED THIS TEST'S METHOD, not just its numbers. It used to pin
  // full-precision float literals captured from the pre-#243 solver
  // (`git show 14fea97`) on the then-committed mask. Those literals were a
  // SNAPSHOT of one route, so they were only valid for one mask — and #455's
  // `TOLERANCE_M` correction legitimately moved the route, which broke the
  // assertion without anything being wrong with the invariant it names.
  // Worse, the route they pinned is one the corrected mask refuses on
  // purpose: its minimum clearance reads 1.8 m under the conservative
  // resampling (fock 2.0 m), i.e. below the 3.0 m gate AND below the boat's
  // 2.1 m draft. The literals had stopped describing a baseline and started
  // encoding the defect.
  //
  // So the claim is now tested as the INVARIANT it actually is, against a
  // reference computed live on whatever mask is committed: with the margin
  // at 0, `planRoute` must produce exactly what the pre-#243 pipeline
  // produces — `solve()` with `SolveParams.comfortDepthM` ABSENT, followed
  // by the same collinear merge with no comfort argument (planRoute.ts's
  // `comfortDepthM` line and its `run()` spread; postprocess.ts's optional
  // 5th parameter). That is byte-for-byte what planRoute did before #243.
  //
  // This is a DIFFERENTIAL test, not the #50 equivalence tautology: the
  // reference is built from `solve` + `mergeCollinearLegs` directly, while
  // the subject is `planRoute` — the layer that could leak a comfort term
  // (a non-zero default margin, an unconditionally-applied derate, comfort
  // surviving from a #53 relaxed tier). Legs are compared wholesale because
  // every scalar `RigResult` field except `etaMs` is a pure function of them
  // (planRoute.ts's `rigResult` literal), and `etaMs` is asserted separately
  // so the clock is covered too.
  it('depthComfortMarginM: 0 takes the pre-#243 path: identical to a solve() carrying NO comfortDepthM (feature-off identity, G.5)', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 0 };
    const res = planRoute(
      {
        origin: FLENSBURG,
        destination: SOENDERBORG,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'soenderborg',
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
    expect(res.recommended).toBe('genoa');
    expect('shallow' in res).toBe(false);

    /** The pre-#243 pipeline, reconstructed on today's code and this mask. */
    const preFeatureReference = (table: PolarTable) => {
      const o = mask.snapToNavigable(FLENSBURG, settings.safetyDepthM);
      const d = mask.snapToNavigable(SOENDERBORG, settings.safetyDepthM);
      expect(o, 'origin must snap').not.toBeNull();
      expect(d, 'destination must snap').not.toBeNull();
      const wind = new WindField(uniformWindGrid(12, 270));
      const solved = solve({
        origin: o!,
        destination: d!,
        departureMs: T0,
        polar: new Polar(table, settings.performanceFactor),
        wind,
        mask,
        settings,
        // comfortDepthM DELIBERATELY ABSENT — that absence is the whole
        // point of this reference; never add it "for symmetry".
      });
      expect(solved.status, 'the reference solve must itself succeed').toBe('ok');
      if (solved.status !== 'ok') throw new Error('reference solve failed');
      return {
        legs: mergeCollinearLegs(solved.legs, mask, wind, uniformGate(settings.safetyDepthM)),
        etaMs: solved.etaMs,
      };
    };

    for (const [rig, table] of [
      ['genoa', polarGenoa],
      ['fock', polarFock],
    ] as const) {
      const ref = preFeatureReference(table);
      const sail = sailResult(res, rig);
      expect(sail!.legs, `${rig}: margin-0 legs must equal the comfort-free solve`).toEqual(
        ref.legs,
      );
      expect(sail!.etaMs, `${rig}: margin-0 clock must equal the comfort-free solve`).toBe(
        ref.etaMs,
      );
    }
  });

  // Design §D.4 "minimum vs. integral": the preference minimizes total
  // shallow-water exposure along a route (an integral of shortfall), not the
  // route's single shallowest point, so the two CAN diverge. This passage
  // used to be the worked example of that divergence — turning the
  // preference on made the MINIMUM worse (3.7 m off -> 3.0 m on).
  //
  // #455 ENDED THAT DIVERGENCE HERE, and the old prose is now false rather
  // than merely stale, so it is rewritten rather than re-pinned. MEASURED on
  // this passage, comfort-off vs comfort-on, on each mask:
  //     pre-#455 mask:  3.7 m -> 3.0 m   (the documented non-improvement)
  //     corrected mask: 3.7 m -> 4.1 m   (the preference now IMPROVES it)
  // The comfort-OFF route is untouched by #455 (4.3465 nm, identical
  // duration on both masks) — only the preference's own choice moved. Cause:
  // the shallower corridor it used to accept was made of cells reading
  // optimistically; reverted to the conservative max resampling, the
  // integral-minimizing choice now lands on the deeper corridor too.
  //
  // §D.4 IS STILL TRUE AS A GENERAL CLAIM — min and integral can diverge,
  // and nothing here promises they won't. This is a per-route drift
  // detector, not a guarantee that the preference improves the minimum
  // anywhere else.
  //
  // Asserted as a live RELATIONSHIP against a comfort-off run rather than a
  // pinned literal (§E.3: the search is heuristic and non-monotone, and a
  // literal here is mask-derived — it moves on any legitimate mask
  // regeneration, which is exactly how the previous 3.5 m bound came to
  // fail). The two figures above are documentation of this mask, not
  // assertions; the relationship is what a future change must not silently
  // reverse. A regression back to non-improvement reds this test.
  //
  // THIS DETECTOR IS ONE-DIRECTIONAL — say so rather than let a future reader
  // assume otherwise. The removed `min < 3.5` was half of a two-sided band,
  // and its own comment named BOTH directions: not silently regressed further,
  // and not silently "fixed" back toward the baseline. `min > minOff` is
  // strict but UNBOUNDED ABOVE, so after #455 nothing in this file detects
  // drift in the IMPROVEMENT direction — an unexplained jump to, say, 12 m
  // would pass silently. That is a deliberate trade, not an oversight: every
  // ceiling available here is either mask-derived (the failure mode being
  // fixed) or an arbitrary constant with no invariant behind it, and a
  // one-directional detector that says so beats a two-directional one that
  // reds on every regeneration. Reviewer note (PR #476): a "comfort target
  // doubled" mutation was tried as a probe of the improvement side and is
  // INCONCLUSIVE, not reassuring — it left the file 13/13 green because the
  // Drejoe route did not move at all (min stayed 4.1 m, minOff 3.7 m), so the
  // mutation was inert on this passage rather than the assertion being blind.
  // The one-sidedness is a structural property of `toBeGreaterThan`, which no
  // experiment here established or refuted.
  it('Aeroeskoebing -> Drejoe at DEFAULT_SETTINGS: the comfort preference improves this passage minimum rather than degrading it', () => {
    const res = planRoute(
      {
        origin: AEROESKOEBING,
        destination: DREJOE,
        viaPoints: [],
        originHarborId: 'aeroeskoebing',
        destinationHarborId: 'drejoe',
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
    const rig = sailResult(res, res.recommended);
    expect(rig).not.toBeNull();
    expectLegsNavigable(rig!.legs, DEFAULT_SETTINGS.safetyDepthM);
    let min = Infinity;
    for (const leg of rig!.legs) {
      const m = mask.segmentShallowestBelow(leg.start, leg.end, 1e6);
      min = Math.min(min, m === null ? 25.4 : m);
    }
    // Never below the hard gate (redundant with expectLegsNavigable above,
    // stated explicitly since it's the safety-relevant half of the claim).
    expect(min).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.safetyDepthM);

    // The same passage with the preference OFF — the comparison baseline,
    // recomputed live so this survives a mask regeneration.
    const off = planRoute(
      {
        origin: AEROESKOEBING,
        destination: DREJOE,
        viaPoints: [],
        originHarborId: 'aeroeskoebing',
        destinationHarborId: 'drejoe',
        departureMs: T0,
        settings: { ...DEFAULT_SETTINGS, depthComfortMarginM: 0 },
        sailIds: ['genoa', 'fock'],
        boat: defaultBoatSnapshot(),
      },
      uniformWindGrid(12, 270),
      SALONA_DEPS,
    );
    expect(off.status).toBe('ok');
    if (off.status !== 'ok') return;
    const offRig = sailResult(off, off.recommended);
    expect(offRig).not.toBeNull();
    let minOff = Infinity;
    for (const leg of offRig!.legs) {
      const m = mask.segmentShallowestBelow(leg.start, leg.end, 1e6);
      minOff = Math.min(minOff, m === null ? 25.4 : m);
    }
    expect(
      min,
      `comfort-on minimum ${min} m must beat comfort-off ${minOff} m on this passage`,
    ).toBeGreaterThan(minOff);
  });
});

