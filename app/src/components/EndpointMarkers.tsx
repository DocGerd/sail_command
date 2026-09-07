import { useEffect, useRef } from 'react';
import { Marker } from 'maplibre-gl';
import type { LngLatLike } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useT } from '../i18n';
import { DESTINATION_COLOR, HALO_COLOR, ORIGIN_COLOR } from '../lib/mapColors';
import type { MsgKey } from '../i18n/dict.de';
import type { PickedPoint } from '../types';

export interface EndpointMarkersProps {
  origin: PickedPoint | null;
  destination: PickedPoint | null;
}

// #1020: a map-picked (or harbor-search-picked, or GPX-imported) origin/
// destination previously rendered NO map marker at all — PlannerPanel's
// `.endpoint-name` text was the only feedback. A HARBOUR pick only LOOKED
// marked, because DataLayers.tsx always draws every one of the ~33 curated
// harbours (`sc-harbor-points`) regardless of which one is currently
// selected as an endpoint — there is no data-driven `setFilter`/paint
// expression keyed on the selection at all. This component fixes the
// map-PICK case (any pick — tap, harbor search, or GPX import all end up as
// a `PickedPoint` in App.tsx's `origin`/`destination` state, so all three
// get a marker uniformly); it deliberately does NOT touch the
// harbor-selection styling gap, which is a separate, larger change (a
// selected harbour needs `sc-harbor-points` to grow a data-driven paint
// property, not a new marker) — see #1020's own triage note. So the
// look-alike inconsistency the issue opened with MOVES rather than
// disappears: an origin picked ON a harbour now shows BOTH a harbour dot
// and an endpoint marker at the same spot, which is at least honest (the
// endpoint marker is unambiguous either way), where before neither pick
// showed anything.
//
// DOM `Marker`, mirroring ViaMarkers.tsx's pattern exactly — few points (0
// to 2), position driven straight by App-level state, an accessible name
// PLUS a visible label (the #947 lesson: an aria-label-only marker leaves a
// sighted user with an unlabelled dot). NOT a MapLibre style layer
// (addLayer/beforeId), so this is deliberately outside the map's
// paint-order tier system app.css's #208 comment declares — that system
// governs STYLE layers and app-chrome elements, neither of which a DOM
// `Marker` is. It is also not a `queryRenderedFeatures` target, so
// App.tsx's `interactiveLayerIds` (the set of style layers MapView's
// generic tap handler must yield to before treating a click as a raw
// coordinate pick) is UNCHANGED by this component — verified by reading
// MapView.tsx's tap handler, which only ever queries the layer ids in that
// array; a DOM marker sitting on top of a pixel has no bearing on it.
//
// Two endpoints only, mutual distinguishability by BOTH colour and shape
// (never colour alone): origin is a CIRCLE in ORIGIN_COLOR (Okabe-Ito sky
// blue), destination a rounded SQUARE in DESTINATION_COLOR (Okabe-Ito
// yellow) — both distinct from ViaMarkers' circular VIA_COLOR
// (reddish-purple) and BoatMarker's triangular BOAT_COLOR (blue).
//
// ALSO distinct from RouteLayer.tsx's tack/gybe MANEUVER markers
// (`sc-maneuver-circles`) — a #1022 spike found a gybe landing exactly on
// the origin point and flagged that, with no endpoint marker at all, a
// user could mistake the manoeuvre circle FOR the (absent) origin marker.
// Three independent reasons this fix does not create a new version of that
// confusion: (1) `sc-maneuver-circles` fills HALO_COLOR (white) with an
// INK_COLOR (near-black) stroke and an internal T/G letter — the exact
// COLOUR INVERSE of these markers (solid ORIGIN_COLOR/DESTINATION_COLOR
// fill, white stroke, no internal glyph); (2) these are DOM `Marker`
// elements, rendered in MapLibre's marker container ABOVE the WebGL
// canvas by construction — a manoeuvre circle sharing the same pixel
// paints BENEATH this marker, never on top of or beside it in a way that
// could be confused for it; and (3) this marker alone carries the
// always-visible caption ("Start: <label>"/"Ziel: <label>"), which no
// manoeuvre marker has. Not verified against a live coincident gybe (no
// route in this session's testing put one exactly at an endpoint); the
// three points above are a structural argument, not a sampled one — see
// CLAUDE.md's "a structural argument beats a measurement when one is
// available" precedent for why that is the stronger form here.
//
// A DOM marker painting "above the WebGL canvas by construction" does not
// by itself answer whether it can bury the OpenStreetMap attribution link
// — an ODbL/CC-BY obligation this repo has already shipped a defect
// against once (#771/PR #800). It cannot: `.maplibregl-marker` is
// `position:absolute; z-index:auto` (CSS 2.1 stacking step 6), while
// `.maplibregl-ctrl-bottom-right`, which contains the attribution, carries
// an explicit `z-index:2` (step 7) — so the attribution control always
// paints above a coincident marker regardless of DOM order. This is the
// same mechanism `app.css`'s own #208 comment already documents for
// `.route-layer-controls` vs `.maplibregl-ctrl-*`, and it is the situation
// `ViaMarkers` and `BoatMarker` are already in today.
//
// Real-map rendering is not unit-tested (jsdom has no MapLibre/WebGL
// runtime, mirrors ViaMarkers.tsx/BoatMarker.tsx) — verified in a real
// browser instead (see this PR's own verification notes).

type EndpointRole = 'origin' | 'destination';

const ROLE_LABEL_KEY: Record<EndpointRole, MsgKey> = {
  origin: 'planner.origin.label',
  destination: 'planner.destination.label',
};

function endpointElement(role: EndpointRole, ariaLabel: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `sc-endpoint-marker sc-endpoint-marker-${role}`;
  el.style.width = '20px';
  el.style.height = '20px';
  el.style.background = role === 'origin' ? ORIGIN_COLOR : DESTINATION_COLOR;
  el.style.border = `2px solid ${HALO_COLOR}`;
  el.style.boxShadow = '0 0 2px rgba(0,0,0,0.5)';
  // Shape carries the role redundantly with colour — circle for origin,
  // rounded square for destination — so the two (and ViaMarkers' own
  // circular dot) are never confusable by colour alone.
  el.style.borderRadius = role === 'origin' ? '50%' : '3px';
  // Not interactive: unlike ViaMarkers, these markers are neither
  // draggable nor a distinct native control, so no role/tabIndex — just
  // the accessible name, same shape as BoatMarker.tsx's marker.
  el.setAttribute('aria-label', ariaLabel);

  // #947-style visible sibling of the aria-label — see ViaMarkers.tsx's own
  // comment for why this label span must NOT force `position: relative`
  // onto the root (MapLibre's `.maplibregl-marker` class already keeps the
  // root `position: absolute`, and an inline override there offsets every
  // stacked marker after the first). `aria-hidden` so assistive tech does
  // not announce the same text twice.
  const labelEl = document.createElement('span');
  labelEl.className = 'sc-endpoint-marker-label';
  labelEl.textContent = ariaLabel;
  labelEl.setAttribute('aria-hidden', 'true');
  el.appendChild(labelEl);

  return el;
}

export default function EndpointMarkers({ origin, destination }: EndpointMarkersProps) {
  const map = useMapInstance();
  const t = useT();
  const markersRef = useRef<Marker[]>([]);

  // Rebuilt on any change — origin/destination are picked one at a time
  // (a tap, a harbor-search selection, a GPX import), never per-frame, so a
  // full teardown/recreate is simpler than diffing and cheap enough not to
  // matter (mirrors ViaMarkers.tsx's own choice, including keeping `t` in
  // the dependency array so a runtime language toggle rebuilds the
  // accessible/visible labels — `t` is a fresh, unmemoized closure every
  // render, per i18n/index.tsx's useT(), so this is not a no-op dependency).
  useEffect(() => {
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const points: Array<{ role: EndpointRole; point: PickedPoint | null }> = [
      { role: 'origin', point: origin },
      { role: 'destination', point: destination },
    ];
    markersRef.current = points
      .filter((entry): entry is { role: EndpointRole; point: PickedPoint } => entry.point !== null)
      .map(({ role, point }) => {
        const ariaLabel = t('map.endpoint.ariaLabel', {
          target: t(ROLE_LABEL_KEY[role]),
          label: point.label,
        });
        const marker = new Marker({ element: endpointElement(role, ariaLabel) }).setLngLat([
          point.point.lon,
          point.point.lat,
        ] as LngLatLike);
        marker.addTo(map);
        return marker;
      });

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
    };
  }, [map, origin, destination, t]);

  return null;
}
