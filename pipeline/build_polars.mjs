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

// Everything below FAILS CLOSED (spec H): a boat or sail whose id is missing,
// unsafe or duplicated, or a boat or sail missing its provenance tier, its
// source note, its plausibility bound or its sanity anchors, throws and names
// itself. It never inherits another boat's values — an anchor that silently
// validates the wrong hull is worse than no anchor.
function requireField(cond, what) {
  if (!cond) throw new Error(`polars-source.json: ${what}`);
}

// Both halves of the `${id}-${sailId}.json` filename must pass this. Applying
// it to the boat id alone left the sail id — the other half of the same
// interpolated string — able to escape the output directory entirely: a sail
// keyed `../../../ESCAPED` wrote app/public/data/ESCAPED.json, beside
// harbors.json and mask.bin, with exit 0 (measured, fix round 1).
const ID_RE = /^[a-z0-9-]+$/;

// Numbers must be real numbers. `>` and `<` coerce, so a table of decimal
// STRINGS satisfies `v > 0 && v < maxSpeedKn` and ships; lib/polar.ts then
// interpolates over strings, where `+` concatenates instead of adding.
function requireNumbers(what, xs) {
  requireField(Array.isArray(xs) && xs.length > 0, `${what}: not a non-empty array`);
  for (const v of xs) requireField(typeof v === 'number' && Number.isFinite(v), `${what}: ${JSON.stringify(v)} is not a finite number`);
}

function requireAngleTable(what, t) {
  requireField(t != null && typeof t === 'object', `${what} missing`);
  requireNumbers(`${what}.tws`, t.tws);
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
// A boat id is an IDENTITY, not just a filename component: boats.ts keys the
// catalogue by it and polarKey() keys PlanDeps.polars by it. Two boats sharing
// one id built cleanly and logged the same filename twice, shipping the second
// boat's speed table and provenance note under the first boat's name — §F.1's
// overwrite hazard on the boat axis (measured, fix round 1).
const seenBoatIds = new Set();

for (const boat of src.boats) {
  const id = boat.id;
  requireField(typeof id === 'string' && ID_RE.test(id), `boat id missing or unsafe: ${JSON.stringify(id)}`);
  requireField(!seenBoatIds.has(id), `duplicate boat id: ${id}`);
  seenBoatIds.add(id);
  requireField(typeof boat.name === 'string' && boat.name.length > 0, `${id}: name missing`);
  requireNumbers(`${id}: tws`, boat.tws);
  requireNumbers(`${id}: twa`, boat.twa);
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
    requireField(ID_RE.test(sailId), `${id}: sail id missing or unsafe: ${JSON.stringify(sailId)}`);
    const sail = boat.sails[sailId];
    requireField(sail.provenance != null, `${name}: polarProvenance missing`);
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
    pending.push({ file: `${id}-${sailId}.json`, table, rows: boat.twa.length, cols: boat.tws.length });
  }
}

mkdirSync(outDir, { recursive: true });
for (const { file, table, rows, cols } of pending) {
  writeFileSync(join(outDir, file), JSON.stringify(table));
  console.log(`wrote polars/${file} (${rows}x${cols})`);
}
