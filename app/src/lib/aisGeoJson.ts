import { PROJECTION_VECTOR_MINUTES, projectionLine } from './projectionVector';
import { formatHeading, formatKn } from './format';
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
): { labelKey: MsgKey; value: string }[] {
  const rows: { labelKey: MsgKey; value: string }[] = [
    { labelKey: 'ais.popup.name', value: props.name.length > 0 ? props.name : props.mmsi },
    { labelKey: 'ais.popup.mmsi', value: props.mmsi },
  ];
  if (props.shipType !== null)
    rows.push({ labelKey: 'ais.popup.shipType', value: String(props.shipType) });
  if (props.sog !== null) rows.push({ labelKey: 'ais.popup.sog', value: formatKn(props.sog) });
  if (props.cog !== null) rows.push({ labelKey: 'ais.popup.cog', value: formatHeading(props.cog) });
  // floor, not round: a 30 s-old signal is "0 min" ago (matches the pinned
  // test literals '2 min' @120 s and '0 min' @30 s).
  const ageMin = Math.max(0, Math.floor((nowMs - props.lastUpdateMs) / 60_000));
  rows.push({ labelKey: 'ais.popup.age', value: `${ageMin} min` });
  return rows;
}
