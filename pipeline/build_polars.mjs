import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CERT_METHOD,
  GENOA_RAMP_METHOD,
  reproductionFailures as derivationFailures,
} from './derive_orc_polars.mjs';
import {
  ESTIMATOR_METHODS,
  RAMP_METHOD,
  SCALAR_METHOD,
  SCALAR_MAX,
  SCALAR_MIN,
  estimatedSails,
  estimatedSailsOfBoat,
  estimatedSpeedsFor,
  reproductionFailures,
  round3,
} from './estimate_polars.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(join(here, 'polars-source.json'), 'utf8'));
// #54 spec F.1: `<boat-id>-<sail-id>.json` under a `polars/` subdirectory. The
// boat id is part of the filename because sail ids are NOT unique across boats
// — the previous `polar-<sail>.json` had no boat identifier at all, so a second
// boat's tables would have overwritten the first's.
const outDir = join(here, '..', 'app', 'public', 'data', 'polars');

// #54 spec G.3. `estimated` is declared but not shipped in release 1; it is
// listed so a tier-C table is a deliberate, reviewable act rather than a typo
// that falls through to a friendlier tier.
const TIERS = ['certificate', 'modelled', 'estimated'];

// Everything below FAILS CLOSED (spec H). The IDENTITY and PROVENANCE contract
// specifically, stated as what is actually checked: a boat id that is missing,
// unsafe or duplicated; a sail id that is unsafe; any two sails resolving to
// the same output file; a boat missing its plausibility bound or its sanity
// anchors; a sail missing its provenance tier or source note. Each throws and
// names itself, and never inherits another boat's values — an anchor that
// silently validates the wrong hull is worse than no anchor.
//
// Not an inventory of every guard below: the structural ones (grid shapes,
// numeric types, axis ordering, TWS monotonicity, anchor bands) are separate
// and additional.
//
// Deliberately NOT checked, so nobody reads a guarantee here that does not
// exist: a MISSING sail id is unreachable (a sail id is an object key), and
// there is no duplicate-SAIL-id check — sail ids are not unique across boats
// by design (see the outDir comment above), and a repeated key within one
// boat's `sails` map is collapsed by JSON.parse before this script ever sees
// it. What the output-file check below does cover is two sails, in any boats,
// landing on one filename.
function requireField(cond, what) {
  if (!cond) throw new Error(`polars-source.json: ${what}`);
}

// Both halves of the `${id}-${sailId}.json` filename must pass this. Applying
// it to the boat id alone left the sail id — the other half of the same
// interpolated string — able to escape the output directory entirely: a sail
// keyed `../../../ESCAPED` wrote app/public/data/ESCAPED.json, beside
// harbors.json and mask.bin, with exit 0 (measured, fix round 1).
//
// The first character may not be `-`: an id like `-rf` stays inside polars/
// but produces a committed filename that a later `rm`/`tar`/`cp` glob in that
// directory hands to the tool as an OPTION rather than a path.
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// tws/twa/beat/gybe grids must be real numbers, not decimal strings — see the
// coercion note on validate()'s plausibility predicate for the mechanism.
function requireNumbers(what, xs) {
  requireField(Array.isArray(xs) && xs.length > 0, `${what}: not a non-empty array`);
  for (const v of xs) requireField(typeof v === 'number' && Number.isFinite(v), `${what}: ${JSON.stringify(v)} is not a finite number`);
}

// An INTERPOLATION AXIS, unlike the data it indexes, must strictly ascend.
// app/src/lib/polar.ts brackets each axis by walking it and then divides by
// the gap between the two bracketing entries. (The walk's exact form differs
// per axis — the TWS one is bounded by `j < tws.length - 1`, the TWA one and
// interp1 are unbounded and guarded by early clamp returns instead — so do
// not expect one quoted line to appear on all four paths; it is the DIVISION
// that is common.) MEASURED against that arithmetic: an out-of-order axis
// brackets (or clamps to) the wrong column and interpolates a silently wrong
// speed ([6,4,8] at 5 answers as if it were 0.5 between 4 and 8), and a
// repeated value can make the denominator zero ([4,4,8] at 4 is 0/0 -> NaN).
// NaN then flows into the isochrone cost unchecked. Neither throws, and
// without the check below the build exits 0. A LENGTH-1 axis is a separate
// hole this loop cannot see — see requireInterpolable below. Applied to the
// four axes polar.ts actually interpolates over (`tws`, `twa`, `beat.tws`,
// `gybe.tws`) and NOT to `beat.angle`/`gybe.angle`, which are the
// interpolated VALUES and are free to fall as well as rise.
//
// This became reachable with #54: the axes moved from one hand-maintained
// shared table to per-boat data a new-boat contributor supplies, so their
// ordering is now untrusted input like everything else this block validates.
function requireAscending(what, xs) {
  for (let i = 1; i < xs.length; i++)
    requireField(
      xs[i] > xs[i - 1],
      `${what}: not strictly ascending at index ${i} (${JSON.stringify(xs[i - 1])} then ${JSON.stringify(xs[i])}) — an interpolation axis must rise`,
    );
}

// SEPARATE from requireAscending, because the loop above is a NO-OP at length
// 1 and `requireNumbers` demands only length > 0 — a single-entry axis passed
// every guard here and shipped at exit 0. Applied to `tws` and `twa` only, the
// two axes speedKn walks; beat.tws/gybe.tws go through interp1, whose two
// clamp returns (`x <= xs[0]`, `x >= xs[n-1]`) cover every x when n is 1, so
// they are safe at length 1 and are deliberately not floored.
//
// The two axes are floored for DIFFERENT reasons, measured against polar.ts's
// own arithmetic rather than assumed alike:
//   tws length 1 — `while (j < tws.length - 1 && …)` is `j < 0`, so j stays 1
//     and `fw = (w - tws[0]) / (tws[1] - tws[0])` is 0/NaN while speeds[row][1]
//     is undefined: NaN out of EVERY heading, into the isochrone cost.
//   twa length 1 — NOT a NaN: the two clamps compare `a` against the SAME
//     element there (`twa[0]` IS `twa[twa.length - 1]`), and `a <= x` and
//     `a >= x` between them cover every angle, so one clamp always returns
//     and the unbounded walk is unreachable. Floored anyway because a
//     one-row table cannot interpolate over TWA at all, which no polar this
//     validates ever means.
// validate() cannot catch either: its column check is consistent at 1, its
// TWS-monotonicity check needs `j > 0`, and its anchors read the SOURCE grid,
// never Polar output.
function requireInterpolable(what, xs) {
  requireField(
    xs.length >= 2,
    `${what}: an interpolation axis needs at least two points, got ${xs.length}`,
  );
}

function requireAngleTable(what, t) {
  requireField(t != null && typeof t === 'object', `${what} missing`);
  requireNumbers(`${what}.tws`, t.tws);
  requireAscending(`${what}.tws`, t.tws);
  requireNumbers(`${what}.angle`, t.angle);
  requireField(t.tws.length === t.angle.length, `${what}: tws/angle length mismatch`);
}

function validate(name, speeds, boat) {
  const { tws, twa } = boat;
  const { maxSpeedKn, anchors } = boat.validation;
  if (speeds.length !== twa.length) throw new Error(`${name}: twa row count`);
  for (const [i, row] of speeds.entries()) {
    if (row.length !== tws.length) throw new Error(`${name}: tws col count @twa ${twa[i]}`);
    for (const [j, v] of row.entries()) {
      // `typeof`/`isFinite` first: `>` and `<` COERCE, so without them a table
      // of decimal STRINGS satisfies `v > 0 && v < maxSpeedKn` and ships, after
      // which lib/polar.ts interpolates over strings where `+` concatenates.
      if (!(typeof v === 'number' && Number.isFinite(v) && v > 0 && v < maxSpeedKn))
        throw new Error(
          `${name}: implausible ${JSON.stringify(v)} kn @ ${twa[i]}/${tws[j]} (max ${maxSpeedKn})`,
        );
      // monotone in TWS up to 20 kn (25-kn column may be depowered)
      if (j > 0 && j < row.length - 1 && row[j] < row[j - 1] - 1e-9)
        throw new Error(`${name}: non-monotone TWS @ twa ${twa[i]}, tws ${tws[j]}`);
    }
  }
  // sanity anchors (research-verified magnitudes), per boat — never shared
  for (const a of anchors) {
    const i = twa.indexOf(a.twa);
    const j = tws.indexOf(a.tws);
    if (i < 0 || j < 0)
      throw new Error(`${name}: sanity anchor twa=${a.twa}/tws=${a.tws} not present in source table`);
    const v = speeds[i][j];
    if (v < a.minKn || v > a.maxKn)
      throw new Error(
        `${name}: ${a.label} @twa ${a.twa}/tws ${a.tws} is ${v} kn, outside [${a.minKn}, ${a.maxKn}]`,
      );
  }
}

// ---- #54 spec N.6: tier-C (estimated) fail-closed rules E1-E8 ----
//
// The whole point of these is that tier C must be DECLARED and never FALLEN
// INTO. An estimated polar is a stronger claim than this app makes anywhere
// else — it is a speed table for the boat the user is actually sailing, and
// nobody measured it against that hull — so every step from the brochure
// figures to the committed numbers has to be re-runnable by a reviewer, and
// anything missing has to stop the build rather than ship quietly.
//
// E8 is not a check in this file: it is the rule that everything ABOVE this
// block stays exactly as it was, so a tier-C boat gets no bypass around the
// axis, plausibility, monotonicity, anchor-band, id and filename guards that
// already existed. app/src/test/buildPolars.failClosed.test.ts pins that by
// firing several of those guards at a tier-C boat specifically.

/** E1 + E2. Runs for EVERY sail, because both directions of E1 matter. */
function requireEstimatorBlock(name, sail, boatsById) {
  const est = sail.estimator;
  const isEstimated = sail.provenance.tier === 'estimated';

  requireField(
    !(est != null && sail.derivation != null),
    `${name}: carries both an estimator block and a derivation block — a table has exactly one ` +
      'derivation (spec P.6 D1)',
  );

  // E1, converse direction. A non-estimated sail carrying an estimator block
  // is a tier that was quietly downgraded in the provenance field while the
  // derivation stayed — the exact "fell into tier C without saying so" shape
  // read backwards, and it would present scaled numbers as certificate-grade.
  if (!isEstimated) {
    requireField(
      est == null,
      `${name}: provenance tier is ${JSON.stringify(sail.provenance.tier)} but the sail carries an ` +
        "estimator block. A derived table must declare tier 'estimated'.",
    );
    return;
  }

  // E1, forward direction, widened by spec P.6 D1 to admit a ramp derivation.
  if (est == null && sail.derivation?.method === GENOA_RAMP_METHOD) return;
  requireField(
    est != null && typeof est === 'object',
    `${name}: tier 'estimated' requires a complete estimator block or a ${GENOA_RAMP_METHOD} ` +
      'derivation (spec N.6 E1) — tier C is declared, never fallen into',
  );
  requireField(
    ESTIMATOR_METHODS.includes(est.method),
    `${name}: estimator.method ${JSON.stringify(est.method)} not one of ${ESTIMATOR_METHODS.join('/')}`,
  );
  for (const key of ['baseBoatId', 'baseSailId']) {
    requireField(
      typeof est[key] === 'string' && est[key].length > 0,
      `${name}: estimator.${key} missing — the derivation must name what it derives FROM`,
    );
  }
  // MAJOR 4 / spec N.3 step 3: naming a base is not enough, the base must BE
  // the certificate-anchored table. Without this, two states build clean and
  // both are forbidden: scaling from the MODELLED genoa overlay (E7 reproduces
  // happily from either, while the hand-written note still claims
  // "certificate-anchored"), and scaling from another ESTIMATED table, which
  // puts G.2's "estimate of an estimate" into the ETA itself rather than into
  // the comparison. Which table it came from and whether that
  // table is a certificate are the two most load-bearing facts about the
  // derivation, and until now they were prose only.
  if (est.method === SCALAR_METHOD) {
    const baseSail = boatsById.get(est.baseBoatId)?.sails?.[est.baseSailId];
    requireField(
      baseSail != null,
      `${name}: estimator base ${est.baseBoatId}/${est.baseSailId} is not a boat/sail in this ` +
        'file (spec N.6 E1)',
    );
    requireField(
      baseSail.provenance?.tier === 'certificate',
      `${name}: estimator base ${est.baseBoatId}/${est.baseSailId} has tier ` +
        `${JSON.stringify(baseSail.provenance?.tier)}, not 'certificate' — spec N.3 step 3 ` +
        'requires the certificate-anchored table as the base, never a modelled overlay or ' +
        'another estimate',
    );
  }

  requireField(
    typeof est.scalar === 'number' && Number.isFinite(est.scalar),
    `${name}: estimator.scalar missing or not a finite number (spec N.6 E1)`,
  );
  // Not merely "present": the value asserts this estimator ingested no
  // third-party corpus, which is what keeps licence exposure and donor
  // keel-variant ambiguity out of scope. A `false` here would describe a
  // different method than the one this file implements.
  requireField(
    est.corpusFree === true,
    `${name}: estimator.corpusFree must be exactly true — this estimator ingests no third-party ` +
      'table, and a block claiming otherwise describes a method this pipeline does not implement',
  );
  requireField(
    typeof est.uncertaintyPct === 'number' && Number.isFinite(est.uncertaintyPct) && est.uncertaintyPct > 0,
    `${name}: estimator.uncertaintyPct missing or not a positive number — an estimated table ` +
      'ships with a published band or it does not ship',
  );

  // E6, the "which ramp" half. The second table's derivation must be explicit.
  //
  // The estimator ALSO refuses a ramp method with no ramp block, so this check
  // is not what makes the build abort — MEASURED: deleting it reds zero
  // selftest rows, because estimate_polars.mjs throws instead. What it adds is
  // an earlier, sharper failure: it names the missing FIELD and the rule, in
  // the structural pass, before any estimator arithmetic runs. Its messages
  // therefore carry the `spec N.6 E6` marker that the estimator's do not, and
  // the selftest rows assert THAT marker — otherwise the rows would be
  // satisfied by the estimator's abort and this block could be deleted with
  // every test still green.
  if (est.method === RAMP_METHOD) {
    requireField(
      est.ramp != null && typeof est.ramp === 'object',
      `${name}: ${RAMP_METHOD} needs a ramp block — spec N.6 E6 requires the second sail to ` +
        'declare WHICH base sail and WHICH ramp it came from',
    );
    for (const key of ['boatId', 'fromSailId', 'toSailId']) {
      requireField(
        typeof est.ramp[key] === 'string' && est.ramp[key].length > 0,
        `${name}: estimator.ramp.${key} missing — spec N.6 E6 requires the second sail to declare ` +
          'WHICH base sail and WHICH ramp it came from',
      );
    }
    // MAJOR 4: a ramp of one sail onto ITSELF is a ratio of exactly 1.0 — two
    // byte-identical tables shipped as two different sails.
    requireField(
      est.ramp.fromSailId !== est.ramp.toSailId,
      `${name}: estimator.ramp.fromSailId and toSailId are both ` +
        `${JSON.stringify(est.ramp.fromSailId)} — that ramp is the identity, so the two sails ` +
        'would ship byte-identical tables (spec N.3 step 3)',
    );
  }

  // MAJOR 2: `inputs` belongs to the SCALAR sail alone, and a RAMP sail must
  // NOT carry one. MEASURED before this rule existed: editing
  // `inputs.sailAreaUpwindM2` on a ramp sail from 77.76 to 85.7 built cleanly
  // with all six assets byte-identical, because estimatedSpeedsFor's RAMP
  // branch recurses into the BASE sail and never reads its own inputs. Those
  // four sourced figures were dead data — E2 checked they existed and named a
  // source, and nothing checked they matched the figures the table was
  // actually built from. Worse, the ramp block held the FIRST occurrence of
  // 77.76 in the file, so it is the one a contributor correcting the Elan's
  // sail area would edit, shipping a table whose declared provenance
  // contradicts its own derivation with no signal at all — the header's
  // "a mixed basis is undetectable afterwards" hazard, one level in.
  //
  // Deleting the data beats guarding it: there is now nothing to diverge.
  if (est.method === RAMP_METHOD) {
    requireField(
      est.inputs === undefined,
      `${name}: a ${RAMP_METHOD} sail must not declare estimator.inputs — it derives from ` +
        `${est.baseBoatId}/${est.baseSailId}, whose block owns the figures. A second copy here ` +
        'is dead data that nothing reads and nothing can keep honest (spec N.6 E2).',
    );
    return;
  }

  // E2. `inputs` must be non-empty first: "every input carries a source" is
  // VACUOUSLY TRUE of an empty object, so the emptiness check is what stops
  // this rule passing on a block that declares no inputs at all.
  requireField(
    est.inputs != null && typeof est.inputs === 'object' && Object.keys(est.inputs).length > 0,
    `${name}: estimator.inputs is empty — an input list nobody can check is not provenance`,
  );
  for (const [key, entry] of Object.entries(est.inputs)) {
    requireField(
      entry != null && typeof entry === 'object',
      `${name}: estimator.inputs.${key} is not a { value, source } object (spec N.6 E2)`,
    );
    requireField(
      typeof entry.value === 'number' && Number.isFinite(entry.value),
      `${name}: estimator.inputs.${key}.value missing or not a finite number (spec N.6 E2)`,
    );
    requireField(
      typeof entry.source === 'string' && entry.source.length > 0,
      `${name}: estimator.inputs.${key} has no source (spec N.6 E2). A ratio built from a MIXED ` +
        'measurement basis is wrong by a few percent through every cell and undetectable ' +
        'afterwards, so each figure names where it came from.',
    );
  }
}

/**
 * E4. Refuse an anchor COPIED from the base boat: same cell, same band, same
 * source. Conjunctive on all three, so the false-positive rate is near zero —
 * two hulls legitimately reaching the same speed in the same conditions differ
 * in at least the source string, and two hulls sharing a source string for
 * genuinely different bands differ in the band.
 *
 * This is spec L's "reuse the Salona 45's polar sanity anchors for other hulls"
 * row made mechanical: such an anchor converts "unvalidated" into "validated
 * against the wrong thing", which is worse than no anchor at all.
 */
function requireOwnAnchors(boat, boatsById) {
  const baseIds = new Set(
    estimatedSailsOfBoat(boat)
      .map((sailId) => boat.sails[sailId].estimator.baseBoatId)
      .filter((baseId) => baseId !== boat.id),
  );
  for (const baseId of baseIds) {
    const base = boatsById.get(baseId);
    if (base == null) continue; // E1/the estimator itself reports an unknown base boat.
    for (const a of boat.validation.anchors) {
      const twin = (base.validation?.anchors ?? []).find((b) => b.twa === a.twa && b.tws === a.tws);
      if (twin == null) continue;
      requireField(
        !(a.minKn === twin.minKn && a.maxKn === twin.maxKn && a.source === twin.source),
        `${boat.id}: anchor ${JSON.stringify(a.label)} @twa ${a.twa}/tws ${a.tws} has the same band ` +
          `[${a.minKn}, ${a.maxKn}] AND the same source as ${baseId}'s anchor at that cell — spec ` +
          'N.6 E4. An anchor inherited from the donor hull validates the wrong boat.',
      );
    }
  }
}

/**
 * E6, the "which base sail" half. Exactly one estimated sail per boat may be
 * the SCALAR base; every other estimated sail must be a ramp off THAT sail, on
 * THIS boat. Two independent scalar tables on one boat would mean two different
 * derivations presented as one boat's inventory, and a ramp pointing at another
 * boat's sail would silently reintroduce the donor's hull into the second table.
 */
function requireSailDerivations(boat) {
  const estimated = estimatedSailsOfBoat(boat);
  if (estimated.length === 0) return;
  const bases = estimated.filter((s) => boat.sails[s].estimator.method === SCALAR_METHOD);
  requireField(
    bases.length === 1,
    `${boat.id}: ${bases.length} sails declare ${SCALAR_METHOD} (expected exactly 1) — a tier-C ` +
      'boat has one scaled base table and derives the rest from it (spec N.6 E6)',
  );
  const baseSailId = bases[0];
  for (const sailId of estimated) {
    if (sailId === baseSailId) continue;
    const est = boat.sails[sailId].estimator;
    requireField(
      est.baseBoatId === boat.id && est.baseSailId === baseSailId,
      `${boat.id}/${sailId}: derives from ${est.baseBoatId}/${est.baseSailId} but a tier-C boat's ` +
        `second sail must derive from its OWN base table, ${boat.id}/${baseSailId} (spec N.6 E6)`,
    );
    // MAJOR 4: the ramp must come from the DONOR hull — the same boat the base
    // table was scaled from. A ramp taken from anywhere else is not "the
    // Salona 45's documented overlay ramp" that N.4 authorises, and N.4's
    // argument (the difference between the two tables is a function of THE
    // RAMP, not the hull) depends on knowing which ramp it is.
    const donorId = boat.sails[baseSailId].estimator.baseBoatId;
    requireField(
      est.ramp.boatId === donorId,
      `${boat.id}/${sailId}: ramp comes from ${est.ramp.boatId} but the base table was scaled ` +
        `from ${donorId} — spec N.4 authorises the DONOR hull's own documented overlay ramp`,
    );
  }
}

// ---- Spec P.6: the `derivation` block, rules D1-D7 (D5 and D7's second half
// run once the catalogue is parsed; D8 is E8 again: every check above still
// applies to a derived sail). Phase 1 knows the certificate and ramp methods
// only, so a polargraph donor is refused rather than half-checked.

/** D1: the method fixes the tier. Also D2's table of known methods. */
const DERIVATION_TIER = { [CERT_METHOD]: 'modelled', [GENOA_RAMP_METHOD]: 'estimated' };
const RAMP_UNCERTAINTY_PCT = 10;
const SOURCE_PATH_RE = /^orc-sources\/[A-Za-z0-9._-]+\.json$/;
const DONOR_RECORD_FIELDS = {
  refNo: 'RefNo',
  yacht: 'YachtName',
  sailNo: 'SailNo',
  measuredDraftM: 'Draft',
  areaJibM2: 'Area_Jib',
  areaMainM2: 'Area_Main',
};
/** The ORC certificate family each certificate method reads. */
const CERT_FAMILY = { [CERT_METHOD]: 'NS' };
/** D6, negative: a tier-B note never claims a certificate of this boat. Matched case-insensitively. */
const OWN_CERTIFICATE_CLAIMS = ['own ORC certificate', 'own certificate'];
/** Spec P.9: the one boat whose modelled table predates the derivation block. */
const REFERENCE_BOAT_ID = 'salona-45';

/** D3: each source is a committed file under orc-sources/, byte-identical to its declared hash. */
function readDerivationSources(name, der) {
  requireField(
    Array.isArray(der.sources) && der.sources.length > 0,
    `${name}: ${der.method} lists no derivation.sources (spec P.6 D3)`,
  );
  return der.sources.map((s) => {
    requireField(
      typeof s?.path === 'string' && SOURCE_PATH_RE.test(s.path),
      `${name}: source path ${JSON.stringify(s?.path)} is not a file directly under orc-sources/ (spec P.6 D3)`,
    );
    const file = join(here, s.path);
    requireField(existsSync(file), `${name}: source ${s.path} does not exist (spec P.6 D3)`);
    const bytes = readFileSync(file);
    requireField(
      createHash('sha256').update(bytes).digest('hex') === s.sha256,
      `${name}: ${s.path} does not match its declared sha256 (spec P.6 D3)`,
    );
    const env = JSON.parse(bytes.toString('utf8'));
    for (const key of ['url', 'retrievedAt', 'responseSha256'])
      requireField(
        typeof env[key] === 'string' && env[key].length > 0,
        `${name}: ${s.path} carries no ${key} (spec P.6 D3)`,
      );
    requireField(
      /^[0-9a-f]{64}$/.test(env.responseSha256) && !/^0+$/.test(env.responseSha256),
      `${name}: ${s.path} responseSha256 ${JSON.stringify(env.responseSha256)} is not a real sha256 of the ` +
        'captured response (spec P.6 D3)',
    );
    return env;
  });
}

/** D4 for the certificate method: a sister-hull donor that matches its record, of this boat's class. */
function requireCertDonor(name, der, envelopes, boat) {
  const donor = der.donor;
  requireField(donor != null && typeof donor === 'object', `${name}: derivation.donor missing (spec P.6 D4)`);
  requireField(
    donor.kind === 'orc-cert',
    `${name}: ${CERT_METHOD} needs donor.kind 'orc-cert', got ${JSON.stringify(donor.kind)} (spec P.6 D4)`,
  );
  requireField(
    donor.relation === 'sister-hull',
    `${name}: donor.relation is ${JSON.stringify(donor.relation)}, not 'sister-hull' (spec P.6 D4)`,
  );
  requireField(
    envelopes.length === 1,
    `${name}: ${CERT_METHOD} reads exactly one certificate, got ${envelopes.length} sources (spec P.6 D4)`,
  );
  const record = envelopes[0].record;
  for (const [key, field] of Object.entries(DONOR_RECORD_FIELDS))
    requireField(
      record?.[field] === donor[key],
      `${name}: donor.${key} ${JSON.stringify(donor[key])} is not the certificate's ${field} ` +
        `${JSON.stringify(record?.[field])} (spec P.6 D4)`,
    );
  requireField(
    record.Family === CERT_FAMILY[der.method],
    `${name}: ${der.method} reads Family ${CERT_FAMILY[der.method]} certificates, but the record's Family is ` +
      `${JSON.stringify(record.Family)} (spec P.6 D4)`,
  );
  requireField(
    typeof record.Class === 'string' &&
      record.Class.length > 0 &&
      (boat.name === record.Class || boat.name.startsWith(`${record.Class} (`)),
    `${name}: a sister-hull donor must be of this boat's class, but the record's Class ` +
      `${JSON.stringify(record.Class)} does not name ${JSON.stringify(boat.name)} (spec P.6 D4)`,
  );
  return record;
}

/** D4 for the ramp method: the base sail is another sail of this boat, the ramp a real boat's sails. */
function requireRampTargets(name, sailId, der, boat, boatsById) {
  requireField(
    typeof der.fromSailId === 'string' && der.fromSailId !== sailId && Object.hasOwn(boat.sails, der.fromSailId),
    `${name}: derivation.fromSailId ${JSON.stringify(der.fromSailId)} is not another sail of ${boat.id} (spec P.6 D4)`,
  );
  const ramp = der.ramp;
  requireField(ramp != null && typeof ramp === 'object', `${name}: derivation.ramp missing (spec P.6 D4)`);
  const rampBoat = typeof ramp.boatId === 'string' ? boatsById.get(ramp.boatId) : undefined;
  requireField(
    rampBoat?.sails != null && typeof rampBoat.sails === 'object',
    `${name}: derivation.ramp.boatId ${JSON.stringify(ramp.boatId)} is not a boat with tables in this file (spec P.6 D4)`,
  );
  for (const key of ['fromSailId', 'toSailId']) {
    requireField(
      typeof ramp[key] === 'string' && Object.hasOwn(rampBoat.sails, ramp[key]),
      `${name}: derivation.ramp.${key} ${JSON.stringify(ramp[key])} is not a sail of ${ramp.boatId} (spec P.6 D4)`,
    );
    // E1/E6's "never an estimate of an estimate", on the ramp path.
    requireField(
      rampBoat.sails[ramp[key]]?.provenance?.tier !== 'estimated',
      `${name}: derivation.ramp.${key} ${ramp.boatId}/${ramp[key]} is itself estimated — a ramp comes from ` +
        'measured or modelled tables (spec P.6 D4)',
    );
  }
}

/**
 * D1-D4 and D6 for one sail carrying a `derivation` block. Returns what an
 * anchor citing this sail's declared sources would name, for D7.
 */
function requireDerivationBlock(name, sailId, sail, boat, boatsById) {
  const der = sail.derivation;
  requireField(der != null && typeof der === 'object', `${name}: derivation is not an object (spec P.6 D2)`);
  requireField(
    typeof der.method === 'string' && Object.hasOwn(DERIVATION_TIER, der.method),
    `${name}: derivation.method ${JSON.stringify(der.method)} is not one of ` +
      `${Object.keys(DERIVATION_TIER).join('/')} (spec P.6 D2)`,
  );
  requireField(
    DERIVATION_TIER[der.method] === sail.provenance.tier,
    `${name}: ${der.method} fixes tier '${DERIVATION_TIER[der.method]}', but the sail declares ` +
      `${JSON.stringify(sail.provenance.tier)} (spec P.6 D1)`,
  );
  let tokens;
  let cited = [];
  if (der.method === GENOA_RAMP_METHOD) {
    requireField(
      der.uncertaintyPct === RAMP_UNCERTAINTY_PCT,
      `${name}: ${der.method} declares uncertaintyPct ${JSON.stringify(der.uncertaintyPct)}, not ` +
        `${RAMP_UNCERTAINTY_PCT} (spec P.6 D1)`,
    );
    requireRampTargets(name, sailId, der, boat, boatsById);
    tokens = ['ESTIMATED', 'ramp'];
  } else {
    const record = requireCertDonor(name, der, readDerivationSources(name, der), boat);
    tokens = ['SISTER HULL', der.donor.refNo];
    cited = [...der.sources.map((s) => basename(s.path)), record.RefNo, record.YachtName, record.SailNo];
  }
  for (const t of tokens)
    requireField(
      sail.provenance.note.includes(t),
      `${name}: provenance note lacks ${JSON.stringify(t)}, which ${der.method} requires (spec P.6 D6)`,
    );
  return cited;
}

/** D6, negative, for every modelled note: run before the positive tokens so the claim itself is named. */
function requireNoOwnCertificateClaim(name, sail) {
  const note = sail.provenance.note.toLowerCase();
  for (const claim of OWN_CERTIFICATE_CLAIMS)
    requireField(
      !note.includes(claim.toLowerCase()),
      `${name}: a modelled note must not claim this boat's certificate, but it says ${JSON.stringify(claim)} ` +
        '(spec P.6 D6)',
    );
}

/** D7, first half: an anchor never names a declared source of its own boat's derived tables. */
function requireAnchorsIndependentOfDerivations(boat, cited) {
  for (const a of boat.validation.anchors)
    for (const c of cited)
      requireField(
        !a.source.includes(c),
        `${boat.id}: anchor ${JSON.stringify(a.label)} cites ${JSON.stringify(c)}, a source of its own ` +
          'derived table, so it cannot check that table (spec P.6 D7)',
      );
}

/** D7, second half: E4 for every boat, against every other boat. */
function requireNoRepeatedAnchors(boats) {
  const owner = new Map();
  for (const boat of boats) {
    if (Object.hasOwn(boat, 'polarsFrom')) continue;
    for (const a of boat.validation.anchors) {
      const key = JSON.stringify([a.twa, a.tws, a.minKn, a.maxKn, a.source]);
      const first = owner.get(key);
      requireField(
        first === undefined || first === boat.id,
        `${boat.id}: anchor ${JSON.stringify(a.label)} @twa ${a.twa}/tws ${a.tws} repeats ${first}'s ` +
          'anchor, band and source alike (spec P.6 D7) — it validates the other hull',
      );
      if (first === undefined) owner.set(key, boat.id);
    }
  }
}

/**
 * #567. A sister ship (same hull model, different keel) declares `polarsFrom:
 * <boat-id>` instead of carrying tables: it shares the donor's shipped assets
 * and its own `draftM` still feeds `verify_mask.py`'s per-boat gate scan. It
 * emits no files, so nothing can drift between two copies of one table.
 */
const TABLE_KEYS = ['tws', 'twa', 'beat', 'gybe', 'sails', 'validation'];

function requireBorrower(boat, boatsById) {
  const id = boat.id;
  requireField(
    typeof boat.polarsFrom === 'string' && boat.polarsFrom.length > 0,
    `${id}: polarsFrom must be a boat id string, got ${JSON.stringify(boat.polarsFrom)}`,
  );
  requireField(boat.polarsFrom !== id, `${id}: polarsFrom names the boat itself`);
  const donor = boatsById.get(boat.polarsFrom);
  requireField(donor != null, `${id}: polarsFrom ${JSON.stringify(boat.polarsFrom)} is not a boat in this file`);
  requireField(
    donor.polarsFrom === undefined,
    `${id}: polarsFrom ${JSON.stringify(boat.polarsFrom)} is itself a borrower — chains are not allowed`,
  );
  for (const key of TABLE_KEYS) {
    requireField(
      boat[key] === undefined,
      `${id}: carries ${key} beside polarsFrom — a borrower shares the donor's tables and never declares its own`,
    );
  }
  requireField(
    typeof boat.draftM === 'number' && Number.isFinite(boat.draftM) && boat.draftM > 0,
    `${id}: draftM missing or not a positive number — a borrower's draft is per hull`,
  );
}

requireField(Array.isArray(src.boats) && src.boats.length > 0, 'no boats');

// Two passes on purpose: EVERY boat and sail is validated before ANYTHING is
// written, so a bad entry leaves no half-built asset set behind. A one-pass
// loop writes the sails it reaches before the throw.
const pending = [];
// TWO checks, and NEITHER subsumes the other — both measured, fix round 2.
//
// `seenBoatIds` guards IDENTITY. A boat id is not just a filename component:
// boats.ts keys the catalogue by it and polarKey() keys PlanDeps.polars by it.
// Two boats sharing one id built cleanly and shipped: `table.boat` (below)
// reads whichever boat's own loop iteration wrote LAST to the shared
// `${id}-${sailId}.json` path — the SECOND (later-declared) boat's own name
// and provenance note, NOT the first's — because a later write simply
// overwrites an earlier one at the same output path. #552.
//
// `seenFiles` guards the OUTPUT, and is needed because `-` is BOTH the
// separator and a legal id character — so the id is not the unique thing, the
// filename is. Boat `a-b` + sail `c` and boat `a` + sail `b-c` are two
// distinct, legal, non-duplicate ids that both resolve to `a-b-c.json`: exit
// 0, the same filename logged twice, one table silently replacing the other.
//
// Why not `seenFiles` alone: two boats sharing an id with DISJOINT sail sets
// collide on no filename at all, so a filename-keyed check passes them (exit 0,
// measured) while the two records silently merge into one boat's polar set.
const seenBoatIds = new Set();
const seenFiles = new Set();
// E4 needs to reach the DONOR boat's anchors while validating the derived one,
// and the donor may appear later in the file than the boat deriving from it.
const boatsById = new Map(src.boats.map((b) => [b?.id, b]));

for (const boat of src.boats) {
  const id = boat.id;
  requireField(typeof id === 'string' && ID_RE.test(id), `boat id missing or unsafe: ${JSON.stringify(id)}`);
  requireField(!seenBoatIds.has(id), `duplicate boat id: ${id}`);
  seenBoatIds.add(id);
  requireField(typeof boat.name === 'string' && boat.name.length > 0, `${id}: name missing`);
  if (Object.hasOwn(boat, 'polarsFrom')) {
    requireBorrower(boat, boatsById);
    continue;
  }
  requireNumbers(`${id}: tws`, boat.tws);
  requireInterpolable(`${id}: tws`, boat.tws);
  requireAscending(`${id}: tws`, boat.tws);
  requireNumbers(`${id}: twa`, boat.twa);
  requireInterpolable(`${id}: twa`, boat.twa);
  requireAscending(`${id}: twa`, boat.twa);
  requireAngleTable(`${id}: beat`, boat.beat);
  requireAngleTable(`${id}: gybe`, boat.gybe);
  requireField(boat.validation != null, `${id}: validation missing`);
  requireField(
    typeof boat.validation.maxSpeedKn === 'number' && boat.validation.maxSpeedKn > 0,
    `${id}: validation.maxSpeedKn missing — a boat never inherits another boat's plausibility bound`,
  );
  requireField(
    Array.isArray(boat.validation.anchors) && boat.validation.anchors.length > 0,
    `${id}: validation.anchors missing — a boat never inherits another boat's sanity anchors`,
  );
  // MINOR 10 / spec N.3 step 5, which treats the plausibility ceiling and the
  // anchors ALIKE: "validation.maxSpeedKn AND every sanity anchor are hand-set
  // from that hull's own published figures". E3 made the anchor half fail
  // closed; this is its sibling. Without it a boat can ship a ceiling with no
  // provenance at all — the same unfalsifiable-band argument E3's own comment
  // makes, applied to the number most likely to be set by judgement rather
  // than by measurement.
  requireField(
    typeof boat.validation.maxSpeedKnSource === 'string' &&
      boat.validation.maxSpeedKnSource.length > 0,
    `${id}: validation.maxSpeedKnSource missing — spec N.3 step 5 holds the plausibility ceiling ` +
      'to the same standard as the anchors: a named figure for THIS hull, or a stated judgement.',
  );
  for (const a of boat.validation.anchors) {
    requireField(
      typeof a.label === 'string' &&
        typeof a.twa === 'number' &&
        typeof a.tws === 'number' &&
        typeof a.minKn === 'number' &&
        typeof a.maxKn === 'number',
      `${id}: malformed anchor ${JSON.stringify(a)}`,
    );
    // E3 (#54 spec N.6). An anchor without a named source is an unfalsifiable
    // band: nobody can tell later whether it came from a measurement of THIS
    // hull or from whatever number happened to make the build pass. Applied to
    // EVERY boat, not only tier-C ones, for two reasons — the reference boat is
    // held to the same standard, and E4 below compares a new hull's anchor
    // source against the base boat's, which is impossible if the base boat has
    // none. Adding these strings changed ZERO shipped bytes: `validation` is
    // not part of the emitted PolarTable.
    requireField(
      typeof a.source === 'string' && a.source.length > 0,
      `${id}: anchor ${JSON.stringify(a.label)} has no source — spec N.6 E3 requires a named, ` +
        'independent, citable magnitude for THIS hull. An anchor that silently validates the ' +
        'wrong hull is worse than no anchor.',
    );
  }

  // The sail set is derived from the data — there is no second enumeration to
  // fall out of step with it. A sail that reached the loop without provenance
  // used to ship an asset with NO `source` key at all (JSON.stringify drops an
  // undefined value), so the note went silently missing rather than visibly
  // wrong; it now throws below.
  const sailIds = Object.keys(boat.sails ?? {});
  const cited = [];
  requireField(sailIds.length > 0, `${id}: no sails`);

  for (const sailId of sailIds) {
    const name = `${id}/${sailId}`;
    // "unsafe", not "missing or unsafe": a sail id is an object key, so a
    // missing one is unreachable — see the contract comment at the top.
    requireField(ID_RE.test(sailId), `${id}: sail id unsafe: ${JSON.stringify(sailId)}`);
    const sail = boat.sails[sailId];
    // `provenance` is the JSON key in this file; `polarProvenance` is only the
    // TypeScript field name in boats.ts, and naming that here sends a
    // contributor grepping polars-source.json for a string it never contains.
    requireField(sail.provenance != null, `${name}: provenance missing`);
    requireField(
      TIERS.includes(sail.provenance.tier),
      `${name}: provenance tier ${JSON.stringify(sail.provenance.tier)} not one of ${TIERS.join('/')}`,
    );
    requireField(
      typeof sail.provenance.note === 'string' && sail.provenance.note.length > 0,
      `${name}: provenance note missing`,
    );
    requireEstimatorBlock(name, sail, boatsById);
    if (sail.provenance.tier === 'modelled') {
      requireNoOwnCertificateClaim(name, sail);
      requireField(
        id === REFERENCE_BOAT_ID || Object.hasOwn(sail, 'derivation'),
        `${name}: a modelled table on any boat but ${REFERENCE_BOAT_ID} needs a derivation block (spec P.9)`,
      );
    }
    if (Object.hasOwn(sail, 'derivation'))
      cited.push(...requireDerivationBlock(name, sailId, sail, boat, boatsById));
    requireField(Array.isArray(sail.speeds), `${name}: speeds missing`);
    validate(name, sail.speeds, boat);

    // Key order and field names are the on-disk PolarTable shape (app/src/
    // types.ts). `rig` is deliberately not renamed: app/src/lib/polar.ts reads
    // `table.rig` at runtime with no compiler between the JSON and the type.
    const table = {
      rig: sailId,
      boat: boat.name,
      tws: boat.tws,
      twa: boat.twa,
      speeds: sail.speeds,
      beat: boat.beat,
      gybe: boat.gybe,
      source: sail.provenance.note,
    };
    const file = `${id}-${sailId}.json`;
    requireField(!seenFiles.has(file), `duplicate output file ${file}: ${name} collides with an earlier sail`);
    seenFiles.add(file);
    pending.push({ file, table, rows: boat.twa.length, cols: boat.tws.length });
  }

  // Boat-level, so they run after every sail of this boat has been seen.
  requireSailDerivations(boat);
  requireOwnAnchors(boat, boatsById);
  requireAnchorsIndependentOfDerivations(boat, cited);
}

// After the loop so E4 reports first where both apply.
requireNoRepeatedAnchors(src.boats);

// ---- E5 and E7, once the whole catalogue is parsed ----
//
// ORDER IS LOAD-BEARING. E5 (the band) runs before E7 (reproducibility) so a
// donor that is simply not comparable reports as that, rather than as a
// mismatched table. A scalar can be out of band while the inputs, the declared
// scalar and every committed cell agree perfectly — that state is E5's alone
// to catch, and it is exactly the state a mutation must construct to prove E5
// is load-bearing rather than shadowed by E7.
for (const { boatId, sailId } of estimatedSails(src)) {
  const k = estimatedSpeedsFor(src, boatId, sailId).scalar;
  requireField(
    k >= SCALAR_MIN && k <= SCALAR_MAX,
    `${boatId}/${sailId}: hull scalar ${round3(k)} is outside [${SCALAR_MIN}, ${SCALAR_MAX}] ` +
      '(spec N.6 E5) — at that ratio the donor is not a comparable hull, and scaling its polar ' +
      'is extrapolation rather than estimation. Refuse rather than extrapolate.',
  );
}

// E7. The committed `speeds` must be exactly what re-running the estimator on
// the committed inputs produces — INCLUDING the second sail's base x ramp step,
// so both tables are reproducible from the same inputs. This is what makes a
// perturbed input (the 85.7-vs-77.76 m2 sail-area trap in estimate_polars.mjs's
// header) a red build rather than a 5% error nobody can see. It is also the
// rule that lets the anchors below be honestly wide: the anchors bound the
// table against reality, E7 bounds the arithmetic against its own inputs, and
// neither has to do the other's job.
const drifted = reproductionFailures(src);
requireField(
  drifted.length === 0,
  'estimated tables do not reproduce from their committed inputs (spec N.6 E7):\n  ' +
    drifted.map((f) => `${f.boatId}/${f.sailId}: ${f.detail}`).join('\n  ') +
    '\nRegenerate with `node estimate_polars.mjs --emit <boatId> <sailId>` or restore the input.',
);

// D5, last: D3 must have refused an unhashed source edit before this can.
let derivedDrift;
try {
  derivedDrift = derivationFailures(src);
} catch (e) {
  throw new Error(`polars-source.json: derived tables cannot be re-derived (spec P.6 D5): ${e.message}`);
}
requireField(
  derivedDrift.length === 0,
  'derived tables do not reproduce from orc-sources (spec P.6 D5):\n  ' +
    derivedDrift.map((f) => `${f.boatId}/${f.sailId}: ${f.detail}`).join('\n  ') +
    '\nRegenerate with `node derive_orc_polars.mjs --emit-boat <boatId>` or restore the source.',
);

mkdirSync(outDir, { recursive: true });
for (const { file, table, rows, cols } of pending) {
  writeFileSync(join(outDir, file), JSON.stringify(table));
  console.log(`wrote polars/${file} (${rows}x${cols})`);
}
