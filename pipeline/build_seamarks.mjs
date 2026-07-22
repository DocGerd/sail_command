import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build-time-only pipeline script (#7): pulls core aids-to-navigation
// (buoys/beacons/lights) from the Overpass API and writes a minimal,
// validated GeoJSON FeatureCollection to app/public/data/seamarks.json.
// NOT wired into app runtime — Overpass has no CORS guarantee and
// rate-limits per IP; the browser only ever reads the committed file.
// Mirrors build_harbors.mjs's validate-then-write shape.

const here = dirname(fileURLToPath(import.meta.url));

const BBOX = { south: 54.3, north: 55.3, west: 9.4, east: 11.0 };
// Core AtoN per the design addendum: buoy_*/beacon_*/light_* only. Everything
// else (rock, wreck, mooring, seabed_area, ...) is deliberately out of scope
// for v1 — a hazard/clutter layer is a separate future issue.
const CORE_PREFIXES = ['buoy_', 'beacon_', 'light_'];
const MIN_EXPECTED_FEATURES = 1000; // sanity floor; a live pull found ~1794

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// One query for every seamark:type node in the bbox; the core-AtoN filter
// (and everything else) happens client-side below, in JS, not in the query —
// keeps the Overpass load to a single request.
const QUERY = `[out:json][timeout:180];\nnode["seamark:type"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});\nout body;`;

async function fetchOverpassNodes() {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Overpass returns 406 to requests with no identifying User-Agent.
      'User-Agent': 'SailCommandPipeline/1.0 (+https://github.com/DocGerd/sail_command)',
    },
    body: `data=${encodeURIComponent(QUERY)}`,
  });
  if (!res.ok) throw new Error(`Overpass request failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.elements)) throw new Error('Overpass response missing elements[]');
  return body.elements;
}

/**
 * Resolves the "primary" core seamark:type for a node. Almost every node
 * carries a single plain value; a rare handful in the live data carry a
 * semicolon-joined dual tag (e.g. "light_minor;beacon_lateral" — a beacon
 * that also carries a light). In that case prefer a buoy_ or beacon_
 * candidate over a light_ one: the buoy_/beacon_ namespace is where
 * category, colour and shape live, so it renders a strictly more informative
 * glyph, and the light's own character, period and colour are captured
 * separately below via the type-independent seamark:light: tags regardless
 * of which candidate wins here.
 */
function primaryType(rawType) {
  const candidates = rawType
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    candidates.find((c) => c.startsWith('buoy_') || c.startsWith('beacon_')) ??
    candidates.find((c) => c.startsWith('light_')) ??
    null
  );
}

function buildFeature(node) {
  if (node.type !== 'node') return null;
  if (!Number.isFinite(node.lat) || !Number.isFinite(node.lon)) return null;
  if (
    node.lat < BBOX.south ||
    node.lat > BBOX.north ||
    node.lon < BBOX.west ||
    node.lon > BBOX.east
  )
    return null;

  const tags = node.tags ?? {};
  const rawType = tags['seamark:type'];
  if (typeof rawType !== 'string' || !rawType) return null;

  const seamarkType = primaryType(rawType);
  if (!seamarkType || !CORE_PREFIXES.some((p) => seamarkType.startsWith(p))) return null;

  const properties = { seamarkType };
  const category = tags[`seamark:${seamarkType}:category`];
  const colour = tags[`seamark:${seamarkType}:colour`];
  const shape = tags[`seamark:${seamarkType}:shape`];
  if (category) properties.category = category;
  if (colour) properties.colour = colour;
  if (shape) properties.shape = shape;

  // Light character/period/colour live under the type-independent
  // `seamark:light:*` namespace (present on buoy_lateral etc. that carry a
  // light, as well as on light_minor/light_major themselves) — never under
  // `seamark:{seamarkType}:light:*`. Written as flat lightCharacter/
  // lightPeriod/lightColour properties, not a nested `light: {...}` object:
  // a MapLibre GeoJSON source silently stringifies nested object properties
  // on read-back (queryRenderedFeatures / click event properties), so a flat
  // shape is what the app side actually needs downstream.
  const lightCharacter = tags['seamark:light:character'];
  const lightPeriod = tags['seamark:light:period'];
  const lightColour = tags['seamark:light:colour'];
  if (lightCharacter) properties.lightCharacter = lightCharacter;
  if (lightPeriod) properties.lightPeriod = lightPeriod;
  if (lightColour) properties.lightColour = lightColour;

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [node.lon, node.lat] },
    properties,
  };
}

const elements = await fetchOverpassNodes();

const seenIds = new Set();
const features = [];
for (const el of elements) {
  const feature = buildFeature(el);
  if (!feature) continue;
  if (seenIds.has(el.id)) throw new Error(`duplicate node id ${el.id}`);
  seenIds.add(el.id);
  features.push(feature);
}

if (features.length < MIN_EXPECTED_FEATURES)
  throw new Error(
    `sanity check failed: only ${features.length} core AtoN nodes found (expected >= ${MIN_EXPECTED_FEATURES}); aborting rather than writing a truncated seamarks.json`,
  );

const collection = { type: 'FeatureCollection', features };
writeFileSync(
  join(here, '..', 'app', 'public', 'data', 'seamarks.json'),
  JSON.stringify(collection),
);
console.log(`wrote seamarks.json: ${features.length} seamarks`);
