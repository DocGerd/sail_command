#!/usr/bin/env node
/**
 * #455 — ROUTE-LEVEL TRIP RATE for the T-bound shallow criterion.
 *
 * READ-ONLY ANALYSER. Consumes arm output files an `app/sweep/` run already
 * wrote and reports to stdout. It writes nothing, plans nothing, and never
 * touches the repo — re-running it cannot perturb a baseline.
 *
 * WHY THIS EXISTS. The only figure on record for #455 is a CELL rate (2.47%
 * of navigable cells; 10,746 true gate-crossers off the committed mask). A
 * cell rate cannot answer the question the maintainer actually has to rule
 * on: if a route-level notice fired on
 *
 *     shallowExposureNm(legs, mask, safetyDepthM + MASK_TOLERANCE_M) > 0
 *
 * would it be a warning or wallpaper? That is a per-ROUTE property and no
 * amount of arithmetic on the cell rate yields it — routes are not random
 * samples of cells, they are the solver's own shortest paths through them.
 *
 * WHY `.mjs` AND NOT `.test.ts`. `sweep/vitest.config.ts`'s
 * `include: ['**\/*.test.ts']` would collect a `*.test.ts` here into EVERY
 * future sweep run, silently enlarging the #282 harness whose whole value is
 * that its arm set is fixed. This must never be part of that harness.
 *
 * It is also OUTSIDE the sweep's input closure despite living in this
 * directory: nothing imports it, so it cannot affect any arm's output and
 * landing it does not invalidate a recorded BASE control. CLAUDE.md names
 * `app/sweep/` as part of that closure and tells you to DEFAULT TO RE-RUNNING,
 * which is the right rule — this file is a stated exemption to it, with its
 * reason, so the exemption does not have to be re-derived. The import arrow
 * runs one way only: this file reads `ARMS`, `ARMS` never reads this file.
 *
 * THRESHOLD PROVENANCE — no hand-copied literals. The per-arm gate is read
 * from `ARMS` in `sweepArms.ts` (the same object the run itself used) and the
 * tolerance from `MASK_TOLERANCE_M` in `src/lib/mask.ts` (the TS twin of
 * `pipeline/build_mask.py`'s `TOLERANCE_M`). The mask walk is the SHIPPED
 * `shallowExposureNm`, imported, never re-implemented: a duplicated DDA fails
 * as a subtly wrong safety number with no signal at all.
 *
 * BASIS OF EVERY NUMBER IT PRINTS. `shallowExposureNm(legs, mask, gate + T)`
 * asks "does the CAUTIOUS reading of the same EMODnet product fall below the
 * gate anywhere along this route" — because the mask is built so
 * `depth_blend <= depth_max + T`, so `depth_max >= shipped - T`, so
 * `shipped < gate + T` is exactly the set whose conservative lower bound can
 * sit under the gate. It is a bound BETWEEN TWO READINGS OF ONE SOURCE. It is
 * not chart truth and not a clearance: the real seabed may be shallower than
 * either reading.
 *
 * USAGE
 *   node app/sweep/tripRate.mjs <armDir> [--json]
 *   node app/sweep/tripRate.mjs --mask-cells
 *
 * `<armDir>` is a directory holding `<arm>.json` files written by a sweep run
 * (`SC_SWEEP_OUT`). Arms absent from the directory are skipped and named as
 * skipped; arms present but not in `ARMS` are reported as unknown rather than
 * silently ignored.
 *
 * `--mask-cells` needs no arm directory: it re-derives the CELL-side figures
 * straight from the committed `mask.bin`, so the addendum's cell counts and
 * its route counts are reproducible from the same committed script. It is
 * deliberately NOT the headline measurement — a cell rate is what #455 already
 * had and what this analyser exists to move past.
 */
import module from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `vitest` is imported at `sweepArms.ts`'s module scope for `runArm`'s `it()`.
// We only read `ARMS`, never call `runArm`, so a throwing stub keeps this
// analyser runnable without the test runner resolved — and fails LOUDLY rather
// than silently no-op'ing if a future edit ever does reach a test API here.
const VITEST_STUB =
  'data:text/javascript,' +
  encodeURIComponent(
    'const die=(n)=>()=>{throw new Error("tripRate.mjs: sweepArms.ts called vitest."+n+"() at import time; this analyser only reads ARMS")};' +
      'export const it=die("it");export const describe=die("describe");' +
      'export const expect=die("expect");export const test=die("test");' +
      'export const vi={};export default {};',
  );

// Node strips TypeScript types natively (the repo's `erasableSyntaxOnly`
// tsconfig makes every module here eligible by construction — no enums, no
// constructor parameter properties). The one gap is that type-stripping does
// not resolve extensionless specifiers, which every import in `src/` uses.
module.registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'vitest') return { url: VITEST_STUB, shortCircuit: true };
    if (!spec.startsWith('.') && !spec.startsWith('/')) return next(spec, ctx);
    try {
      return next(spec, ctx);
    } catch (err) {
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try {
          return next(spec + ext, ctx);
        } catch {
          /* try the next candidate extension */
        }
      }
      throw err;
    }
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../public/data');

const { ARMS } = await import(resolve(here, 'sweepArms.ts'));
const { NavMask, MASK_TOLERANCE_M } = await import(resolve(here, '../src/lib/mask.ts'));
const { shallowExposureNm } = await import(resolve(here, '../src/lib/shallowExposure.ts'));

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const maskCellsOnly = args.includes('--mask-cells');
const armDir = args.find((a) => !a.startsWith('--'));
if (!armDir && !maskCellsOnly) {
  console.error('usage: node app/sweep/tripRate.mjs <armDir> [--json]');
  console.error('       node app/sweep/tripRate.mjs --mask-cells');
  process.exit(2);
}

const meta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8'));
const maskBytes = new Uint8Array(readFileSync(resolve(dataDir, 'mask.bin')));
const mask = new NavMask(meta, maskBytes);

if (maskCellsOnly) {
  // Decode exactly as `src/lib/mask.ts` does: 0 = land/unknown/drying,
  // 255 = the >= 25.4 m cap, else byte/10. A cell "crosses" at gate G iff it is
  // navigable (d >= G) while its CAUTIOUS lower bound sits under the gate
  // (d - T < G) — i.e. G <= d < G + T. This is the SHIPPED-BYTE basis and is a
  // strict SUPERSET of the true conservative-vs-shipped crossers, which need
  // the EMODnet source raster to recompute and are NOT derivable from
  // `mask.bin` alone. Never present the two as the same quantity.
  const DEEP_M = 25.4;
  const depthM = (b) => (b === 255 ? DEEP_M : b / 10);
  const hist = new Array(256).fill(0);
  for (const b of maskBytes) hist[b]++;
  const total = maskBytes.length;
  const water = total - hist[0];
  console.log('#455 CELL-SIDE FIGURES, re-derived from the committed mask.bin');
  console.log('='.repeat(78));
  console.log(`grid              : ${meta.rows} x ${meta.cols} = ${total} cells`);
  console.log(`byte 0            : ${hist[0]}  (land OR unsurveyed OR drying — indistinguishable)`);
  console.log(`water (byte != 0) : ${water}  (${((100 * water) / total).toFixed(4)}% of grid)`);
  console.log(`byte 254 / 255    : ${hist[254]} / ${hist[255]}`);
  console.log(`MASK_TOLERANCE_M  : ${MASK_TOLERANCE_M}`);
  for (const gate of [3.0, 2.9, 4.0]) {
    let nav = 0;
    let cross = 0;
    for (let b = 1; b < 256; b++) {
      if (hist[b] === 0) continue;
      const d = depthM(b);
      if (d >= gate) {
        nav += hist[b];
        if (d < gate + MASK_TOLERANCE_M) cross += hist[b];
      }
    }
    console.log(
      `\ngate ${gate} (threshold ${(gate + MASK_TOLERANCE_M).toFixed(1)})` +
        `\n  navigable  (d >= gate)        : ${nav}` +
        `\n  T-bound    (gate <= d < thr)  : ${cross}  (${((100 * cross) / nav).toFixed(4)}% of navigable)`,
    );
  }
  process.exit(0);
}

/** Sorted-array quantile, linear interpolation. */
function q(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    min: q(s, 0),
    p25: q(s, 0.25),
    median: q(s, 0.5),
    p75: q(s, 0.75),
    p90: q(s, 0.9),
    max: q(s, 1),
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
  };
}
const f = (x, d = 4) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d));
const pct = (num, den) => (den === 0 ? 'n/a' : `${((100 * num) / den).toFixed(1)}%`);

/**
 * One measured plan row. `expT` is the criterion under test; `expG` is the
 * SAME walk at the bare gate and is a CONTROL, not a second finding: the
 * solver validates every accepted segment with `segmentNavigable(a, b, gate)`,
 * so a non-relaxed route must read exactly 0 there. A non-zero would mean this
 * walk and the solver's disagree, and every headline number below would be
 * unsafe to quote.
 *
 * DO NOT READ THAT AS THE CONVERSE. The control is ONE-SIDED: it detects only
 * OVER-visiting (a cell the solver never validated). A walk visiting FEWER
 * cells than the solver's — or none at all — reads 0.0 nm too, so `expG == 0`
 * does NOT establish that the two traversals agree, and an under-visiting bug
 * would deflate `expT` while leaving this green. What establishes agreement is
 * a SEQUENCE differential (the #516/PR #523 method — a recording `depthInfoM`
 * facade against `NavMask`'s private `walkCells`), run over all 67 non-relaxed
 * routes: 1,871 legs / 130,930 cells, zero mismatches, in order.
 */
function measure(legs, thresholdM, gateM) {
  if (!Array.isArray(legs) || legs.length === 0) return null;
  const expT = shallowExposureNm(legs, mask, thresholdM);
  const expG = shallowExposureNm(legs, mask, gateM);
  const distNm = legs.reduce((a, l) => a + (l.distanceNm ?? 0), 0);
  return { expT, expG, distNm };
}

const armReports = [];
const unknownFiles = [];
const skipped = [];

for (const [armName, arm] of Object.entries(ARMS)) {
  const file = resolve(armDir, `${armName}.json`);
  if (!existsSync(file)) {
    skipped.push(armName);
    continue;
  }
  const gateM = arm.settings.safetyDepthM;
  const thresholdM = gateM + MASK_TOLERANCE_M;
  const originId = arm.originId ?? 'flensburg';
  const rows = JSON.parse(readFileSync(file, 'utf8'));

  const outcomes = new Map();
  const plans = []; // one entry per `ok` row
  for (const [destId, row] of Object.entries(rows)) {
    if (row.status !== 'ok') {
      const key = `error:${row.reason ?? '?'}`;
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
      continue;
    }
    const relaxed = Object.prototype.hasOwnProperty.call(row, 'shallow');
    outcomes.set(
      relaxed ? 'ok+shallow' : 'ok',
      (outcomes.get(relaxed ? 'ok+shallow' : 'ok') ?? 0) + 1,
    );
    const bySail = new Map(row.sails.map((s) => [s.sailId, s.result]));
    const recLegs = bySail.get(row.recommended)?.legs ?? null;
    const perSail = row.sails
      .filter((s) => s.result)
      .map((s) => ({ sailId: s.sailId, m: measure(s.result.legs, thresholdM, gateM) }))
      .filter((s) => s.m);
    plans.push({
      destId,
      relaxed,
      selfPair: destId === originId,
      recommended: measure(recLegs, thresholdM, gateM),
      perSail,
    });
  }
  armReports.push({ armName, gateM, thresholdM, originId, n: Object.keys(rows).length, outcomes, plans });
}

for (const name of ['becalmed', 'deep-becalmed']) {
  const r = armReports.find((a) => a.armName === name);
  if (r) {
    const okCount = (r.outcomes.get('ok') ?? 0) + (r.outcomes.get('ok+shallow') ?? 0);
    r.vacuous = okCount === 0;
  }
}

/** Split a plan list into the populations the report keeps strictly apart. */
function classify(plans) {
  return {
    nonRelaxed: plans.filter((p) => !p.relaxed && !p.selfPair),
    selfPairs: plans.filter((p) => p.selfPair),
    relaxed: plans.filter((p) => p.relaxed && !p.selfPair),
  };
}

/** Trip tally on the RECOMMENDED sail's legs — what the results card renders. */
function tally(plans) {
  let trips = 0;
  let clear = 0;
  let unknown = 0;
  let noLegs = 0;
  const expo = [];
  const expoPct = [];
  const gateViolations = [];
  for (const p of plans) {
    const m = p.recommended;
    if (!m) {
      noLegs++;
      continue;
    }
    if (m.expT === null) {
      unknown++;
    } else if (m.expT > 0) {
      trips++;
      expo.push(m.expT);
      if (m.distNm > 0) expoPct.push((100 * m.expT) / m.distNm);
    } else {
      clear++;
    }
    if (m.expG !== null && m.expG > 0) gateViolations.push({ destId: p.destId, expG: m.expG });
  }
  return { n: plans.length, trips, clear, unknown, noLegs, expo, expoPct, gateViolations };
}

/** Trip tally where EITHER rig's own track would trip (the alt-rig overlay). */
function tallyAnySail(plans) {
  let trips = 0;
  let clear = 0;
  let unknown = 0;
  for (const p of plans) {
    if (p.perSail.length === 0) continue;
    const vals = p.perSail.map((s) => s.m.expT);
    if (vals.some((v) => v !== null && v > 0)) trips++;
    else if (vals.some((v) => v === null)) unknown++;
    else clear++;
  }
  return { trips, clear, unknown };
}

const NON_VACUOUS = armReports.filter((a) => !a.vacuous);
const allPlans = NON_VACUOUS.flatMap((a) => a.plans);
const split = classify(allPlans);
const headline = tally(split.nonRelaxed);
const headlineAny = tallyAnySail(split.nonRelaxed);
const relaxed = tally(split.relaxed);
const selfPairs = tally(split.selfPairs);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        maskToleranceM: MASK_TOLERANCE_M,
        arms: armReports.map((a) => ({
          arm: a.armName,
          gateM: a.gateM,
          thresholdM: a.thresholdM,
          originId: a.originId,
          n: a.n,
          vacuous: Boolean(a.vacuous),
          outcomes: Object.fromEntries(a.outcomes),
          nonRelaxed: tally(classify(a.plans).nonRelaxed),
          relaxed: tally(classify(a.plans).relaxed),
        })),
        headline,
        headlineAnySail: headlineAny,
        relaxedPopulation: relaxed,
        selfPairs,
        skippedArms: skipped,
      },
      (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v),
      2,
    ),
  );
  process.exit(0);
}

const L = (s = '') => console.log(s);
L('#455 ROUTE-LEVEL TRIP RATE');
L('='.repeat(78));
L(`arm directory     : ${armDir}`);
L(`MASK_TOLERANCE_M  : ${MASK_TOLERANCE_M} (src/lib/mask.ts)`);
L(`criterion         : shallowExposureNm(legs, mask, gate + T) > 0`);
L(`legs basis        : the RECOMMENDED sail's legs (what RouteSummary renders)`);
if (skipped.length) L(`arms not present  : ${skipped.join(', ')}`);
if (unknownFiles.length) L(`unknown files     : ${unknownFiles.join(', ')}`);
L();

L('PER-ARM OUTCOME DISTRIBUTION');
L('-'.repeat(78));
for (const a of armReports) {
  const oc = [...a.outcomes.entries()].sort((x, y) => y[1] - x[1]);
  L(
    `${a.armName.padEnd(17)} origin=${a.originId.padEnd(10)} gate=${String(a.gateM).padEnd(4)} ` +
      `thr=${String(a.thresholdM).padEnd(4)} n=${a.n}${a.vacuous ? '   [VACUOUS: zero ok rows]' : ''}`,
  );
  L(`  ${oc.map(([k, v]) => `${k}=${v}`).join('  ')}`);
}
L();

function report(title, t, anyT, controlMustBeZero = true) {
  L(title);
  L('-'.repeat(78));
  L(`plans in population : ${t.n}`);
  L(`  trips (exp > 0)   : ${t.trips}   (${pct(t.trips, t.n)})`);
  L(`  clear (exp == 0)  : ${t.clear}   (${pct(t.clear, t.n)})`);
  L(`  unknown (null)    : ${t.unknown}   (${pct(t.unknown, t.n)})  [leg outside mask rect]`);
  if (t.noLegs) L(`  no legs           : ${t.noLegs}`);
  if (anyT) {
    L(`  any-sail basis    : trips=${anyT.trips} clear=${anyT.clear} unknown=${anyT.unknown}`);
  }
  if (t.expo.length) {
    const s = stats(t.expo);
    const sp = stats(t.expoPct);
    L(`  exposure nm       : min=${f(s.min)} p25=${f(s.p25)} med=${f(s.median)} ` +
      `p75=${f(s.p75)} p90=${f(s.p90)} max=${f(s.max)} mean=${f(s.mean)}`);
    L(`  exposure %route   : min=${f(sp.min, 2)} p25=${f(sp.p25, 2)} med=${f(sp.median, 2)} ` +
      `p75=${f(sp.p75, 2)} p90=${f(sp.p90, 2)} max=${f(sp.max, 2)} mean=${f(sp.mean, 2)}`);
  }
  // The exp@gate reading means OPPOSITE things in the two populations, so it
  // is labelled per-population rather than reported as one number. On a
  // NON-RELAXED plan the solver validated every accepted segment with
  // `segmentNavigable(a, b, gate)`, so a non-zero would mean this walk and the
  // solver's disagree and nothing here could be quoted. On a RELAXED plan
  // `usedDepthM < requestedDepthM` BY CONSTRUCTION, so a non-zero is the
  // relaxation itself and a ZERO would be the surprise. Reporting one verdict
  // for both would accuse a correct artifact.
  if (controlMustBeZero) {
    L(
      `  CONTROL exp@gate  : ${
        t.gateViolations.length === 0
          ? '0 plans — REQUIRED, and met: the solver validated every segment at the gate'
          : `${t.gateViolations.length} NON-ZERO — this walk disagrees with the solver. ` +
            'DO NOT QUOTE ANY FIGURE ABOVE: ' +
            t.gateViolations.map((g) => `${g.destId}=${f(g.expG)}`).join(' ')
      }`,
    );
  } else {
    L(
      `  exp@gate          : ${t.gateViolations.length} of ${t.n} plans non-zero — EXPECTED here ` +
        '(relaxation solves below the requested gate by construction; not a control)',
    );
  }
  L();
}

report('HEADLINE — NON-RELAXED population (PlanResult.shallow absent, self-pairs excluded)', headline, headlineAny);
report(
  'RELAXED population (PlanResult.shallow present) — reported SEPARATELY, never merged',
  relaxed,
  null,
  false,
);
report('SELF-PAIRS (origin === destination; zero-distance, cannot trip)', selfPairs);

L('PER-ARM, NON-RELAXED ONLY');
L('-'.repeat(78));
for (const a of NON_VACUOUS) {
  const t = tally(classify(a.plans).nonRelaxed);
  const s = t.expo.length ? stats(t.expo) : null;
  L(
    `${a.armName.padEnd(17)} n=${String(t.n).padStart(2)}  trips=${String(t.trips).padStart(2)} ` +
      `(${pct(t.trips, t.n).padStart(6)})  clear=${String(t.clear).padStart(2)}  unknown=${t.unknown}` +
      (s ? `  med=${f(s.median)} nm  max=${f(s.max)} nm` : ''),
  );
}
L();

L('TRIPPING PLANS (non-relaxed), longest exposure first');
L('-'.repeat(78));
const tripRows = [];
for (const a of NON_VACUOUS) {
  for (const p of classify(a.plans).nonRelaxed) {
    if (p.recommended && p.recommended.expT !== null && p.recommended.expT > 0) {
      tripRows.push({ arm: a.armName, ...p, ...p.recommended });
    }
  }
}
tripRows.sort((x, y) => y.expT - x.expT);
for (const r of tripRows) {
  L(
    `${r.arm.padEnd(17)} ${r.destId.padEnd(16)} exp=${f(r.expT)} nm  ` +
      `route=${f(r.distNm, 2)} nm  ${f((100 * r.expT) / r.distNm, 2)}% of route`,
  );
}
if (tripRows.length === 0) L('(none)');
