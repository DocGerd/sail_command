import { useEffect, useRef } from 'react';
import { Marker } from 'maplibre-gl';
import type { GeoJSONSource, LngLatLike } from 'maplibre-gl';
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

// Not unit-tested: jsdom has no MapLibre/WebGL runtime (mirrors RouteLayer.tsx).
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

  // Created once per map instance; position/rotation/accuracy updates are
  // applied imperatively in the effects below rather than by recreating the
  // marker on every fix.
  useEffect(() => {
    if (!map) return;
    const marker = new Marker({ element: boatTriangleElement(), rotationAlignment: 'map' })
      .setLngLat([point.lon, point.lat] as LngLatLike)
      .addTo(map);
    markerRef.current = marker;

    if (!map.getSource(ACCURACY_SOURCE)) {
      map.addSource(ACCURACY_SOURCE, {
        type: 'geojson',
        data: accuracyCircleGeoJson(point, accuracyM),
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
        data: ownshipVectorGeoJson(point, cogDeg, sogKn),
      });
      map.addLayer({
        id: VECTOR_LAYER,
        type: 'line',
        source: VECTOR_SOURCE,
        paint: { 'line-color': BOAT_COLOR, 'line-width': 1.5, 'line-opacity': 0.85 },
      });
    }

    return () => {
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
