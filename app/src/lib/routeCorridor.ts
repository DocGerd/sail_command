// #146 AIS route-corridor subscription — pure corridor geometry. React-free and
// map-free (the lib/projectionVector.ts precedent): turns the active rig's legs
// + activeLegIndex into a merged, capped set of aisstream bounding boxes, plus
// the point-in-corridor counter used for the status chip's routeCount. The
// corridor is a SUBSCRIPTION concern only — it changes which boxes aisstream
// streams, never what renders (no downstream filtering).

import type { LatLon, Leg } from '../types';
import { destinationPoint, haversineNm, toRad, EARTH_RADIUS_NM } from './geo';
import type { AisBoundingBox } from '../services/aisStream';

export const AIS_CORRIDOR_HALF_WIDTH_NM = 5;
export const AIS_CORRIDOR_MAX_BOXES = 8;
export const AIS_CORRIDOR_MAX_AREA_NM2 = 2000;

function boxesOverlap(a: AisBoundingBox, b: AisBoundingBox): boolean {
  // Inclusive on all edges so touching boxes merge too.
  return a[0][0] <= b[1][0] && b[0][0] <= a[1][0] && a[0][1] <= b[1][1] && b[0][1] <= a[1][1];
}

function envelope(a: AisBoundingBox, b: AisBoundingBox): AisBoundingBox {
  return [
    [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1])],
    [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1])],
  ];
}

function boxCenter(box: AisBoundingBox): LatLon {
  return { lat: (box[0][0] + box[1][0]) / 2, lon: (box[0][1] + box[1][1]) / 2 };
}

/** Mid-latitude-corrected area of a lat/lon bounding box in nm². */
export function boundingBoxAreaNm2(box: AisBoundingBox): number {
  const [[latMin, lonMin], [latMax, lonMax]] = box;
  const heightNm = toRad(latMax - latMin) * EARTH_RADIUS_NM;
  const widthNm = toRad(lonMax - lonMin) * EARTH_RADIUS_NM * Math.cos(toRad((latMin + latMax) / 2));
  return heightNm * widthNm;
}

/**
 * Fixpoint union-merge: while any pair overlaps-or-touches, replace it with the
 * component-wise envelope. Adjacent legs share an endpoint, so their padded
 * boxes always overlap and collapse into one continuous corridor box per
 * contiguous run.
 */
export function mergeOverlappingBoxes(boxes: readonly AisBoundingBox[]): AisBoundingBox[] {
  const out: AisBoundingBox[] = boxes.map((b) => [
    [b[0][0], b[0][1]],
    [b[1][0], b[1][1]],
  ]);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        if (boxesOverlap(out[i], out[j])) {
          out[i] = envelope(out[i], out[j]);
          out.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return out;
}

/**
 * Corridor box set for the remaining route: legs from one leg astern of the
 * active leg (`Math.max(0, activeLegIndex - 1)`; the full route when
 * activeLegIndex is null), each endpoint box padded nm-true with
 * destinationPoint (NOT the degree-fraction padBoundingBox, which stays
 * viewport-only), union-merged, capped to AIS_CORRIDOR_MAX_BOXES by merging
 * nearest pairs (over-covers, never drops coverage), and dropped entirely
 * (viewport-only fallback, one console.warn) if the summed area exceeds
 * AIS_CORRIDOR_MAX_AREA_NM2. Accepts RigResult.legs (Leg[]) and bare
 * {start,end} literals — only each segment's endpoints are read.
 */
export function routeCorridorBoxes(
  legs: readonly Pick<Leg, 'start' | 'end'>[],
  activeLegIndex: number | null,
  halfWidthNm: number,
): AisBoundingBox[] {
  const startIdx = activeLegIndex === null ? 0 : Math.max(0, activeLegIndex - 1);
  const included = legs.slice(startIdx);
  if (included.length === 0) return [];

  const perLeg: AisBoundingBox[] = included.map((leg) => {
    const latMin = Math.min(leg.start.lat, leg.end.lat);
    const latMax = Math.max(leg.start.lat, leg.end.lat);
    const lonMin = Math.min(leg.start.lon, leg.end.lon);
    const lonMax = Math.max(leg.start.lon, leg.end.lon);
    const sw = { lat: latMin, lon: lonMin };
    const ne = { lat: latMax, lon: lonMax };
    const sLat = destinationPoint(sw, 180, halfWidthNm).lat; // due south
    const nLat = destinationPoint(ne, 0, halfWidthNm).lat; // due north
    const sLon = destinationPoint(sw, 270, halfWidthNm).lon; // due west (cos at SW corner's lat)
    const nLon = destinationPoint(ne, 90, halfWidthNm).lon; // due east
    return [
      [sLat, sLon],
      [nLat, nLon],
    ];
  });

  const boxes = mergeOverlappingBoxes(perLeg);

  // Box-count cap: merge the nearest pair (great-circle distance between box
  // centers) into their envelope until within budget.
  while (boxes.length > AIS_CORRIDOR_MAX_BOXES) {
    let bestI = 0;
    let bestJ = 1;
    let bestDist = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const d = haversineNm(boxCenter(boxes[i]), boxCenter(boxes[j]));
        if (d < bestDist) {
          bestDist = d;
          bestI = i;
          bestJ = j;
        }
      }
    }
    boxes[bestI] = envelope(boxes[bestI], boxes[bestJ]);
    boxes.splice(bestJ, 1);
  }

  const totalArea = boxes.reduce((sum, b) => sum + boundingBoxAreaNm2(b), 0);
  if (totalArea > AIS_CORRIDOR_MAX_AREA_NM2) {
    console.warn(
      `AIS route corridor area ${Math.round(totalArea)} nm² exceeds cap ` +
        `${AIS_CORRIDOR_MAX_AREA_NM2} nm² — falling back to viewport-only subscription`,
    );
    return [];
  }
  return boxes;
}

export function pointInBox(p: LatLon, box: AisBoundingBox): boolean {
  return p.lat >= box[0][0] && p.lat <= box[1][0] && p.lon >= box[0][1] && p.lon <= box[1][1];
}

/** Targets whose position lies inside any corridor box (the chip's routeCount). */
export function countTargetsInCorridor(
  targets: readonly { position: { lat: number; lon: number } }[],
  boxes: readonly AisBoundingBox[],
): number {
  let count = 0;
  for (const t of targets) {
    if (boxes.some((b) => pointInBox(t.position, b))) count += 1;
  }
  return count;
}
