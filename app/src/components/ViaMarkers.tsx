import { useEffect, useRef } from 'react';
import { Marker } from 'maplibre-gl';
import type { LngLatLike } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useT } from '../i18n';
import { HALO_COLOR, VIA_COLOR } from '../lib/mapColors';
import type { LatLon, ViaPoint } from '../types';

export interface ViaMarkersProps {
  // #571 redesign (review fix): source of truth for marker POSITIONS is
  // App.tsx's DRAFT via list (RouteLayer.tsx's `draftViaPoints` prop),
  // never `plan.request.viaPoints` directly. This is what makes an add/
  // remove/reorder/drag in the panel or on the map show up as markers
  // immediately — the marker-building effect below rebuilds from this prop
  // on every draft write, so an edit and its marker are never out of sync.
  // The committed `plan.request.viaPoints` only catches up once the next
  // Plan-route press applies the draft. `replanning` below is the
  // disclosure that the two currently differ.
  //
  // An EARLIER version of this component (and its App.tsx caller) sourced
  // this prop from `plan.request.viaPoints` instead, reasoning that a drag's
  // own imperative DOM position would "just stay where dropped" since
  // nothing would force a rebuild. That reasoning was wrong, measured in a
  // real browser: App.tsx's drag handler is memoized on `[plan,
  // draftViaPoints]`, so every draft write DOES change its identity, which
  // IS in this effect's own dependency array below — a full rebuild fired on
  // every drag, from the (unchanged) committed list, snapping every marker
  // straight back. Worse, the snapped-back element then broke the SECOND
  // drag of the same marker outright (a reference-equality lookup could no
  // longer find it). Threading the draft through, as this version does,
  // fixes both: the rebuild now reflects the actual edit instead of
  // reverting it.
  // #846: widened LatLon[] -> ViaPoint[] so a named waypoint's `name`
  // reaches the marker's accessible name below. Free at every call site:
  // LatLon[] still satisfies ViaPoint[] (name is optional), so App.tsx's
  // own draftViaPoints state (still typed LatLon[]) needs no change.
  viaPoints: ViaPoint[];
  // #571 redesign: PROP NAME kept as `replanning` — RouteLayer.tsx passes it
  // straight through under that exact key and is unrelated to/unchanged by
  // this task. Its MEANING has moved: no auto-replan exists any more (the
  // maintainer's #571 ruling), so this no longer means "a replan is in
  // flight" — it means "the draft (this component's own `viaPoints` prop)
  // no longer matches the committed `plan.request.viaPoints`" (App.tsx's
  // `viaDraftStale`, computed with `lib/planForm.ts`'s `viaPointsDiffer`).
  // Shows the chip below as a MAP-side staleness disclosure; no longer gates
  // dragging (a draft edit is never "in flight" — there is nothing async
  // left for a second edit to race).
  replanning: boolean;
  // Resolves true once the drag was applied to the draft via list (App.tsx's
  // handleViaDragEnd), which also rebuilds every marker from the (now
  // updated) `viaPoints` prop above — including the dragged one, at its new
  // position. Resolves false only if App.tsx has no active plan at all
  // (defensive; ViaMarkers itself never renders without one), which
  // triggers an explicit snap-back to the marker's last position.
  onDragEnd: (index: number, next: LatLon) => Promise<boolean>;
}

// Real-map rendering is not unit-tested (jsdom has no MapLibre/WebGL
// runtime); the component's own logic is covered by ViaMarkers.test.tsx.
// Deliberately thin: all decision logic
// (dedupe, stored-wind reuse, in-flight guard, error mapping) lives in
// state/replan.ts, fully unit-tested there.

// #715: VIA_COLOR (Okabe-Ito reddish-purple, distinct from BoatMarker's blue
// and the route's port/starboard green/red) is now imported from
// lib/mapColors.ts.

function viaElement(ariaLabel: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sc-via-marker';
  el.style.width = '16px';
  el.style.height = '16px';
  el.style.borderRadius = '50%';
  el.style.background = VIA_COLOR;
  el.style.border = `2px solid ${HALO_COLOR}`;
  el.style.boxShadow = '0 0 2px rgba(0,0,0,0.5)';
  // A draggable point on the map, not a native <button> — role/tabIndex
  // make it reachable and identifiable to assistive tech (dragging itself
  // stays mouse/touch-only, same as every other MapLibre marker; v1 scope).
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', ariaLabel);

  // #947: previously this element carried ONLY the aria-label above — a
  // screen-reader user heard the waypoint's name, but a sighted user saw an
  // unlabelled dot, and several waypoints were mutually indistinguishable on
  // the map. Render the SAME text visibly, `aria-hidden` so assistive tech
  // does not announce it a second time alongside the root's own aria-label
  // (the two must say the same thing, so neither can drift from the other).
  // The label span below is `position: absolute` (app.css) — deliberately
  // WITHOUT setting `position: relative` on this root: MapLibre's own
  // `.maplibregl-marker` class already keeps the root `position: absolute`,
  // and an inline override of that (tried during review, PR #954) put the
  // root back into normal document flow, offsetting every via marker beyond
  // the first by the stacked height of the ones before it. The label still
  // resolves correctly against the root because MapLibre's own imperative
  // `transform` on this element (its `translate(-50%,-50%)` center anchor,
  // `ui/marker.ts`) already establishes a CSS containing block for an
  // absolutely-positioned child — no `position: relative` is needed.
  // `pointer-events: none` (app.css) keeps the label out of the marker's
  // own click/drag/touch target.
  const labelEl = document.createElement('span');
  labelEl.className = 'sc-via-marker-label';
  labelEl.textContent = ariaLabel;
  labelEl.setAttribute('aria-hidden', 'true');
  el.appendChild(labelEl);

  return el;
}

export default function ViaMarkers({ viaPoints, replanning, onDragEnd }: ViaMarkersProps) {
  const map = useMapInstance();
  const t = useT();
  const markersRef = useRef<Marker[]>([]);

  // Rebuilt whenever the DRAFT via list changes (add/remove/reorder from the
  // panel, or a successful drag — #571 redesign: never a replan) — via
  // points are few (v1: no hard cap, but expected single digits), so a full
  // teardown/recreate per change is simpler than diffing/keying individual
  // markers and cheap enough not to matter here, unlike RouteLayer's
  // route-line geometry. `onDragEnd`'s own identity changing on every draft
  // write (it is memoized on `[plan, draftViaPoints]` in App.tsx) is
  // EXACTLY what makes this effect re-run on every drag too — see
  // `viaPoints`'s own comment above for why that is now correct rather than
  // a bug.
  useEffect(() => {
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = viaPoints.map((p, index) => {
      // #846: a named waypoint uses its name as the accessible name; an
      // unnamed one falls back to the existing indexed label — the DoD's
      // exact fallback contract, reused here rather than a new key.
      const ariaLabel = p.name ?? t('planner.via.marker', { index: index + 1 });
      const marker = new Marker({ element: viaElement(ariaLabel), draggable: true }).setLngLat([
        p.lon,
        p.lat,
      ] as LngLatLike);
      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        const snapBack = () => marker.setLngLat([p.lon, p.lat] as LngLatLike);
        void onDragEnd(index, { lat: lngLat.lat, lon: lngLat.lng })
          .then((accepted) => {
            // Rejected (defensive only — App.tsx's handleViaDragEnd returns
            // false only when no plan is active, which ViaMarkers itself
            // never renders without): the prop didn't change, so nothing
            // will re-sync this marker's position on its own — explicitly
            // snap the live DOM position back to its last position.
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
    //
    // Review fix: deliberately NO `role="status"` here (removed — this used
    // to duplicate PlannerPanel.tsx's own `.planner-status sr-only`
    // announcement, since `formDirty` gaining the `viaPoints` term in this
    // same PR means its `staleSuffix` now ALSO fires on a via edit; the two
    // fired together, announcing the same sentence twice). The chip stays
    // visually visible; PlannerPanel's single persistent live region is the
    // only ARIA announcement — see that component's own "ONE persistent
    // live region … never a second aria-live region" comment, whose intent
    // this restores.
    <div className="via-markers-spinner-chip">{t('planner.result.stale')}</div>
  ) : null;
}
