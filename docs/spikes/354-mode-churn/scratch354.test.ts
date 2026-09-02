/**
 * #354 REPRODUCTION DRIVER — measures "motor -> short sail -> motor" churn
 * vs. the #264 "motor-tacking weave" on six curated routes, against the REAL
 * committed mask/polars, via planRoute() only (no solver edit).
 *
 * NOT part of the sweep's committed arm set — a standalone, throwaway
 * measurement instrument. Run with:
 *   npm --prefix app run test -- --config sweep/vitest.config.ts scratch354.test.ts
 * (from the repo root) or, from app/:
 *   npx vitest run --config sweep/vitest.config.ts scratch354.test.ts
 *
 * Discipline (see CLAUDE.md's app/sweep/ and #354 bullets):
 *  - Real committed mask.bin/mask.meta.json + polar tables.
 *  - uniformWindGrid() from src/test/fixtures (default hours=48, matching
 *    sweepArms.ts's own uniformWindGrid(12,225) usage).
 *  - DEFAULT_SETTINGS, DEFAULT_BOAT_ID, T0 = sweepArms.ts's own departure.
 *  - Reuses sweepArms.ts's own `serialize()` so fingerprints are directly
 *    comparable to any #282 baseline artefact.
 *  - Two full runs; every fingerprint must match run-to-run before any
 *    number here is trusted (this file's own required-BASE-double-run
 *    analogue, at repro scale).
 *  - Pre-merge leg counts are recovered by SPYING on postprocess.ts's
 *    exported `mergeCollinearLegs` via `vi.spyOn` (test-harness
 *    instrumentation from OUTSIDE app/src/, not a source edit — zero diff
 *    under app/src/). `mergeCollinearLegs` is only ever invoked on a
 *    SUCCESSFUL segment solve (planRoute.ts's `run()`: the call sits after
 *    the `res.status !== 'ok'` early return), and `runAll()` is used
 *    immediately once ANY sail in a tier succeeds (`tier1.some(r =>
 *    r.rigResult) => return assemble(tier1, null)`, and the same shape at
 *    every later tier) — so no tier before the one actually assembled can
 *    ever have produced a successful (and therefore merge-recorded) sail.
 *    That means the spy's call COUNT for one planRoute() invocation always
 *    equals the number of non-null SailResults in the final PlanResult, and
 *    the calls arrive in solve order (sailIds order, since #340/#54 pins
 *    `runAll` to a synchronous `.map()`) — so zipping calls with the
 *    successful sailIds in order is a SOUND pairing, not an assumption. The
 *    driver still checks this invariant explicitly per plan and marks a row
 *    CONFOUNDED rather than silently mispairing if it ever fails.
 */
import { it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as postprocess from '../src/routing/postprocess';
import { planRoute } from '../src/routing/planRoute';
import { NavMask } from '../src/lib/mask';
import { uniformGate } from '../src/lib/depthGate';
import { uniformWindGrid } from '../src/test/fixtures';
import { defaultBoatSnapshot, DEFAULT_SETTINGS } from '../src/types';
import type {
  Leg,
  LatLon,
  MaskMeta,
  PlanResult,
  PlanResultOk,
  PolarTable,
  SailId,
  Settings,
} from '../src/types';
import { boatById, DEFAULT_BOAT_ID, polarKey } from '../src/data/boats';
import { normalizeDeg180 } from '../src/lib/geo';
import { solverTimeoutMs } from '../src/test/timeouts';
import { serialize } from './sweepArms';

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data');

/** #354's own departure instant — identical to sweepArms.ts's T0. */
const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
/**
 * Output directory for the JSON dumps this driver writes. Defaults to a
 * sibling of this file so a bare run always produces something readable —
 * unlike sweepArms.ts's OUT_DIR this is NOT fail-closed, because this is a
 * throwaway repro driver, not a committed baseline artefact.
 */
const OUT_DIR =
  env?.SC_DRIVER_OUT ?? resolve(dirname(fileURLToPath(import.meta.url)), 'scratch354-out');

interface Harbor {
  id: string;
  snap: LatLon;
}

interface RouteSpec {
  id: string;
  origin: string;
  dest: string;
  twsKn: number;
  wdirDeg: number;
  why: string;
}

// Control (R6) printed FIRST, per the brief.
const ROUTES: RouteSpec[] = [
  {
    id: 'R6-control',
    origin: 'flensburg',
    dest: 'gelting-mole',
    twsKn: 12,
    wdirDeg: 225,
    why: 'CONTROL — reuses breeze arm wind field; every heading clears the 3.7kn floor, expect zero mode changes.',
  },
  {
    id: 'R1-primary-churn',
    origin: 'flensburg',
    dest: 'soenderborg',
    twsKn: 4,
    wdirDeg: 62,
    why: 'PRIMARY CHURN PROBE — archetypal light-air beat, dead upwind, motor/sail alternation expected.',
  },
  {
    id: 'R2-confined-beat',
    origin: 'flensburg',
    dest: 'gluecksburg',
    twsKn: 4.5,
    wdirDeg: 50,
    why: 'CONFINED-WATER BEAT, short — exercises the origin-pocket dtS substep retry.',
  },
  {
    id: 'R3-narrow-fairway',
    origin: 'svendborg',
    dest: 'troense',
    twsKn: 5,
    wdirDeg: 140,
    why: 'NARROWEST FAIRWAY — Svendborgsund; honest risk of a short plan or no-route.',
  },
  {
    id: 'R4-downwind-knife-edge',
    origin: 'aeroeskoebing',
    dest: 'soeby',
    twsKn: 5.5,
    wdirDeg: 120,
    why: 'DOWNWIND KNIFE-EDGE — dead-run boundary between sail-locked and motorable arcs.',
  },
  {
    id: 'R5-beam-reach-shoals',
    origin: 'faaborg',
    dest: 'avernakoe',
    twsKn: 4.5,
    wdirDeg: 260,
    why: 'BEAM REACH THROUGH SHOALS — control-within-the-churn-set; isolates mask-forced course changes from beating.',
  },
];

function loadDeps() {
  const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
  const mask = new NavMask(maskMeta, new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin'))));
  const boat = boatById(DEFAULT_BOAT_ID);
  const polars: Record<string, PolarTable> = {};
  for (const sail of boat.sails) {
    polars[polarKey(boat.id, sail.id)] = JSON.parse(
      readFileSync(resolve(dataDir, '..', sail.polarAsset), 'utf8'),
    ) as PolarTable;
  }
  const harbors = JSON.parse(readFileSync(resolve(dataDir, 'harbors.json'), 'utf8')) as Harbor[];
  const sailIds: readonly SailId[] = boat.sails.map((s) => s.id as SailId);
  return { mask, boat, polars, harbors, sailIds };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function modeChangeCount(legs: readonly Leg[]): number {
  let c = 0;
  for (let i = 0; i < legs.length - 1; i++) if (legs[i].kind !== legs[i + 1].kind) c++;
  return c;
}

function modeRunsStr(legs: readonly Leg[]): string {
  const runs: { kind: string; count: number }[] = [];
  for (const l of legs) {
    const last = runs[runs.length - 1];
    if (last && last.kind === l.kind) last.count++;
    else runs.push({ kind: l.kind, count: 1 });
  }
  return runs.map((r) => `${r.kind === 'motor' ? 'M' : 'S'}(${r.count})`).join(' ');
}

function shortSailRunsCount(legs: readonly Leg[]): number {
  let count = 0;
  let i = 0;
  while (i < legs.length) {
    if (legs[i].kind === 'sail') {
      let j = i;
      let durMs = 0;
      while (j < legs.length && legs[j].kind === 'sail') {
        durMs += legs[j].endTimeMs - legs[j].startTimeMs;
        j++;
      }
      const boundedBothSides =
        i > 0 && legs[i - 1].kind === 'motor' && j < legs.length && legs[j].kind === 'motor';
      if (boundedBothSides && durMs < 300_000) count++;
      i = j;
    } else {
      i++;
    }
  }
  return count;
}

interface Joint {
  index: number;
  kindBefore: string;
  kindAfter: string;
  absDeltaHeadingDeg: number;
}

function modeChangeJoints(legs: readonly Leg[]): Joint[] {
  const out: Joint[] = [];
  for (let i = 0; i < legs.length - 1; i++) {
    if (legs[i].kind !== legs[i + 1].kind) {
      out.push({
        index: i,
        kindBefore: legs[i].kind,
        kindAfter: legs[i + 1].kind,
        absDeltaHeadingDeg: Math.abs(normalizeDeg180(legs[i + 1].headingDeg - legs[i].headingDeg)),
      });
    }
  }
  return out;
}

function mmJointsCount(legs: readonly Leg[]): number {
  let c = 0;
  for (let i = 0; i < legs.length - 1; i++) {
    if (legs[i].kind === 'motor' && legs[i + 1].kind === 'motor') {
      const d = Math.abs(normalizeDeg180(legs[i + 1].headingDeg - legs[i].headingDeg));
      if (d >= 45) c++;
    }
  }
  return c;
}

function msmTriplesCount(legs: readonly Leg[]): number {
  let c = 0;
  for (let i = 0; i + 2 < legs.length; i++) {
    if (legs[i].kind === 'motor' && legs[i + 1].kind === 'sail' && legs[i + 2].kind === 'motor')
      c++;
  }
  return c;
}

function reversalsAndSignFlips(legs: readonly Leg[]): { reversals45: number; signFlips: number } {
  let reversals45 = 0;
  const deltas: number[] = [];
  for (let i = 0; i < legs.length - 1; i++) {
    const d = normalizeDeg180(legs[i + 1].headingDeg - legs[i].headingDeg);
    deltas.push(d);
    if (Math.abs(d) >= 45) reversals45++;
  }
  let signFlips = 0;
  let lastSign = 0;
  for (const d of deltas) {
    if (d === 0) continue;
    const s = d > 0 ? 1 : -1;
    if (lastSign !== 0 && s !== lastSign) signFlips++;
    lastSign = s;
  }
  return { reversals45, signFlips };
}

/** Fixed 16-char prefix + full digest, per the brief's fingerprint column. */
function fp(s: string): { prefix16: string; full: string } {
  const full = sha256(s);
  return { prefix16: full.slice(0, 16), full };
}

interface SailRow {
  route: string;
  originId: string;
  destId: string;
  twsKn: number;
  wdirDeg: number;
  sailId: SailId;
  boat: string;
  settings: string; // 'DEFAULT_SETTINGS' unless overridden
  departureIso: string;
  status: 'ok' | 'error' | 'missing';
  noRouteReasonLabel: string | null;
  legsPost: number | null;
  legsPre: number | null;
  legsPrePostEqualModeChanges: boolean | null;
  modeChanges: number | null;
  modeChangesPre: number | null;
  modeChangesPrePostEqual: boolean | null;
  modeRuns: string | null;
  shortSailRuns: number | null;
  modeChangeJoints: Joint[] | null;
  mmJoints: number | null;
  msmTriples: number | null;
  reversals45: number | null;
  signFlips: number | null;
  motorShareByTimePct: number | null;
  motorShareByDistPct: number | null;
  etaMin: number | null;
  chordNavigable: boolean;
  legsFingerprintPrefix16: string | null;
  legsFingerprintFull: string | null;
  planFingerprintPrefix16: string;
  planFingerprintFull: string;
  mergeCallConfounded: boolean;
}

interface PlanRow {
  route: string;
  status: 'ok' | 'error';
  recommended: string | null;
  comparison: string;
  comparisonComplete: boolean | null;
  shallowPresent: boolean;
  confounded: boolean;
  solveMs: number;
}

function planOneRoute(
  spec: RouteSpec,
  deps: ReturnType<typeof loadDeps>,
  overrideSettings?: Settings,
): { sails: SailRow[]; plan: PlanRow } {
  const { mask, boat, polars, harbors, sailIds } = deps;
  const origin = harbors.find((h) => h.id === spec.origin);
  const dest = harbors.find((h) => h.id === spec.dest);
  if (!origin) throw new Error(`#354 driver: no harbor '${spec.origin}'`);
  if (!dest) throw new Error(`#354 driver: no harbor '${spec.dest}'`);

  const settings = overrideSettings ?? DEFAULT_SETTINGS;
  const windGrid = uniformWindGrid(spec.twsKn, spec.wdirDeg);
  const gate = uniformGate(settings.safetyDepthM);
  const chordNavigable = mask.segmentNavigable(origin.snap, dest.snap, gate);

  // Reset the merge-call capture for THIS planRoute() invocation.
  const original = postprocess.mergeCollinearLegs;
  const calls: Leg[][] = [];
  const spy = vi.spyOn(postprocess, 'mergeCollinearLegs').mockImplementation((...args) => {
    calls.push(args[0]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (original as any)(...args);
  });

  const t0 = Date.now();
  let result: PlanResult;
  try {
    result = planRoute(
      {
        origin: origin.snap,
        destination: dest.snap,
        viaPoints: [],
        originHarborId: spec.origin,
        destinationHarborId: spec.dest,
        departureMs: T0,
        settings,
        sailIds,
        boat: defaultBoatSnapshot(),
      },
      windGrid,
      { polars, boat, mask },
    );
  } finally {
    spy.mockRestore();
  }
  const solveMs = Date.now() - t0;

  const planFp = fp(serialize(result));
  const settingsLabel = overrideSettings ? 'DEFAULT_SETTINGS (perturbed)' : 'DEFAULT_SETTINGS';
  const departureIso = new Date(T0).toISOString();

  const sailRows: SailRow[] = [];

  if (result.status === 'error') {
    // Whole-plan failure: no assemble() ever ran, so zero merge calls is
    // consistent with zero successes for BOTH requested sails.
    for (const sailId of sailIds) {
      sailRows.push({
        route: spec.id,
        originId: spec.origin,
        destId: spec.dest,
        twsKn: spec.twsKn,
        wdirDeg: spec.wdirDeg,
        sailId,
        boat: boat.name,
        settings: settingsLabel,
        departureIso,
        status: 'error',
        noRouteReasonLabel: result.reason,
        legsPost: null,
        legsPre: null,
        legsPrePostEqualModeChanges: null,
        modeChanges: null,
        modeChangesPre: null,
        modeChangesPrePostEqual: null,
        modeRuns: null,
        shortSailRuns: null,
        modeChangeJoints: null,
        mmJoints: null,
        msmTriples: null,
        reversals45: null,
        signFlips: null,
        motorShareByTimePct: null,
        motorShareByDistPct: null,
        etaMin: null,
        chordNavigable,
        legsFingerprintPrefix16: null,
        legsFingerprintFull: null,
        planFingerprintPrefix16: planFp.prefix16,
        planFingerprintFull: planFp.full,
        mergeCallConfounded: calls.length !== 0,
      });
    }
  } else {
    const ok: PlanResultOk = result;
    const successfulSailIdsInOrder = ok.sails.filter((s) => s.result !== null).map((s) => s.sailId);
    const mergeCallConfoundedGlobal = successfulSailIdsInOrder.length !== calls.length;
    let callIdx = 0;

    for (const sr of ok.sails) {
      if (sr.result === null) {
        sailRows.push({
          route: spec.id,
          originId: spec.origin,
          destId: spec.dest,
          twsKn: spec.twsKn,
          wdirDeg: spec.wdirDeg,
          sailId: sr.sailId,
          boat: boat.name,
          settings: settingsLabel,
          departureIso,
          status: 'error',
          noRouteReasonLabel: sr.reason,
          legsPost: null,
          legsPre: null,
          legsPrePostEqualModeChanges: null,
          modeChanges: null,
          modeChangesPre: null,
          modeChangesPrePostEqual: null,
          modeRuns: null,
          shortSailRuns: null,
          modeChangeJoints: null,
          mmJoints: null,
          msmTriples: null,
          reversals45: null,
          signFlips: null,
          motorShareByTimePct: null,
          motorShareByDistPct: null,
          etaMin: null,
          chordNavigable,
          legsFingerprintPrefix16: null,
          legsFingerprintFull: null,
          planFingerprintPrefix16: planFp.prefix16,
          planFingerprintFull: planFp.full,
          mergeCallConfounded: mergeCallConfoundedGlobal,
        });
        continue;
      }

      const legsPost = sr.result.legs;
      const preMerge = mergeCallConfoundedGlobal ? null : (calls[callIdx] ?? null);
      if (!mergeCallConfoundedGlobal) callIdx++;

      const modeChanges = modeChangeCount(legsPost);
      const modeChangesPre = preMerge ? modeChangeCount(preMerge) : null;
      const { reversals45, signFlips } = reversalsAndSignFlips(legsPost);
      const lastLeg = legsPost[legsPost.length - 1];
      const firstLeg = legsPost[0];
      const totalMs = lastLeg.endTimeMs - firstLeg.startTimeMs;
      const motorMs = legsPost
        .filter((l) => l.kind === 'motor')
        .reduce((s, l) => s + (l.endTimeMs - l.startTimeMs), 0);
      const legsFp = fp(serialize(legsPost));

      sailRows.push({
        route: spec.id,
        originId: spec.origin,
        destId: spec.dest,
        twsKn: spec.twsKn,
        wdirDeg: spec.wdirDeg,
        sailId: sr.sailId,
        boat: boat.name,
        settings: settingsLabel,
        departureIso,
        status: 'ok',
        noRouteReasonLabel: null,
        legsPost: legsPost.length,
        legsPre: preMerge ? preMerge.length : null,
        legsPrePostEqualModeChanges: preMerge ? modeChanges === modeChangesPre : null,
        modeChanges,
        modeChangesPre,
        modeChangesPrePostEqual: preMerge ? modeChanges === modeChangesPre : null,
        modeRuns: modeRunsStr(legsPost),
        shortSailRuns: shortSailRunsCount(legsPost),
        modeChangeJoints: modeChangeJoints(legsPost),
        mmJoints: mmJointsCount(legsPost),
        msmTriples: msmTriplesCount(legsPost),
        reversals45,
        signFlips,
        motorShareByTimePct: totalMs > 0 ? Math.round((motorMs / totalMs) * 1000) / 10 : 0,
        motorShareByDistPct:
          sr.result.distanceNm > 0
            ? Math.round((sr.result.motorDistanceNm / sr.result.distanceNm) * 1000) / 10
            : 0,
        etaMin: Math.round((sr.result.durationMs / 60000) * 10) / 10,
        chordNavigable,
        legsFingerprintPrefix16: legsFp.prefix16,
        legsFingerprintFull: legsFp.full,
        planFingerprintPrefix16: planFp.prefix16,
        planFingerprintFull: planFp.full,
        mergeCallConfounded: mergeCallConfoundedGlobal,
      });
    }
  }

  const planRow: PlanRow = {
    route: spec.id,
    status: result.status,
    recommended: result.status === 'ok' ? result.recommended : null,
    comparison: result.status === 'ok' ? (result.rigRecommendation?.kind ?? 'not-compared') : 'n/a',
    comparisonComplete: result.status === 'ok' ? result.comparisonComplete : null,
    shallowPresent: result.status === 'ok' ? Boolean(result.shallow) : false,
    confounded: result.status === 'ok' ? Boolean(result.shallow) : false,
    solveMs,
  };

  return { sails: sailRows, plan: planRow };
}

function runFullBattery(deps: ReturnType<typeof loadDeps>) {
  const sails: SailRow[] = [];
  const plans: PlanRow[] = [];
  for (const spec of ROUTES) {
    const { sails: s, plan: p } = planOneRoute(spec, deps);
    sails.push(...s);
    plans.push(p);
  }
  return { sails, plans };
}

// ---------------------------------------------------------------------------
// RUN 1 / RUN 2 — the required double-run control.
// ---------------------------------------------------------------------------
let run1: ReturnType<typeof runFullBattery> | null = null;
let run2: ReturnType<typeof runFullBattery> | null = null;

it(
  '#354 driver: RUN 1 — six curated routes x 2 sails, real mask/polars',
  () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const deps = loadDeps();
    run1 = runFullBattery(deps);
    writeFileSync(resolve(OUT_DIR, 'run1.json'), JSON.stringify(run1, null, 2));
    // eslint-disable-next-line no-console
    console.log('##354-RUN1## wrote ' + resolve(OUT_DIR, 'run1.json'));
    expect(run1.sails.length).toBeGreaterThan(0);
  },
  solverTimeoutMs(240_000),
);

it(
  '#354 driver: RUN 2 — repeat, and diff every fingerprint against RUN 1',
  () => {
    expect(run1, 'RUN 1 must have completed before RUN 2').not.toBeNull();
    mkdirSync(OUT_DIR, { recursive: true });
    const deps = loadDeps();
    run2 = runFullBattery(deps);
    writeFileSync(resolve(OUT_DIR, 'run2.json'), JSON.stringify(run2, null, 2));
    // eslint-disable-next-line no-console
    console.log('##354-RUN2## wrote ' + resolve(OUT_DIR, 'run2.json'));

    const r1 = run1!;
    const mismatches: string[] = [];
    if (r1.sails.length !== run2.sails.length) {
      mismatches.push(`row count differs: run1=${r1.sails.length} run2=${run2.sails.length}`);
    } else {
      for (let i = 0; i < r1.sails.length; i++) {
        const a = r1.sails[i];
        const b = run2.sails[i];
        if (a.legsFingerprintFull !== b.legsFingerprintFull) {
          mismatches.push(`[${a.route}/${a.sailId}] legs fingerprint differs run1->run2`);
        }
        if (a.planFingerprintFull !== b.planFingerprintFull) {
          mismatches.push(`[${a.route}/${a.sailId}] plan fingerprint differs run1->run2`);
        }
      }
    }
    const control = { byteIdentical: mismatches.length === 0, mismatches };
    writeFileSync(resolve(OUT_DIR, 'double-run-control.json'), JSON.stringify(control, null, 2));
    // eslint-disable-next-line no-console
    console.log('##354-DOUBLE-RUN-CONTROL##' + JSON.stringify(control));
    expect(mismatches, `RUN1 vs RUN2 mismatches:\n${mismatches.join('\n')}`).toEqual([]);
  },
  solverTimeoutMs(240_000),
);

// ---------------------------------------------------------------------------
// POSITIVE CONTROL: R1 (light-air beat, motor/sail floor central to the
// churn) must change its leg-array fingerprint when the sail-speed floor
// (`max(motorThresholdKn, motorSpeedKn - sailPreferenceKn)`, #254) is
// perturbed via `sailPreferenceKn`; the perturbation is then reverted
// (DEFAULT_SETTINGS is a module constant, never mutated — this just
// re-solves at the unperturbed settings to confirm both readings are
// internally consistent). NOTE: an earlier version of this control
// perturbed `maneuverPenaltyS` instead and found ZERO effect on R1 —
// R1's own route apparently has no priced maneuver for that penalty to
// bite on, so that was a bad choice of lever for THIS route, not a defect
// in the fingerprinting; `sailPreferenceKn` moves the floor that R1's own
// "why" explicitly names as the mechanism behind its churn, so it is a
// stronger positive control for this specific route.
// ---------------------------------------------------------------------------
it(
  '#354 driver: POSITIVE CONTROL — perturbing sailPreferenceKn moves R1s fingerprint',
  () => {
    const deps = loadDeps();
    const r1spec = ROUTES.find((r) => r.id === 'R1-primary-churn')!;
    const baseline = planOneRoute(r1spec, deps);
    const perturbed = planOneRoute(r1spec, deps, {
      ...DEFAULT_SETTINGS,
      sailPreferenceKn: DEFAULT_SETTINGS.sailPreferenceKn + 2.0,
    });
    const reverted = planOneRoute(r1spec, deps);

    const baselineFp = baseline.plan; // plan-level, but we compare per-sail below
    const baseFpBySail = new Map(baseline.sails.map((s) => [s.sailId, s.planFingerprintFull]));
    const pertFpBySail = new Map(perturbed.sails.map((s) => [s.sailId, s.planFingerprintFull]));
    const revFpBySail = new Map(reverted.sails.map((s) => [s.sailId, s.planFingerprintFull]));

    let anyDiffered = false;
    for (const [sailId, baseFull] of baseFpBySail) {
      if (pertFpBySail.get(sailId) !== baseFull) anyDiffered = true;
    }
    let revertMatches = true;
    for (const [sailId, baseFull] of baseFpBySail) {
      if (revFpBySail.get(sailId) !== baseFull) revertMatches = false;
    }

    const controlResult = {
      route: r1spec.id,
      baselinePlanFingerprint: baselineFp.route,
      perturbation: 'sailPreferenceKn + 2.0',
      anyDiffered,
      revertMatches,
      baseline: baseline.sails,
      perturbed: perturbed.sails,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      resolve(OUT_DIR, 'positive-control.json'),
      JSON.stringify(controlResult, null, 2),
    );
    // eslint-disable-next-line no-console
    console.log(
      '##354-POSITIVE-CONTROL##' + JSON.stringify({ route: r1spec.id, anyDiffered, revertMatches }),
    );
    expect(
      anyDiffered,
      'perturbing sailPreferenceKn by +2.0kn should move at least one sail fingerprint on R1',
    ).toBe(true);
    expect(
      revertMatches,
      'reverting the perturbation should reproduce the baseline fingerprint',
    ).toBe(true);
  },
  solverTimeoutMs(120_000),
);
