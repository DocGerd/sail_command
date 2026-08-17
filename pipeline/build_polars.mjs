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

// Everything below FAILS CLOSED (spec H): a boat or sail missing its id, its
// provenance tier, its source note, its plausibility bound or its sanity
// anchors throws and names itself. It never inherits another boat's values —
// an anchor that silently validates the wrong hull is worse than no anchor.
function requireField(cond, what) {
  if (!cond) throw new Error(`polars-source.json: ${what}`);
}

function validate(name, speeds, boat) {
  const { tws, twa } = boat;
  const { maxSpeedKn, anchors } = boat.validation;
  if (speeds.length !== twa.length) throw new Error(`${name}: twa row count`);
  for (const [i, row] of speeds.entries()) {
    if (row.length !== tws.length) throw new Error(`${name}: tws col count @twa ${twa[i]}`);
    for (const [j, v] of row.entries()) {
      if (!(v > 0 && v < maxSpeedKn))
        throw new Error(`${name}: implausible ${v} kn @ ${twa[i]}/${tws[j]} (max ${maxSpeedKn})`);
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

for (const boat of src.boats) {
  const id = boat.id;
  requireField(typeof id === 'string' && /^[a-z0-9-]+$/.test(id), `boat id missing or unsafe: ${id}`);
  requireField(typeof boat.name === 'string' && boat.name.length > 0, `${id}: name missing`);
  requireField(Array.isArray(boat.tws) && boat.tws.length > 0, `${id}: tws missing`);
  requireField(Array.isArray(boat.twa) && boat.twa.length > 0, `${id}: twa missing`);
  requireField(boat.beat != null && boat.gybe != null, `${id}: beat/gybe missing`);
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
