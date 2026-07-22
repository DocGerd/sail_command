import type { LatLon, Leg, MaskMeta, Plan, Rig } from '../types';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtDeg = (d: number) => `${String(Math.round(d)).padStart(3, '0')}°T`;

// desc strings are chartplotter data interchange (GPX), deliberately English / not routed through the app i18n dictionary.
function legDesc(leg: Leg): string {
  const man = leg.maneuverAtStart ? `${leg.maneuverAtStart} → ` : '';
  const what =
    leg.kind === 'motor'
      ? `motor ${fmtDeg(leg.headingDeg)} ${leg.speedKn.toFixed(1)} kn`
      : `sail ${leg.board} ${fmtDeg(leg.headingDeg)} ${leg.speedKn.toFixed(1)} kn`;
  return man + what;
}

export function toGpx(plan: Plan, rig: Rig): string {
  const result = rig === 'genoa' ? plan.result.genoa : plan.result.fock;
  if (!result) throw new Error(`no ${rig} result on plan ${plan.id}`);
  if (result.legs.length === 0) throw new Error(`empty route on plan ${plan.id} (${rig})`);
  const pts = result.legs.map(
    (leg) =>
      `    <rtept lat="${leg.start.lat}" lon="${leg.start.lon}">\n` +
      `      <time>${new Date(leg.startTimeMs).toISOString()}</time>\n` +
      `      <desc>${esc(legDesc(leg))}</desc>\n` +
      `    </rtept>`,
  );
  const last = result.legs[result.legs.length - 1];
  pts.push(
    `    <rtept lat="${last.end.lat}" lon="${last.end.lon}">\n` +
      `      <time>${new Date(last.endTimeMs).toISOString()}</time>\n` +
      `      <desc>destination</desc>\n` +
      `    </rtept>`,
  );
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="SailCommand" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <rte>\n    <name>${esc(plan.name)} (${rig})</name>\n${pts.join('\n')}\n  </rte>\n</gpx>\n`
  );
}

// ---------------------------------------------------------------------------
// GPX import (#3, first increment). Parses a chartplotter-exported .gpx into a
// SailCommand planning input (origin/destination/viaPoints). No new domain
// types leave this module — a ParsedGpxRoute is handed straight to the planner
// prefill and never persisted. Parsing is 100% client-side via the browser
// DOMParser, which does NOT resolve external entities, so it is XXE-safe by
// construction (do not hand-roll entity handling).
// ---------------------------------------------------------------------------

/**
 * Soft cap on imported intermediate waypoints (origin + destination are always
 * kept). Each forced via-point *constrains* the time-optimal search — the
 * router must pass through it — so beyond this many we drop the extras with a
 * non-blocking notice rather than over-constraining the solve. Tunable.
 */
export const MAX_VIA_POINTS = 8;

// The app can only route inside its committed mask data-area, so an imported
// point beyond this window is rejected at parse time. Mirrors the bounds in
// app/public/data/mask.meta.json — the locked 54.3..55.3°N / 9.4..11.0°E domain
// area the design spec fixes (openMeteo.ts hardcodes the same corner). Keep in
// sync with mask.meta.json if the data-area ever changes.
const DATA_AREA: Pick<MaskMeta, 'west' | 'south' | 'east' | 'north'> = {
  west: 9.4,
  south: 54.3,
  east: 11.0,
  north: 55.3,
};

export type GpxErrorReason =
  | 'not-xml' // not well-formed XML (DOMParser <parsererror>)
  | 'not-gpx' // well-formed XML but no <gpx> root element
  | 'too-few-points' // fewer than 2 usable points (need origin + destination)
  | 'bad-coord' // a lat/lon is missing, non-numeric, or out of WGS84 range
  | 'out-of-bounds'; // a point is valid WGS84 but outside the mask data-area

/**
 * Thrown by {@link parseGpx} on any rejection. The caller maps `reason` to a
 * specific i18n message — the parser stays free of the i18n dictionary so it
 * has no UI coupling. Never a silent no-op.
 */
export class GpxParseError extends Error {
  readonly reason: GpxErrorReason;
  constructor(reason: GpxErrorReason) {
    super(`GPX import rejected: ${reason}`);
    this.name = 'GpxParseError';
    this.reason = reason;
  }
}

/** Non-blocking observations surfaced to the user after a successful import. */
export type GpxNotice =
  | { kind: 'track-reduced' } // a <trk> was collapsed to its first+last point
  | { kind: 'via-capped'; dropped: number } // via count exceeded MAX_VIA_POINTS
  | { kind: 'multiple-routes' }; // >1 <rte> present, only the first was used

/**
 * Local hand-off shape (not a domain type, not persisted): the imported route
 * mapped onto the existing planner inputs. `origin`/`destination` are the first
 * and last parsed points; `viaPoints` are the intermediate points in file
 * order (after the soft cap).
 */
export interface ParsedGpxRoute {
  origin: LatLon;
  destination: LatLon;
  viaPoints: LatLon[];
  notices: GpxNotice[];
}

// Namespace-agnostic element lookup by local name, in document order. GPX files
// use the default GPX/1/1 namespace (unprefixed local names) but some exporters
// prefix it (e.g. <gpx:rtept>); matching on localName handles both.
function elementsByLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((el) => el.localName === name);
}

// Parse + fully validate one rtept/trkpt/wpt into a LatLon. Throws (never
// silently skips) on a missing, non-numeric, out-of-WGS84-range, or
// out-of-data-area coordinate. `Number` (not parseFloat) is used deliberately:
// it rejects trailing garbage like "54.8abc" as NaN, where parseFloat would
// accept it.
function pointFrom(el: Element): LatLon {
  const latAttr = el.getAttribute('lat');
  const lonAttr = el.getAttribute('lon');
  if (latAttr === null || lonAttr === null || latAttr.trim() === '' || lonAttr.trim() === '')
    throw new GpxParseError('bad-coord');
  const lat = Number(latAttr);
  const lon = Number(lonAttr);
  if (Number.isNaN(lat) || Number.isNaN(lon)) throw new GpxParseError('bad-coord');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new GpxParseError('bad-coord');
  if (
    lon < DATA_AREA.west ||
    lon > DATA_AREA.east ||
    lat < DATA_AREA.south ||
    lat > DATA_AREA.north
  )
    throw new GpxParseError('out-of-bounds');
  return { lat, lon };
}

/**
 * Parse a GPX 1.1 document (Garmin Boating / ActiveCaptain and other
 * chartplotters export this) into a SailCommand planning input.
 *
 * Point extraction, in priority order:
 *  1. `<rte>`/`<rtept>` — a route is intended waypoints; take all rtepts of the
 *     FIRST `<rte>` in document order (others noted, ignored).
 *  2. `<trk>`/`<trkpt>` — a track is a recorded breadcrumb, not intended
 *     waypoints; keep only its first and last trkpt (shape ignored, noted).
 *  3. standalone `<wpt>` — treat the waypoint list as ordered points.
 *
 * First point → origin, last → destination, the rest → viaPoints (capped at
 * {@link MAX_VIA_POINTS}). Throws {@link GpxParseError} on any rejection (§6).
 */
export function parseGpx(xml: string): ParsedGpxRoute {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // A well-formedness failure yields a document containing a <parsererror>
  // element (browsers and jsdom alike) — the honest not-well-formed-XML signal.
  if (doc.getElementsByTagName('parsererror').length > 0) throw new GpxParseError('not-xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'gpx') throw new GpxParseError('not-gpx');

  const notices: GpxNotice[] = [];
  let points: LatLon[];

  const rtes = elementsByLocalName(doc, 'rte');
  const trks = elementsByLocalName(doc, 'trk');
  const wpts = elementsByLocalName(doc, 'wpt');

  if (rtes.length > 0) {
    if (rtes.length > 1) notices.push({ kind: 'multiple-routes' });
    points = elementsByLocalName(rtes[0], 'rtept').map(pointFrom);
  } else if (trks.length > 0) {
    const trkpts = elementsByLocalName(trks[0], 'trkpt');
    if (trkpts.length < 2) throw new GpxParseError('too-few-points');
    points = [pointFrom(trkpts[0]), pointFrom(trkpts[trkpts.length - 1])];
    notices.push({ kind: 'track-reduced' });
  } else if (wpts.length > 0) {
    points = wpts.map(pointFrom);
  } else {
    throw new GpxParseError('too-few-points');
  }

  if (points.length < 2) throw new GpxParseError('too-few-points');

  const origin = points[0];
  const destination = points[points.length - 1];
  // All parsed points are validated (pointFrom) BEFORE the cap, so a malformed
  // coordinate anywhere — even on a via that would be dropped — errors honestly
  // rather than being silently discarded.
  let viaPoints = points.slice(1, -1);
  if (viaPoints.length > MAX_VIA_POINTS) {
    notices.push({ kind: 'via-capped', dropped: viaPoints.length - MAX_VIA_POINTS });
    viaPoints = viaPoints.slice(0, MAX_VIA_POINTS);
  }

  return { origin, destination, viaPoints, notices };
}
