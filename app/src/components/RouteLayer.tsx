import { useEffect, useMemo, useState } from 'react';
import { LngLatBounds, Map as MaplibreMap } from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import { formatTime } from '../lib/format';
import { activeRigResult } from '../lib/plan';
import {
  adaptiveBarbFeatures,
  legsToFeatureCollection,
  nearestHourIndex,
  routePointFeatures,
} from '../lib/routeGeoJson';
import { registerBarbImages } from '../lib/windBarbs';
import { NavMask } from '../lib/mask';
import { loadRoutingAssets } from '../services/assets';
import ViaMarkers from './ViaMarkers';
import RouteLegend from './RouteLegend';
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

// Not unit-tested: jsdom has no MapLibre/WebGL runtime — map.addSource/
// addLayer/getSource etc. either no-op or return undefined under jsdom, so
// this component's own source/layer wiring can only be meaningfully
// exercised against a real browser (manual/Playwright verification). The
// pure feature-building logic it calls into (routeGeoJson.ts) is covered
// separately, with ordinary unit tests.

const ROUTE_SOURCE = 'sc-route';
const MANEUVER_SOURCE = 'sc-maneuvers';
const BARB_SOURCE = 'sc-barbs';
// The three annotation symbol layers the "Times & speeds" checkbox flips
// together (heading dots stay on — they're tiny and minzoom-gated).
const ANNOTATION_LAYERS = ['sc-eta-primary', 'sc-eta-secondary', 'sc-leg-speed'] as const;
const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };
// Exported as the cross-component z-order anchor: DataLayers inserts its
// plan-independent layers BEFORE this one (below the whole route stack). Shared
// so a rename here can't silently break that ordering (a stale string literal
// would resolve to no beforeId and drop the layers on top, with no error).
export const HIGHLIGHT_LAYER = 'sc-route-highlight';
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
    map.addSource(ROUTE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
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
    // Per-leg speed label along the line (#35). line-center placement only
    // renders when the label fits the on-screen leg length and collision
    // culls overlaps, so short legs stay unlabeled at low zoom and gain a
    // label as you zoom in — no hand-tuned nm threshold. Text stays achromatic
    // for contrast; the board colors live on the line beneath it.
    map.addLayer({
      id: 'sc-leg-speed',
      type: 'symbol',
      source: ROUTE_SOURCE,
      minzoom: 10,
      layout: {
        'text-field': ['get', 'speedLabel'],
        'symbol-placement': 'line-center',
        'text-size': 11,
        'text-font': ['Noto Sans Regular'],
        'text-rotation-alignment': 'map',
      },
      paint: {
        'text-color': '#1a1a1a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.4,
      },
    });
  }
  if (!map.getSource(MANEUVER_SOURCE)) {
    map.addSource(MANEUVER_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    // MANEUVER_SOURCE now carries the whole uniform point set (routePointFeatures):
    // start/finish/tack/gybe/heading. The maneuver circle+letter layers must
    // therefore filter to tack/gybe (inlined below), or they'd draw r=9 circles
    // at every point.
    // Heading-change dots (#37): a "mini" maneuver circle, same achromatic
    // family, clearly subordinate. Added first so it paints beneath the r=9
    // maneuver circles. minzoom 11 — declutter is by zoom, not a toggle.
    map.addLayer({
      id: 'sc-heading-dots',
      type: 'circle',
      source: MANEUVER_SOURCE,
      minzoom: 11,
      filter: ['==', ['get', 'kind'], 'heading'],
      paint: {
        'circle-radius': 3,
        'circle-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#1a1a1a',
      },
    });
    map.addLayer({
      id: 'sc-maneuver-circles',
      type: 'circle',
      source: MANEUVER_SOURCE,
      filter: ['in', ['get', 'kind'], ['literal', ['tack', 'gybe']]],
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
      filter: ['in', ['get', 'kind'], ['literal', ['tack', 'gybe']]],
      layout: {
        'text-field': '', // populated by the lang-sync effect below
        'text-size': 11,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#1a1a1a' },
    });
    // ETA text labels (#35). Two layers so zoom-tiering is by layer minzoom
    // (never a ['zoom'] filter): primary (departure/arrival/maneuvers) from
    // z9, secondary (plain heading joints) from z12 — one step after the dots
    // appear at 11, so a dot never pops in already-labeled. symbol-sort-key
    // = rank, so on a collision the destination ETA (rank 0) wins, then the
    // departure, then maneuvers. text-allow-overlap:false → MapLibre declutters.
    // (Layout/paint inlined per layer so addLayer's contextual typing applies.)
    map.addLayer({
      id: 'sc-eta-primary',
      type: 'symbol',
      source: MANEUVER_SOURCE,
      minzoom: 9,
      filter: ['in', ['get', 'kind'], ['literal', ['start', 'finish', 'tack', 'gybe']]],
      layout: {
        'text-field': ['get', 'eta'],
        'text-anchor': 'left',
        'text-offset': [0.9, 0],
        'text-size': 11,
        'text-font': ['Noto Sans Regular'],
        'text-allow-overlap': false,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': '#1a1a1a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.4,
      },
    });
    map.addLayer({
      id: 'sc-eta-secondary',
      type: 'symbol',
      source: MANEUVER_SOURCE,
      minzoom: 12,
      filter: ['==', ['get', 'kind'], 'heading'],
      layout: {
        'text-field': ['get', 'eta'],
        'text-anchor': 'left',
        'text-offset': [0.9, 0],
        'text-size': 11,
        'text-font': ['Noto Sans Regular'],
        'text-allow-overlap': false,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': '#1a1a1a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.4,
      },
    });
  }
  if (!map.getSource(BARB_SOURCE)) {
    registerBarbImages(map);
    map.addSource(BARB_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
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

export default function RouteLayer({
  plan,
  rig,
  activeLegIndex,
  viaReplanning,
  onViaDragEnd,
}: RouteLayerProps) {
  const map = useMapInstance();
  const [lang] = useLang();
  const t = useT();
  const [barbsVisible, setBarbsVisible] = useState(false);
  // "Times & speeds" escape hatch — the single clean-chart toggle over the ETA
  // and per-leg-speed labels. Defaults ON (a skipper wants the numbers).
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  // Real land/depth mask for barb land-culling — loaded once, best-effort.
  // A plain Uint8Array VIEW over the module-cached buffer (never a copy, never
  // transferred, never mutated). null until it resolves; sampling skips
  // culling gracefully in the meantime.
  const [mask, setMask] = useState<NavMask | null>(null);
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

  // E2E handle: publish the live map so Playwright can introspect the barb and
  // annotation layers (queryRenderedFeatures / getLayoutProperty) — there is no
  // DOM handle for symbol counts. Mirrors the window.__sailGlyphWarmup E2E
  // signal convention; a reference to an already-in-memory object, harmless in
  // production.
  useEffect(() => {
    if (!map) return;
    const w = window as unknown as { __scMap?: MaplibreMap };
    w.__scMap = map;
    return () => {
      if (w.__scMap === map) delete w.__scMap;
    };
  }, [map]);

  // Load the real mask once (for barb land-culling). new Uint8Array(buffer) is
  // a read-only VIEW over the module-cached maskBuffer — no copy, no transfer,
  // no mutation; NavMask only reads. Best-effort: on failure, barbs still
  // render without land-culling.
  useEffect(() => {
    let cancelled = false;
    loadRoutingAssets()
      .then((assets) => {
        if (cancelled) return;
        setMask(new NavMask(assets.maskMeta, new Uint8Array(assets.maskBuffer)));
      })
      .catch(() => {
        /* leave mask null — barbs render un-culled */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Route line + the uniform annotation point set (start/finish/maneuvers/
  // heading joints, each carrying its precomputed ETA string). The line source
  // also gains the per-leg speed label; both depend on lang (ETA/speed strings
  // are precomputed), so a language switch rebuilds them.
  useEffect(() => {
    if (!map || !styleReady) return;
    const legs = result?.legs ?? [];
    const routeData = legsToFeatureCollection(legs, { motorLetter: t('route.motorLetter') });
    const pointData = routePointFeatures(legs, result?.etaMs ?? 0, lang);
    (map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined)?.setData(routeData);
    (map.getSource(MANEUVER_SOURCE) as GeoJSONSource | undefined)?.setData(pointData);
    // t() is re-derived from lang every render; only lang's identity should
    // retrigger this rebuild (the strings are language-dependent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, styleReady, result, lang]);

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

  // Viewport-scoped adaptive barbs (#36): recomputed on debounced moveend/
  // zoomend and on slider/plan/rig/mask changes — but ONLY while visible (no
  // per-frame JS during a pan, and no work at all when the toggle is off).
  // Always sampled from plan.windGrid at the slider time — never re-fetched.
  useEffect(() => {
    if (!map || !styleReady) return;
    const source = () => map.getSource(BARB_SOURCE) as GeoJSONSource | undefined;
    if (!plan || !barbsVisible) {
      // No plan → clear stale barbs. Hidden → the layer is already invisible,
      // but clearing avoids a one-frame flash of the previous hour/zoom when
      // it's re-enabled.
      source()?.setData(EMPTY_FC);
      return;
    }
    const legs = result?.legs ?? [];
    let raf = 0;
    const rebuild = () => {
      const b = map.getBounds();
      const data = adaptiveBarbFeatures(
        plan.windGrid,
        tMs,
        {
          project: (p: LatLon) => {
            const pt = map.project([p.lon, p.lat]);
            return { x: pt.x, y: pt.y };
          },
          bounds: {
            west: b.getWest(),
            south: b.getSouth(),
            east: b.getEast(),
            north: b.getNorth(),
          },
        },
        legs,
        mask,
      );
      source()?.setData(data);
    };
    const onViewChange = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        rebuild();
      });
    };
    rebuild(); // initial paint for the current slider/plan/rig/mask/viewport
    map.on('moveend', onViewChange);
    map.on('zoomend', onViewChange);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      map.off('moveend', onViewChange);
      map.off('zoomend', onViewChange);
    };
  }, [map, styleReady, plan, tMs, result, barbsVisible, mask]);

  useEffect(() => {
    if (!map || !styleReady || !map.getLayer('sc-wind-barbs')) return;
    map.setLayoutProperty('sc-wind-barbs', 'visibility', barbsVisible ? 'visible' : 'none');
  }, [map, styleReady, barbsVisible]);

  // "Times & speeds" toggle flips the ETA + per-leg-speed label layers
  // together (heading dots are NOT included — they stay minzoom-gated).
  useEffect(() => {
    if (!map || !styleReady) return;
    const visibility = annotationsVisible ? 'visible' : 'none';
    for (const id of ANNOTATION_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
  }, [map, styleReady, annotationsVisible]);

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
        <input
          type="checkbox"
          checked={annotationsVisible}
          onChange={(e) => setAnnotationsVisible(e.target.checked)}
        />
        {t('route.annotations.toggle')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={barbsVisible}
          onChange={(e) => setBarbsVisible(e.target.checked)}
        />
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
      <ViaMarkers
        viaPoints={plan.request.viaPoints}
        replanning={viaReplanning}
        onDragEnd={onViaDragEnd}
      />
      <RouteLegend />
    </div>
  );
}
