// TZ pinned for the aria-valuetext wiring tests below (#292/#373 fix-wave
// Minor 3): those hand-derive an expected `formatDateTime` string for a
// fixed UTC instant, which is only deterministic across CI/dev machines if
// the local timezone used to render it is also fixed. No other test in this
// file reads a formatted local-time string (route geometry etc. use
// Date.UTC-derived instants directly), so pinning here is neutral for them.
// @ts-expect-error process is not typed in browser context
process.env.TZ = 'Europe/Berlin';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RouteLayer, { HIGHLIGHT_LAYER, ROUTE_STACK_BOTTOM_LAYER } from './RouteLayer';
import { I18nProvider } from '../i18n';
import { makeFakeMap, simulateStyleReload } from '../test/fakeMaplibre';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Leg, type Plan } from '../types';
import { defaultBoatSnapshot } from '../types';
import { PLAN_SCHEMA_VERSION } from '../types';

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
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: LEG.start,
      destination: LEG.end,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: uniformWindGrid(12, 225, { t0Ms: DEPARTURE_MS - 3_600_000, hours: 6 }),
    result: {
      status: 'ok',
      sails: [
        {
          sailId: 'genoa',
          result: {
            sailId: 'genoa',
            legs: [LEG],
            etaMs: ETA_MS,
            durationMs: 3_600_000,
            distanceNm: 10,
            maneuverCount: 0,
            motorDistanceNm: 0,
          },
          reason: null,
        },
        { sailId: 'fock', result: null, reason: 'calm-motor-off' },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: LEG.start,
      snappedDestination: LEG.end,
    },
  };
}

// #324: a second leg for the fock rig, geometrically distinct from LEG (the
// genoa leg makePlan() uses) so the two rigs' feature collections are
// trivially distinguishable by coordinates alone.
const FOCK_LEG: Leg = {
  kind: 'sail',
  board: 'port',
  twaDeg: -60,
  maneuverAtStart: null,
  start: { lat: 54.8, lon: 10.0 },
  end: { lat: 54.8, lon: 10.4 },
  startTimeMs: DEPARTURE_MS,
  endTimeMs: ETA_MS,
  headingDeg: 270,
  twsKn: 12,
  speedKn: 5,
  distanceNm: 10,
};

// #324: both rigs solved (unlike makePlan(), whose fock is null) — the alt-
// rig overlay fixture. genoa stays the recommended/displayed rig by default.
function makeBothRigsPlan(): Plan {
  const base = makePlan();
  return {
    ...base,
    result: {
      ...base.result,
      sails: base.result.sails.map((s) =>
        s.sailId === 'fock'
          ? {
              sailId: 'fock' as const,
              result: {
                sailId: 'fock' as const,
                legs: [FOCK_LEG],
                etaMs: ETA_MS + 60_000,
                durationMs: 3_660_000,
                distanceNm: 10,
                maneuverCount: 0,
                motorDistanceNm: 0,
              },
              reason: null,
            }
          : s,
      ),
    },
  };
}

// PR #384 review: both rigs solve, but genoa — the rig the test then asks
// RouteLayer to display as PRIMARY — is the one WITHOUT a route; fock is the
// only one that found one. Models RouteSummary's rig tabs being ungated:
// nothing stops a user from selecting a rig whose own result never solved
// while the complement did.
function makeOtherRigOnlyPlan(): Plan {
  const base = makeBothRigsPlan();
  return {
    ...base,
    result: {
      ...base.result,
      sails: base.result.sails.map((s) =>
        s.sailId === 'genoa'
          ? { sailId: 'genoa' as const, result: null, reason: 'calm-motor-off' as const }
          : s,
      ),
      recommended: 'fock',
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

function renderRouteLayerWithPlan(
  map: ReturnType<typeof makeFakeMap>,
  plan: Plan,
  rig: 'genoa' | 'fock' = 'genoa',
) {
  hoisted.map = map;
  return render(
    <RouteLayer
      plan={plan}
      rig={rig}
      activeLegIndex={null}
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

// #378: waypoint ETAs disappearing at some zooms, and ETA/speed text being
// too small. The behavior itself (MapLibre collision/placement) can only be
// exercised against a real browser (see app/e2e/annotations.spec.ts's #378
// test) — jsdom has no MapLibre runtime — but the LAYER SPEC these fixes
// depend on is plain data the fake map records verbatim from addLayer's
// argument, so pinning it here catches an accidental revert (e.g. back to a
// flat text-size:11, or losing icon-ignore-placement) at unit-test speed
// instead of only via the slower e2e symptom.
describe('RouteLayer annotation layer spec (#378)', () => {
  it('sizes ETA/speed text with a zoom interpolation, not a flat literal', () => {
    const map = makeFakeMap();
    renderRouteLayer(map, null);
    for (const id of ['sc-eta-primary', 'sc-eta-secondary', 'sc-leg-speed']) {
      const textSize = map.layers.get(id)?.layout?.['text-size'];
      expect(Array.isArray(textSize), `${id}'s text-size`).toBe(true);
      expect((textSize as unknown[])[0]).toBe('interpolate');
    }
  });

  it('gives the ETA layers placement fallbacks via text-variable-anchor', () => {
    const map = makeFakeMap();
    renderRouteLayer(map, null);
    for (const id of ['sc-eta-primary', 'sc-eta-secondary']) {
      const layout = map.layers.get(id)?.layout;
      expect(layout?.['text-variable-anchor']).toEqual(['left', 'right', 'top', 'bottom']);
      // text-variable-anchor is incompatible with text-anchor/text-offset in
      // the MapLibre style spec — text-radial-offset is the replacement.
      expect(layout?.['text-anchor']).toBeUndefined();
      expect(layout?.['text-offset']).toBeUndefined();
      expect(layout?.['text-radial-offset']).toBe(0.9);
    }
  });

  it('exempts the dense wind-barb layer from blocking other symbols (icon-ignore-placement)', () => {
    const map = makeFakeMap();
    renderRouteLayer(map, null);
    const layout = map.layers.get('sc-wind-barbs')?.layout;
    // icon-allow-overlap alone only protects barbs FROM being culled; without
    // icon-ignore-placement barbs still occupy the collision index and cull
    // the ETA/speed text layers beneath them — the actual #378 root cause.
    expect(layout?.['icon-allow-overlap']).toBe(true);
    expect(layout?.['icon-ignore-placement']).toBe(true);
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

// #324: "show both foresail routes" — a map-only overlay of the rig NOT
// currently displayed as the primary route, default OFF, distinguished by
// dash pattern + reduced opacity rather than a new colour (colour already
// carries sail/motor + port/starboard meaning). The overlay must never add a
// symbol/label layer (that would reopen #378's collision-index fragility),
// so these tests pin the LINE layer spec and its explicit beforeId anchor —
// the behavior itself (whether the dashed line is legible against the real
// basemap) is a real-browser concern, per this file's own "Not unit-tested"
// header for MapLibre rendering.
describe('RouteLayer alt-rig overlay (#324)', () => {
  it('creates the alt-rig source/layers hidden by default, with an unchecked, enabled toggle', () => {
    const map = makeFakeMap();
    renderRouteLayerWithPlan(map, makeBothRigsPlan());
    expect(map.sources.has('sc-route-alt')).toBe(true);
    expect(map.layers.get('sc-route-alt-sail')?.layout?.visibility).toBe('none');
    expect(map.layers.get('sc-route-alt-motor')?.layout?.visibility).toBe('none');
    const toggle = screen.getByRole('checkbox', { name: 'Anderes Rigg anzeigen' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
  });

  it('disables the toggle, explains why via an aria-describedby note, and leaves the alt source empty when only one rig has a route', () => {
    const map = makeFakeMap();
    // makePlan() (used by renderRouteLayer) has fock: null.
    renderRouteLayer(map, null);
    const toggle = screen.getByRole('checkbox', { name: 'Anderes Rigg anzeigen' });
    expect(toggle).toBeDisabled();
    // A `title` attribute is hover-only (unreachable on touch, this app's
    // primary context) — the explanation must be a real, visible, wired-up
    // note instead.
    const note = screen.getByText('Nur ein Rigg hat eine Route gefunden');
    expect(toggle).toHaveAttribute('aria-describedby', note.id);
    expect(sourceData(map, 'sc-route-alt').features).toHaveLength(0);
  });

  // PR #384 review (r3713944428): pre-fix, `disabled={!altResult}` only
  // checked the OTHER rig's result — so selecting a PRIMARY rig with no
  // route of its own (genoa here, via RouteSummary's ungated tabs) left the
  // toggle enabled, because the complement (fock) is what backs `altResult`.
  it('disables the toggle and explains why when the PRIMARY rig has no route, even though the other rig does', () => {
    const map = makeFakeMap();
    renderRouteLayerWithPlan(map, makeOtherRigOnlyPlan(), 'genoa');
    const toggle = screen.getByRole('checkbox', { name: 'Anderes Rigg anzeigen' });
    expect(toggle).toBeDisabled();
    const note = screen.getByText('Nur ein Rigg hat eine Route gefunden');
    expect(toggle).toHaveAttribute('aria-describedby', note.id);
  });

  // PR #384 review: `disabled` alone does not retract an ALREADY-visible
  // overlay — altRigVisible is a persisted toggle (usePersistedToggle)
  // independent of which rig is primary. Pre-fix, the layer-visibility
  // effect keyed on `altRigVisible` alone, so a toggle left ON from an
  // earlier, both-rigs-solved plan would still paint the overlay here —
  // meaning the ONLY real route (fock's) would render as the dashed,
  // reduced-opacity "other rig" track, with the primary source empty and
  // nothing solid on the map at all (the composition inversion the review
  // flagged). Asserting layer visibility, not just the checkbox, is what
  // makes this test fail against the pre-fix `disabled={!altResult}` code —
  // that change alone never touches the visibility effect.
  it('hides an already-toggled-on overlay, not just disables the checkbox, once the PRIMARY rig has no route', () => {
    localStorage.setItem('sc-alt-rig-visible', '1');
    const map = makeFakeMap();
    renderRouteLayerWithPlan(map, makeOtherRigOnlyPlan(), 'genoa');
    expect(map.layers.get('sc-route-alt-sail')?.layout?.visibility).toBe('none');
    expect(map.layers.get('sc-route-alt-motor')?.layout?.visibility).toBe('none');
    // Confirms the primary route really is empty in this state — hiding the
    // overlay leaves nothing, which is strictly better than the pre-fix
    // "only the de-emphasised track renders" bug.
    expect(sourceData(map, 'sc-route').features).toHaveLength(0);
  });

  it('enables the toggle with no unavailable note when both rigs have a route', () => {
    const map = makeFakeMap();
    renderRouteLayerWithPlan(map, makeBothRigsPlan());
    const toggle = screen.getByRole('checkbox', { name: 'Anderes Rigg anzeigen' });
    expect(toggle).toBeEnabled();
    expect(toggle).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Nur ein Rigg hat eine Route gefunden')).not.toBeInTheDocument();
  });

  it('reveals the layer and paints the OTHER rig — not the primary route — when toggled on', () => {
    const map = makeFakeMap();
    renderRouteLayerWithPlan(map, makeBothRigsPlan());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Anderes Rigg anzeigen' }));
    expect(map.layers.get('sc-route-alt-sail')?.layout?.visibility).toBe('visible');
    expect(map.layers.get('sc-route-alt-motor')?.layout?.visibility).toBe('visible');
    // The primary genoa track is untouched.
    expect(
      (sourceData(map, 'sc-route').features[0].geometry as GeoJSON.LineString).coordinates,
    ).toEqual([
      [10.0, 54.75],
      [10.4, 54.75],
    ]);
    // The overlay carries the OTHER rig's (fock's) distinct geometry.
    const alt = sourceData(map, 'sc-route-alt');
    expect(alt.features).toHaveLength(1);
    expect((alt.features[0].geometry as GeoJSON.LineString).coordinates).toEqual([
      [10.0, 54.8],
      [10.4, 54.8],
    ]);
  });

  it('distinguishes the overlay by dash pattern + reduced opacity, not a new colour', () => {
    const map = makeFakeMap();
    renderRouteLayerWithPlan(map, makeBothRigsPlan());
    const altSail = map.layers.get('sc-route-alt-sail');
    const altMotor = map.layers.get('sc-route-alt-motor');
    // Dashed: present at all (the primary sail line has NO dasharray), and
    // distinct from the primary motor line's [2, 1.5] dash so the overlay
    // reads as "the other rig", not "a motor leg".
    expect(map.layers.get('sc-route-sail')?.paint?.['line-dasharray']).toBeUndefined();
    expect(map.layers.get('sc-route-motor')?.paint?.['line-dasharray']).toEqual([2, 1.5]);
    expect(altSail?.paint?.['line-dasharray']).toEqual([1, 1.5]);
    expect(altMotor?.paint?.['line-dasharray']).toEqual([1, 1.5]);
    // Reduced opacity: the primary route paints at full (default/unset)
    // opacity, the overlay explicitly below it.
    expect(map.layers.get('sc-route-sail')?.paint?.['line-opacity']).toBeUndefined();
    expect(map.layers.get('sc-route-motor')?.paint?.['line-opacity']).toBeUndefined();
    expect(altSail?.paint?.['line-opacity']).toBe(0.45);
    expect(altMotor?.paint?.['line-opacity']).toBe(0.45);
    // Colour: the SAME board/motor vocabulary as the primary route, not a
    // new hue — issue #324 itself names colour as already carrying meaning.
    // Pinned as a literal (not "equals whatever sc-route-sail has today") so a
    // colour regression in EITHER layer still fails this — comparing the two
    // layers to each other would pass if both were changed to the same new
    // (wrong) hue.
    const boardColorExpr = ['case', ['==', ['get', 'board'], 'port'], '#D55E00', '#009E73'];
    expect(altSail?.paint?.['line-color']).toEqual(boardColorExpr);
    expect(map.layers.get('sc-route-sail')?.paint?.['line-color']).toEqual(boardColorExpr);
    expect(altMotor?.paint?.['line-color']).toBe('#5b5b5b');
  });

  it('anchors below HIGHLIGHT_LAYER with an explicit beforeId, so the recommendation paints on top', () => {
    const map = makeFakeMap();
    renderRouteLayerWithPlan(map, makeBothRigsPlan());
    expect(map.layers.get('sc-route-alt-sail')?.beforeId).toBe(HIGHLIGHT_LAYER);
    expect(map.layers.get('sc-route-alt-motor')?.beforeId).toBe(HIGHLIGHT_LAYER);
    const order = map.layerOrder;
    const idx = (id: string) => order.indexOf(id);
    expect(idx(ROUTE_STACK_BOTTOM_LAYER)).toBeGreaterThanOrEqual(0);
    // Bottom -> top: shallow casing, alt overlay, highlight, primary sail/motor.
    expect(idx(ROUTE_STACK_BOTTOM_LAYER)).toBeLessThan(idx('sc-route-alt-sail'));
    expect(idx('sc-route-alt-sail')).toBeLessThan(idx(HIGHLIGHT_LAYER));
    expect(idx('sc-route-alt-motor')).toBeLessThan(idx(HIGHLIGHT_LAYER));
    expect(idx(HIGHLIGHT_LAYER)).toBeLessThan(idx('sc-route-sail'));
    expect(idx(HIGHLIGHT_LAYER)).toBeLessThan(idx('sc-route-motor'));
  });
});

describe('RouteLayer style reload (#153)', () => {
  it('re-adds all sources/layers and repaints the CURRENT plan data', () => {
    const map = makeFakeMap();
    renderRouteLayer(map, null);
    act(() => {
      simulateStyleReload(map);
    });
    for (const id of ['sc-route', 'sc-route-alt', 'sc-maneuvers', 'sc-barbs']) {
      expect(map.sources.has(id)).toBe(true);
    }
    for (const id of [
      ROUTE_STACK_BOTTOM_LAYER,
      HIGHLIGHT_LAYER,
      'sc-route-alt-sail',
      'sc-route-alt-motor',
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

  // #324: mirrors the wind-barbs ON-by-default case above, but for a
  // toggle whose DEFAULT is off — the re-created layer must still pick up
  // an explicit persisted ON choice, not just fall back to the (matching,
  // here) default.
  it('re-applies a persisted ON alt-rig visibility state after a reload', () => {
    localStorage.setItem('sc-alt-rig-visible', '1');
    const map = makeFakeMap();
    renderRouteLayerWithPlan(map, makeBothRigsPlan());
    act(() => {
      simulateStyleReload(map);
    });
    expect(map.layers.get('sc-route-alt-sail')?.layout?.visibility).toBe('visible');
    expect(map.layers.get('sc-route-alt-motor')?.layout?.visibility).toBe('visible');
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
