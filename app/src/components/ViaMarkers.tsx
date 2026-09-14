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
// runtime); the component's marker-construction/drag logic is covered by
// ViaMarkers.test.tsx, while the staleness chip below (its only JSX return)
// is covered by App.test.tsx's integration test, since ViaMarkers.test.tsx
// itself never renders it (every call there passes `replanning={false}`).
// Deliberately thin: all decision logic (dedupe, stored-wind reuse, error
// mapping) lives in state/replan.ts, fully unit-tested there — #571
// redesign removed the in-flight guard this component used to gate on (see
// the `replanning` prop's own comment above).

// #715: VIA_COLOR (Okabe-Ito reddish-purple, distinct from BoatMarker's blue
// and the route's port/starboard green/red) is now imported from
// lib/mapColors.ts.

// #1186: the visible dot stays 16px, but the DRAG/TAP target is widened to
// the spec's >=44px gloved-use floor by making the whole marker root a
// transparent 44px box (flex-centered on the dot) — MapLibre positions the
// root's CENTER at the coordinate regardless of its size (a %-based CSS
// transform, not a pixel offset), so the dot's on-map position is unchanged.
// maplibre-gl's drag handler gates on `_element.contains(target)` where
// `_element` is this root, so the padding is part of the same element and
// stays draggable. Keep role/aria-label on the ROOT (unchanged contract).
const VIA_MARKER_VISIBLE_PX = 16;
const VIA_MARKER_HIT_PX = 44;

// #1198: adjacent via markers can overlap at the widened 44px hit target
// (#1186). MapLibre's Marker._addDragHandler (marker.ts) gates purely on
// `_element.contains(e.originalEvent.target)`, where `target` is the
// browser's own hit-test result for the native mousedown/touchstart — fixed
// BEFORE any JS runs (marker.ts's MapMouseEvent/MapTouchEvent constructors
// wrap that SAME native event object directly, never re-hit-testing it) and
// unrelated to which marker the press was actually closer to. Later-
// constructed via markers paint on top (addTo() appends siblings in
// construction order) and win every ambiguous press, so an earlier marker's
// drag silently no-ops. Raising a marker's z-order IN RESPONSE to the press
// cannot fix that SAME press — `.target` is immutable for an event already
// in flight; the only lever is WHICH element the event is dispatched at.
interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function rectContainsPoint(rect: ScreenRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// Exported so the #1198 regression test can pin this pure selection rule
// directly, without any DOM/event plumbing: given a press point and the
// candidates whose rendered box already contains it (>=2, i.e. an overlap),
// returns the one whose CENTRE is nearest. This is the disambiguation
// MapLibre's own hit test cannot perform — it resolves purely by DOM paint
// order, which is unrelated to which marker the press was actually closer to.
// eslint-disable-next-line react-refresh/only-export-components
export function nearestCandidate<T>(
  point: { x: number; y: number },
  candidates: readonly { rect: ScreenRect; value: T }[],
): T {
  let best = candidates[0]!;
  let bestDistSq = Infinity;
  for (const c of candidates) {
    const cx = (c.rect.left + c.rect.right) / 2;
    const cy = (c.rect.top + c.rect.bottom) / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = c;
    }
  }
  return best.value;
}

// Touch construction needs feature detection: `Touch`/`TouchEvent` are
// unavailable in jsdom, so #1198's regression test exercises the mouse path
// only — the touch path is verified by code (it mirrors marker.ts's own
// event shape) and matters most here, since touch is this app's primary
// on-deck, gloved input (#1186).
function buildSyntheticPress(
  e: MouseEvent | TouchEvent,
  intendedTarget: EventTarget,
  clientX: number,
  clientY: number,
): MouseEvent | TouchEvent | null {
  if (e.type === 'mousedown') {
    return new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
    });
  }
  if (typeof Touch !== 'function' || typeof TouchEvent !== 'function') return null;
  // `identifier` only needs to be distinct per touch; Date.now() is unique
  // enough for a single-finger press and is never compared to a real
  // browser's own identifiers.
  const touch = new Touch({ identifier: Date.now(), target: intendedTarget, clientX, clientY });
  return new TouchEvent('touchstart', {
    bubbles: true,
    cancelable: true,
    touches: [touch],
    changedTouches: [touch],
  });
}

function viaElement(ariaLabel: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sc-via-marker';
  el.style.width = `${VIA_MARKER_HIT_PX}px`;
  el.style.height = `${VIA_MARKER_HIT_PX}px`;
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  // A draggable point on the map, not a native <button> — role/tabIndex
  // make it reachable and identifiable to assistive tech (dragging itself
  // stays mouse/touch-only, same as every other MapLibre marker; v1 scope).
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', ariaLabel);

  // The visible dot: a plain child, so `position: relative` here does NOT
  // hit the root/MapLibre conflict described below (that conflict is
  // specific to the root, which carries MapLibre's own absolute
  // positioning transform).
  const dot = document.createElement('div');
  dot.className = 'sc-via-marker-dot';
  dot.style.position = 'relative';
  dot.style.width = `${VIA_MARKER_VISIBLE_PX}px`;
  dot.style.height = `${VIA_MARKER_VISIBLE_PX}px`;
  dot.style.borderRadius = '50%';
  dot.style.background = VIA_COLOR;
  dot.style.border = `2px solid ${HALO_COLOR}`;
  dot.style.boxShadow = '0 0 2px rgba(0,0,0,0.5)';
  el.appendChild(dot);

  // #947: previously this element carried ONLY the aria-label above — a
  // screen-reader user heard the waypoint's name, but a sighted user saw an
  // unlabelled dot, and several waypoints were mutually indistinguishable on
  // the map. Render the SAME text visibly, `aria-hidden` so assistive tech
  // does not announce it a second time alongside the root's own aria-label
  // (the two must say the same thing, so neither can drift from the other).
  // The label span below is `position: absolute` (app.css), anchored to the
  // DOT (not the root): MapLibre's own `.maplibregl-marker` class already
  // keeps the ROOT `position: absolute`, and an inline override of that
  // (tried during review, PR #954) put the root back into normal document
  // flow, offsetting every via marker beyond the first by the stacked
  // height of the ones before it.
  // `pointer-events: none` (app.css) keeps the label out of the marker's
  // own click/drag/touch target.
  const labelEl = document.createElement('span');
  labelEl.className = 'sc-via-marker-label';
  labelEl.textContent = ariaLabel;
  labelEl.setAttribute('aria-hidden', 'true');
  dot.appendChild(labelEl);

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

  // #1198: this listens in the CAPTURE phase on the canvas container — the
  // exact element handler_manager.ts attaches its own, bubble-phase
  // 'mousedown'/'touchstart' listeners to (confirmed against installed
  // maplibre-gl 6.7.0's HandlerManager constructor: `this._el =
  // this._map.getCanvasContainer()`), so it always runs BEFORE MapLibre's
  // own dispatch for the same event. When the press point falls inside >=2
  // via roots (from `markersRef.current`, read fresh at event time — this
  // effect deliberately depends on `[map]` only, never `viaPoints`) and the
  // nearest-by-centre one disagrees with the browser's own target, it
  // suppresses the original event and redispatches an equivalent synthetic
  // one AT the intended root: `dispatchEvent` sets `.target` to the element
  // it is called on directly (no re-hit-test), so the synthetic bubbles
  // back through MapLibre's own pipeline unmodified — `_addDragHandler`'s
  // `.contains()` check now passes for the RIGHT marker, and
  // `_positionDelta`/state/pan-suppression/dragend all run exactly as for
  // an uncontended press. Never touches any OTHER marker kind (BoatMarker,
  // the route-line drag handle, #850) — only via roots are inspected, and
  // it is a no-op whenever <2 of them contain the press point.
  useEffect(() => {
    if (!map) return;
    // A test fake (App.test.tsx's own ad hoc Map stub) may not model this
    // DOM surface at all; real MapLibre always exposes it.
    if (typeof map.getCanvasContainer !== 'function') return;
    const container = map.getCanvasContainer();
    if (!container || typeof container.addEventListener !== 'function') return;

    // The redirect's own synthetic event re-enters this SAME capture
    // listener (it bubbles through the same container) — this set is how
    // it recognises and ignores its own redispatch rather than looping.
    const redispatched = new WeakSet<Event>();

    const handlePress = (e: MouseEvent | TouchEvent): void => {
      if (redispatched.has(e)) return;
      const point = 'touches' in e ? e.touches[0] : e;
      if (!point) return;
      const { clientX, clientY } = point;

      const candidates = markersRef.current
        .map((marker) => ({ marker, rect: marker.getElement().getBoundingClientRect() }))
        .filter(({ rect }) => rectContainsPoint(rect, clientX, clientY));
      if (candidates.length < 2) return;

      const intended = nearestCandidate(
        { x: clientX, y: clientY },
        candidates.map(({ marker, rect }) => ({ rect, value: marker })),
      );
      const intendedEl = intended.getElement();
      if (intendedEl.contains(e.target as Node | null)) return;

      e.preventDefault();
      e.stopPropagation();

      const synthetic = buildSyntheticPress(e, intendedEl, clientX, clientY);
      if (!synthetic) return;
      redispatched.add(synthetic);
      intendedEl.dispatchEvent(synthetic);
    };

    container.addEventListener('mousedown', handlePress, { capture: true });
    container.addEventListener('touchstart', handlePress, { capture: true });
    return () => {
      container.removeEventListener('mousedown', handlePress, { capture: true });
      container.removeEventListener('touchstart', handlePress, { capture: true });
    };
  }, [map]);

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
