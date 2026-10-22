import { useEffect, useRef, useState } from 'react';
import { Popup } from 'maplibre-gl';
import type { GeoJSONSource, Map as MaplibreMap, MapLayerMouseEvent } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { HARBOR_CIRCLE_LAYER, SEAMARKS_HAZARD_LAYER, SEAMARKS_LAYER } from './DataLayers';
import { SAVED_WAYPOINT_LAYER } from './SavedWaypointsLayer';
import { AIS_STACK_BOTTOM_LAYER, AIS_VESSEL_LAYER } from './AisLayer';
import { ROUTE_HIT_LAYER, ROUTE_STACK_BOTTOM_LAYER } from './RouteLayer';
import { useLang, useT } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import { installStyleSetup } from '../lib/styleReload';
import { formatHeading, type Lang } from '../lib/format';
import { INK_COLOR } from '../lib/mapColors';
import {
  EMPTY_WAVE_ARROWS,
  EMPTY_WAVE_CELLS,
  SEA_STATE_BAND_KEY,
  SEA_STATE_COLORS,
  WAVE_ARROW_IMAGE,
  WAVE_ARROW_LAYER,
  WAVE_ARROW_PIXEL_RATIO,
  WAVE_ARROW_SOURCE,
  WAVE_CELL_SOURCE,
  WAVE_EDGE_LAYER,
  WAVE_EDGE_OPACITY,
  WAVE_FILL_LAYER,
  WAVE_FILL_OPACITY,
  formatSeaStateM,
  waveArrowImage,
  waveFeaturesAt,
  type ShadedBand,
} from '../lib/waveMap';
import type { WaveGrid } from '../types';

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

function setupLayers(map: MaplibreMap): void {
  if (!map.hasImage(WAVE_ARROW_IMAGE)) {
    map.addImage(WAVE_ARROW_IMAGE, waveArrowImage(), { pixelRatio: WAVE_ARROW_PIXEL_RATIO });
  }
  const beforeId = waveBeforeId(map);
  map.addSource(WAVE_CELL_SOURCE, { type: 'geojson', data: EMPTY_WAVE_CELLS });
  map.addSource(WAVE_ARROW_SOURCE, { type: 'geojson', data: EMPTY_WAVE_ARROWS });
  map.addLayer(
    {
      id: WAVE_FILL_LAYER,
      type: 'fill',
      source: WAVE_CELL_SOURCE,
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'match',
          ['get', 'band'],
          'calm',
          SEA_STATE_COLORS.calm,
          'smooth',
          SEA_STATE_COLORS.smooth,
          'slight',
          SEA_STATE_COLORS.slight,
          'moderate',
          SEA_STATE_COLORS.moderate,
          'rough',
          SEA_STATE_COLORS.rough,
          'rgba(0,0,0,0)',
        ],
        'fill-opacity': WAVE_FILL_OPACITY,
        // Antialiasing draws hairline seams between adjacent cells.
        'fill-antialias': false,
      },
    },
    beforeId,
  );
  map.addLayer(
    {
      id: WAVE_EDGE_LAYER,
      type: 'line',
      source: WAVE_CELL_SOURCE,
      layout: { visibility: 'none' },
      paint: {
        'line-color': INK_COLOR,
        'line-opacity': WAVE_EDGE_OPACITY,
        'line-width': 0.75,
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
        'icon-image': WAVE_ARROW_IMAGE,
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

function row(label: string, value: string): HTMLElement {
  const p = document.createElement('div');
  const b = document.createElement('strong');
  b.textContent = `${label}: `;
  p.append(b, value);
  return p;
}

function popupContent(
  props: Record<string, unknown>,
  t: (k: MsgKey) => string,
  lang: Lang,
): HTMLElement {
  const num = (k: string): number | null =>
    typeof props[k] === 'number' && Number.isFinite(props[k]) ? props[k] : null;
  const noData = t('map.waves.popup.noData');
  const height = num('heightM');
  const period = num('periodS');
  const travel = num('travelDeg');
  const band = props.band as ShadedBand | undefined;
  const root = document.createElement('div');
  root.className = 'wave-popover';
  const title = document.createElement('strong');
  title.textContent = t('map.waves.popup.title');
  root.append(
    title,
    row(
      t('map.waves.popup.height'),
      height === null ? noData : `${formatSeaStateM(height, lang)} m`,
    ),
    row(
      t('map.waves.popup.band'),
      band && Object.hasOwn(SEA_STATE_BAND_KEY, band) ? t(SEA_STATE_BAND_KEY[band]) : noData,
    ),
    row(t('map.waves.popup.period'), period === null ? noData : `${Math.round(period)} s`),
    row(t('map.waves.popup.direction'), travel === null ? noData : formatHeading(travel)),
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
}

// #1699: plan-bound sea-state overlay — Hs shading by WMO band plus travel
// arrows, display only. Rendered by RouteLayer, which owns the slider.
export default function WaveLayer({ grid, tMs, visible, mapPickArmed }: WaveLayerProps) {
  const map = useMapInstance();
  const t = useT();
  const [lang] = useLang();
  const [styleEpoch, setStyleEpoch] = useState(0);
  const hasGrid = grid !== undefined;
  const popupRef = useRef<Popup | null>(null);
  const armedRef = useRef(mapPickArmed);
  const tRef = useRef(t);
  const langRef = useRef(lang);
  useEffect(() => {
    armedRef.current = mapPickArmed;
    tRef.current = t;
    langRef.current = lang;
  });

  // Only a plan with a grid creates the layers; plans without one leave the
  // map's stack exactly as it was.
  useEffect(() => {
    if (!map || !hasGrid) return;
    const setup = () => {
      const missing = !map.getSource(WAVE_CELL_SOURCE);
      if (missing) setupLayers(map);
      setStyleEpoch((e) => (missing || e === 0 ? e + 1 : e));
    };
    return installStyleSetup(map, setup);
  }, [map, hasGrid]);

  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const cells = map.getSource(WAVE_CELL_SOURCE) as GeoJSONSource | undefined;
    const arrows = map.getSource(WAVE_ARROW_SOURCE) as GeoJSONSource | undefined;
    const data = grid ? waveFeaturesAt(grid, tMs) : null;
    cells?.setData(data?.cells ?? EMPTY_WAVE_CELLS);
    arrows?.setData(data?.arrows ?? EMPTY_WAVE_ARROWS);
    // The popup's numbers belong to the hour and plan it was opened on.
    popupRef.current?.remove();
    popupRef.current = null;
  }, [map, styleEpoch, grid, tMs]);

  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const visibility = visible && hasGrid ? 'visible' : 'none';
    for (const id of [WAVE_FILL_LAYER, WAVE_EDGE_LAYER, WAVE_ARROW_LAYER]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
    if (visibility === 'none') {
      popupRef.current?.remove();
      popupRef.current = null;
    }
  }, [map, styleEpoch, visible, hasGrid]);

  useEffect(() => {
    if (!map || styleEpoch === 0) return;
    const handleClick = (e: MapLayerMouseEvent) => {
      if (armedRef.current) return;
      // A DOM marker (origin, destination, via, ownship) sits over the canvas,
      // and MapLibre still delivers its click to the layer below.
      const target = e.originalEvent?.target;
      if (target instanceof Element && target.closest('.maplibregl-marker')) return;
      // Any other tappable layer under the point owns the tap; the wave
      // layer covers most of the sea and must never steal it.
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
      const props = e.features?.[0]?.properties;
      if (!props) return;
      popupRef.current?.remove();
      popupRef.current = new Popup({
        closeButton: true,
        maxWidth: '240px',
        className: 'wave-popup',
      })
        .setLngLat(e.lngLat)
        .setDOMContent(popupContent(props, tRef.current, langRef.current))
        .addTo(map);
    };
    map.on('click', WAVE_FILL_LAYER, handleClick);
    return () => {
      map.off('click', WAVE_FILL_LAYER, handleClick);
    };
  }, [map, styleEpoch]);

  // Unmount (plan cleared): the layers stay, emptied.
  useEffect(() => {
    if (!map) return;
    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
      (map.getSource(WAVE_CELL_SOURCE) as GeoJSONSource | undefined)?.setData(EMPTY_WAVE_CELLS);
      (map.getSource(WAVE_ARROW_SOURCE) as GeoJSONSource | undefined)?.setData(EMPTY_WAVE_ARROWS);
    };
  }, [map]);

  return null;
}
