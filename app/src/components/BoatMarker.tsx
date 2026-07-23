import { useEffect, useRef } from 'react';
import { Marker } from 'maplibre-gl';
import type { GeoJSONSource, LngLatLike, Map as MaplibreMap } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { destinationPoint } from '../lib/geo';
import { ownshipVectorGeoJson } from '../lib/ownshipVector';
import type { LatLon } from '../types';

export interface BoatMarkerProps {
  point: LatLon;
  cogDeg: number | null;
  sogKn: number | null; // feeds the #141 projection vector; null = no vector
  headingToSteerDeg: number; // fallback rotation when the device reports no COG
  accuracyM: number;
}

// Real-map rendering is not unit-tested: jsdom has no MapLibre/WebGL runtime
// (mirrors RouteLayer.tsx). The #141 vector wiring and the #150 style-reload
// re-add ARE unit-tested against a fake map in BoatMarker.test.tsx.
// Deliberately trivial — an imperative marker plus a small accuracy-circle
// source/layer, no state of its own beyond the map instance itself.

const ACCURACY_SOURCE = 'sc-boat-accuracy';
const ACCURACY_LAYER = 'sc-boat-accuracy-fill';
const VECTOR_SOURCE = 'sc-boat-vector';
const VECTOR_LAYER = 'sc-boat-vector-line';
const NM_PER_METER = 1 / 1852;
const CIRCLE_STEPS = 32;
const BOAT_COLOR = '#0072B2'; // Okabe-Ito blue

function accuracyCircleGeoJson(center: LatLon, radiusM: number) {
  const radiusNm = radiusM * NM_PER_METER;
  const coords: [number, number][] = [];
  for (let i = 0; i <= CIRCLE_STEPS; i++) {
    const p = destinationPoint(center, (360 * i) / CIRCLE_STEPS, radiusNm);
    coords.push([p.lon, p.lat]);
  }
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'Polygon' as const, coordinates: [coords] },
      },
    ],
  };
}

// Same one-shot style-ready helper as AisLayer/DataLayers/RouteLayer (map
// 'load' fires exactly once per map lifetime; valid only for one-time setup —
// see RouteLayer's whenStyleReady comment for why it must never gate REPEATED
// updates). The style-RELOAD re-add path (#150) listens on 'styledata'
// instead, in the mount effect below.
function whenStyleReady(map: MaplibreMap, fn: () => void): void {
  if (map.isStyleLoaded()) fn();
  else map.once('load', fn);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function boatTriangleElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sc-boat-marker';

  // Triangle points "up" (bearing 0°); MapLibre's rotationAlignment: 'map'
  // rotates the whole element to the marker's set rotation from there. Built
  // via DOM APIs (not innerHTML) even though BOAT_COLOR is an internal
  // constant, not user input.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '26');
  svg.setAttribute('height', '26');
  svg.setAttribute('viewBox', '0 0 26 26');
  svg.setAttribute('aria-hidden', 'true');

  const polygon = document.createElementNS(SVG_NS, 'polygon');
  polygon.setAttribute('points', '13,1 23,23 13,17 3,23');
  polygon.setAttribute('fill', BOAT_COLOR);
  polygon.setAttribute('stroke', '#ffffff');
  polygon.setAttribute('stroke-width', '1.5');

  svg.appendChild(polygon);
  el.appendChild(svg);
  return el;
}

export default function BoatMarker({
  point,
  cogDeg,
  sogKn,
  headingToSteerDeg,
  accuracyM,
}: BoatMarkerProps) {
  const map = useMapInstance();
  const markerRef = useRef<Marker | null>(null);

  // Latest fix, readable from the style-ready/re-add handler in the [map]
  // effect below without re-running that effect per fix (AisLayer's tRef
  // idiom): a re-add after a mid-session style reload must paint the CURRENT
  // fix, not the one the mount effect closed over (#150).
  const fixRef = useRef({ point, cogDeg, sogKn, accuracyM });
  useEffect(() => {
    fixRef.current = { point, cogDeg, sogKn, accuracyM };
  });

  // Created once per map instance; position/rotation/accuracy updates are
  // applied imperatively in the effects below rather than by recreating the
  // marker on every fix.
  useEffect(() => {
    if (!map) return;
    // The marker is a DOM overlay — style reloads don't touch it, so it is
    // added exactly once, outside the style-ready/re-add path below.
    const marker = new Marker({ element: boatTriangleElement(), rotationAlignment: 'map' })
      .setLngLat([point.lon, point.lat] as LngLatLike)
      .addTo(map);
    markerRef.current = marker;

    // #150: ONE shared setup for BOTH layers (accuracy fill + #141 vector),
    // idempotent via the same source-presence guard as AisLayer's setupLayers.
    // It runs once the style is ready (whenStyleReady, AisLayer's gate) and
    // again on every 'styledata': a mid-session map.setStyle() drops custom
    // sources/layers, and 'styledata' fires once the replacement style is in
    // place (the style is parsed by then, so addSource/addLayer are safe).
    // The guard turns the frequent routine 'styledata' firings (any
    // addLayer/setPaintProperty map-wide, including this setup's own adds)
    // into cheap no-ops.
    const setup = () => {
      const fix = fixRef.current;
      if (!map.getSource(ACCURACY_SOURCE)) {
        map.addSource(ACCURACY_SOURCE, {
          type: 'geojson',
          data: accuracyCircleGeoJson(fix.point, fix.accuracyM),
        });
        map.addLayer({
          id: ACCURACY_LAYER,
          type: 'fill',
          source: ACCURACY_SOURCE,
          paint: { 'fill-color': BOAT_COLOR, 'fill-opacity': 0.15 },
        });
      }

      // #141: 6-min COG/SOG projection vector — geometry + suppression policy
      // live in lib/ownshipVector.ts (shared projectionLine, same 6-min
      // convention as the AIS target vectors). Same line-style family as
      // AisLayer's COG vectors (width 1.5, opacity 0.85) but the ownship blue,
      // so it can't read as a traffic vector. Added above the accuracy fill; no
      // minzoom — unlike the many AIS targets there is nothing to declutter,
      // and the skipper's own projection matters most.
      if (!map.getSource(VECTOR_SOURCE)) {
        map.addSource(VECTOR_SOURCE, {
          type: 'geojson',
          data: ownshipVectorGeoJson(fix.point, fix.cogDeg, fix.sogKn),
        });
        map.addLayer({
          id: VECTOR_LAYER,
          type: 'line',
          source: VECTOR_SOURCE,
          paint: { 'line-color': BOAT_COLOR, 'line-width': 1.5, 'line-opacity': 0.85 },
        });
      }
    };
    whenStyleReady(map, setup);
    map.on('styledata', setup);

    return () => {
      // Unlike AisLayer (which leaves its layers in place for the map's
      // lifetime), BoatMarker tears everything down on unmount — so BOTH the
      // 'styledata' re-add hook and a still-pending whenStyleReady one-shot
      // must be cancelled here, or a later event would resurrect ownerless
      // layers. Evented.off removes once()-registered listeners too.
      map.off('styledata', setup);
      map.off('load', setup);
      marker.remove();
      markerRef.current = null;
      if (map.getLayer(VECTOR_LAYER)) map.removeLayer(VECTOR_LAYER);
      if (map.getSource(VECTOR_SOURCE)) map.removeSource(VECTOR_SOURCE);
      if (map.getLayer(ACCURACY_LAYER)) map.removeLayer(ACCURACY_LAYER);
      if (map.getSource(ACCURACY_SOURCE)) map.removeSource(ACCURACY_SOURCE);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one marker/source per map instance; updates handled below
  }, [map]);

  useEffect(() => {
    markerRef.current?.setLngLat([point.lon, point.lat] as LngLatLike);
    markerRef.current?.setRotation(cogDeg ?? headingToSteerDeg);
  }, [point, cogDeg, headingToSteerDeg]);

  useEffect(() => {
    if (!map || !map.getSource(ACCURACY_SOURCE)) return;
    (map.getSource(ACCURACY_SOURCE) as GeoJSONSource).setData(
      accuracyCircleGeoJson(point, accuracyM),
    );
  }, [map, point, accuracyM]);

  // #141: per-fix vector update — ownshipVectorGeoJson returns an empty
  // collection when suppressed (no COG/SOG, or SOG below the noise floor),
  // so a single unconditional setData both draws and clears.
  useEffect(() => {
    if (!map || !map.getSource(VECTOR_SOURCE)) return;
    (map.getSource(VECTOR_SOURCE) as GeoJSONSource).setData(
      ownshipVectorGeoJson(point, cogDeg, sogKn),
    );
  }, [map, point, cogDeg, sogKn]);

  return null;
}
