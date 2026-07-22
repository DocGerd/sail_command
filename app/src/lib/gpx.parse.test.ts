import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_AREA, GpxParseError, MAX_GPX_ELEMENTS, MAX_VIA_POINTS, parseGpx } from './gpx';

// ---------------------------------------------------------------------------
// Literals in these tests are hand-derived from the fixture coordinates below,
// never copied from parseGpx's own output (repo lesson #50). The load-bearing
// assertions are STRUCTURAL — which parsed point becomes origin vs. destination
// vs. via — derived independently from the §5 priority rules, so a mapping bug
// (e.g. treating a track's shape as via-points) fails the test rather than
// passing tautologically.
// ---------------------------------------------------------------------------

const GPX_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<gpx version="1.1" creator="Test" xmlns="http://www.topografix.com/GPX/1/1">';

/** Extract the single GpxParseError parseGpx throws (fails loudly otherwise). */
function parseError(xml: string): GpxParseError {
  try {
    parseGpx(xml);
  } catch (e) {
    if (e instanceof GpxParseError) return e;
    throw e;
  }
  throw new Error('expected parseGpx to throw, but it returned a route');
}

describe('parseGpx — <rte> (priority 1)', () => {
  it('maps first rtept to origin, last to destination, middle to via in order', () => {
    const xml =
      GPX_OPEN +
      '<rte><name>Test route</name>' +
      '<rtept lat="54.79" lon="9.43"><name>A</name></rtept>' +
      '<rtept lat="54.85" lon="9.80"><name>B</name></rtept>' +
      '<rtept lat="54.90" lon="10.20"><name>C</name></rtept>' +
      '<rtept lat="54.85" lon="10.52"><name>D</name></rtept>' +
      '</rte></gpx>';
    const route = parseGpx(xml);
    // A → origin, D → destination, B & C → via in file order (hand-derived).
    expect(route.origin).toEqual({ lat: 54.79, lon: 9.43 });
    expect(route.destination).toEqual({ lat: 54.85, lon: 10.52 });
    expect(route.viaPoints).toEqual([
      { lat: 54.85, lon: 9.8 },
      { lat: 54.9, lon: 10.2 },
    ]);
    expect(route.notices).toEqual([]);
  });

  it('uses the FIRST <rte> and notes the others were ignored', () => {
    const xml =
      GPX_OPEN +
      '<rte><rtept lat="54.70" lon="9.50"/><rtept lat="54.72" lon="9.55"/></rte>' +
      '<rte><rtept lat="54.80" lon="10.00"/><rtept lat="54.82" lon="10.05"/></rte>' +
      '</gpx>';
    const route = parseGpx(xml);
    // First rte's endpoints only — the second rte's coords must NOT appear.
    expect(route.origin).toEqual({ lat: 54.7, lon: 9.5 });
    expect(route.destination).toEqual({ lat: 54.72, lon: 9.55 });
    expect(route.viaPoints).toEqual([]);
    expect(route.notices).toContainEqual({ kind: 'multiple-routes' });
  });
});

describe('parseGpx — <trk> fallback (priority 2)', () => {
  it('reduces a 5-point track to its first+last trkpt, dropping the shape', () => {
    const xml =
      GPX_OPEN +
      '<trk><name>Recorded</name><trkseg>' +
      '<trkpt lat="54.60" lon="9.50"/>' +
      '<trkpt lat="54.62" lon="9.55"/>' +
      '<trkpt lat="54.64" lon="9.60"/>' +
      '<trkpt lat="54.66" lon="9.65"/>' +
      '<trkpt lat="54.68" lon="9.70"/>' +
      '</trkseg></trk></gpx>';
    const route = parseGpx(xml);
    // First trkpt → origin, last → destination, NO via (the 3 middle breadcrumb
    // points are intentionally ignored — this is the anti-tautology assertion).
    expect(route.origin).toEqual({ lat: 54.6, lon: 9.5 });
    expect(route.destination).toEqual({ lat: 54.68, lon: 9.7 });
    expect(route.viaPoints).toEqual([]);
    expect(route.notices).toContainEqual({ kind: 'track-reduced' });
  });

  it('uses the FIRST <trk> and notes the others were ignored (mirrors multiple-routes)', () => {
    const xml =
      GPX_OPEN +
      '<trk><name>First</name><trkseg>' +
      '<trkpt lat="54.60" lon="9.50"/><trkpt lat="54.62" lon="9.55"/>' +
      '</trkseg></trk>' +
      '<trk><name>Second</name><trkseg>' +
      '<trkpt lat="54.80" lon="10.00"/><trkpt lat="54.82" lon="10.05"/>' +
      '</trkseg></trk></gpx>';
    const route = parseGpx(xml);
    // First trk's endpoints only — the second trk's coords must NOT appear.
    expect(route.origin).toEqual({ lat: 54.6, lon: 9.5 });
    expect(route.destination).toEqual({ lat: 54.62, lon: 9.55 });
    expect(route.viaPoints).toEqual([]);
    expect(route.notices).toContainEqual({ kind: 'multiple-tracks' });
    expect(route.notices).toContainEqual({ kind: 'track-reduced' });
  });

  it('rejects a track with a single trkpt (no destination)', () => {
    const xml = GPX_OPEN + '<trk><trkseg><trkpt lat="54.6" lon="9.5"/></trkseg></trk></gpx>';
    expect(parseError(xml).reason).toBe('too-few-points');
  });
});

describe('parseGpx — standalone <wpt> (priority 3)', () => {
  it('treats the waypoint list as ordered origin/via/destination', () => {
    const xml =
      GPX_OPEN +
      '<wpt lat="54.75" lon="9.80"><name>W0</name></wpt>' +
      '<wpt lat="54.80" lon="10.00"><name>W1</name></wpt>' +
      '<wpt lat="54.85" lon="10.20"><name>W2</name></wpt>' +
      '</gpx>';
    const route = parseGpx(xml);
    expect(route.origin).toEqual({ lat: 54.75, lon: 9.8 });
    expect(route.destination).toEqual({ lat: 54.85, lon: 10.2 });
    expect(route.viaPoints).toEqual([{ lat: 54.8, lon: 10 }]);
    expect(route.notices).toEqual([]);
  });
});

describe('parseGpx — validation errors (§6)', () => {
  it('rejects malformed / non-well-formed XML', () => {
    expect(parseError('<gpx><rte></gpxbroken>').reason).toBe('not-xml');
  });

  it('rejects well-formed XML without a <gpx> root', () => {
    const xml = '<?xml version="1.0"?><notgpx><rtept lat="54.8" lon="9.9"/></notgpx>';
    expect(parseError(xml).reason).toBe('not-gpx');
  });

  it('rejects an empty gpx with no rte/trk/wpt', () => {
    expect(parseError(GPX_OPEN + '</gpx>').reason).toBe('too-few-points');
  });

  it('rejects a missing lon attribute', () => {
    const xml = GPX_OPEN + '<rte><rtept lat="54.8"/><rtept lat="54.9" lon="9.9"/></rte></gpx>';
    expect(parseError(xml).reason).toBe('bad-coord');
  });

  it('rejects a non-numeric coordinate', () => {
    const xml =
      GPX_OPEN + '<rte><rtept lat="abc" lon="9.9"/><rtept lat="54.9" lon="9.9"/></rte></gpx>';
    expect(parseError(xml).reason).toBe('bad-coord');
  });

  it('rejects a coordinate outside WGS84 range', () => {
    const xml =
      GPX_OPEN + '<rte><rtept lat="200" lon="9.9"/><rtept lat="54.9" lon="9.9"/></rte></gpx>';
    expect(parseError(xml).reason).toBe('bad-coord');
  });

  it('rejects a WGS84-valid point outside the mask data-area', () => {
    // 55.9°N is a perfectly valid latitude but north of the 55.3°N data-area
    // edge — must be out-of-bounds, NOT bad-coord.
    const xml =
      GPX_OPEN + '<rte><rtept lat="54.8" lon="9.9"/><rtept lat="55.9" lon="10.0"/></rte></gpx>';
    expect(parseError(xml).reason).toBe('out-of-bounds');
  });
});

describe('parseGpx — via-count cap (§5)', () => {
  it('drops intermediates beyond MAX_VIA_POINTS with a notice', () => {
    // 12 rtepts: idx 0 = origin, idx 11 = destination, idx 1..10 = 10
    // intermediates. Cap 8 → keep the first 8 (idx 1..8), drop 2 (idx 9,10).
    const xml =
      GPX_OPEN +
      '<rte>' +
      '<rtept lat="54.50" lon="9.50"/>' + // 0 origin
      '<rtept lat="54.55" lon="9.55"/>' + // 1 via[0]
      '<rtept lat="54.60" lon="9.60"/>' + // 2
      '<rtept lat="54.65" lon="9.65"/>' + // 3
      '<rtept lat="54.70" lon="9.70"/>' + // 4
      '<rtept lat="54.75" lon="9.75"/>' + // 5
      '<rtept lat="54.80" lon="9.80"/>' + // 6
      '<rtept lat="54.85" lon="9.85"/>' + // 7
      '<rtept lat="54.90" lon="9.90"/>' + // 8 via[7] (last kept)
      '<rtept lat="54.95" lon="9.95"/>' + // 9 dropped
      '<rtept lat="55.00" lon="10.00"/>' + // 10 dropped
      '<rtept lat="55.05" lon="10.05"/>' + // 11 destination
      '</rte></gpx>';
    const route = parseGpx(xml);
    expect(MAX_VIA_POINTS).toBe(8);
    expect(route.origin).toEqual({ lat: 54.5, lon: 9.5 });
    expect(route.destination).toEqual({ lat: 55.05, lon: 10.05 });
    expect(route.viaPoints).toHaveLength(8);
    expect(route.viaPoints[0]).toEqual({ lat: 54.55, lon: 9.55 });
    expect(route.viaPoints[7]).toEqual({ lat: 54.9, lon: 9.9 });
    expect(route.notices).toContainEqual({ kind: 'via-capped', dropped: 2 });
  });
});

describe('parseGpx — element-count DoS guard', () => {
  it('rejects a document whose total element count exceeds MAX_GPX_ELEMENTS', () => {
    // Hand-derived count: (MAX_GPX_ELEMENTS + 1) rtepts + the <gpx> and <rte>
    // wrapper elements = MAX_GPX_ELEMENTS + 3 total elements, one past the bound.
    // The coordinates are in-bounds and valid, so nothing but the size guard can
    // reject this — proving the guard, not a coord/bounds check, fires. Generous
    // per-test timeout: building + jsdom-parsing 100k nodes is ~0.5 s here but
    // CI runners are 6–10× slower (never tighten below the file default).
    const xml =
      GPX_OPEN +
      '<rte>' +
      '<rtept lat="54.5" lon="9.5"/>'.repeat(MAX_GPX_ELEMENTS + 1) +
      '</rte></gpx>';
    expect(parseError(xml).reason).toBe('too-large');
  }, 30_000);
});

describe('parseGpx — realistic Garmin-style export', () => {
  it('extracts geometry and ignores names/symbols/times/extensions', () => {
    // A Garmin Boating export: default GPX namespace, metadata, per-rtept name/
    // sym/time and a garmin extensions block. Only lat/lon geometry is used.
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx xmlns="http://www.topografix.com/GPX/1/1"' +
      ' xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3"' +
      ' version="1.1" creator="Garmin Desktop App">\n' +
      '  <metadata><link href="http://www.garmin.com"><text>Garmin</text></link>' +
      '<time>2026-07-20T09:00:00Z</time></metadata>\n' +
      '  <rte>\n' +
      '    <name>Flensburg to Marstal</name>\n' +
      '    <rtept lat="54.792000" lon="9.438000">\n' +
      '      <name>FLENSBURG</name><sym>Anchor</sym><time>2026-07-20T09:00:00Z</time>\n' +
      '      <extensions><gpxx:RoutePointExtension/></extensions>\n' +
      '    </rtept>\n' +
      '    <rtept lat="54.910000" lon="9.790000">\n' +
      '      <name>SONDERBORG APPR</name><sym>Waypoint</sym>\n' +
      '    </rtept>\n' +
      '    <rtept lat="54.854000" lon="10.520000">\n' +
      '      <name>MARSTAL</name><sym>Anchor</sym>\n' +
      '    </rtept>\n' +
      '  </rte>\n' +
      '</gpx>\n';
    const route = parseGpx(xml);
    expect(route.origin).toEqual({ lat: 54.792, lon: 9.438 });
    expect(route.destination).toEqual({ lat: 54.854, lon: 10.52 });
    expect(route.viaPoints).toEqual([{ lat: 54.91, lon: 9.79 }]);
    expect(route.notices).toEqual([]);
  });
});

describe('DATA_AREA (mask.meta.json drift guard)', () => {
  it('deep-equals the committed mask.meta.json west/south/east/north bounds', () => {
    // Read the committed mask metadata independently (resolveJsonModule is off,
    // so no JSON import) and pin DATA_AREA to it. If the mask data-area ever
    // moves, this fails until gpx.ts's DATA_AREA is updated to match — the
    // enforcement of its "keep in sync with mask.meta.json" note. The expectation
    // is derived from the committed file, not from DATA_AREA (repo lesson #50).
    const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
    const meta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as {
      west: number;
      south: number;
      east: number;
      north: number;
    };
    expect(DATA_AREA).toEqual({
      west: meta.west,
      south: meta.south,
      east: meta.east,
      north: meta.north,
    });
  });
});
