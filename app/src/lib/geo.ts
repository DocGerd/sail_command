import type { LatLon } from '../types';

export const EARTH_RADIUS_NM = 3440.065;

export const toRad = (deg: number): number => (deg * Math.PI) / 180;
export const toDeg = (rad: number): number => (rad * 180) / Math.PI;

export function normalizeDeg360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Normalize to (-180, 180]. */
export function normalizeDeg180(deg: number): number {
  const d = normalizeDeg360(deg);
  return d > 180 ? d - 360 : d;
}

export function haversineNm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(s));
}

export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg360(toDeg(Math.atan2(y, x)));
}

export function destinationPoint(a: LatLon, bearingDeg: number, distNm: number): LatLon {
  const δ = distNm / EARTH_RADIUS_NM;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: normalizeDeg180(toDeg(λ2)) };
}

/** A point with its latitude trig precomputed, for repeated use as an origin or target. */
export interface PreparedPoint {
  readonly lat: number;
  readonly lon: number;
  readonly phi: number;
  readonly lambda: number;
  readonly sinPhi: number;
  readonly cosPhi: number;
}

export function preparePoint(p: LatLon): PreparedPoint {
  const phi = toRad(p.lat);
  return {
    lat: p.lat,
    lon: p.lon,
    phi,
    lambda: toRad(p.lon),
    sinPhi: Math.sin(phi),
    cosPhi: Math.cos(phi),
  };
}

/** Bit-identical to `haversineNm(a, b)`. */
export function haversineNmTo(a: LatLon, b: PreparedPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * b.cosPhi * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(s));
}

/** Bit-identical to `initialBearingDeg(a, b)`. */
export function initialBearingDegFrom(a: PreparedPoint, b: PreparedPoint): number {
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * b.cosPhi;
  const x = a.cosPhi * b.sinPhi - a.sinPhi * b.cosPhi * Math.cos(Δλ);
  return normalizeDeg360(toDeg(Math.atan2(y, x)));
}

/** Bit-identical to `destinationPoint(a, bearingDeg, distNm)`. */
export function destinationPointFrom(a: PreparedPoint, bearingDeg: number, distNm: number): LatLon {
  const δ = distNm / EARTH_RADIUS_NM;
  const θ = toRad(bearingDeg);
  const φ2 = Math.asin(a.sinPhi * Math.cos(δ) + a.cosPhi * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    a.lambda +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * a.cosPhi, Math.cos(δ) - a.sinPhi * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: normalizeDeg180(toDeg(λ2)) };
}

/** Signed cross-track distance (nm) of p from great-circle segment a→b. */
export function crossTrackNm(p: LatLon, a: LatLon, b: LatLon): number {
  const d13 = haversineNm(a, p) / EARTH_RADIUS_NM;
  const θ13 = toRad(initialBearingDeg(a, p));
  const θ12 = toRad(initialBearingDeg(a, b));
  return Math.asin(Math.sin(d13) * Math.sin(θ13 - θ12)) * EARTH_RADIUS_NM;
}

/** Fraction (can be <0 or >1) of p's projection along segment a→b. */
export function alongTrackFraction(p: LatLon, a: LatLon, b: LatLon): number {
  const d13 = haversineNm(a, p) / EARTH_RADIUS_NM;
  const xt = crossTrackNm(p, a, b) / EARTH_RADIUS_NM;
  const at = Math.acos(Math.min(1, Math.max(-1, Math.cos(d13) / Math.cos(xt)))) * EARTH_RADIUS_NM;
  const total = haversineNm(a, b);
  const θ13 = toRad(initialBearingDeg(a, p));
  const θ12 = toRad(initialBearingDeg(a, b));
  const sign = Math.cos(θ13 - θ12) >= 0 ? 1 : -1;
  return total === 0 ? 0 : (sign * at) / total;
}
