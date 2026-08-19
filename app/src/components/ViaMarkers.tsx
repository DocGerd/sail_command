import { useEffect, useRef } from 'react';
import { Marker } from 'maplibre-gl';
import type { LngLatLike } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useT } from '../i18n';
import type { LatLon } from '../types';

export interface ViaMarkersProps {
  // Source of truth for marker POSITIONS is always the *committed* plan
  // (plan.request.viaPoints, from RouteLayer.tsx — unrelated to and
  // unchanged by the #571 redesign below). #571 redesign: a via edit no
  // longer replans in place, so this is no longer merely "until a rejected
  // replan snaps it back" — it is now STRUCTURAL: RouteLayer.tsx has no
  // draft to feed this component even if it wanted to, so an add/remove/
  // reorder done in the panel is invisible HERE until the next Plan-route
  // press changes `plan.request.viaPoints` itself. A drag is the one
  // exception in practice — see dragend below — because MapLibre updates a
  // marker's DOM position imperatively during the gesture, independent of
  // this prop, and nothing here forces a rebuild when the prop hasn't
  // changed. `replanning` below is the disclosure for this whole gap.
  viaPoints: LatLon[];
  // #571 redesign: PROP NAME kept as `replanning` — RouteLayer.tsx passes it
  // straight through under that exact key and is unrelated to/unchanged by
  // this task. Its MEANING has moved: no auto-replan exists any more (the
  // maintainer's #571 ruling), so this no longer means "a replan is in
  // flight" — it means "the panel's draft via list no longer matches what's
  // committed/shown on the map" (App.tsx's `viaDraftStale`, computed with
  // `lib/planForm.ts`'s `viaPointsDiffer`). Shows the chip below as a
  // MAP-side staleness disclosure; no longer gates dragging (a draft edit is
  // never "in flight" — there is nothing async left for a second edit to
  // race).
  replanning: boolean;
  // Resolves true once the drag was applied to the DRAFT via list (App.tsx's
  // handleViaDragEnd) — the marker's own DOM position, already at the
  // dropped point (MapLibre set it imperatively during the drag), is simply
  // left alone — or false when it could not be applied (e.g. the dragged
  // point was already removed from the draft via the panel while its
  // now-stale marker was still showing — see `viaPoints`'s own comment
  // above), which triggers an explicit snap-back to the last committed
  // position.
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
          // resolves — it's a plain synchronous draftViaPoints write with
          // nothing in it that can throw — so this is currently unreachable,
          // but a future caller that lets a rejection through must not leave
          // the marker silently stuck at the dragged-to position.
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

  // #571 redesign REMOVED the effect that used to live here, disabling
  // dragging while `replanning` (then: a replan in flight) was true.
  // `replanning` no longer means that (see its own comment above), and a
  // draft edit is never "in flight" — every marker stays draggable from
  // construction (`draggable: true` above) for as long as it exists.

  return replanning ? (
    // #571 redesign: className kept as `via-markers-spinner-chip` (app.css
    // styling, out of scope for this task) even though the chip is no
    // longer a spinner — it's the MAP-side staleness disclosure, the
    // counterpart of the panel's own Chip/live-region fold (both driven by
    // App.tsx's `formDirty`, which now includes the via list too — see
    // lib/planForm.ts's PlanFormSnapshot). Reuses the SAME `planner.result.
    // stale` copy ("Showing the previously calculated route — the inputs
    // have changed since.") — it already covers "the via list changed"
    // without inventing new wording.
    <div className="via-markers-spinner-chip" role="status">
      {t('planner.result.stale')}
    </div>
  ) : null;
}
