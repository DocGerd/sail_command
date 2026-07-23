import { useEffect, useRef } from 'react';
import { Map as MaplibreMap, Popup } from 'maplibre-gl';
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useT } from '../i18n';
import { ROUTE_STACK_BOTTOM_LAYER } from './RouteLayer';
import { aisFeatureCollection, aisPopupRows, type AisPopupProps } from '../lib/aisGeoJson';
import type { AisTargetSnapshot } from '../lib/aisTargets';

export const AIS_SOURCE = 'sc-ais';
export const AIS_VECTOR_LAYER = 'sc-ais-vectors';
export const AIS_VESSEL_LAYER = 'sc-ais-vessels';
export const AIS_LABEL_LAYER = 'sc-ais-labels';

const ARROW_IMAGE = 'sc-ais-arrow';
const DOT_IMAGE = 'sc-ais-dot';
const AIS_COLOR = '#009E73'; // Okabe-Ito green, distinct from BoatMarker's blue

// Same one-shot style-ready helper as DataLayers/RouteLayer (map 'load' fires
// once; valid only for one-time setup).
function whenStyleReady(map: MaplibreMap, fn: () => void): void {
  if (map.isStyleLoaded()) fn();
  else map.once('load', fn);
}

// A crisp directional arrow + a neutral dot, registered as map images so the
// symbol layer can rotate the arrow via icon-rotate. Built on a canvas (no DOM
// image fetch); skipped where there's no 2D backend (jsdom).
function registerAisImages(map: MaplibreMap): void {
  const size = 32;
  if (!map.hasImage(ARROW_IMAGE)) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(size / 2, 3); // bow (points "up" = 0°, rotated by icon-rotate)
      ctx.lineTo(size - 7, size - 5);
      ctx.lineTo(size / 2, size - 11);
      ctx.lineTo(7, size - 5);
      ctx.closePath();
      ctx.fillStyle = AIS_COLOR;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      map.addImage(ARROW_IMAGE, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
    }
  }
  if (!map.hasImage(DOT_IMAGE)) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 6, 0, 2 * Math.PI);
      ctx.fillStyle = AIS_COLOR;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      map.addImage(DOT_IMAGE, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
    }
  }
}

function setupLayers(map: MaplibreMap): void {
  // Anchor below the route stack (resolved at add time) so AIS renders ABOVE the
  // depth/seamark overlays (added earlier, also below the anchor) but BELOW the
  // route stack and the ownship marker (a DOM Marker, always on top).
  const beforeId = map.getLayer(ROUTE_STACK_BOTTOM_LAYER) ? ROUTE_STACK_BOTTOM_LAYER : undefined;
  if (map.getSource(AIS_SOURCE)) return;
  map.addSource(AIS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  // COG vectors (below the vessel glyph); hidden below ~zoom 9 (declutter).
  map.addLayer(
    {
      id: AIS_VECTOR_LAYER,
      type: 'line',
      source: AIS_SOURCE,
      filter: ['==', ['get', 'kind'], 'vector'],
      minzoom: 9,
      paint: {
        'line-color': AIS_COLOR,
        'line-width': 1.5,
        'line-opacity': ['match', ['get', 'tier'], 'stale', 0.4, 0.85],
      },
    },
    beforeId,
  );

  // Vessel glyphs: arrow when a course is known (and zoom ≥ 9), else a neutral
  // dot; stale targets faded. icon-rotate turns the arrow to heading/COG.
  map.addLayer(
    {
      id: AIS_VESSEL_LAYER,
      type: 'symbol',
      source: AIS_SOURCE,
      filter: ['==', ['get', 'kind'], 'vessel'],
      layout: {
        'icon-image': [
          'step',
          ['zoom'],
          DOT_IMAGE,
          9,
          ['case', ['get', 'hasCourse'], ARROW_IMAGE, DOT_IMAGE],
        ],
        'icon-rotate': ['get', 'rotation'],
        'icon-rotation-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 0.9],
        'icon-allow-overlap': true,
      },
      paint: { 'icon-opacity': ['match', ['get', 'tier'], 'stale', 0.5, 1] },
    },
    beforeId,
  );

  // Name labels only at ≥ ~zoom 11, collision-culled.
  map.addLayer(
    {
      id: AIS_LABEL_LAYER,
      type: 'symbol',
      source: AIS_SOURCE,
      filter: ['==', ['get', 'kind'], 'vessel'],
      minzoom: 11,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#1a1a1a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.2,
        'text-opacity': ['match', ['get', 'tier'], 'stale', 0.55, 1],
      },
    },
    beforeId,
  );
}

export default function AisLayer({ targets }: { targets: AisTargetSnapshot[] }) {
  const map = useMapInstance();
  const t = useT();
  const styleReadyRef = useRef(false);
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  // One-time source/layer/image setup, gated on the style being ready.
  useEffect(() => {
    if (!map) return;
    whenStyleReady(map, () => {
      registerAisImages(map);
      setupLayers(map);
      styleReadyRef.current = true;
      // Paint whatever targets already arrived before the style finished.
      (map.getSource(AIS_SOURCE) as GeoJSONSource | undefined)?.setData(
        aisFeatureCollection(targets),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time setup; targets flow through the setData effect below
  }, [map]);

  // ≤1 Hz setData: `targets` is already published at ≤1 Hz by useAisTraffic.
  useEffect(() => {
    if (!map || !styleReadyRef.current) return;
    (map.getSource(AIS_SOURCE) as GeoJSONSource | undefined)?.setData(
      aisFeatureCollection(targets),
    );
  }, [map, targets]);

  // Tap a vessel -> themed popup (seamark pattern): built via DOM APIs, one
  // popup at a time, dismissed by a tap elsewhere (MapLibre default).
  useEffect(() => {
    if (!map) return;
    const handleClick = (e: MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties as Record<string, unknown> | undefined;
      if (!p) return;
      const props: AisPopupProps = {
        mmsi: String(p.mmsi ?? ''),
        name: String(p.name ?? ''),
        shipType: typeof p.shipType === 'number' ? p.shipType : null,
        sog: typeof p.sog === 'number' ? p.sog : null,
        cog: typeof p.cog === 'number' ? p.cog : null,
        heading: typeof p.heading === 'number' ? p.heading : null,
        lastUpdateMs: typeof p.lastUpdateMs === 'number' ? p.lastUpdateMs : Date.now(),
      };
      const container = document.createElement('div');
      container.className = 'ais-popover';
      for (const row of aisPopupRows(props, Date.now())) {
        const line = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = `${tRef.current(row.labelKey)}: `;
        line.append(label, document.createTextNode(row.value));
        container.append(line);
      }
      const disclaimer = document.createElement('p');
      disclaimer.className = 'ais-popover-disclaimer';
      disclaimer.textContent = tRef.current('ais.disclaimer');
      container.append(disclaimer);
      new Popup({ closeButton: true, maxWidth: '240px', className: 'ais-popup' })
        .setLngLat(e.lngLat)
        .setDOMContent(container)
        .addTo(map);
    };
    const enter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', AIS_VESSEL_LAYER, handleClick);
    map.on('mouseenter', AIS_VESSEL_LAYER, enter);
    map.on('mouseleave', AIS_VESSEL_LAYER, leave);
    return () => {
      map.off('click', AIS_VESSEL_LAYER, handleClick);
      map.off('mouseenter', AIS_VESSEL_LAYER, enter);
      map.off('mouseleave', AIS_VESSEL_LAYER, leave);
    };
  }, [map]);

  return null;
}
