/**
 * #54 spec N.3 — the tier-C polar estimator, `salona45-uniform-scalar-v1`.
 *
 * WHAT THIS IS. Two Flensburg fleet models ship with no ORC/IRC certificate and
 * no published VPP polar (spec G.1, M.6). Rather than ship nothing, spec N
 * authorises scaling the app's own certificate-anchored Salona 45 table by a
 * single dimensionless hull scalar. Inputs are the ALREADY-SHIPPED Salona 45
 * tables plus public brochure dimensions and NOTHING ELSE — this script
 * downloads nothing and ingests no third-party table, which is what keeps
 * licence exposure, donor keel-variant ambiguity and corpus completeness out of
 * scope entirely (`corpusFree: true` on every estimator block).
 *
 * THE METHOD, in full (spec N.3):
 *   1. SA/D = sailAreaUpwindM2 / (displacementKg / 1025)^(2/3), for target and base.
 *   2. k    = sqrt( (SA/D)_target / (SA/D)_base ).
 *   3. speeds[i][j] = round( base_fock[i][j] * k, 2 ).
 *   4. tws, twa, beat and gybe are copied from the base boat UNCHANGED.
 *   5. validation.maxSpeedKn and every anchor are hand-set from that hull's OWN
 *      published figures — never inherited, never derived from this output
 *      (spec N.6 E3/E4, and spec L's "reuse the Salona 45's anchors" row).
 *
 * Step 2's exponent is DIMENSIONAL, not fitted: speed goes roughly as the
 * square root of driving force for a given resistance curve. No measurement in
 * this repository licenses it. What makes it acceptable is a measured CEILING
 * rather than a claim of accuracy — spec M.7 records an oracle study in which
 * the BEST POSSIBLE single scalar chosen with hindsight still leaves a median
 * RMS around 3 % and a median worst cell around 8-10 %, because the residual is
 * polar SHAPE, which no scalar corrects. A more elaborate scalar cannot buy
 * much, so prefer the simple auditable one and publish a wide band.
 *
 * `k` IS A RATIO, WHICH IS WHY THE MEASUREMENT BASIS MUST BE UNIFORM AND WHY
 * THE UNIT CONVENTION DOES NOT MATTER. Every uniform factor cancels exactly
 * between numerator and denominator — MEASURED here: computing SA/D in metric
 * (kg, m^2, 1025 kg/m^3) and in sailboatdata's imperial convention
 * (lb, ft^2, 64 lb/ft^3) changes each ratio by a uniform 0.0118 % and changes
 * every `k` by ZERO at full double precision. A MIXED basis is the opposite
 * case and corrupts `k` invisibly: Yachting World prints the Elan Impression
 * 444's 100 % foretriangle area as 85.7 m^2 where sailboatdata prints
 * 77.76 m^2 (the larger figure measures the main differently), and taking that
 * one figure from the other publication yields k = 0.937 instead of 0.892 — a
 * 5 % error through every cell of a speed table, from a reputable source, with
 * nothing downstream able to detect it. Every dimension input therefore cites
 * ONE source, and E2 makes the citation mandatory.
 *
 * WHAT THE METHOD CANNOT DO (spec N.3, stated here and not only in the spec):
 *   - It cannot measure error against a real boat. Every accuracy figure
 *     anywhere in this feature is one VPP predicted from another.
 *   - It cannot move pointing angles. Every estimated boat INHERITS the base
 *     boat's beat and gybe angles outright — an inherited claim, not a
 *     derived one.
 *   - It cannot capture hull shape, and it cannot fix a wrong keel.
 *   - It says nothing about waves, current, fouling or reefing.
 *
 * SECOND SAIL (spec N.4). A tier-C boat ships two sails, and the second is the
 * boat's OWN base table multiplied by the base boat's documented genoa overlay
 * ramp. The difference between the two tables is therefore a function of THE
 * RAMP, NOT THE HULL — deterministic, repeatable, and carrying zero information
 * about that boat. That is why the sail comparison is suppressed by type
 * (`not-compared`) rather than presented as a noisy finding: it is not a noisy
 * finding, it is not a finding.
 *
 * The ramp is applied to the ROUNDED base table, which is what "the boat's own
 * base table x the ramp" literally says and what E7 re-runs. It is NOT the same
 * as scaling the base boat's genoa table directly: the intermediate rounding
 * moves 20 of 135 cells for the Salona 44 and 19 of 135 for the Elan, all by
 * 0.01 kn. Chaining through the committed base table is deliberate — it makes
 * the second table reproducible from the FIRST COMMITTED TABLE plus the ramp,
 * so a reader can check it without re-deriving the scalar.
 *
 * USAGE
 *   node estimate_polars.mjs            # --check: recompute and compare (exit 1 on drift)
 *   node estimate_polars.mjs --report   # the same, plus scalars and anchor margins
 *   node estimate_polars.mjs --emit <boatId> <sailId>   # formatted speeds rows to paste
 *
 * There is deliberately NO mode that rewrites pipeline/polars-source.json.
 * That file is hand-formatted (number rows inline, one polar row per line) and
 * a whole-file re-serialiser cannot reproduce that layout byte-for-byte, so it
 * would churn the Salona 45's committed block on every run. The committed
 * `speeds` literals are the artifact; this script is the generator (`--emit`)
 * and the keeper (`--check`), and build_polars.mjs's E7 runs the keeper on
 * every build.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE_PATH = join(here, 'polars-source.json');

/** Seawater density, kg/m^3 — the denominator that turns mass into displaced volume. */
export const SEAWATER_KG_M3 = 1025;

/** The two methods a tier-C sail may declare. A sail naming anything else fails E1. */
export const SCALAR_METHOD = 'salona45-uniform-scalar-v1';
export const RAMP_METHOD = 'salona45-genoa-ramp-v1';
export const ESTIMATOR_METHODS = [SCALAR_METHOD, RAMP_METHOD];

/**
 * Speeds are committed to two decimals, so every derived cell rounds the same
 * way. Kept as a named export because build_polars.mjs's E7 must round
 * IDENTICALLY — two spellings of "round to 2 dp" that disagree on one tie would
 * make the reproducibility check red on a correct table.
 */
export function round2(x) {
  return Math.round(x * 100) / 100;
}

/** Sail-area / displacement ratio. Dimensionless once the units are consistent. */
export function sailAreaDisplacementRatio(sailAreaUpwindM2, displacementKg) {
  return sailAreaUpwindM2 / Math.pow(displacementKg / SEAWATER_KG_M3, 2 / 3);
}

/**
 * The uniform hull scalar. Full double precision — NEVER the rounded `scalar`
 * declared in the JSON, which is a human-readable DECLARATION that E7
 * cross-checks against this. Deriving the table from the rounded declaration
 * instead would make a perturbed input invisible whenever it moved `k` by less
 * than half of the last declared decimal.
 */
export function uniformScalar(target, base) {
  return Math.sqrt(
    sailAreaDisplacementRatio(target.sailAreaUpwindM2, target.displacementKg) /
      sailAreaDisplacementRatio(base.sailAreaUpwindM2, base.displacementKg),
  );
}

/** Declared `scalar` precision. Three decimals distinguishes 1.020 from 1.019. */
export function round3(x) {
  return Math.round(x * 1000) / 1000;
}

export function scaleSpeeds(baseSpeeds, k) {
  return baseSpeeds.map((row) => row.map((v) => round2(v * k)));
}

/**
 * `own x (to / from)`, cell by cell. `from` is the ramp's denominator and must
 * be the base boat's own base sail, or the ratio is not the documented overlay.
 */
export function rampSpeeds(ownSpeeds, fromSpeeds, toSpeeds) {
  return ownSpeeds.map((row, i) => row.map((v, j) => round2(v * (toSpeeds[i][j] / fromSpeeds[i][j]))));
}

function fail(msg) {
  throw new Error(`estimate_polars: ${msg}`);
}

function boatOf(src, id) {
  const b = src.boats.find((x) => x.id === id);
  if (!b) fail(`no boat ${JSON.stringify(id)} in polars-source.json`);
  return b;
}

function speedsOf(src, boatId, sailId) {
  const b = boatOf(src, boatId);
  const sail = b.sails?.[sailId];
  if (!sail) fail(`boat ${boatId} has no sail ${JSON.stringify(sailId)}`);
  if (!Array.isArray(sail.speeds)) fail(`${boatId}/${sailId}: speeds missing`);
  return sail.speeds;
}

function inputValue(est, key, where) {
  const entry = est.inputs?.[key];
  if (entry == null || typeof entry.value !== 'number' || !Number.isFinite(entry.value))
    fail(`${where}: estimator.inputs.${key}.value missing or not a finite number`);
  return entry.value;
}

/**
 * Recompute one estimated sail's `speeds` from the committed inputs alone.
 *
 * Returns null for a sail that declares no estimator block — a non-estimated
 * sail is simply not this script's business, and E1 (not this function) is what
 * decides whether a tier-C sail is allowed to lack one.
 *
 * The RAMP method recurses into its own boat's base sail, so the second table
 * is reproducible from the same committed inputs as the first (E7's "including
 * the second sail's base x ramp step"). The recursion is one level deep by
 * construction: a base sail declares the SCALAR method, which does not recurse.
 */
export function estimatedSpeedsFor(src, boatId, sailId) {
  const boat = boatOf(src, boatId);
  const sail = boat.sails?.[sailId];
  const est = sail?.estimator;
  if (est == null) return null;
  const where = `${boatId}/${sailId}`;

  if (est.method === SCALAR_METHOD) {
    const k = uniformScalar(
      {
        sailAreaUpwindM2: inputValue(est, 'sailAreaUpwindM2', where),
        displacementKg: inputValue(est, 'displacementKg', where),
      },
      {
        sailAreaUpwindM2: inputValue(est, 'baseSailAreaUpwindM2', where),
        displacementKg: inputValue(est, 'baseDisplacementKg', where),
      },
    );
    return { speeds: scaleSpeeds(speedsOf(src, est.baseBoatId, est.baseSailId), k), scalar: k };
  }

  if (est.method === RAMP_METHOD) {
    const ramp = est.ramp;
    if (ramp == null) fail(`${where}: ${RAMP_METHOD} needs a ramp block`);
    // The base table is recomputed, never read from disk: E7 must red when an
    // input to the FIRST table moves, and reading the committed second-hand
    // copy would hide exactly that.
    const own = estimatedSpeedsFor(src, est.baseBoatId, est.baseSailId);
    if (own == null) fail(`${where}: base sail ${est.baseBoatId}/${est.baseSailId} is not estimated`);
    return {
      speeds: rampSpeeds(
        own.speeds,
        speedsOf(src, ramp.boatId, ramp.fromSailId),
        speedsOf(src, ramp.boatId, ramp.toSailId),
      ),
      scalar: own.scalar,
    };
  }

  fail(`${where}: unknown estimator method ${JSON.stringify(est.method)}`);
}

/**
 * Spec N.6 E5. Outside this band the donor is not comparable and the build
 * refuses rather than extrapolating: a scalar of 0.6 or 1.6 is not a scaled
 * sister ship, it is a different kind of boat wearing one's polar.
 */
export const SCALAR_MIN = 0.8;
export const SCALAR_MAX = 1.25;

/** The sail ids of one boat that carry an estimator block, in file order. */
export function estimatedSailsOfBoat(boat) {
  return Object.keys(boat.sails ?? {}).filter((sailId) => boat.sails[sailId]?.estimator != null);
}

/** Every (boatId, sailId) carrying an estimator block, in file order. */
export function estimatedSails(src) {
  return src.boats.flatMap((b) =>
    Object.keys(b.sails ?? {})
      .filter((sailId) => b.sails[sailId]?.estimator != null)
      .map((sailId) => ({ boatId: b.id, sailId })),
  );
}

function sameGrid(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((row, i) => row.length === b[i].length && row.every((v, j) => Object.is(v, b[i][j])))
  );
}

/**
 * E7's comparison, exported so build_polars.mjs runs the SAME code rather than
 * a second implementation of it. Returns the list of sails whose committed
 * speeds do not reproduce; empty means reproducible.
 */
export function reproductionFailures(src) {
  const out = [];
  for (const { boatId, sailId } of estimatedSails(src)) {
    const got = estimatedSpeedsFor(src, boatId, sailId);
    const committed = speedsOf(src, boatId, sailId);
    if (!sameGrid(got.speeds, committed)) {
      const firstBad = [];
      got.speeds.forEach((row, i) =>
        row.forEach((v, j) => {
          if (firstBad.length < 3 && !Object.is(v, committed?.[i]?.[j]))
            firstBad.push(`[${i}][${j}] committed ${committed?.[i]?.[j]} vs recomputed ${v}`);
        }),
      );
      out.push({ boatId, sailId, detail: firstBad.join('; ') || 'grid shape differs' });
    }
    const declared = src.boats.find((b) => b.id === boatId).sails[sailId].estimator.scalar;
    if (!Object.is(round3(got.scalar), declared))
      out.push({
        boatId,
        sailId,
        detail: `declared scalar ${declared} but the committed inputs give ${round3(got.scalar)} (${got.scalar})`,
      });
  }
  return out;
}

// ---------------------------------------------------------------- CLI ----

function readSource() {
  return JSON.parse(readFileSync(SOURCE_PATH, 'utf8'));
}

function emit(boatId, sailId) {
  const src = readSource();
  const got = estimatedSpeedsFor(src, boatId, sailId);
  if (got == null) fail(`${boatId}/${sailId} declares no estimator block`);
  const rows = got.speeds.map((row) => `            [${row.map((v) => String(v)).join(', ')}]`);
  process.stdout.write(`          "speeds": [\n${rows.join(',\n')}\n          ]\n`);
}

function report(src) {
  for (const b of src.boats) {
    for (const sailId of Object.keys(b.sails ?? {})) {
      const est = b.sails[sailId].estimator;
      if (est == null) continue;
      const got = estimatedSpeedsFor(src, b.id, sailId);
      const flat = got.speeds.flat();
      process.stdout.write(
        `${b.id}/${sailId}: method ${est.method}, scalar ${round3(got.scalar)} ` +
          `(${got.scalar.toFixed(6)}), speeds ${Math.min(...flat)}-${Math.max(...flat)} kn\n`,
      );
    }
    // Anchor margins. Spec C.8 R8's idiom: a band a table clears with nothing
    // to spare passes a binary check while telling you it nearly did not.
    for (const a of b.validation?.anchors ?? []) {
      const i = b.twa.indexOf(a.twa);
      const j = b.tws.indexOf(a.tws);
      if (i < 0 || j < 0) continue;
      for (const sailId of Object.keys(b.sails ?? {})) {
        const v = b.sails[sailId].speeds?.[i]?.[j];
        if (typeof v !== 'number') continue;
        process.stdout.write(
          `  anchor ${b.id}/${sailId} ${a.label} @twa ${a.twa}/tws ${a.tws}: ${v} kn in ` +
            `[${a.minKn}, ${a.maxKn}] (margins ${round2(v - a.minKn)} / ${round2(a.maxKn - v)})\n`,
        );
      }
    }
  }
}

function main(argv) {
  if (argv[0] === '--emit') {
    if (argv.length !== 3) fail('--emit needs <boatId> <sailId>');
    emit(argv[1], argv[2]);
    return 0;
  }
  const src = readSource();
  if (argv[0] === '--report') report(src);
  const failures = reproductionFailures(src);
  if (failures.length > 0) {
    for (const f of failures)
      process.stderr.write(`NOT REPRODUCIBLE ${f.boatId}/${f.sailId}: ${f.detail}\n`);
    process.stderr.write(
      `${failures.length} estimated table(s) do not reproduce from the committed inputs.\n` +
        'Either an input moved without the table being regenerated, or the table was hand-edited.\n' +
        'Regenerate with --emit and paste, or restore the input.\n',
    );
    return 1;
  }
  process.stdout.write(
    `all ${estimatedSails(src).length} estimated table(s) reproduce from the committed inputs\n`,
  );
  return 0;
}

// Only run the CLI when invoked directly — build_polars.mjs imports this module.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
