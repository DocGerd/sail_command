import { useEffect, useRef } from 'react';
import { Marker } from 'maplibre-gl';
import type { LngLatLike } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useT } from '../i18n';
import type { LatLon } from '../types';

export interface ViaMarkersProps {
  // Source of truth for marker positions is always the *committed* plan
  // (plan.request.viaPoints, from RouteLayer) — never a local optimistic
  // draft. A rejected replan therefore snaps back "for free" wherever this
  // prop itself is what didn't change; the one place that still needs an
  // explicit reset is a marker's own live drag position (see dragend below),
  // since MapLibre updates that imperatively during the drag gesture,
  // independent of props.
  viaPoints: LatLon[];
  // True while a replan triggered by this component (or a sibling — the
  // panel's via chips) is in flight. Disables dragging and shows a spinner
  // chip; mirrors ViaMarkers/PlannerPanel both being disabled together so
  // the two edit paths never race each other (state/replan.ts's useViaReplan
  // in-flight guard is the actual enforcement; this is the visual match).
  replanning: boolean;
  // Resolves true if the dragged position was accepted (the plan/markers
  // already reflect it via the updated viaPoints prop by the time this
  // resolves) or false if rejected — false triggers an explicit snap-back
  // to the last committed position.
  onDragEnd: (index: number, next: LatLon) => Promise<boolean>;
}

// jsdom-untestable (map child, mirrors BoatMarker.tsx/RouteLayer.tsx — jsdom
// has no MapLibre/WebGL runtime). Deliberately thin: all decision logic
// (dedupe, stored-wind reuse, in-flight guard, error mapping) lives in
// state/replan.ts, fully unit-tested there.

const VIA_COLOR = '#CC79A7'; // Okabe-Ito reddish-purple — distinct from BoatMarker's blue and the route's port/starboard green/red

function viaElement(ariaLabel: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sc-via-marker';
  el.style.width = '16px';
  el.style.height = '16px';
  el.style.borderRadius = '50%';
  el.style.background = VIA_COLOR;
  el.style.border = '2px solid #ffffff';
  el.style.boxShadow = '0 0 2px rgba(0,0,0,0.5)';
  // A draggable point on the map, not a native <button> — role/tabIndex
  // make it reachable and identifiable to assistive tech (dragging itself
  // stays mouse/touch-only, same as every other MapLibre marker; v1 scope).
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', ariaLabel);
  return el;
}

export default function ViaMarkers({ viaPoints, replanning, onDragEnd }: ViaMarkersProps) {
  const map = useMapInstance();
  const t = useT();
  const markersRef = useRef<Marker[]>([]);

  // Rebuilt whenever the committed via list changes (add/remove/reorder from
  // the panel, or a successful drag replan) — via points are few (v1: no
  // hard cap, but expected single digits), so a full teardown/recreate per
  // change is simpler than diffing/keying individual markers and cheap
  // enough not to matter here, unlike RouteLayer's route-line geometry.
  useEffect(() => {
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = viaPoints.map((p, index) => {
      const ariaLabel = t('planner.via.marker', { index: index + 1 });
      const marker = new Marker({ element: viaElement(ariaLabel), draggable: true }).setLngLat([
        p.lon,
        p.lat,
      ] as LngLatLike);
      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        const snapBack = () => marker.setLngLat([p.lon, p.lat] as LngLatLike);
        void onDragEnd(index, { lat: lngLat.lat, lon: lngLat.lng })
          .then((accepted) => {
            // Rejected: the prop didn't change, so nothing will re-sync this
            // marker's position on its own — explicitly snap the live DOM
            // position back to the last committed point.
            if (!accepted) snapBack();
          })
          // Defense-in-depth: onDragEnd (App.tsx's handleViaDragEnd) always
          // resolves (viaReplan.replace catches everything internally and
          // returns null), so this is currently unreachable — but a future
          // caller that lets a rejection through must not leave the marker
          // silently stuck at the dragged-to position.
          .catch(snapBack);
      });
      marker.addTo(map);
      return marker;
    });
    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
    };
  }, [map, viaPoints, onDragEnd, t]);

  // Disable dragging (not marker identity) while a replan — from this drag
  // or the panel's chip edits — is in flight, so a user can't queue a second
  // conflicting edit (state/replan.ts's useViaReplan already no-ops a
  // second replace(), this just keeps the map from inviting one).
  useEffect(() => {
    markersRef.current.forEach((m) => m.setDraggable(!replanning));
  }, [replanning]);

  return replanning ? (
    <div className="via-markers-spinner-chip" role="status">
      {t('planner.via.replanning')}
    </div>
  ) : null;
}
