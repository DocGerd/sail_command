import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WaveLayer from './WaveLayer';
import { HARBOR_CIRCLE_LAYER, SEAMARKS_HAZARD_LAYER, SEAMARKS_LAYER } from './DataLayers';
import { SAVED_WAYPOINT_LAYER } from './SavedWaypointsLayer';
import { AIS_VESSEL_LAYER } from './AisLayer';
import { ROUTE_HIT_LAYER } from './RouteLayer';
import { I18nProvider } from '../i18n';
import { makeFakeMap, simulateStyleReload } from '../test/fakeMaplibre';
import { makeWaveGrid } from '../test/waveFixtures';
import {
  WAVE_ARROW_IMAGE,
  WAVE_ARROW_LAYER,
  WAVE_ARROW_SOURCE,
  WAVE_CELL_SOURCE,
  WAVE_FILL_LAYER,
} from '../lib/waveMap';
import type { WaveGrid } from '../types';

interface RecordedPopup {
  className: string | undefined;
  content: HTMLElement | null;
  added: boolean;
  removed: boolean;
}

const hoisted = vi.hoisted(() => ({ map: null as unknown, popups: [] as unknown[] }));

vi.mock('maplibre-gl', () => ({
  Popup: class {
    className: string | undefined;
    content: HTMLElement | null = null;
    added = false;
    removed = false;
    constructor(opts?: { className?: string }) {
      this.className = opts?.className;
      hoisted.popups.push(this);
    }
    setLngLat() {
      return this;
    }
    setDOMContent(el: HTMLElement) {
      this.content = el;
      return this;
    }
    addTo() {
      this.added = true;
      return this;
    }
    remove() {
      this.removed = true;
    }
  },
}));
vi.mock('./MapView', () => ({ useMapInstance: () => hoisted.map }));

const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);
const HOUR = 3_600_000;

type FakeMap = ReturnType<typeof makeFakeMap>;
type QueryFn = (point: unknown, opts: { layers: string[] }) => unknown[];

function mapWithQuery(impl: QueryFn = () => []): FakeMap & {
  queryRenderedFeatures: ReturnType<typeof vi.fn>;
} {
  return Object.assign(makeFakeMap(), { queryRenderedFeatures: vi.fn(impl) });
}

// Point (0,0) calm, (0,1) no-data Hs, (1,0) rough with no direction, rest slight.
function grid(): WaveGrid {
  return makeWaveGrid((la, lo, t) => {
    if (la === 0 && lo === 0) return { heightM: 0.05, periodS: 3, dirFromDeg: 270 + t };
    if (la === 0 && lo === 1) return { heightM: NaN, periodS: NaN, dirFromDeg: NaN };
    if (la === 1 && lo === 0) return { heightM: 3, periodS: 7.6, dirFromDeg: NaN };
    return { heightM: 0.8, periodS: 4, dirFromDeg: 10 };
  });
}

function renderWaves(
  map: FakeMap,
  props: Partial<{
    grid: WaveGrid | undefined;
    tMs: number;
    visible: boolean;
    armed: boolean;
  }> = {},
) {
  hoisted.map = map;
  const el = (p: typeof props) => (
    <I18nProvider>
      <WaveLayer
        grid={'grid' in p ? p.grid : grid()}
        tMs={p.tMs ?? T0}
        visible={p.visible ?? true}
        mapPickArmed={p.armed ?? false}
      />
    </I18nProvider>
  );
  const r = render(el(props));
  return { ...r, rerenderWith: (p: typeof props) => r.rerender(el(p)) };
}

function lastData(map: FakeMap, id: string): GeoJSON.FeatureCollection {
  const src = map.sources.get(id);
  if (!src) throw new Error(`source ${id} not added`);
  const calls = src.setData.mock.calls;
  return (calls.length ? calls[calls.length - 1]![0] : src.def.data) as GeoJSON.FeatureCollection;
}

function click(map: FakeMap, props: Record<string, unknown>, target?: EventTarget) {
  act(() => {
    map.fireLayerEvent('click', WAVE_FILL_LAYER, {
      point: { x: 10, y: 10 },
      lngLat: { lng: 10, lat: 54.5 },
      features: [{ properties: props }],
      ...(target !== undefined ? { originalEvent: { target } } : {}),
    });
  });
}

const CELL = { band: 'slight', heightM: 0.8, periodS: 4.4, travelDeg: 190 };

beforeEach(() => {
  hoisted.popups.length = 0;
  localStorage.setItem('sc-lang', 'en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('WaveLayer setup (#1699)', () => {
  it('adds no source, layer or image for a plan without a wave grid', () => {
    const map = makeFakeMap();
    renderWaves(map, { grid: undefined });
    expect(map.sources.has(WAVE_CELL_SOURCE)).toBe(false);
    expect(map.layers.has(WAVE_FILL_LAYER)).toBe(false);
    expect(map.images.has(WAVE_ARROW_IMAGE)).toBe(false);
  });

  it('adds the fill and an arrow symbol layer that never enters the collision index', () => {
    const map = makeFakeMap();
    renderWaves(map);
    expect(map.images.has(WAVE_ARROW_IMAGE)).toBe(true);
    expect(map.layers.get(WAVE_FILL_LAYER)?.type).toBe('fill');
    const arrows = map.layers.get(WAVE_ARROW_LAYER);
    expect(arrows?.type).toBe('symbol');
    expect(arrows?.layout).toMatchObject({
      'icon-image': WAVE_ARROW_IMAGE,
      'icon-rotate': ['get', 'rotateDeg'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    });
    expect(arrows?.layout?.['text-field']).toBeUndefined();
    expect(map.layerOrder).toEqual([WAVE_FILL_LAYER, WAVE_ARROW_LAYER]);
  });

  it('paints a no-data point as no cell at all, never as calm', () => {
    const map = makeFakeMap();
    renderWaves(map);
    const cells = lastData(map, WAVE_CELL_SOURCE).features;
    // 3 x 2 grid, one no-data point.
    expect(cells).toHaveLength(5);
    expect(cells.map((f) => f.properties?.band).sort()).toEqual([
      'calm',
      'rough',
      'slight',
      'slight',
      'slight',
    ]);
    const centres = cells.map((f) => {
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0]!;
      return [(ring[0]![0]! + ring[1]![0]!) / 2, (ring[0]![1]! + ring[2]![1]!) / 2].map((v) =>
        v.toFixed(2),
      );
    });
    expect(centres).not.toContainEqual(['10.10', '54.50']);
  });

  it('samples by time and points arrows the way the waves travel', () => {
    const map = makeFakeMap();
    const { rerenderWith } = renderWaves(map, { tMs: T0 });
    const rot = () =>
      lastData(map, WAVE_ARROW_SOURCE).features.find(
        (f) => (f.geometry as GeoJSON.Point).coordinates.join() === '10,54.5',
      )?.properties?.rotateDeg;
    expect(rot()).toBe(90);
    rerenderWith({ tMs: T0 + 2 * HOUR });
    expect(rot()).toBe(92);
    // No arrow where the direction is missing; the cell is still there.
    expect(lastData(map, WAVE_ARROW_SOURCE).features).toHaveLength(4);
  });

  it('renders nothing outside the wave grid time axis', () => {
    const map = makeFakeMap();
    renderWaves(map, { tMs: T0 + 30 * HOUR });
    expect(lastData(map, WAVE_CELL_SOURCE).features).toHaveLength(0);
    expect(lastData(map, WAVE_ARROW_SOURCE).features).toHaveLength(0);
  });

  it('follows the toggle and re-creates hidden-or-visible state after a style reload', () => {
    const map = makeFakeMap();
    const { rerenderWith } = renderWaves(map, { visible: true });
    expect(map.layers.get(WAVE_FILL_LAYER)?.layout?.visibility).toBe('visible');
    expect(map.layers.get(WAVE_ARROW_LAYER)?.layout?.visibility).toBe('visible');
    rerenderWith({ visible: false });
    expect(map.layers.get(WAVE_FILL_LAYER)?.layout?.visibility).toBe('none');
    rerenderWith({ visible: true });
    act(() => simulateStyleReload(map));
    expect(map.layers.get(WAVE_FILL_LAYER)?.layout?.visibility).toBe('visible');
    expect(lastData(map, WAVE_CELL_SOURCE).features).toHaveLength(5);
  });

  it('hides and empties the layers when the plan loses its grid', () => {
    const map = makeFakeMap();
    const { rerenderWith } = renderWaves(map);
    rerenderWith({ grid: undefined });
    expect(map.layers.get(WAVE_FILL_LAYER)?.layout?.visibility).toBe('none');
    expect(lastData(map, WAVE_CELL_SOURCE).features).toHaveLength(0);
  });
});

describe('WaveLayer tap popup (#1699)', () => {
  it('shows height, band, period and travel direction', () => {
    const map = mapWithQuery();
    renderWaves(map);
    click(map, CELL);
    const popup = hoisted.popups.at(-1) as RecordedPopup;
    expect(popup.className).toBe('wave-popup');
    expect(popup.added).toBe(true);
    const text = popup.content?.textContent ?? '';
    expect(text).toContain('Significant wave height: 0.8 m');
    expect(text).toContain('Sea-state category: slight');
    expect(text).toContain('Wave period: 4 s');
    expect(text).toContain('Travel direction: 190°');
  });

  it('reads missing period and direction as no data', () => {
    const map = mapWithQuery();
    renderWaves(map);
    click(map, { band: 'rough', heightM: 3 });
    const text = (hoisted.popups.at(-1) as RecordedPopup).content?.textContent ?? '';
    expect(text).toContain('Wave period: no data');
    expect(text).toContain('Travel direction: no data');
  });

  // R2-4: truncated, so the printed height never names the next band up.
  it.each([
    [2.46, '2.46 m', 'moderate'],
    [2.5, '2.5 m', 'rough'],
    [2.499, '2.49 m', 'moderate'],
  ] as const)('prints %s m as %s beside its %s band', (heightM, shown, band) => {
    const map = mapWithQuery();
    renderWaves(map);
    click(map, { band, heightM });
    const text = (hoisted.popups.at(-1) as RecordedPopup).content?.textContent ?? '';
    expect(text).toContain(`Significant wave height: ${shown}`);
    expect(text).toContain(`Sea-state category: ${band}`);
  });

  // R2-7: MapLibre delivers a click on a DOM marker to the layer below it.
  it('yields a tap that landed on a DOM marker, and opens for one beside it', () => {
    const map = mapWithQuery();
    renderWaves(map);
    const marker = document.createElement('div');
    marker.className = 'maplibregl-marker';
    const dot = document.createElement('span');
    marker.append(dot);
    click(map, CELL, dot);
    expect(hoisted.popups).toHaveLength(0);
    click(map, CELL, document.createElement('canvas'));
    expect(hoisted.popups).toHaveLength(1);
  });

  it('yields the tap while a map pick is armed', () => {
    const map = mapWithQuery();
    renderWaves(map, { armed: true });
    click(map, CELL);
    expect(hoisted.popups).toHaveLength(0);
  });

  it.each([
    HARBOR_CIRCLE_LAYER,
    SEAMARKS_LAYER,
    SEAMARKS_HAZARD_LAYER,
    AIS_VESSEL_LAYER,
    SAVED_WAYPOINT_LAYER,
    ROUTE_HIT_LAYER,
  ])('yields the tap to a feature on %s at the same point', (other) => {
    const map = mapWithQuery((_p, opts) => (opts.layers.includes(other) ? [{ id: 1 }] : []));
    map.addLayer({ id: other, type: 'symbol' });
    renderWaves(map);
    click(map, CELL);
    expect(hoisted.popups).toHaveLength(0);
  });

  it('opens when the other interactive layers exist but have nothing under the tap', () => {
    const map = mapWithQuery(() => []);
    map.addLayer({ id: SEAMARKS_LAYER, type: 'symbol' });
    renderWaves(map);
    click(map, CELL);
    expect(hoisted.popups).toHaveLength(1);
    expect(map.queryRenderedFeatures).toHaveBeenCalledWith(
      { x: 10, y: 10 },
      { layers: [SEAMARKS_LAYER] },
    );
  });

  it('closes an open popup when the slider hour changes', () => {
    const map = mapWithQuery();
    const { rerenderWith } = renderWaves(map, { tMs: T0 });
    click(map, CELL);
    rerenderWith({ tMs: T0 + HOUR });
    expect((hoisted.popups[0] as RecordedPopup).removed).toBe(true);
  });
});
