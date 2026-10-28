import { useEffect, useRef, useState } from 'react';
import { Popup } from 'maplibre-gl';
import type { CanvasSource, GeoJSONSource, Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { HARBOR_CIRCLE_LAYER, SEAMARKS_HAZARD_LAYER, SEAMARKS_LAYER } from './DataLayers';
import { SAVED_WAYPOINT_LAYER } from './SavedWaypointsLayer';
import { AIS_STACK_BOTTOM_LAYER, AIS_VESSEL_LAYER } from './AisLayer';
import { ROUTE_HIT_LAYER, ROUTE_STACK_BOTTOM_LAYER } from './RouteLayer';
import { useLang, useT } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import { installStyleSetup } from '../lib/styleReload';
import { formatHeading, type Lang } from '../lib/format';
import { depthSourceCorners } from '../lib/depthColor';
import {
  EMPTY_WAVE_MARKERS,
  SEA_STATE_BAND_KEY,
  WAVE_ARROW_IMAGE,
  WAVE_ARROW_LAYER,
  WAVE_ARROW_PIXEL_RATIO,
  WAVE_ARROW_SOURCE,
  WAVE_DOT_IMAGE,
  WAVE_FILL_LAYER,
  WAVE_FILL_OPACITY,
  WAVE_RASTER_SOURCE,
  formatSeaStateM,
  paintSeaState,
  seaStateMarkers,
  seaStateRasterIndex,
  seaStateRasterSize,
  shadedWaveCellAt,
  waveArrowImage,
  waveDotImage,
  type WaveCellProps,
} from '../lib/waveMap';
import { waveHourIndexAt } from '../lib/waves';
import type { NavMask } from '../lib/mask';
import type { MaskMeta, WaveGrid } from '../types';

// Stack position (#160): above the depth ramp, hatch and contours (DataLayers
// anchors those below WAVE_STACK_BOTTOM_LAYER when it exists), below every
// tappable point layer, AIS and the route. Saved waypoints sit directly under
// the harbour circles, so the lowest point layer present is the anchor.
function waveBeforeId(map: MaplibreMap): string | undefined {
  for (const id of [
    SAVED_WAYPOINT_LAYER,
    HARBOR_CIRCLE_LAYER,
    AIS_STACK_BOTTOM_LAYER,
    ROUTE_STACK_BOTTOM_LAYER,
  ]) {
    if (map.getLayer(id)) return id;
  }
  return undefined;
}

// The canvas behind each map's raster source; replaced on a style reload.
const rasterCanvases = new WeakMap<MaplibreMap, HTMLCanvasElement>();

function setupLayers(map: MaplibreMap, meta: MaskMeta): void {
  if (!map.hasImage(WAVE_ARROW_IMAGE)) {
    map.addImage(WAVE_ARROW_IMAGE, waveArrowImage(), { pixelRatio: WAVE_ARROW_PIXEL_RATIO });
  }
  if (!map.hasImage(WAVE_DOT_IMAGE)) {
    map.addImage(WAVE_DOT_IMAGE, waveDotImage(), { pixelRatio: WAVE_ARROW_PIXEL_RATIO });
  }
  // addImage fires 'styledata' synchronously, so a setup armed on that event
  // may already have re-entered and added everything below.
  if (map.getSource(WAVE_RASTER_SOURCE)) return;
  const beforeId = waveBeforeId(map);
  const canvas = document.createElement('canvas');
  const size = seaStateRasterSize(meta);
  canvas.width = size.width;
  canvas.height = size.height;
  rasterCanvases.set(map, canvas);
  // Created even without a 2D context: DataLayers anchors below the fill.
  map.addSource(WAVE_RASTER_SOURCE, {
    type: 'canvas',
    canvas,
    animate: false,
    coordinates: depthSourceCorners(meta),
  });
  map.addSource(WAVE_ARROW_SOURCE, { type: 'geojson', data: EMPTY_WAVE_MARKERS });
  map.addLayer(
    {
      id: WAVE_FILL_LAYER,
      type: 'raster',
      source: WAVE_RASTER_SOURCE,
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': WAVE_FILL_OPACITY,
        // Magnified band edges stay crisp; minification still blends.
        'raster-resampling': 'nearest',
        'raster-fade-duration': 0,
      },
    },
    beforeId,
  );
  map.addLayer(
    {
      id: WAVE_ARROW_LAYER,
      type: 'symbol',
      source: WAVE_ARROW_SOURCE,
      layout: {
        visibility: 'none',
        'icon-image': ['match', ['get', 'marker'], 'dot', WAVE_DOT_IMAGE, WAVE_ARROW_IMAGE],
        'icon-rotate': ['get', 'rotateDeg'],
        'icon-rotation-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 10, 1],
        'icon-allow-overlap': true,
        // #378: never enter the collision index, so ETA/speed labels are never culled.
        'icon-ignore-placement': true,
      },
    },
    beforeId,
  );
}

// Re-uploads the canvas texture once: the source is created with animate: false.
function uploadRaster(map: MaplibreMap): void {
  const source = map.getSource(WAVE_RASTER_SOURCE) as CanvasSource | undefined;
  if (source && 'play' in source) {
    source.play();
    source.pause();
  }
}

function row(label: string, value: string): HTMLElement {
  const p = document.createElement('div');
  const b = document.createElement('strong');
  b.textContent = `${label}: `;
  p.append(b, value);
  return p;
}

function popupContent(cell: WaveCellProps, t: (k: MsgKey) => string, lang: Lang): HTMLElement {
  const noData = t('map.waves.popup.noData');
  const root = document.createElement('div');
  root.className = 'wave-popover';
  const title = document.createElement('strong');
  title.textContent = t('map.waves.popup.title');
  root.append(
    title,
    row(t('map.waves.popup.height'), `${formatSeaStateM(cell.heightM, lang)} m`),
    row(t('map.waves.popup.band'), t(SEA_STATE_BAND_KEY[cell.band])),
    row(
      t('map.waves.popup.period'),
      cell.periodS === undefined ? noData : `${Math.round(cell.periodS)} s`,
    ),
    row(
      t('map.waves.popup.direction'),
      cell.travelDeg === undefined ? noData : formatHeading(cell.travelDeg),
    ),
  );
  const note = document.createElement('p');
  note.className = 'wave-popover-disclaimer';
  note.textContent = t('map.waves.popup.disclaimer');
  root.append(note);
  return root;
}

export interface WaveLayerProps {
  grid: WaveGrid | undefined;
  // RouteLayer's slider time; sampled on the wave grid's own time axis.
  tMs: number;
  visible: boolean;
  // A map pick (origin/destination/via) is armed: the tap belongs to it.
  mapPickArmed: boolean;
  // Land/water mask for clipping; null while it loads or if it fails to load.
  mask: NavMask | null;
}

// #1699: plan-bound sea-state overlay — Hs shading by WMO band plus travel
// arrows, display only. Rendered by RouteLayer, which owns the slider. #1854:
// the shading is a raster clipped to nav-mask water.
export default function WaveLayer({ grid, tMs, visible, mapPickArmed, mask }: WaveLayerProps) {
  const map = useMapInstance();
  const t = useT();
  const [lang] = useLang();
  const [styleEpoch, setStyleEpoch] = useState(0);
  const hasGrid = grid !== undefined;
  const popupRef = useRef<Popup | null>(null);
  const paintedRef = useRef<{ canvas: HTMLCanvasElement; key: unknown[] } | null>(null);
  const latest = useRef({ mapPickArmed, t, lang, grid, tMs, mask, shown: visible && hasGrid });
  useEffect(() => {
    latest.current = { mapPickArmed, t, lang, grid, tMs, mask, shown: visible && hasGrid };
  });

  // Plans without a grid leave the map's stack exactly as it was; nothing is
  // created until the mask loads, since its bbox places the raster.
  const meta = hasGrid ? mask?.meta : undefined;
  useEffect(() => {
    if (!map || !meta) return;
    const setup = () => {
      const missing = !map.getSource(WAVE_RASTER_SOURCE);
      if (missing) setupLayers(map, meta);
      setStyleEpoch((e) => (missing || e === 0 ? e + 1 : e));
    };
    return installStyleSetup(map, setup);
  }, [map, meta]);

  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    // The popup's numbers belong to the hour and plan it was opened on.
    popupRef.current?.remove();
    popupRef.current = null;
    const hourIdx = grid ? waveHourIndexAt(grid, tMs) : null;
    const raster = grid && mask && hourIdx !== null ? seaStateRasterIndex(mask, grid) : null;
    const markers = map.getSource(WAVE_ARROW_SOURCE) as GeoJSONSource | undefined;
    markers?.setData(
      raster && grid && hourIdx !== null
        ? seaStateMarkers(raster, grid, hourIdx)
        : EMPTY_WAVE_MARKERS,
    );
    const canvas = rasterCanvases.get(map);
    if (!canvas || !visible) return;
    const key = [grid, mask, hourIdx];
    const painted = paintedRef.current;
    if (painted?.canvas === canvas && painted.key.every((v, i) => v === key[i])) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (raster && grid && hourIdx !== null) {
      const image = ctx.createImageData(raster.width, raster.height);
      paintSeaState(raster, grid, hourIdx, image.data);
      ctx.putImageData(image, 0, 0);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    paintedRef.current = { canvas, key };
    uploadRaster(map);
  }, [map, styleEpoch, grid, tMs, mask, visible]);

  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const visibility = visible && hasGrid ? 'visible' : 'none';
    for (const id of [WAVE_FILL_LAYER, WAVE_ARROW_LAYER]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
    if (visibility === 'none') {
      popupRef.current?.remove();
      popupRef.current = null;
    }
  }, [map, styleEpoch, visible, hasGrid]);

  // A raster is not queryable, so the tap is resolved against the raster index:
  // the popup opens only where a pixel is shaded.
  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const handleClick = (e: MapMouseEvent) => {
      const { mapPickArmed: armed, grid: g, tMs: time, mask: m, shown } = latest.current;
      if (!shown || armed || !g || !m) return;
      // A DOM marker (endpoints, vias, ownship, the route-drag handle) sits
      // over the canvas, and MapLibre still delivers its click to the map.
      const target = e.originalEvent?.target;
      if (target instanceof Element && target.closest('.maplibregl-marker')) return;
      // Any other tappable layer under the point owns the tap; the sea state
      // covers most of the sea and must never steal it.
      const others = [
        HARBOR_CIRCLE_LAYER,
        SEAMARKS_LAYER,
        SEAMARKS_HAZARD_LAYER,
        AIS_VESSEL_LAYER,
        SAVED_WAYPOINT_LAYER,
        ROUTE_HIT_LAYER,
      ].filter((id) => map.getLayer(id));
      if (others.length > 0 && map.queryRenderedFeatures(e.point, { layers: others }).length > 0)
        return;
      const hourIdx = waveHourIndexAt(g, time);
      if (hourIdx === null) return;
      const cell = shadedWaveCellAt(seaStateRasterIndex(m, g), g, hourIdx, {
        lat: e.lngLat.lat,
        lon: e.lngLat.lng,
      });
      if (!cell) return;
      popupRef.current?.remove();
      popupRef.current = new Popup({
        closeButton: true,
        maxWidth: '240px',
        className: 'wave-popup',
      })
        .setLngLat(e.lngLat)
        .setDOMContent(popupContent(cell, latest.current.t, latest.current.lang))
        .addTo(map);
    };
    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
  }, [map, styleEpoch]);

  // Unmount (plan cleared): the layers stay, emptied.
  useEffect(() => {
    if (!map) return;
    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
      paintedRef.current = null;
      const canvas = rasterCanvases.get(map);
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        uploadRaster(map);
      }
      (map.getSource(WAVE_ARROW_SOURCE) as GeoJSONSource | undefined)?.setData(EMPTY_WAVE_MARKERS);
    };
  }, [map]);

  return null;
}
