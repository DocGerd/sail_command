/**
 * #282 ACCEPTANCE SWEEP — the shared engine.
 *
 * Every harbour in the shipped `harbors.json`, across nine settings arms
 * (33 destinations x 9 = 297 plans), against the REAL committed mask and
 * polars. Every `PlanResult` is serialised deterministically so a BASE run
 * and a HEAD run can be compared byte-for-byte: #282's standing requirement
 * is that a change which is meant to be presentational moves NO route.
 *
 * The origin is Flensburg for the original six arms (#450) and Marstal for
 * the three #452 relaxation arms (`margin-zero`, `relaxation-dense`,
 * `margin-extreme`) — see `Arm.originId`'s own doc comment for why.
 *
 * DELIBERATELY OUTSIDE `app/src/`. `vite.config.ts`'s `test.include` is
 * `['src/**\/*.test.{ts,tsx}']`, so nothing here is collected by
 * `npm --prefix app run test` or by CI — this is an on-demand experiment
 * costing ~20 minutes of real solver time, not part of the suite's contract.
 * See `README.md` in this directory for how to run it.
 *
 * BASELINE PARAMETERS ARE LOAD-BEARING. Every constant below — the arm list,
 * each arm's wind field, `T0`, the origin, and the serializer — defines what a
 * stored baseline means. Change any one and previously-recorded output is no
 * longer comparable, which silently destroys the only evidence a future
 * classification change has to argue against. Add a new arm rather than
 * editing an existing one.
 *
 * Imports nothing that exists on only one side of a refactor (no
 * `SolveFailureCause`, no `NO_ROUTE_LABEL_OF_CAUSE`), so the identical file
 * runs unchanged at BASE and at HEAD.
 */
import { expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NavMask } from '../src/lib/mask';
import { planRoute } from '../src/routing/planRoute';
import { uniformWindGrid } from '../src/test/fixtures';
import { boatById, DEFAULT_BOAT_ID, polarKey } from '../src/data/boats';
import { defaultBoatSnapshot, DEFAULT_SETTINGS } from '../src/types';
import type { LatLon, MaskMeta, PolarTable, SailId, Settings, WindGrid } from '../src/types';
import { solverTimeoutMs } from '../src/test/timeouts';
import { ARM_NAMES } from './armNames';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
/** Absolute output directory. REQUIRED — fail closed rather than silently overwrite a default. */
const OUT_DIR = env?.SC_SWEEP_OUT;
/** Optional: first N destinations only, for calibrating a change to this harness. */
const LIMIT = Number(env?.SC_SWEEP_LIMIT ?? '0');

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data');

interface Harbor {
  id: string;
  snap: LatLon;
}

export interface Arm {
  label: string;
  settings: Settings;
  wind: () => WindGrid;
  /**
   * #452: origin harbour id, defaulting to `flensburg` when absent. Every
   * PRE-#452 arm omits this, so it resolves exactly as before — byte-identical
   * to the recorded baseline. Only the three #452 relaxation arms below set
   * it, because Flensburg is the wrong origin for what they need to
   * demonstrate: a mask-connectivity probe over all 528 unique harbour pairs
   * in `harbors.json` (33 choose 2 — the SAME 528 the file-level comment
   * above cites; twin-searched to agree, see #488 review) — `cellsConnected`
   * BFS at the 3.0 m gate vs. down to the 2.1 m `BOAT_DRAFT_M` floor, run
   * once per origin against all 32 other harbours as destinations, as a
   * one-off exploration, not part of this committed harness — found that
   * from any of the 27 GIANT-COMPONENT origins (every harbour except the 5
   * below), exactly 1 of the other 32 harbours needs depth relaxation at all
   * (Marstal itself); from Marstal, 27 of 32 do; from any of the 5 #9
   * KNOWN_DISCONNECTED harbours — arnis, kappeln, maasholm, dyvig,
   * graasten — ZERO of the other 32 do, not 1: those 5 are unreachable at
   * any gate down to the draft floor, INCLUDING from each other and from
   * Marstal, so relaxation cannot help them regardless of which harbour
   * they are paired with. (A prior version of this comment said "from ANY
   * origin other than Marstal, only 1 … needs depth relaxation", which is
   * false for exactly these 5 — corrected in the #452 fix wave.)
   *
   * WHY MARSTAL-AS-ORIGIN (not Marstal-as-destination, which
   * `docs/spikes/452-local-depth-relaxation.md` §4(b) "The sweep cannot
   * currently discriminate a correct fix from a silently broken one"
   * ("Both judges: add a relaxation-exercising arm (a Marstal-destination
   * arm...)") recommends) IS A SOUND SUBSTITUTE. `cellsConnected` being
   * symmetric only establishes that
   * relaxation FIRES the same way for `(marstal, X)` and `(X, marstal)` — it
   * says nothing about whether a future SCOPED implementation would COVER
   * both directions identically, and a one-ended design (e.g. "only widen
   * the gate near the origin") would falsify that on its own. What actually
   * carries the substitution: all three spike designs scope relaxation on
   * the SNAPPED WAYPOINT SET, not on a direction — P3's `gateAtCell` widens
   * the gate for any cell within `APPROACH_RADIUS_M` of "a snapped waypoint"
   * (same doc, §2.3 "P3 — Approach-scoped relaxation ('relaxation discs')",
   * Mechanism paragraph: "gateAtCell(cell) returns the relaxed gate..."),
   * and P1/P2 are likewise keyed off "origin, destination, and every via"
   * as an unordered set (§1.4 "Snapping happens at the requested gate and
   * is not relaxable", same phrase verbatim; and §2.3's own Invariant
   * paragraph, "No leg ... unless that cell lies within
   * `APPROACH_RADIUS_M` of a snapped waypoint"). `{marstal_snap, X_snap}`
   * is the IDENTICAL set
   * whichever end Marstal sits at, so any of the three scoped designs would
   * treat a `margin-zero`/`relaxation-dense`/#-forcing plan through this
   * arm's Marstal-origin pairs exactly as it would treat the spike's
   * suggested Marstal-destination pairs. This arm is Marstal-origin purely
   * because it reuses `runArm()`'s existing destination-loop shape
   * unmodified — the alternative needs a second, structurally different
   * origin-loop shape for no additional discriminating coverage. See #452's
   * issue thread for the reconciliation note against the spike's literal
   * wording.
   */
  originId?: string;
}

/** Departure instant. Part of the baseline identity — never "refresh" it. */
export const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

/**
 * The first six arms below, with the role each one actually plays — MEASURED
 * on the 2026-08-07 baseline (198 plans), not assumed. Gate counts below are
 * `depthRelaxationMayHelp` true/false and come from an instrumented run.
 *
 *   breeze          - ordinary sailing breeze; 27 `ok`. The happy path, and
 *                     (with no-comfort) the source of the only two plans
 *                     carrying a #53 shallow warning. Gate 6/0.
 *   no-comfort      - `depthComfortMarginM: 0` => `comfortDepthM` undefined =>
 *                     the byte-identical pre-#243 path, on which the #243
 *                     tier-2 retry is unreachable and `comfortRetryMayHelp` is
 *                     never consulted at all. Shares breeze's wind field, but
 *                     only 6 of 33 rows match it — the comfort margin really
 *                     does move 27 of 33 routes. Gate 6/0.
 *   short-horizon   - a 3 h forecast grid. THE reason all three causes are
 *                     reachable: it alone contributes 26 of the 28
 *                     `beyond-horizon` outcomes and 21 of the 23
 *                     `horizon-exceeded` gate observations. Gate 11/20.
 *   light-motorless - #282's own configuration, verbatim: uniform TWS 3 /
 *                     dir 0, `motorEnabled: false`, otherwise DEFAULT_SETTINGS.
 *                     TWS is below the polar's 4 kn floor (scaled linearly to
 *                     0), so the boat is slow and the search exhausts. The
 *                     heaviest relaxation arm. Gate 16/2.
 *   becalmed        - TWS far below the polar floor + engine off => every
 *                     candidate heading dies calm => cause
 *                     'calm-without-motor', which both gates must reject.
 *                     Gate 6/27.
 *   deep-becalmed   - the same at a 4.0 m gate. Its real and UNIQUE
 *                     contribution is the 3 `snap-failed-destination` rows no
 *                     other arm produces — the pre-solve failure path. Note
 *                     what it does NOT do: the relaxation gate fires TRUE 6
 *                     times here, identical to breeze, no-comfort and
 *                     becalmed, so a deeper gate does NOT relax "far more
 *                     often" (an earlier version of this comment claimed it
 *                     did; the counters refute it). Gate 6/24.
 *
 * #452 ADDS the three arms below, all Marstal-origin, because the six arms
 * above are structurally unable to discriminate a depth-relaxation change.
 * `depthRelaxationMayHelp` is consulted (and answers true) 51 of 198 times
 * across the six arms — README.md's gate-coverage table — so the GATE itself
 * is not rare: `planRoute.ts`'s relaxation block opens on `mask-blocked`
 * alone, and the five #9 KNOWN_DISCONNECTED harbours (arnis, kappeln,
 * maasholm, dyvig, graasten) enter it too on EVERY Flensburg-origin row that
 * names one — they run `findRelaxedGate`'s full probe search and take its
 * NULL-RESULT path (no candidate gate connects — since #452 the null is the
 * whole result, never a `usedDepthM` field set to null) before falling
 * through to `unreachable`, real if weak coverage (a future scoping bug that
 * made one of them suddenly relax would be caught here). What IS rare is a
 * SUCCESSFUL relaxation: only
 * 27 of the 528 unique harbour pairs in `harbors.json` (33 choose 2) are
 * mask-connected at a relaxed gate at all, and every one of the 27 involves
 * Marstal — measured via a `cellsConnected` BFS probe over every pair at the
 * 3.0 m gate (see `Arm.originId`'s doc comment). At Flensburg origin only
 * ONE of the 33 per-arm rows (the Marstal leg) can ever carry a SUCCESSFUL
 * relaxation (a `shallow` block) — so the existing arms carry at most 1/33
 * discriminating power for the mechanism this PR needs coverage of —
 * `breeze` and `no-comfort` are, per the header above, the source of the
 * ONLY two plans across all 198 with a #53 shallow warning.
 *
 * TIER-REACH METHOD, shared by `relaxation-dense` and `margin-extreme`
 * below: temporary `__SWEEP_TIER_DEBUG: string[]` instrumentation added to
 * `planRoute.ts` (one `push('tier1'|'tier2'|'tier3'|'tier4'|…)` immediately
 * before each of its `return assemble(...)` call sites, reverted before
 * commit — zero diff under `app/src/` in the shipped PR), read after each
 * `planRoute()` call in a throwaway probe script run against the real
 * committed mask/polars for all 27 Marstal-origin relaxable destinations.
 * VALIDATED behaviour-neutral: every `result.status` produced by the
 * instrumented run matched the corresponding row of the already-generated
 * (uninstrumented) arm output file, so the instrumentation observed the real
 * control flow rather than perturbing it. Independently reproduced twice —
 * once during PR #488 review, once in the fix wave that followed — with
 * identical tier-4 row sets both times. Re-run this method (not just cited
 * numbers) to verify any claim below against a future `planRoute.ts` — the
 * tier boundaries themselves are not pinned by any committed test.
 *
 *   margin-zero       - `depthComfortMarginM: 0` at Marstal origin — the
 *                     purest unprotected relaxation case. `edgeFactor`
 *                     (isochrone.ts) short-circuits to a bare
 *                     `mask.segmentNavigable(a, b, gateM) ? 1 : null` whenever
 *                     `comfortDepthM === undefined` (verified by reading
 *                     `edgeFactor`'s own guard, `if (comfortDepthM ===
 *                     undefined || comfortDepthM <= gateM) return
 *                     mask.segmentNavigable(a, b, gateM) ? 1 : null;`), so
 *                     there is no comfort pricing and no #243 merge
 *                     protection at all — every relaxed-tier leg is priced
 *                     exactly as the pre-#243 solver priced it, and neither
 *                     retry gate is even reachable (`comfortDepthM !==
 *                     undefined` guards both, planRoute.ts), so this arm can
 *                     NEVER produce a tier2/tier4 row by construction.
 *                     DELIBERATELY NOT Flensburg-origin: the existing
 *                     `no-comfort` arm already IS `depthComfortMarginM: 0` at
 *                     Flensburg with this same wind field, so a literal
 *                     Flensburg-origin reading of "margin-zero" would be
 *                     byte-identical to `no-comfort` — a second arm testing
 *                     nothing `no-comfort` doesn't already, the exact
 *                     "another `becalmed`" trap this issue exists to avoid.
 *                     Marstal origin makes it a genuinely new arm: 27 of 32
 *                     rows exercise relaxation, all of them with comfort
 *                     pricing OFF end to end.
 *   relaxation-dense  - Marstal origin, plain DEFAULT_SETTINGS (comfort
 *                     margin 2.0 m, the shipped default) — the normal-usage
 *                     counterpart to margin-zero: relaxation WITH #243
 *                     comfort pricing active, across the same 27 pairs. THE
 *                     BROADEST tier-4 exerciser of the three #452 arms —
 *                     by the TIER-REACH METHOD above, 11 of its 27 rows
 *                     (`aabenraa`, `augustenborg`, `damp`, `flensburg`,
 *                     `gelting-mole`, `hoeruphav`, `mommark`, `olpenitz`,
 *                     `schleimuende`, `soenderborg`, `wackerballig`) resolve
 *                     via tier 4, a STRICT SUPERSET of `margin-extreme`'s 3
 *                     below. Also the arm with the most genuinely NEW route
 *                     geometry over `margin-zero`: only 16 of 33 rows differ
 *                     from it byte-for-byte (PR #488 review), so the shipped
 *                     2.0 m default margin changes fewer routes than it
 *                     might look like from the arm count alone.
 *   margin-extreme    - Marstal origin, `depthComfortMarginM: 8.0` +
 *                     `safetyDepthM: 2.9` — an inflated comfort margin
 *                     against a safety depth just above `BOAT_DRAFT_M`
 *                     (2.1 m). NOT a "tier-4-forcing" arm — an EARLIER
 *                     version of this comment claimed inflating the margin
 *                     forces tier 4, which is BACKWARDS: by the TIER-REACH
 *                     METHOD above, this arm resolves via tier 4 on only 3 of
 *                     its 27 rows (`damp`, `olpenitz`, `schleimuende`) — a
 *                     STRICT SUBSET of `relaxation-dense`'s 11, not a
 *                     superset. `depthComfortMarginM: 4.0` at the same
 *                     `safetyDepthM: 2.9`, and `depthComfortMarginM: 8.0` at
 *                     the default `safetyDepthM: 3.0`, both reproduce the
 *                     IDENTICAL 3-row set (PR #488 review, independently
 *                     re-verified in this fix wave) — so those 3 rows are a
 *                     margin-INDEPENDENT structural core (they resolve via
 *                     tier 4 at every tested margin >= 4.0), while the other
 *                     8 of `relaxation-dense`'s 11 are specific to the
 *                     shipped 2.0 m default and vanish at any larger margin
 *                     tested. What this arm actually discriminates: it
 *                     isolates that ROBUST 3-row core from the
 *                     margin-SPECIFIC remainder — real, useful evidence, just
 *                     not "more tier-4 coverage than relaxation-dense". Its
 *                     mechanism, for a future investigator: comfort pricing
 *                     derates an edge's ranking cost toward
 *                     `(1 - DEPTH_DERATE_MAX)` as clearance approaches the
 *                     gate REGARDLESS of margin size (the ramp's endpoint is
 *                     margin-invariant — see `edgeFactor`'s shortfall
 *                     arithmetic), but a SMALL margin reaches that endpoint
 *                     over a much SHORTER clearance range, concentrating the
 *                     ranking distortion sharply at the pinch point; a LARGE
 *                     margin spreads the same ramp over a wider depth range,
 *                     diluting it. This is a plausible mechanical account of
 *                     why a large margin SUPPRESSES rather than forces tier-4
 *                     entry — stated as a hypothesis, not verified by tracing
 *                     the search itself.
 */
export const ARMS: Record<(typeof ARM_NAMES)[number], Arm> = {
  breeze: { label: 'breeze', settings: DEFAULT_SETTINGS, wind: () => uniformWindGrid(12, 225) },
  'no-comfort': {
    label: 'no-comfort',
    settings: { ...DEFAULT_SETTINGS, depthComfortMarginM: 0 },
    wind: () => uniformWindGrid(12, 225),
  },
  'short-horizon': {
    label: 'short-horizon',
    settings: DEFAULT_SETTINGS,
    wind: () => uniformWindGrid(12, 225, { hours: 3 }),
  },
  'light-motorless': {
    label: 'light-motorless',
    settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
    wind: () => uniformWindGrid(3, 0),
  },
  becalmed: {
    label: 'becalmed',
    settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
    wind: () => uniformWindGrid(0.15, 0),
  },
  'deep-becalmed': {
    label: 'deep-becalmed',
    settings: { ...DEFAULT_SETTINGS, motorEnabled: false, safetyDepthM: 4.0 },
    wind: () => uniformWindGrid(0.15, 0),
  },
  'margin-zero': {
    label: 'margin-zero',
    settings: { ...DEFAULT_SETTINGS, depthComfortMarginM: 0 },
    wind: () => uniformWindGrid(12, 225),
    originId: 'marstal',
  },
  'relaxation-dense': {
    label: 'relaxation-dense',
    settings: DEFAULT_SETTINGS,
    wind: () => uniformWindGrid(12, 225),
    originId: 'marstal',
  },
  'margin-extreme': {
    label: 'margin-extreme',
    settings: { ...DEFAULT_SETTINGS, depthComfortMarginM: 8.0, safetyDepthM: 2.9 },
    wind: () => uniformWindGrid(12, 225),
    originId: 'marstal',
  },
};

/**
 * Deterministic serialization. `JSON.stringify(value, replacer, 1)` — the
 * 1-space indent is part of the baseline identity, not cosmetics: it fixes the
 * byte layout every stored comparison was made against. Non-finite numbers
 * become explicit sentinels because JSON would otherwise turn NaN/Infinity
 * into `null` and quietly erase a real difference.
 */
export function serialize(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? `#nf:${String(v)}` : v),
    1,
  );
}

export function runArm(label: (typeof ARM_NAMES)[number]): void {
  const arm = ARMS[label];
  if (!arm) throw new Error(`unknown sweep arm ${label}`);

  const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
  const mask = new NavMask(maskMeta, new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))));
  // #54: read straight off the catalogue rather than by literal filename, so
  // the harness needs no edit when a boat is added. The keys are what
  // `PlanDeps.polars` is looked up by.
  const boat = boatById(DEFAULT_BOAT_ID);
  const polars: Record<string, PolarTable> = {};
  for (const sail of boat.sails) {
    polars[polarKey(boat.id, sail.id)] = JSON.parse(
      // `polarAsset` is public-root-relative (`data/polars/*.json`) because the
      // browser fetches it under BASE_URL; `dataDir` is already inside
      // `public/`, hence the `..`.
      readFileSync(resolve(dataDir, '..', sail.polarAsset), 'utf8'),
    ) as PolarTable;
  }
  // #553/#549: derived from the SAME `boat` resolved above, never a bare
  // `['genoa', 'fock']` literal. `PlanRequest.sailIds` IS the solve order
  // (spec §E.3), so a hardcoded pair silently pins the sweep to two sail ids
  // that the catalogue may rename, reorder or extend — and because the sweep
  // lives outside `app/src/`, the #54 structural guard
  // (`src/test/sailLiteralCallSites.test.ts`) does not scan this file and
  // could never have reported the literal.
  //
  // Byte-identical to the previous literal at today's catalogue (the Salona
  // 45's sails are `genoa` then `fock`, in that order), so no recorded
  // baseline is invalidated by this change alone. It is the derivation, not
  // the current value, that is the point.
  //
  // The `as SailId` cast mirrors `data/boats.ts`'s own DEFAULT_SAIL_IDS:
  // `SailDef.id` is declared plain `string` (SailDef is the general per-boat
  // shape, not narrowed to any one boat's literal ids) while `SailId` is the
  // catalogue-derived union, and `boat` here always IS a catalogue entry.
  const sailIds: readonly SailId[] = boat.sails.map((s) => s.id as SailId);

  const harbors = JSON.parse(readFileSync(resolve(dataDir, 'harbors.json'), 'utf8')) as Harbor[];
  // #452: origin defaults to flensburg — every pre-#452 arm omits `originId`,
  // so this resolves exactly as it always has.
  const originId = arm.originId ?? 'flensburg';
  const origin = harbors.find((h) => h.id === originId);
  if (!origin) throw new Error(`#282/#452 sweep: harbors.json has no \`${originId}\` entry`);

  it(
    `#282 sweep arm ${label}: ${originId} -> all harbours`,
    () => {
      // Fail closed, and inside the test so the whole file still collects when
      // the variable is unset (a thrown error at module scope reads as a
      // collection crash rather than an actionable message).
      expect(OUT_DIR, '#282 sweep: set SC_SWEEP_OUT to an absolute output directory').toBeTruthy();
      const outDir = OUT_DIR as string;
      mkdirSync(outDir, { recursive: true });

      const dests = LIMIT > 0 ? harbors.slice(0, LIMIT) : harbors;
      const windGrid = arm.wind();
      const rows: Record<string, unknown> = {};
      const timings: Record<string, number> = {};
      for (const h of dests) {
        const t = Date.now();
        rows[h.id] = planRoute(
          {
            origin: origin.snap,
            destination: h.snap,
            viaPoints: [],
            originHarborId: originId,
            destinationHarborId: h.id,
            departureMs: T0,
            settings: arm.settings,
            sailIds,
            // #54 Task 11: required by PlanRequest. The solver takes its boat
            // from PlanDeps.boat, never from the request, so this field does
            // not reach the search and the recorded baseline is unaffected.
            boat: defaultBoatSnapshot(),
          },
          windGrid,
          { polars, boat, mask },
        );
        timings[h.id] = Date.now() - t;
      }
      writeFileSync(resolve(outDir, `${label}.json`), serialize(rows));
      writeFileSync(resolve(outDir, `${label}.timings.json`), serialize(timings));
      expect(Object.keys(rows).length).toBe(dests.length);
    },
    solverTimeoutMs(3_600_000),
  );
}
