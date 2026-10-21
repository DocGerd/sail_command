import { useEffect } from 'react';
import BoatMarker from './BoatMarker';
import { useMapInstance } from './MapView';
import type { GpsFix } from '../services/geolocation';

export interface OwnshipMarkerProps {
  fix: GpsFix | null;
  /** The fix is no longer current (signal lost or denied): draw the marker dimmed and without its projection vector. */
  stale?: boolean;
}

const STALE_MAP_CLASS = 'live-gps-lost';

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
export default function OwnshipMarker({ fix, stale = false }: OwnshipMarkerProps) {
  const map = useMapInstance();
  // BoatMarker owns its element, so the stale style is a class on the map
  // container that Live-scoped CSS keys on.
  useEffect(() => {
    const container = map?.getContainer();
    if (!container) return;
    container.classList.toggle(STALE_MAP_CLASS, stale);
    return () => container.classList.remove(STALE_MAP_CLASS);
  }, [map, stale]);
  if (!fix) return null;
  return (
    <BoatMarker
      point={fix.point}
      cogDeg={fix.cogDeg}
      sogKn={stale ? null : fix.sogKn}
      headingToSteerDeg={fix.cogDeg ?? 0}
      accuracyM={fix.accuracyM}
    />
  );
}
