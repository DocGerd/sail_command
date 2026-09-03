import { PROJECTION_VECTOR_MINUTES, projectionLine } from './projectionVector';
import { formatHeading, formatKn, type Lang } from './format';
import { haversineNm } from './geo';
import type { AisTargetSnapshot } from './aisTargets';
import type { MsgKey } from '../i18n/dict.de';

// A COG vector shows where a vessel reaches in this many minutes at current
// SOG — the shared convention from projectionVector.ts (#141 parity).
export const AIS_VECTOR_MINUTES = PROJECTION_VECTOR_MINUTES;

/**
 * #25: one GeoJSON FeatureCollection for the AIS overlay. Per target: a vessel
 * Point (props drive paint/rotation/label + declutter) and, when moving with a
 * known course, a COG-vector LineString (geometry via the shared projectionLine
 * helper, reused by #141). Rotation prefers true heading, falls back to COG,
 * else a neutral dot (hasCourse:false, rotation:0). Nested objects are avoided
 * in properties — a MapLibre GeoJSON source stringifies them on read-back (the
 * seamarks flat-props lesson).
 */
export function aisFeatureCollection(targets: AisTargetSnapshot[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const t of targets) {
    const courseDeg = t.headingDeg ?? t.cogDeg;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [t.position.lon, t.position.lat] },
      properties: {
        mmsi: t.mmsi,
        kind: 'vessel',
        tier: t.tier,
        hasCourse: courseDeg !== undefined,
        rotation: courseDeg ?? 0,
        label: t.name ?? t.mmsi,
        name: t.name ?? '',
        shipType: t.shipType ?? null,
        sog: t.sogKn ?? null,
        cog: t.cogDeg ?? null,
        heading: t.headingDeg ?? null,
        lastUpdateMs: t.lastUpdateMs,
      },
    });
    if (t.sogKn !== undefined && t.sogKn > 0 && courseDeg !== undefined) {
      const [start, end] = projectionLine(t.position, courseDeg, t.sogKn, AIS_VECTOR_MINUTES);
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [start.lon, start.lat],
            [end.lon, end.lat],
          ],
        },
        properties: { mmsi: t.mmsi, kind: 'vector', tier: t.tier },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// Popup content, read back off the tapped feature's (flat) properties. Numeric
// props are `number | null` after the GeoJSON round-trip.
export interface AisPopupProps {
  mmsi: string;
  name: string;
  shipType: number | null;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  lastUpdateMs: number;
}

export function aisPopupRows(
  props: AisPopupProps,
  nowMs: number,
  lang: Lang,
): { labelKey: MsgKey; value: string }[] {
  const rows: { labelKey: MsgKey; value: string }[] = [
    { labelKey: 'ais.popup.name', value: props.name.length > 0 ? props.name : props.mmsi },
    { labelKey: 'ais.popup.mmsi', value: props.mmsi },
  ];
  if (props.shipType !== null)
    rows.push({ labelKey: 'ais.popup.shipType', value: String(props.shipType) });
  if (props.sog !== null)
    rows.push({ labelKey: 'ais.popup.sog', value: formatKn(props.sog, lang) });
  if (props.cog !== null) rows.push({ labelKey: 'ais.popup.cog', value: formatHeading(props.cog) });
  // floor, not round: a 30 s-old signal is "0 min" ago (matches the pinned
  // test literals '2 min ago' @120 s and '0 min ago' @30 s).
  const ageMin = Math.max(0, Math.floor((nowMs - props.lastUpdateMs) / 60_000));
  // #709: the value must carry the "ago"/"vor" itself, built per-language —
  // AisLayer.tsx always composes `${label}: ${value}`, and German needs the
  // preposition on the value side of the colon ("Letztes Signal: vor 2 min"),
  // not stranded on the label side as it was before.
  rows.push({
    labelKey: 'ais.popup.age',
    value: lang === 'de' ? `vor ${ageMin} min` : `${ageMin} min ago`,
  });
  return rows;
}

// #831: the viewport filter behind the keyboard-reachable "AIS vessels in
// view" list (AisTraffic.tsx's AisVesselsInView) — a keyboard user's DOM
// equivalent of AisLayer.tsx's pointer-only vessel click (WCAG 2.1.1),
// mirroring lib/seamarksInView.ts's #830 shape. Unlike seamarks (which needs
// its own viewport query against a region-wide catalogue), the population
// here is simply the ALREADY-SUBSCRIBED `targets` array AisTraffic passes to
// AisLayer — filtered to the map's current bounds so the list matches what a
// mouse user can actually SEE and click on AIS_VESSEL_LAYER, never the wider
// corridor-subscribed set useAisTraffic tracks for the socket subscription.
export interface AisViewportBounds {
  west: number;
  south: number;
  east: number;
  north: number;
  centerLon: number;
  centerLat: number;
}

export interface AisTargetsInViewResult {
  /** At most `max` targets, nearest to the map centre first. */
  targets: AisTargetSnapshot[];
  /** Every target in view, before the cap — what the summary count states. */
  total: number;
}

// The row cap — a maintainer JUDGEMENT CALL in the same sense
// seamarksInView.ts's SEAMARKS_IN_VIEW_MAX is: AIS traffic in one fjord is
// normally small (the AisStatusChip's own count confirms this at a glance),
// but a busy strait could still exceed a usable keyboard-list length.
export const AIS_IN_VIEW_MAX = 50;

// MapLibre's bounds can span more than the whole world at very low zoom
// (`east - west >= 360`) or wrap across the antimeridian (`west > east`);
// mirrors seamarksInView.ts's identical handling.
function lonInRange(lon: number, west: number, east: number): boolean {
  if (east - west >= 360) return true;
  if (west <= east) return lon >= west && lon <= east;
  return lon >= west || lon <= east;
}

/**
 * The subset of `targets` whose position falls inside `viewport`, nearest to
 * the map centre first, capped at `max` with `total` counting the whole
 * in-view set (before the cap).
 */
export function aisTargetsInView(
  targets: AisTargetSnapshot[],
  viewport: AisViewportBounds,
  max: number = AIS_IN_VIEW_MAX,
): AisTargetsInViewResult {
  const centre = { lat: viewport.centerLat, lon: viewport.centerLon };
  const inView = targets
    .filter(
      (t) =>
        t.position.lat >= viewport.south &&
        t.position.lat <= viewport.north &&
        lonInRange(t.position.lon, viewport.west, viewport.east),
    )
    .map((t) => ({ target: t, distanceNm: haversineNm(centre, t.position) }));
  // Array.prototype.sort is stable (ES2019): equidistant targets keep their
  // input order rather than an arbitrary one.
  inView.sort((a, b) => a.distanceNm - b.distanceNm);
  const sorted = inView.map((e) => e.target);
  return { targets: sorted.slice(0, max), total: sorted.length };
}
