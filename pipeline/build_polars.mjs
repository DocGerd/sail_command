import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
//   twa length 1 — NOT a NaN: `a <= twa[0]` and `a >= twa[twa.length - 1]`
//     are the same test there, so every angle takes a clamp and the unbounded
//     walk is unreachable. Floored anyway because a one-row table cannot
//     interpolate over TWA at all, which no polar this validates ever means.
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

requireField(Array.isArray(src.boats) && src.boats.length > 0, 'no boats');

// Two passes on purpose: EVERY boat and sail is validated before ANYTHING is
// written, so a bad entry leaves no half-built asset set behind. A one-pass
// loop writes the sails it reaches before the throw.
const pending = [];
// TWO checks, and NEITHER subsumes the other — both measured, fix round 2.
//
// `seenBoatIds` guards IDENTITY. A boat id is not just a filename component:
// boats.ts keys the catalogue by it and polarKey() keys PlanDeps.polars by it.
// Two boats sharing one id built cleanly and shipped the second boat's speed
// table and provenance note under the first boat's name.
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

for (const boat of src.boats) {
  const id = boat.id;
  requireField(typeof id === 'string' && ID_RE.test(id), `boat id missing or unsafe: ${JSON.stringify(id)}`);
  requireField(!seenBoatIds.has(id), `duplicate boat id: ${id}`);
  seenBoatIds.add(id);
  requireField(typeof boat.name === 'string' && boat.name.length > 0, `${id}: name missing`);
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
  for (const a of boat.validation.anchors) {
    requireField(
      typeof a.label === 'string' &&
        typeof a.twa === 'number' &&
        typeof a.tws === 'number' &&
        typeof a.minKn === 'number' &&
        typeof a.maxKn === 'number',
      `${id}: malformed anchor ${JSON.stringify(a)}`,
    );
  }

  // The sail set is derived from the data — there is no second enumeration to
  // fall out of step with it. A sail that reached the loop without provenance
  // used to ship an asset with NO `source` key at all (JSON.stringify drops an
  // undefined value), so the note went silently missing rather than visibly
  // wrong; it now throws below.
  const sailIds = Object.keys(boat.sails ?? {});
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
}

mkdirSync(outDir, { recursive: true });
for (const { file, table, rows, cols } of pending) {
  writeFileSync(join(outDir, file), JSON.stringify(table));
  console.log(`wrote polars/${file} (${rows}x${cols})`);
}
