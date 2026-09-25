import type { LatLon } from '../types';
import { isLiveSimRequested, subscribeLiveSim } from '../dev/liveSimulator';

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
 *
 * #143: this is the ONE export both GPS consumers (LiveView.tsx's prop
 * default and useOwnshipGps.ts's param default) fall back to, so gating the
 * simulator substitution HERE — rather than in either consumer — is what
 * drives both seams from one source without a new prop on either (spike
 * docs/spikes/749-live-view-demo-mode.md §7.2 precondition 1). The leading
 * `if` is a fold-exact STATEMENT, not a wrapped second function: splitting
 * the real logic into its own function left a small permanent residue in
 * the production entry chunk even after full dead-code elimination of the
 * simulator (measured — see the PR body), because the wrapper call itself
 * is a structural change. An early-return `if` whose condition is the same
 * build-time-literal `import.meta.env.DEV || __SC_UAT__` folds to nothing
 * at all in a production build and dead-code-eliminates
 * dev/liveSimulator.ts entirely (#96 byte-identity; mirrors App.tsx's
 * `__SC_UAT__ ?` pattern).
 */
export function watchPosition(
  onFix: (fix: GpsFix) => void,
  onError: (kind: GpsErrorKind) => void,
): () => void {
  if ((import.meta.env.DEV || __SC_UAT__) && isLiveSimRequested()) {
    return subscribeLiveSim(onFix, onError);
  }

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
