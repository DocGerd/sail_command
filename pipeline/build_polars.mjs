import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(join(here, 'polars-source.json'), 'utf8'));
const outDir = join(here, '..', 'app', 'public', 'data');

const SOURCE_NOTE =
  'Estimate derived from ORC International 2026 certificate Salona 45 "Miles Ahead" (AUT 035/26); ' +
  'downwind corrected to white sails via 23-boat ORC non-spinnaker ratio study; genoa table modeled overlay. ' +
  'Flat-water racing VPP — tune with the performance factor. NOT race-calibrated.';

function validate(name, speeds) {
  if (speeds.length !== src.twa.length) throw new Error(`${name}: twa row count`);
  for (const [i, row] of speeds.entries()) {
    if (row.length !== src.tws.length) throw new Error(`${name}: tws col count @twa ${src.twa[i]}`);
    for (const [j, v] of row.entries()) {
      if (!(v > 0 && v < 12)) throw new Error(`${name}: implausible ${v} kn @ ${src.twa[i]}/${src.tws[j]}`);
      // monotone in TWS up to 20 kn (25-kn column may be depowered)
      if (j > 0 && j < row.length - 1 && row[j] < row[j - 1] - 1e-9)
        throw new Error(`${name}: non-monotone TWS @ twa ${src.twa[i]}, tws ${src.tws[j]}`);
    }
  }
  // sanity anchors (research-verified magnitudes)
  const at = (twa, tws) => speeds[src.twa.indexOf(twa)][src.tws.indexOf(tws)];
  if (Math.abs(at(90, 16) - 8.86) > 0.6) throw new Error(`${name}: beam reach @16kn drifted`);
  if (at(52, 12) < 6.5 || at(52, 12) > 8.5) throw new Error(`${name}: upwind @12kn implausible`);
}

for (const rig of ['genoa', 'fock']) {
  validate(rig, src[rig]);
  const table = {
    rig,
    boat: src.boat,
    tws: src.tws,
    twa: src.twa,
    speeds: src[rig],
    beat: src.beat,
    gybe: src.gybe,
    source: SOURCE_NOTE,
  };
  writeFileSync(join(outDir, `polar-${rig}.json`), JSON.stringify(table));
  console.log(`wrote polar-${rig}.json (${src.twa.length}x${src.tws.length})`);
}
