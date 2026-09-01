import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, 'harbors-source.json'), 'utf8'));
// German translations of the English approach notes, keyed by harbor id.
// MUST cover every id whose note is non-null (build fails otherwise).
const notesDe = JSON.parse(readFileSync(join(here, 'harbors-notes-de.json'), 'utf8'));

// #652: the five #9 harbours genuinely unreachable at the ~46 m mask
// resolution are surfaced to the picker as a generated `knownDisconnected`
// field, sourced from verify_mask.py's KNOWN_DISCONNECTED dict — the
// pipeline's existing single source of truth (verify_mask.py already fails
// the mask build if that dict drifts from mask reality). Parsed from the
// Python source rather than duplicated as a second hand-written list here:
// a hand copy would be a THIRD place these ids could drift, on top of the
// Python source and the shipped harbors.json.
// app/src/test/harborKnownDisconnected.test.ts independently re-parses this
// same file (same regex idiom, deliberately not shared code — see
// maskTolerance.test.ts's readToleranceM()/verifyMaskConnectivity.test.ts's
// readKnownDisconnected() for the established pattern) and asserts the
// shipped harbors.json agrees, so a KNOWN_DISCONNECTED edit whose
// `npm --prefix pipeline run harbors` re-run was skipped reds the REQUIRED
// `app` check instead of silently shipping stale disclosure data.
function readKnownDisconnectedIds() {
  const py = readFileSync(join(here, 'verify_mask.py'), 'utf8');
  const block = py.match(/^KNOWN_DISCONNECTED:\s*dict\[str,\s*str\]\s*=\s*\{([\s\S]*?)^\}/m);
  if (!block) {
    throw new Error(
      "could not find an anchored KNOWN_DISCONNECTED dict in verify_mask.py (renamed, retyped, or " +
        "reformatted) - update this regex and app/src/test/harborKnownDisconnected.test.ts together",
    );
  }
  // #652 review MINOR 1: matches ANY quoted key, not `[a-z0-9-]+` — a
  // narrower charset silently DROPS a real entry whose id contains `_` or
  // an uppercase letter (measured: adding "sonderborg_old" or "Sonderborg"
  // to KNOWN_DISCONNECTED parsed the SAME five ids either way, no throw).
  // Reachability of that gap is nil TODAY only because the id-validation
  // check below, inside the harbors-source.json row map
  // (`if (!/^[a-z0-9-]+$/.test(id)) throw ...`), already enforces this same
  // narrow charset on every harbor id, so a real harbour can never have a
  // key the narrow form here would drop — but that makes the row-map check
  // an UNDOCUMENTED PRECONDITION of THIS regex, and relaxing it alone would
  // silently disarm this guard with nothing to say so. Widening costs
  // nothing: over-extraction (a stray quoted string inside a comment, a
  // nested-dict value) still fails CLOSED, downstream — either the "which
  // is not a harbor in harbors-source.json" throw a few lines below, or, if
  // it somehow named a real id, a mismatch against harbors.json in
  // app/src/test/harborKnownDisconnected.test.ts's equality guard.
  const ids = [...block[1].matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]);
  if (ids.length === 0) {
    throw new Error(
      'KNOWN_DISCONNECTED matched but zero ids were extracted - EITHER the entry regex stopped ' +
        'matching (single-quoted keys?), update it alongside the pipeline change, OR ' +
        'KNOWN_DISCONNECTED is now legitimately empty (all five #9 harbours reconnected) - in that ' +
        'case delete this guard and the shipped-ids field it derives, rather than widening the regex',
    );
  }
  return new Set(ids);
}
const KNOWN_DISCONNECTED_IDS = readKnownDisconnectedIds();

const BBOX = { south: 54.3, north: 55.3, west: 9.4, east: 11.0 };
const seen = new Set();
const harbors = rows.map(([id, de, da, en, country, lat, lon, noteEn]) => {
  if (seen.has(id)) throw new Error(`duplicate id ${id}`);
  seen.add(id);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad id ${id}`);
  if (![lat, lon].every(Number.isFinite)) throw new Error(`${id}: lat/lon not finite numbers`);
  if (lat < BBOX.south || lat > BBOX.north || lon < BBOX.west || lon > BBOX.east)
    throw new Error(`${id} outside bbox: ${lat},${lon}`);
  if (!['DE', 'DK'].includes(country)) throw new Error(`${id}: bad country`);
  const harbor = { id, names: { de, da, en }, country, snap: { lat, lon } };
  if (noteEn) {
    if (!notesDe[id]) throw new Error(`${id}: missing German note translation`);
    harbor.approachNote = { de: notesDe[id], en: noteEn };
  }
  if (KNOWN_DISCONNECTED_IDS.has(id)) harbor.knownDisconnected = true;
  return harbor;
});

// Fail loud rather than silently dropping a disclosure: a KNOWN_DISCONNECTED
// id that doesn't match any harbors-source.json row (typo, stale entry)
// would otherwise never get flagged, with nothing here to say so.
// verify_mask.py separately re-checks this same fact against harbors.json
// AFTER this script has run (its own DEEPEST_CONNECTING_GATE_M check) — this
// is the earlier, build-time half.
for (const id of KNOWN_DISCONNECTED_IDS) {
  if (!seen.has(id)) {
    throw new Error(
      `verify_mask.py's KNOWN_DISCONNECTED lists "${id}", which is not a harbor in harbors-source.json`,
    );
  }
}

harbors.sort((a, b) => a.names.de.localeCompare(b.names.de, 'de'));
writeFileSync(join(here, '..', 'app', 'public', 'data', 'harbors.json'), JSON.stringify(harbors, null, 1));
console.log(`wrote harbors.json: ${harbors.length} harbors`);
