import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Map as MaplibreMap, addProtocol, AttributionControl } from 'maplibre-gl';
import type {
  StyleSpecification,
  MapMouseEvent,
  ErrorEvent,
  LngLatBoundsLike,
  LngLatLike,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useLang } from '../i18n';
import { noteMapError } from '../services/swRecovery';
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
  '<a href="https://emodnet.ec.europa.eu/en/bathymetry" target="_blank" rel="noopener">EMODnet Bathymetry</a> (CC-BY 4.0) · ' +
  '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> (CC-BY 4.0)';

function buildStyle(lang: string): StyleSpecification {
  const pmtilesUrl = new URL(import.meta.env.BASE_URL + 'data/basemap.pmtiles', location.href);
  const flavor = { ...namedFlavor('light'), water: '#bfd9ea' };
  return {
    version: 8,
    glyphs: import.meta.env.BASE_URL + 'basemap-assets/fonts/{fontstack}/{range}.pbf',
    sprite: new URL(import.meta.env.BASE_URL + 'basemap-assets/sprites/v4/light', location.href)
      .href,
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

// #33: MapLibre 5.x's compact AttributionControl always enters compact mode
// EXPANDED — the control enters the DOM empty/non-compact at onAdd, then
// `_updateCompact` adds `maplibregl-compact` together with
// `maplibregl-compact-show` (the class that reveals the full notice) the
// moment the first attribution string arrives, and it stays expanded until
// the first map drag (or a tap on its own toggle) — `_updateCompactMinimize`
// removes `maplibregl-compact-show`. There is no upstream option for "start
// collapsed". Below the 1024px breakpoint that expanded ~600px bar overlays
// the bottom sheet's full-width controls and intercepts their pointer
// events, so this reproduces upstream's own drag-collapse — remove
// `maplibregl-compact-show`, nothing else — at the moment of that one-shot
// auto-expansion. The attribution starts collapsed EVERYWHERE (not gated on
// viewport width): a load-time gate would leave a wide-loaded session that
// is later narrowed with the bar overlapping the sheet. Collapsing keeps the
// notice one tap away — the position #33 accepted as satisfying CC-BY/ODbL
// (upstream's compact docs recommend not collapsing where the bar fits; the
// wide layout deliberately trades that for consistency and for closing the
// resize gap). Removing or permanently hiding it would not be acceptable. A
// MutationObserver callback runs as a microtask, i.e. before the expanded
// bar can ever paint. Only CSS classes MapLibre itself ships styles for in
// maplibre-gl.css are touched (a de-facto-stable surface; no JS internals);
// the control's summary button keeps working. Returns a disposer for
// unmount (no-op once the one-shot has fired).
//
// eslint-disable-next-line react-refresh/only-export-components
export function collapseAttributionAtLoad(mapContainer: HTMLElement): () => void {
  const attrib = mapContainer.querySelector('details.maplibregl-ctrl-attrib');
  if (!attrib) return () => {};
  // Already expanded at add time (attributions were available synchronously).
  if (attrib.classList.contains('maplibregl-compact-show')) {
    attrib.classList.remove('maplibregl-compact-show');
    return () => {};
  }
  // One-shot: the first appearance of `maplibregl-compact-show` is always the
  // auto-expansion (the toggle button only becomes usable once compact mode
  // engages, which is the same instant), so collapsing it can never swallow a
  // deliberate user expansion. Afterwards MapLibre never re-adds the class on
  // its own (`_updateCompact` no-ops once `maplibregl-compact` is set), so
  // the observer disconnects for good.
  const observer = new MutationObserver(() => {
    if (attrib.classList.contains('maplibregl-compact-show')) {
      attrib.classList.remove('maplibregl-compact-show');
      observer.disconnect();
    }
  });
  observer.observe(attrib, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

export interface MapViewProps {
  tapActive: boolean;
  onTap: (p: LatLon) => void;
  onMapError?: () => void;
  children?: ReactNode;
}

export default function MapView({ tapActive, onTap, onMapError, children }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<MaplibreMap | null>(null);
  const [lang] = useLang();

  // Refs so the click/error handlers always see the latest prop values
  // without tearing down and recreating the map (an expensive operation) on
  // every prop change. Synced in an effect (not during render) per the
  // react-hooks/refs rule.
  const tapActiveRef = useRef(tapActive);
  const onTapRef = useRef(onTap);
  const onMapErrorRef = useRef(onMapError);
  useEffect(() => {
    tapActiveRef.current = tapActive;
    onTapRef.current = onTap;
    onMapErrorRef.current = onMapError;
  });

  // MapLibre can fire many 'error' events in a row (style/glyph/tile fetch
  // failures, etc.); only the first should surface the app's map-error
  // banner. A ref, not state — it needs to gate the handler synchronously
  // on every subsequent event, not trigger a re-render itself.
  const mapErrorReportedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    mapErrorReportedRef.current = false;

    // Label language is baked into the style at creation time; SailCommand's
    // language switch is rare enough that re-fetching/re-diffing the whole
    // style (which would also disturb child-added layers) isn't worth it here.
    //
    // No explicit resize handling: `trackResize` defaults to true, and
    // MapLibre v5 backs it with a ResizeObserver on `container` (not a bare
    // window 'resize' listener). That already keeps the canvas in sync when
    // the container box changes — including the #24 responsive breakpoint
    // crossing that flips the map between full-viewport and the ~2/3 side-
    // panel column — so a second observer here would only double-fire resize.
    const instance = new MaplibreMap({
      container,
      style: buildStyle(lang),
      center: CENTER,
      zoom: ZOOM,
      maxBounds: MAX_BOUNDS,
      attributionControl: false,
    });
    instance.addControl(new AttributionControl({ compact: true }));
    // Collapse the attribution's one-shot auto-expansion before it can paint
    // (#33) — see collapseAttributionAtLoad.
    const stopAttributionCollapse = collapseAttributionAtLoad(instance.getContainer());

    const handleClick = (e: MapMouseEvent) => {
      if (!tapActiveRef.current) return;
      onTapRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    };
    instance.on('click', handleClick);

    // See mapErrorReportedRef's declaration above for why this only ever
    // surfaces once. Every error is still console-logged, one-shot or not.
    const handleError = (e: ErrorEvent) => {
      console.error('MapLibre error', e.error);
      // #27: recorded for EVERY error (before the one-shot banner gate
      // below) — swRecovery itself decides whether the page was
      // SW-uncontrolled at the time, which is the only case it acts on.
      noteMapError();
      if (mapErrorReportedRef.current) return;
      mapErrorReportedRef.current = true;
      onMapErrorRef.current?.();
    };
    instance.on('error', handleError);

    setMap(instance);

    return () => {
      stopAttributionCollapse();
      instance.off('click', handleClick);
      instance.off('error', handleError);
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
