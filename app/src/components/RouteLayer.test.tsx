// TZ pinned for the aria-valuetext wiring tests below (#292/#373 fix-wave
// Minor 3): those hand-derive an expected `formatDateTime` string for a
// fixed UTC instant, which is only deterministic across CI/dev machines if
// the local timezone used to render it is also fixed. No other test in this
// file reads a formatted local-time string (route geometry etc. use
// Date.UTC-derived instants directly), so pinning here is neutral for them.
// @ts-expect-error process is not typed in browser context
process.env.TZ = 'Europe/Berlin';

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RouteLayer, { HIGHLIGHT_LAYER, ROUTE_STACK_BOTTOM_LAYER } from './RouteLayer';
import { I18nProvider } from '../i18n';
import { makeFakeMap, simulateStyleReload } from '../test/fakeMaplibre';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Leg, type Plan } from '../types';

// #153: RouteLayer's style-reload re-add against the shared fake map (jsdom
// has no MapLibre runtime — the BoatMarker.test.tsx approach; the component's
// real rendering stays browser-verified). Pinned here: after a simulated
// mid-session style reload the sources/layers are re-created AND repainted
// with the CURRENT plan data, persisted visibility toggles, language-
// dependent labels, and the active-leg highlight filter.

vi.mock('maplibre-gl', () => ({
  Marker: class {
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    on() {
      return this;
    }
    remove() {}
  },
  LngLatBounds: class {
    extend() {
      return this;
    }
  },
  Popup: class {
    setLngLat() {
      return this;
    }
    setDOMContent() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  },
}));

const hoisted = vi.hoisted(() => ({ map: null as unknown }));
vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));

// Mask fetch stays pending forever: RouteLayer treats a missing mask as
// "barbs un-culled", which keeps this suite off the real fetch path.
vi.mock('../services/assets', () => ({
  loadRoutingAssets: vi.fn(() => new Promise(() => {})),
}));

const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);
const ETA_MS = DEPARTURE_MS + 3_600_000;

const LEG: Leg = {
  kind: 'sail',
  board: 'starboard',
  twaDeg: 60,
  maneuverAtStart: null,
  start: { lat: 54.75, lon: 10.0 },
  end: { lat: 54.75, lon: 10.4 },
  startTimeMs: DEPARTURE_MS,
  endTimeMs: ETA_MS,
  headingDeg: 90,
  twsKn: 12,
  speedKn: 6,
  distanceNm: 10,
};

function makePlan(): Plan {
  return {
    id: 'plan-153',
    name: 'Test plan',
    createdAtMs: DEPARTURE_MS - 3_600_000,
    request: {
      origin: LEG.start,
      destination: LEG.end,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
    },
    windGrid: uniformWindGrid(12, 225, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 6 }),
    result: {
      status: 'ok',
      genoa: {
        rig: 'genoa',
        legs: [LEG],
        etaMs: ETA_MS,
        durationMs: 3_600_000,
        distanceNm: 10,
        maneuverCount: 0,
        motorDistanceNm: 0,
      },
      fock: null,
      genoaReason: null,
      fockReason: 'calm-motor-off',
      recommended: 'genoa',
      snappedOrigin: LEG.start,
      snappedDestination: LEG.end,
    },
  };
}

function renderRouteLayer(map: ReturnType<typeof makeFakeMap>, activeLegIndex: number | null) {
  hoisted.map = map;
  return render(
    <RouteLayer
      plan={makePlan()}
      rig="genoa"
      activeLegIndex={activeLegIndex}
      viaReplanning={false}
      onViaDragEnd={async () => true}
    />,
  );
}

// Latest content of a GeoJSON fake source: last setData payload, else the
// creation data (BoatMarker.test.tsx's vectorData helper).
function sourceData(map: ReturnType<typeof makeFakeMap>, id: string): GeoJSON.FeatureCollection {
  const src = map.sources.get(id);
  if (!src) throw new Error(`source ${id} not added`);
  const calls = src.setData.mock.calls;
  return calls.length > 0
    ? (calls[calls.length - 1][0] as GeoJSON.FeatureCollection)
    : (src.def.data as GeoJSON.FeatureCollection);
}

beforeEach(() => {
  localStorage.clear();
});

describe('RouteLayer setup', () => {
  it('adds the route/maneuver/barb sources and paints the plan', () => {
    const map = makeFakeMap();
    renderRouteLayer(map, null);
    expect(map.sources.has('sc-route')).toBe(true);
    expect(map.sources.has('sc-maneuvers')).toBe(true);
    expect(map.sources.has('sc-barbs')).toBe(true);
    expect(map.layers.has(ROUTE_STACK_BOTTOM_LAYER)).toBe(true);
    expect(map.layers.has(HIGHLIGHT_LAYER)).toBe(true);
    // One sail leg -> one LineString; start + finish -> two annotation points.
    const route = sourceData(map, 'sc-route');
    expect(route.features).toHaveLength(1);
    expect((route.features[0].geometry as GeoJSON.LineString).coordinates).toEqual([
      [10.0, 54.75],
      [10.4, 54.75],
    ]);
    expect(sourceData(map, 'sc-maneuvers').features).toHaveLength(2);
  });
});

// #155: the fit-to-route camera call must not quietly own the map's
// orientation. MapLibre's cameraForBounds computes `options?.bearing || 0`, so
// omitting `bearing` does not mean "leave it alone" — it means "rotate to
// north". With the compass shipping, that would knock track-up out of follow
// on every new plan.id, including a Live-tab reroute-from-here under way.
describe('RouteLayer fit-to-route (#155)', () => {
  it('fits at the CURRENT bearing instead of silently rotating the chart to north', () => {
    const map = makeFakeMap();
    map.setBearing(135);
    renderRouteLayer(map, null);
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    expect(map.fitBounds.mock.calls[0][1]).toMatchObject({ bearing: 135 });
  });

  it('still fits north-up when the chart is north-up', () => {
    const map = makeFakeMap();
    renderRouteLayer(map, null);
    expect(map.fitBounds.mock.calls[0][1]).toMatchObject({ bearing: 0 });
  });
});

describe('RouteLayer style reload (#153)', () => {
  it('re-adds all sources/layers and repaints the CURRENT plan data', () => {
    const map = makeFakeMap();
    renderRouteLayer(map, null);
    act(() => {
      simulateStyleReload(map);
    });
    for (const id of ['sc-route', 'sc-maneuvers', 'sc-barbs']) {
      expect(map.sources.has(id)).toBe(true);
    }
    for (const id of [
      ROUTE_STACK_BOTTOM_LAYER,
      HIGHLIGHT_LAYER,
      'sc-route-sail',
      'sc-route-motor',
      'sc-leg-speed',
      'sc-heading-dots',
      'sc-maneuver-circles',
      'sc-maneuver-labels',
      'sc-eta-primary',
      'sc-eta-secondary',
      'sc-wind-barbs',
    ]) {
      expect(map.layers.has(id)).toBe(true);
    }
    // Repainted, not left at the re-created empty collections.
    const route = sourceData(map, 'sc-route');
    expect(route.features).toHaveLength(1);
    expect((route.features[0].geometry as GeoJSON.LineString).coordinates).toEqual([
      [10.0, 54.75],
      [10.4, 54.75],
    ]);
    expect(route.features[0].properties?.legIndex).toBe(0);
    expect(sourceData(map, 'sc-maneuvers').features).toHaveLength(2);
    // Language-dependent maneuver letters re-applied (default lang de: W/H).
    expect(map.layers.get('sc-maneuver-labels')?.layout?.['text-field']).toEqual([
      'match',
      ['get', 'kind'],
      'tack',
      'W',
      'gybe',
      'H',
      '',
    ]);
    // Barbs default ON (#63): the layer is re-created hidden and must be
    // flipped back visible by the re-run visibility sync.
    expect(map.layers.get('sc-wind-barbs')?.layout?.visibility).toBe('visible');
  });

  it('re-applies the CURRENT active-leg highlight filter after a reload', () => {
    const map = makeFakeMap();
    const { rerender } = renderRouteLayer(map, 0);
    rerender(
      <RouteLayer
        plan={makePlan()}
        rig="genoa"
        activeLegIndex={2}
        viaReplanning={false}
        onViaDragEnd={async () => true}
      />,
    );
    act(() => {
      simulateStyleReload(map);
    });
    // The re-created layer starts at the never-matching -1 filter; the
    // re-run sync must restore the LATEST index (2), not the mount-time 0.
    expect(map.layers.get(HIGHLIGHT_LAYER)?.filter).toEqual(['==', ['get', 'legIndex'], 2]);
  });

  it('re-applies persisted OFF visibility states after a reload', () => {
    localStorage.setItem('sc-annotations-visible', '0');
    localStorage.setItem('sc-barbs-visible', '0');
    const map = makeFakeMap();
    renderRouteLayer(map, null);
    act(() => {
      simulateStyleReload(map);
    });
    for (const id of ['sc-eta-primary', 'sc-eta-secondary', 'sc-leg-speed']) {
      expect(map.layers.get(id)?.layout?.visibility).toBe('none');
    }
    expect(map.layers.get('sc-wind-barbs')?.layout?.visibility).toBe('none');
  });

  it('routine styledata firings neither re-create nor repaint anything', () => {
    const map = makeFakeMap();
    renderRouteLayer(map, null);
    const addSourceCalls = map.addSource.mock.calls.length;
    const setDataCalls = map.sources.get('sc-route')?.setData.mock.calls.length;
    act(() => {
      map.fire('styledata');
    });
    expect(map.addSource.mock.calls.length).toBe(addSourceCalls);
    expect(map.sources.get('sc-route')?.setData.mock.calls.length).toBe(setDataCalls);
  });

  it('unmount removes the re-add hook: a later style reload cannot resurrect the layers', () => {
    const map = makeFakeMap();
    const { unmount } = renderRouteLayer(map, null);
    unmount();
    simulateStyleReload(map);
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });
});

// #292 review (PR #373, Minor 3): the visible slider label can be abbreviated
// (bare time or a short weekday), so the ONLY place a screen-reader user gets
// the unambiguous full date+time is the range input's `aria-valuetext`. #361
// (a parallel PR) shipped an accessible-name regression unnoticed, which is
// exactly the failure class an eyeball check on this attribute cannot catch
// reliably -- this pins the actual DOM wiring instead.
//
// DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0) is 2026-07-15 10:00 CEST
// under the file's pinned Europe/Berlin TZ (UTC+2 in July) -- the expected
// strings are hand-derived from that instant via `Intl.DateTimeFormat`
// directly (`de-DE`/`en-GB`, day/month/year 2-digit + hour/minute h23,
// matching `formatDateTime`'s own known options -- see this file's
// `formatDateTime` tests for the same DD.MM.YYYY, HH:MM / DD/MM/YYYY, HH:MM
// shapes), not by calling `formatSliderTime`/`formatDateTime` from the
// component under test.
describe('RouteLayer wind-barb slider aria-valuetext (#292, #373 fix-wave)', () => {
  it('carries the full unambiguous date+time in German, independent of the abbreviated visible label', () => {
    const map = makeFakeMap();
    renderRouteLayer(map, null);
    const slider = screen.getByRole('slider', { name: 'Vorhersagezeitpunkt' });
    expect(slider).toHaveAttribute('aria-valuetext', '15.07.2026, 10:00');
  });

  it('carries the full unambiguous date+time in English, independent of the abbreviated visible label', () => {
    localStorage.setItem('sc-lang', 'en');
    const map = makeFakeMap();
    hoisted.map = map;
    render(
      <I18nProvider>
        <RouteLayer
          plan={makePlan()}
          rig="genoa"
          activeLegIndex={null}
          viaReplanning={false}
          onViaDragEnd={async () => true}
        />
      </I18nProvider>,
    );
    const slider = screen.getByRole('slider', { name: 'Forecast time' });
    expect(slider).toHaveAttribute('aria-valuetext', '15/07/2026, 10:00');
  });
});
