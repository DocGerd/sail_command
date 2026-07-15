import { useEffect, useMemo, useState } from 'react';
import { LngLatBounds, Map as MaplibreMap } from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import { formatTime } from '../lib/format';
import { activeRigResult } from '../lib/plan';
import { barbFeatures, legsToFeatureCollection, maneuverFeatures, nearestHourIndex } from '../lib/routeGeoJson';
import { registerBarbImages } from '../lib/windBarbs';
import ViaMarkers from './ViaMarkers';
import type { LatLon, Plan, Rig } from '../types';

export interface RouteLayerProps {
  plan: Plan | null;
  rig: Rig | null;
  // From useActivePlan() (published by LiveView off the GPS fix). Drives a
  // cheap setFilter() on the highlight layer only — never a source re-set —
  // so near-boundary GPS noise flipping between adjacent legs stays cheap.
  activeLegIndex: number | null;
  // E8: via-waypoint re-route. ViaMarkers is rendered here (not as a
  // sibling in App.tsx) mirroring LiveView's own BoatMarker — a plan's via
  // points are route-scoped, and RouteLayer already receives `plan`. Both
  // props are only meaningful once `plan` exists (renders null before
  // that), so App.tsx's wiring only needs to keep them defined once a plan
  // is active.
  viaReplanning: boolean;
  onViaDragEnd: (index: number, next: LatLon) => Promise<boolean>;
}

// Not unit-tested: jsdom has no MapLibre/WebGL runtime, so source/layer
// wiring here can only be exercised against a real map (see the Phase E4
// browser verification pass). The pure feature-building logic it calls into
// (routeGeoJson.ts) is covered separately.

const ROUTE_SOURCE = 'sc-route';
const MANEUVER_SOURCE = 'sc-maneuvers';
const BARB_SOURCE = 'sc-barbs';
const BARB_STRIDE = 2;
const HIGHLIGHT_LAYER = 'sc-route-highlight';
// No leg can ever have this index — an always-false filter, used while no
// leg is active instead of toggling the layer's visibility on/off.
const NO_HIGHLIGHT_IDX = -1;

// Gates a callback on the map's style existing, for calls that need to
// happen exactly once per map instance (setupLayers, below). map.once('load', ...)
// is correct ONLY for this one-shot use: MapLibre fires 'load' exactly once
// per map lifetime, when the initial style finishes loading. Reusing this
// helper for later, repeated updates (data refreshes, fitBounds, layout
// toggles) is a bug — isStyleLoaded() can transiently read false again
// afterwards (e.g. right after addSource, or while basemap tiles are still
// streaming in), and registering another once('load', ...) at that point
// waits forever, since 'load' already fired and never fires again. Those
// later effects call the map APIs directly instead (see below) — they're
// safe to call any time after the style exists, regardless of transient
// tile-loading state.
function whenStyleReady(map: MaplibreMap, fn: () => void): void {
  if (map.isStyleLoaded()) fn();
  else map.once('load', fn);
}

function setupLayers(map: MaplibreMap): void {
  if (!map.getSource(ROUTE_SOURCE)) {
    map.addSource(ROUTE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    // Halo layer, added first so it paints underneath the sail/motor lines
    // added below. Starts matching nothing (NO_HIGHLIGHT_IDX); the
    // activeLegIndex-sync effect below re-filters it with a cheap
    // setFilter() call — never a source re-set — as the live fix moves.
    map.addLayer({
      id: HIGHLIGHT_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      filter: ['==', ['get', 'legIndex'], NO_HIGHLIGHT_IDX],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 10,
        'line-color': '#FFD400',
        'line-opacity': 0.55,
        'line-blur': 1,
      },
    });
    // Two filtered layers rather than one data-driven layer: line-dasharray
    // is not a data-driven-capable paint property in the MapLibre style
    // spec, so sail vs. motor legs (only the latter dashed) need separate
    // layers on the shared source.
    map.addLayer({
      id: 'sc-route-sail',
      type: 'line',
      source: ROUTE_SOURCE,
      filter: ['==', ['get', 'kind'], 'sail'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 3.5,
        // Okabe-Ito colorblind-safe green/red, echoing the port/starboard
        // nav-light convention. Mirrored in RouteSummary.tsx's board dots.
        'line-color': ['case', ['==', ['get', 'board'], 'port'], '#D55E00', '#009E73'],
      },
    });
    map.addLayer({
      id: 'sc-route-motor',
      type: 'line',
      source: ROUTE_SOURCE,
      filter: ['==', ['get', 'kind'], 'motor'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 3.5,
        'line-color': '#5b5b5b',
        'line-dasharray': [2, 1.5],
      },
    });
  }
  if (!map.getSource(MANEUVER_SOURCE)) {
    map.addSource(MANEUVER_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'sc-maneuver-circles',
      type: 'circle',
      source: MANEUVER_SOURCE,
      paint: {
        'circle-radius': 9,
        'circle-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#1a1a1a',
      },
    });
    map.addLayer({
      id: 'sc-maneuver-labels',
      type: 'symbol',
      source: MANEUVER_SOURCE,
      layout: {
        'text-field': '', // populated by the lang-sync effect below
        'text-size': 11,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#1a1a1a' },
    });
  }
  if (!map.getSource(BARB_SOURCE)) {
    registerBarbImages(map);
    map.addSource(BARB_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'sc-wind-barbs',
      type: 'symbol',
      source: BARB_SOURCE,
      layout: {
        // barb-{round(speed/5)*5}, clamped to the 0..50 range registerBarbImages() drew.
        'icon-image': [
          'concat',
          'barb-',
          ['to-string', ['max', 0, ['min', 50, ['*', ['round', ['/', ['get', 'speedKn'], 5]], 5]]]],
        ],
        // Points INTO the FROM direction (standard barb convention) — see windBarbs.ts.
        'icon-rotate': ['get', 'dirFromDeg'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        visibility: 'none', // togglable via the barbsVisible control below
      },
    });
  }
}

export default function RouteLayer({ plan, rig, activeLegIndex, viaReplanning, onViaDragEnd }: RouteLayerProps) {
  const map = useMapInstance();
  const [lang] = useLang();
  const t = useT();
  const [barbsVisible, setBarbsVisible] = useState(false);
  const [hourIdx, setHourIdx] = useState(0);
  // Reset the slider to departure whenever the plan itself changes (not on
  // every render). Adjusted during render — React's documented pattern for
  // deriving state from a prop change (mirrors OptionsPanel.tsx's
  // NumberField) — rather than in an effect, which would cause an extra
  // cascading render after the DOM already committed the stale index.
  const [prevPlanId, setPrevPlanId] = useState(plan?.id ?? null);
  if ((plan?.id ?? null) !== prevPlanId) {
    setPrevPlanId(plan?.id ?? null);
    setHourIdx(0);
  }

  const result = plan && rig ? activeRigResult(plan, rig) : null;

  // Tracks whether setupLayers() has actually run for the current map
  // instance (sources/layers exist). Re-rendering on this flip — rather than
  // just calling setupLayers from a fire-and-forget 'load' callback — matters
  // because that callback can fire well after mount with only its
  // mount-time closure (map, no plan yet); the effects below need to
  // re-observe the *current* result/plan/etc. once sources actually exist,
  // which only happens via a dependency-driven re-run.
  const [styleReady, setStyleReady] = useState(false);

  // Create sources/layers once per map instance. styleReady starts false
  // and this only ever flips it true (never resets it) — MapView creates
  // exactly one map instance per mount, so `map` transitions null -> instance
  // at most once in this component's lifetime.
  useEffect(() => {
    if (!map) return;
    whenStyleReady(map, () => {
      setupLayers(map);
      setStyleReady(true);
    });
  }, [map]);

  // Route + maneuver geometry follows the active rig's legs.
  useEffect(() => {
    if (!map || !styleReady) return;
    const routeData = legsToFeatureCollection(result?.legs ?? []);
    const maneuverData = maneuverFeatures(result?.legs ?? []);
    (map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined)?.setData(routeData);
    (map.getSource(MANEUVER_SOURCE) as GeoJSONSource | undefined)?.setData(maneuverData);
  }, [map, styleReady, result]);

  // Maneuver letter labels are language-dependent: W/H (de), T/G (en).
  useEffect(() => {
    if (!map || !styleReady || !map.getLayer('sc-maneuver-labels')) return;
    map.setLayoutProperty('sc-maneuver-labels', 'text-field', [
      'match',
      ['get', 'kind'],
      'tack',
      t('route.maneuverLetter.tack'),
      'gybe',
      t('route.maneuverLetter.gybe'),
      '',
    ]);
    // t() is re-derived from lang every render (see i18n/index.tsx); only
    // lang's identity should retrigger this layout update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, styleReady, lang]);

  // Fit the map to the active route when the plan changes — not on every rig
  // switch (both rigs cover roughly the same area) or barb-slider tick.
  useEffect(() => {
    if (!map || !result || result.legs.length === 0) return;
    const bounds = new LngLatBounds();
    for (const leg of result.legs) {
      bounds.extend([leg.start.lon, leg.start.lat]);
      bounds.extend([leg.end.lon, leg.end.lat]);
    }
    map.fitBounds(bounds, { padding: 48, duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit on plan identity, not the (recreated) result object
  }, [map, plan?.id]);

  // Forecast hours spanning departure->ETA — the slider's snap points.
  const hourOptions = useMemo(() => {
    if (!plan || !result) return [];
    const { departureMs } = plan.request;
    const { etaMs } = result;
    const inRange = plan.windGrid.timesMs.filter((ms) => ms >= departureMs && ms <= etaMs);
    if (inRange.length > 0) return inRange;
    // Route shorter than one forecast hour: fall back to the single nearest hour.
    return [plan.windGrid.timesMs[nearestHourIndex(plan.windGrid.timesMs, departureMs)]];
  }, [plan, result]);

  const clampedHourIdx = Math.min(hourIdx, Math.max(0, hourOptions.length - 1));
  const tMs = hourOptions[clampedHourIdx] ?? plan?.request.departureMs ?? 0;

  // Barb data follows the slider position, sampled from the plan's stored
  // wind grid — never re-fetched (a saved route must render against the
  // forecast it was computed from). When plan clears, empty the source to
  // remove stale barbs from the map.
  useEffect(() => {
    if (!map || !styleReady) return;
    if (!plan) {
      (map.getSource(BARB_SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const data = barbFeatures(plan.windGrid, tMs, BARB_STRIDE);
    (map.getSource(BARB_SOURCE) as GeoJSONSource | undefined)?.setData(data);
  }, [map, styleReady, plan, tMs]);

  useEffect(() => {
    if (!map || !styleReady || !map.getLayer('sc-wind-barbs')) return;
    map.setLayoutProperty('sc-wind-barbs', 'visibility', barbsVisible ? 'visible' : 'none');
  }, [map, styleReady, barbsVisible]);

  // Cheap setFilter() only — no source re-set — so this stays cheap even
  // when GPS noise near a leg boundary flips activeLegIndex back and forth.
  // The effect dependency array already value-gates this to real changes.
  useEffect(() => {
    if (!map || !styleReady || !map.getLayer(HIGHLIGHT_LAYER)) return;
    map.setFilter(HIGHLIGHT_LAYER, ['==', ['get', 'legIndex'], activeLegIndex ?? NO_HIGHLIGHT_IDX]);
  }, [map, styleReady, activeLegIndex]);

  if (!plan) return null;

  return (
    <div className="route-layer-controls">
      <label>
        <input type="checkbox" checked={barbsVisible} onChange={(e) => setBarbsVisible(e.target.checked)} />
        {t('route.windBarbs.toggle')}
      </label>
      {hourOptions.length > 1 && (
        <div className="route-layer-time-slider">
          <input
            type="range"
            min={0}
            max={hourOptions.length - 1}
            step={1}
            value={clampedHourIdx}
            onChange={(e) => setHourIdx(Number(e.target.value))}
            aria-label={t('route.windBarbs.timeSlider')}
          />
          <span>{formatTime(tMs, lang)}</span>
        </div>
      )}
      <ViaMarkers viaPoints={plan.request.viaPoints} replanning={viaReplanning} onDragEnd={onViaDragEnd} />
    </div>
  );
}
