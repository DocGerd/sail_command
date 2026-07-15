import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Map as MaplibreMap, addProtocol, AttributionControl } from 'maplibre-gl';
import type { StyleSpecification, MapMouseEvent, LngLatBoundsLike, LngLatLike } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useLang } from '../i18n';
import type { LatLon } from '../types';

// Register the pmtiles:// protocol once per module load (MapLibre protocols
// are process-global; re-registering per mount would be redundant, not wrong).
const pmtilesProtocol = new Protocol();
addProtocol('pmtiles', pmtilesProtocol.tile);

const MAX_BOUNDS: LngLatBoundsLike = [
  [8.9, 54.05],
  [11.5, 55.55],
];
const CENTER: LngLatLike = [9.9, 54.85];
const ZOOM = 9;

const ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · ' +
  '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> · ' +
  'EMODnet Bathymetry (CC-BY 4.0) · Open-Meteo (CC-BY 4.0)';

function buildStyle(lang: string): StyleSpecification {
  const pmtilesUrl = new URL(import.meta.env.BASE_URL + 'data/basemap.pmtiles', location.href);
  const flavor = { ...namedFlavor('light'), water: '#bfd9ea' };
  return {
    version: 8,
    glyphs: import.meta.env.BASE_URL + 'basemap-assets/fonts/{fontstack}/{range}.pbf',
    sprite: new URL(import.meta.env.BASE_URL + 'basemap-assets/sprites/v4/light', location.href).href,
    sources: {
      protomaps: {
        type: 'vector',
        url: 'pmtiles://' + pmtilesUrl.href,
        attribution: ATTRIBUTION,
      },
    },
    layers: layers('protomaps', flavor, { lang }),
  };
}

const MapInstanceCtx = createContext<MaplibreMap | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useMapInstance(): MaplibreMap | null {
  return useContext(MapInstanceCtx);
}

export interface MapViewProps {
  tapActive: boolean;
  onTap: (p: LatLon) => void;
  children?: ReactNode;
}

export default function MapView({ tapActive, onTap, children }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<MaplibreMap | null>(null);
  const [lang] = useLang();

  // Refs so the click handler always sees the latest prop values without
  // tearing down and recreating the map (an expensive operation) on every
  // prop change. Synced in an effect (not during render) per the
  // react-hooks/refs rule.
  const tapActiveRef = useRef(tapActive);
  const onTapRef = useRef(onTap);
  useEffect(() => {
    tapActiveRef.current = tapActive;
    onTapRef.current = onTap;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Label language is baked into the style at creation time; SailCommand's
    // language switch is rare enough that re-fetching/re-diffing the whole
    // style (which would also disturb child-added layers) isn't worth it here.
    const instance = new MaplibreMap({
      container,
      style: buildStyle(lang),
      center: CENTER,
      zoom: ZOOM,
      maxBounds: MAX_BOUNDS,
      attributionControl: false,
    });
    instance.addControl(new AttributionControl({ compact: true }));

    const handleClick = (e: MapMouseEvent) => {
      if (!tapActiveRef.current) return;
      onTapRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    };
    instance.on('click', handleClick);

    setMap(instance);

    return () => {
      instance.off('click', handleClick);
      instance.remove();
      setMap(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one map instance per mount; lang at mount time only, see comment above
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* MapLibre takes over this element imperatively; React must never place
          children inside it, or reconciliation and MapLibre's own DOM writes
          (canvas, controls) will fight over the same subtree. */}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <MapInstanceCtx.Provider value={map}>{children}</MapInstanceCtx.Provider>
    </div>
  );
}
