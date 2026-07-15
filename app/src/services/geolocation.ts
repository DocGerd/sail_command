import type { LatLon } from '../types';

export interface GpsFix {
  point: LatLon;
  cogDeg: number | null; // course over ground, degrees true; null if the device isn't reporting one
  sogKn: number | null; // speed over ground, knots; null if the device isn't reporting one
  accuracyM: number;
}

export type GpsErrorKind = 'denied' | 'unavailable';

const MS_TO_KN = 1.9438444924406046; // 1 m/s in knots

function mapErrorKind(err: GeolocationPositionError): GpsErrorKind {
  // POSITION_UNAVAILABLE and TIMEOUT are both transient/environmental
  // failures the caller should treat the same way ("no fix right now"), as
  // opposed to PERMISSION_DENIED, which needs the one-time hint (spec §4).
  return err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable';
}

/**
 * Thin wrapper over navigator.geolocation.watchPosition: converts
 * coords.speed (m/s) to knots, maps heading/speed nulls through untouched,
 * also collapses a NaN heading/speed to null (the device reports NaN rather
 * than null for a stationary fix — see the inline comment below), and
 * collapses the DOM's three-way error code into the two kinds the UI
 * distinguishes. Returns an unsubscribe function.
 */
export function watchPosition(
  onFix: (fix: GpsFix) => void,
  onError: (kind: GpsErrorKind) => void,
): () => void {
  if (!('geolocation' in navigator) || !navigator.geolocation) {
    onError('unavailable');
    return () => {};
  }

  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, heading, speed, accuracy } = pos.coords;
      // Per the Geolocation spec, heading/speed are `null` only when the
      // device never reports them; when it does, either can still be `NaN`
      // at that particular fix — heading is NaN whenever speed is 0 (a
      // stationary or unmoving device has no meaningful course over
      // ground). NaN and null both mean "nothing to show" to the UI, so
      // both collapse to null here — otherwise a NaN leaks into GpsFix and
      // renders literally as "NaN°"/"NaN kn" (formatHeading/formatKn don't
      // special-case it).
      const cogDeg = heading == null || Number.isNaN(heading) ? null : heading;
      const sogKn = speed == null || Number.isNaN(speed) ? null : speed * MS_TO_KN;
      onFix({
        point: { lat: latitude, lon: longitude },
        cogDeg,
        sogKn,
        accuracyM: accuracy,
      });
    },
    (err) => onError(mapErrorKind(err)),
    { enableHighAccuracy: true },
  );

  return () => navigator.geolocation.clearWatch(id);
}
