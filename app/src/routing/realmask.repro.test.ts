import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NavMask } from '../lib/mask';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { solve } from './isochrone';
import { mergeCollinearLegs } from './postprocess';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import type { LatLon, Leg, MaskMeta, PolarTable, Settings } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

// Regression tests for issue #20: the solver returned 'unreachable' for real
// harbor-to-harbor routes because a full isochrone step (0.5-2 km) is longer
// than real harbor arms are straight (~200-400 m wide), so every candidate
// died on the first expansion. These run against the real shipped mask and
// polars, unlike the synthetic masks used everywhere else in the suite.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const mask = new NavMask(maskMeta, new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))));
const polarGenoa = JSON.parse(
  readFileSync(resolve(dataDir, 'polar-genoa.json'), 'utf8'),
) as PolarTable;
const polarFock = JSON.parse(
  readFileSync(resolve(dataDir, 'polar-fock.json'), 'utf8'),
) as PolarTable;

// Real harbor snap coordinates from harbors.json
const FLENSBURG: LatLon = { lat: 54.798, lon: 9.4335 };
const GLUECKSBURG: LatLon = { lat: 54.8415, lon: 9.5225 };
const MARSTAL: LatLon = { lat: 54.8579, lon: 10.528 };
const SOENDERBORG: LatLon = { lat: 54.9046, lon: 9.7833 };
const BAGENKOP: LatLon = { lat: 54.753, lon: 10.668 };
const AEROESKOEBING: LatLon = { lat: 54.8935, lon: 10.416 };
const DREJOE: LatLon = { lat: 54.9645, lon: 10.439 };
// Open-water anchors (navigable at 3.0 m in the shipped mask)
const FJORD_MOUTH: LatLon = { lat: 54.83, lon: 9.9 };
const OPEN_BALTIC: LatLon = { lat: 54.75, lon: 10.3 };

const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

function solveGenoa(
  origin: LatLon,
  destination: LatLon,
  dirFromDeg: number,
  settings: Settings,
  onProgress?: (info: { tMs: number; frontierSize: number }) => void,
) {
  const o = mask.snapToNavigable(origin, settings.safetyDepthM);
  const d = mask.snapToNavigable(destination, settings.safetyDepthM);
  if (!o || !d) throw new Error('snap failed');
  return solve({
    origin: o,
    destination: d,
    departureMs: T0,
    polar: new Polar(polarGenoa, settings.performanceFactor),
    wind: new WindField(uniformWindGrid(12, dirFromDeg)),
    mask,
    settings,
    onProgress,
  });
}

/** Every leg the planner emits must itself be navigable at the plan's safety depth. */
function expectLegsNavigable(legs: Leg[], safetyDepthM: number) {
  for (const leg of legs)
    expect(
      mask.segmentNavigable(leg.start, leg.end, safetyDepthM),
      `leg ${JSON.stringify(leg.start)} -> ${JSON.stringify(leg.end)} crosses non-navigable water`,
    ).toBe(true);
}

/**
 * #243 §E's EXACT sub-threshold exposure metric: sample each leg every
 * ~15 m (well under the 46 m cell) and sum the sampled length whose cell is
 * charted below `thresholdM`. A whole-leg ("charge the leg if any cell is
 * shallow") metric over-states exposure by 3-4x and is not comparable across
 * routes with different leg counts — never use one for this feature.
 */
function exposureNm(legs: Leg[], thresholdM: number): number {
  const STEP_NM = 15 / 1852;
  let nm = 0;
  for (const leg of legs) {
    const n = Math.max(2, Math.ceil(leg.distanceNm / STEP_NM));
    const seg = leg.distanceNm / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p: LatLon = {
        lat: leg.start.lat + (leg.end.lat - leg.start.lat) * t,
        lon: leg.start.lon + (leg.end.lon - leg.start.lon) * t,
      };
      const info = mask.depthInfoM(p);
      const d = info.capped ? 25.4 : info.depthM;
      if (d < thresholdM) nm += seg;
    }
  }
  return nm;
}

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
      },
      uniformWindGrid(12, 270),
      { polarGenoa, polarFock, mask },
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    for (const rig of [res.genoa, res.fock]) {
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
        },
        uniformWindGrid(12, 270),
        { polarGenoa, polarFock, mask },
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      // Explicitly-requested 2.3 m needs no relaxation: no shallow warnings.
      expect('shallow' in res).toBe(false);
      const rig = res.recommended === 'genoa' ? res.genoa : res.fock;
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
      expect(mask.cellsConnected(o!, d!, 2.3)).toBe(true);
      expect(mask.cellsConnected(o!, d!, 2.4)).toBe(false);

      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
        },
        uniformWindGrid(12, 270),
        { polarGenoa, polarFock, mask },
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
      for (const rig of [res.genoa, res.fock]) {
        expect(rig).not.toBeNull();
        expect(rig!.distanceNm).toBeGreaterThan(30);
        expect(rig!.durationMs).toBeLessThan(12 * 3_600_000);
        expectLegsNavigable(rig!.legs, res.shallow!.usedDepthM);
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
      },
      uniformWindGrid(12, 270),
      { polarGenoa, polarFock, mask },
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const rig = res.recommended === 'genoa' ? res.genoa : res.fock;
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
        },
        uniformWindGrid(12, 270),
        { polarGenoa, polarFock, mask },
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.shallow).toBeDefined();
      expect(res.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      const rig = res.recommended === 'genoa' ? res.genoa : res.fock;
      expect(rig).not.toBeNull();
      expectLegsNavigable(rig!.legs, res.shallow!.usedDepthM);
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
        },
        uniformWindGrid(12, 270),
        { polarGenoa, polarFock, mask },
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.shallow).toBeDefined();
      expect(res.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      const rig = res.recommended === 'genoa' ? res.genoa : res.fock;
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
      },
      uniformWindGrid(12, 270),
      { polarGenoa, polarFock, mask },
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
        legs: mergeCollinearLegs(solved.legs, mask, wind, settings),
        etaMs: solved.etaMs,
      };
    };

    for (const [rig, table] of [
      ['genoa', polarGenoa],
      ['fock', polarFock],
    ] as const) {
      const ref = preFeatureReference(table);
      expect(res[rig]!.legs, `${rig}: margin-0 legs must equal the comfort-free solve`).toEqual(
        ref.legs,
      );
      expect(res[rig]!.etaMs, `${rig}: margin-0 clock must equal the comfort-free solve`).toBe(
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
      },
      uniformWindGrid(12, 270),
      { polarGenoa, polarFock, mask },
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const rig = res.recommended === 'genoa' ? res.genoa : res.fock;
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
      },
      uniformWindGrid(12, 270),
      { polarGenoa, polarFock, mask },
    );
    expect(off.status).toBe('ok');
    if (off.status !== 'ok') return;
    const offRig = off.recommended === 'genoa' ? off.genoa : off.fock;
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

describe('issue #265: the mirror case — genuinely mask-limited must stay unreachable', () => {
  // Flensburg -> Marstal at the REQUESTED 3.0 m gate is genuinely
  // mask-disconnected (documented in this file's DEFAULT_SETTINGS test above
  // and in issue #9): the shipped mask only 4-connects Flensburg to Marstal
  // at gates <= 2.3 m. This is the #265 review's Blocker-2 concern in
  // concrete form — a light-air, motor-off plan against a destination that
  // is disconnected for reasons having NOTHING to do with wind. A
  // reclassification that makes masked-but-slow headings read as "calm"
  // (the subFloor idea evaluated and REJECTED in this PR — see the PR
  // description) would make this exact case regress to 'calm-motor-off',
  // telling the user to wait for wind that can never help. Ground truth
  // comes from an independent oracle (mask.cellsConnected), not from
  // solve()/planRoute() itself.
  const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: false };

  it('is mask-disconnected at the requested 3.0 m gate but connected at 2.3 m (independent oracle)', () => {
    const o = mask.snapToNavigable(FLENSBURG, settings.safetyDepthM);
    const d = mask.snapToNavigable(MARSTAL, settings.safetyDepthM);
    expect(o).not.toBeNull();
    expect(d).not.toBeNull();
    expect(mask.cellsConnected(o!, d!, 3.0)).toBe(false);
    expect(mask.cellsConnected(o!, d!, 2.3)).toBe(true);
  });

  it(
    'a light-air, motor-off plan reports unreachable, not calm-motor-off, even though #53 relaxation is attempted',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      // Measured directly (not derived from this PR's own reasoning): #53's
      // relaxed-gate mechanism DOES fire here (reason defaults to
      // 'unreachable' from the disconnected-at-3.0m fast path, which is the
      // relaxation trigger), finds the same 2.3 m gate as the DEFAULT_SETTINGS
      // test above, and re-solves both rigs there under this scenario's
      // light air + motor-off settings — which still fails (the pinch is
      // narrow enough that the solver can't thread it at this wind/motor
      // combination), so the plan correctly falls through to 'unreachable'
      // rather than being coerced into 'calm-motor-off'.
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings,
        },
        uniformWindGrid(3, 0),
        { polarGenoa, polarFock, mask },
      );
      // Split so a red run names WHICH fact broke: `status` is the
      // solver-capability/mask-connectivity fact (would flip to 'ok' if
      // either the mask reconnects at 3.0 m OR the relaxed 2.3 m re-solve
      // starts succeeding — both "good news", neither a classification
      // regression), while `reason` is the actual classification guard this
      // test exists to protect. A single `toEqual` would report both as one
      // failure and couldn't tell them apart.
      expect(res.status).toBe('error');
      if (res.status === 'error') expect(res.reason).toBe('unreachable');
    },
  );
});
