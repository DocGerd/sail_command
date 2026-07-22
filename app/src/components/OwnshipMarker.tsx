import BoatMarker from './BoatMarker';
import type { GpsFix } from '../services/geolocation';

export interface OwnshipMarkerProps {
  fix: GpsFix | null;
}

// #25 addendum: the standalone "show my position" marker. Renders BoatMarker
// (+ its accuracy circle, both UNCHANGED — see BoatMarker.tsx) in ANY map
// context — planning, no plan, or Live View — once the showOwnship setting is
// on and a fix is available. The GPS subscription itself lives in
// useOwnshipGps.ts (consumed by App.tsx), which needs no map context and so
// stays OUTSIDE MapView's subtree; this component only needs to render
// BoatMarker (which resolves the map instance itself via useMapInstance()),
// so it is a thin, purely presentational sibling of DataLayers/RouteLayer/
// LiveView inside MapView's children (mirrors DataLayers.tsx's "always-
// mounted, plan-independent" pattern).
//
// This is also the ONLY place BoatMarker is ever rendered — LiveView no
// longer renders its own (see LiveView.tsx's #25 addendum comment) — which is
// what keeps "toggle on while Live View is active" from ever showing two
// markers: there is structurally only one render site left.
//
// headingToSteerDeg falls back to 0 (bow points true north) absent a device
// COG: unlike LiveView's route-following context, there is no leg here to
// derive a steer-to heading from.
//
// Not unit-tested beyond the props contract (OwnshipMarker.test.tsx, with
// BoatMarker mocked): jsdom has no MapLibre/WebGL runtime, mirroring
// BoatMarker.tsx/RouteLayer.tsx's own "not unit-tested" notes.
export default function OwnshipMarker({ fix }: OwnshipMarkerProps) {
  if (!fix) return null;
  return (
    <BoatMarker
      point={fix.point}
      cogDeg={fix.cogDeg}
      headingToSteerDeg={fix.cogDeg ?? 0}
      accuracyM={fix.accuracyM}
    />
  );
}
