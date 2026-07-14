import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, 'harbors-source.json'), 'utf8'));
// German translations of the English approach notes, keyed by harbor id.
// MUST cover every id whose note is non-null (build fails otherwise).
const notesDe = JSON.parse(readFileSync(join(here, 'harbors-notes-de.json'), 'utf8'));

const BBOX = { south: 54.3, north: 55.3, west: 9.4, east: 11.0 };
const seen = new Set();
const harbors = rows.map(([id, de, da, en, country, lat, lon, noteEn]) => {
  if (seen.has(id)) throw new Error(`duplicate id ${id}`);
  seen.add(id);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad id ${id}`);
  if (lat < BBOX.south || lat > BBOX.north || lon < BBOX.west || lon > BBOX.east)
    throw new Error(`${id} outside bbox: ${lat},${lon}`);
  if (!['DE', 'DK'].includes(country)) throw new Error(`${id}: bad country`);
  const harbor = { id, names: { de, da, en }, country, snap: { lat, lon } };
  if (noteEn) {
    if (!notesDe[id]) throw new Error(`${id}: missing German note translation`);
    harbor.approachNote = { de: notesDe[id], en: noteEn };
  }
  return harbor;
});
harbors.sort((a, b) => a.names.de.localeCompare(b.names.de, 'de'));
writeFileSync(join(here, '..', 'app', 'public', 'data', 'harbors.json'), JSON.stringify(harbors, null, 1));
console.log(`wrote harbors.json: ${harbors.length} harbors`);
