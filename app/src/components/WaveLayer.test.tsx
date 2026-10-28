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
import { NavMask } from '../lib/mask';
import { depthSourceCorners } from '../lib/depthColor';
import {
  paintSeaState,
  seaStateMarkers,
  seaStateRasterIndex,
  seaStateRasterSize,
  WAVE_ARROW_IMAGE,
  WAVE_ARROW_LAYER,
  WAVE_ARROW_SOURCE,
  WAVE_DOT_IMAGE,
  WAVE_FILL_LAYER,
  WAVE_FILL_OPACITY,
  WAVE_RASTER_SOURCE,
} from '../lib/waveMap';
import type { MaskMeta, WaveGrid } from '../types';

interface RecordedPopup {
  className: string | undefined;
  content: HTMLElement | null;
  added: boolean;
  removed: boolean;
}

const hoisted = vi.hoisted(() => ({
  map: null as unknown,
  popups: [] as unknown[],
  ops: [] as string[],
  puts: [] as Uint8ClampedArray[],
}));

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

// 0.01° cells over makeWaveGrid's default lattice (lats 54.5–54.7, lons
// 10.0–10.1), fine enough that the quarter-resolution raster has pixels in
// every lattice cell.
const META: MaskMeta = { south: 54.45, north: 54.75, west: 9.95, east: 10.15, rows: 30, cols: 20 };
const RASTER = seaStateRasterSize(META);

function mask(byteAt: (lat: number, lon: number) => number = () => 50): NavMask {
  const data = new Uint8Array(META.rows * META.cols);
  for (let r = 0; r < META.rows; r++)
    for (let c = 0; c < META.cols; c++)
      data[r * META.cols + c] = byteAt(META.south + (r + 0.5) * 0.01, META.west + (c + 0.5) * 0.01);
  return new NavMask(META, data);
}
const WATER = mask();

// jsdom has no 2D context (test/setup.ts answers null); answer for the wave
// raster's own size only, and record what is painted.
HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement): unknown {
  if (this.width !== RASTER.width || this.height !== RASTER.height) return null;
  return {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img: { data: Uint8ClampedArray }) => {
      hoisted.ops.push('put');
      hoisted.puts.push(img.data.slice());
    },
    clearRect: () => hoisted.ops.push('clear'),
  };
}) as unknown as HTMLCanvasElement['getContext'];

const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);
const HOUR = 3_600_000;

type FakeMap = ReturnType<typeof makeFakeMap>;
type QueryFn = (point: unknown, opts: { layers: string[] }) => unknown[];

// The fake's sources gain the CanvasSource play/pause pair.
function waveMap(query: QueryFn = () => [], opts?: { styleLoaded?: boolean }) {
  const map = Object.assign(makeFakeMap(opts), { queryRenderedFeatures: vi.fn(query) });
  const addSource = map.addSource;
  map.addSource = vi.fn((id: string, def: Parameters<typeof addSource>[1]) => {
    addSource(id, def);
    Object.assign(map.sources.get(id)!, {
      play: () => hoisted.ops.push('play'),
      pause: () => hoisted.ops.push('pause'),
    });
  }) as typeof addSource;
  return map;
}

// Point (0,0) calm, (0,1) no-data Hs, (1,0) rough with no direction, rest slight.
function grid(): WaveGrid {
  return makeWaveGrid((la, lo, t) => {
    if (la === 0 && lo === 0) return { heightM: 0.05, periodS: 3, dirFromDeg: 270 + t };
    if (la === 0 && lo === 1) return { heightM: NaN, periodS: NaN, dirFromDeg: NaN };
    if (la === 1 && lo === 0) return { heightM: 3, periodS: 7.6, dirFromDeg: NaN };
    return { heightM: 0.8, periodS: 4.4, dirFromDeg: 10 };
  });
}

function renderWaves(
  map: FakeMap,
  props: Partial<{
    grid: WaveGrid | undefined;
    tMs: number;
    visible: boolean;
    armed: boolean;
    mask: NavMask | null;
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
        mask={'mask' in p ? (p.mask ?? null) : WATER}
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

function expectedPaint(g: WaveGrid, m: NavMask, hourIdx: number): Uint8ClampedArray {
  const raster = seaStateRasterIndex(m, g);
  const out = new Uint8ClampedArray(raster.width * raster.height * 4);
  paintSeaState(raster, g, hourIdx, out);
  return out;
}

// MapLibre's map-level click: the raster is not queryable.
function click(map: FakeMap, lngLat: { lat: number; lng: number }, target?: EventTarget) {
  const handlers = map.on.mock.calls.filter((c) => c[0] === 'click' && typeof c[1] === 'function');
  const handler = handlers.at(-1)?.[1] as ((e: unknown) => void) | undefined;
  act(() => {
    handler?.({
      point: { x: 10, y: 10 },
      lngLat,
      ...(target !== undefined ? { originalEvent: { target } } : {}),
    });
  });
}

const SLIGHT = { lat: 54.7, lng: 10.0 };
const NO_DATA = { lat: 54.5, lng: 10.1 };
const NO_DIRECTION = { lat: 54.6, lng: 10.0 };

beforeEach(() => {
  hoisted.popups.length = 0;
  hoisted.ops.length = 0;
  hoisted.puts.length = 0;
  localStorage.setItem('sc-lang', 'en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('WaveLayer setup (#1699, #1854)', () => {
  it('adds no source, layer or image for a plan without a wave grid', () => {
    const map = waveMap();
    renderWaves(map, { grid: undefined });
    expect(map.sources.has(WAVE_RASTER_SOURCE)).toBe(false);
    expect(map.layers.has(WAVE_FILL_LAYER)).toBe(false);
    expect(map.images.has(WAVE_ARROW_IMAGE)).toBe(false);
  });

  it('creates nothing until the mask loads, whose bbox places the raster', () => {
    const map = waveMap();
    const g = grid();
    const { rerenderWith } = renderWaves(map, { grid: g, mask: null });
    expect(map.layers.has(WAVE_FILL_LAYER)).toBe(false);
    rerenderWith({ grid: g, mask: WATER });
    expect(map.layerOrder).toEqual([WAVE_FILL_LAYER, WAVE_ARROW_LAYER]);
  });

  it('adds a water-clipped raster fill and one marker layer outside the collision index', () => {
    const map = waveMap();
    renderWaves(map);
    expect(map.layerOrder).toEqual([WAVE_FILL_LAYER, WAVE_ARROW_LAYER]);
    const source = map.sources.get(WAVE_RASTER_SOURCE)!.def;
    expect(source).toMatchObject({
      type: 'canvas',
      animate: false,
      coordinates: depthSourceCorners(META),
    });
    const canvas = source.canvas as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([RASTER.width, RASTER.height]);
    const fill = map.layers.get(WAVE_FILL_LAYER);
    expect(fill).toMatchObject({ type: 'raster', source: WAVE_RASTER_SOURCE });
    expect(fill?.paint).toMatchObject({
      'raster-opacity': WAVE_FILL_OPACITY,
      'raster-resampling': 'nearest',
    });
    expect(map.images.has(WAVE_ARROW_IMAGE)).toBe(true);
    expect(map.images.has(WAVE_DOT_IMAGE)).toBe(true);
    expect(map.layers.get(WAVE_ARROW_LAYER)?.layout).toMatchObject({
      'icon-image': ['match', ['get', 'marker'], 'dot', WAVE_DOT_IMAGE, WAVE_ARROW_IMAGE],
      'icon-rotate': ['get', 'rotateDeg'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    });
    expect(map.layers.has('sc-waves-edge')).toBe(false);
  });

  it('paints the raster for the hour, then uploads it once', () => {
    const map = waveMap();
    const g = grid();
    renderWaves(map, { grid: g });
    expect(hoisted.ops).toEqual(['put', 'play', 'pause']);
    expect(hoisted.puts[0]).toEqual(expectedPaint(g, WATER, 0));
    expect(hoisted.puts[0]!.some((v) => v > 0)).toBe(true);
  });

  it('puts one marker on each shaded cell: an arrow, or a dot without a direction', () => {
    const map = waveMap();
    const g = grid();
    renderWaves(map, { grid: g });
    const raster = seaStateRasterIndex(WATER, g);
    expect(lastData(map, WAVE_ARROW_SOURCE)).toEqual(seaStateMarkers(raster, g, 0));
    // 3 x 2 grid, one no-data point; (1,0) has no direction.
    expect(lastData(map, WAVE_ARROW_SOURCE).features.map((f) => f.properties?.marker)).toEqual([
      'arrow',
      'dot',
      'arrow',
      'arrow',
      'arrow',
    ]);
  });

  it('samples by time: repaints and re-points arrows on an hour change', () => {
    const map = waveMap();
    const g = grid();
    const { rerenderWith } = renderWaves(map, { grid: g, tMs: T0 });
    const rot = () =>
      lastData(map, WAVE_ARROW_SOURCE).features.find(
        (f) => (f.geometry as GeoJSON.Point).coordinates.join() === '10,54.5',
      )?.properties?.rotateDeg;
    expect(rot()).toBe(90);
    rerenderWith({ grid: g, tMs: T0 + 10 * 60_000 });
    expect(hoisted.ops.filter((o) => o === 'put')).toHaveLength(1);
    rerenderWith({ grid: g, tMs: T0 + 2 * HOUR });
    expect(rot()).toBe(92);
    expect(hoisted.ops.filter((o) => o === 'put')).toHaveLength(2);
  });

  it('renders nothing outside the wave grid time axis', () => {
    const map = waveMap();
    renderWaves(map, { tMs: T0 + 30 * HOUR });
    expect(lastData(map, WAVE_ARROW_SOURCE).features).toHaveLength(0);
    expect(hoisted.ops).toEqual(['clear', 'play', 'pause']);
  });

  it('follows the toggle, paints only while shown, and repaints after a style reload', () => {
    const map = waveMap();
    const g = grid();
    const { rerenderWith } = renderWaves(map, { grid: g, visible: true });
    expect(map.layers.get(WAVE_FILL_LAYER)?.layout?.visibility).toBe('visible');
    expect(map.layers.get(WAVE_ARROW_LAYER)?.layout?.visibility).toBe('visible');
    rerenderWith({ grid: g, visible: false });
    expect(map.layers.get(WAVE_FILL_LAYER)?.layout?.visibility).toBe('none');
    expect(map.layers.get(WAVE_ARROW_LAYER)?.layout?.visibility).toBe('none');
    rerenderWith({ grid: g, visible: false, tMs: T0 + HOUR });
    expect(hoisted.ops.filter((o) => o === 'put')).toHaveLength(1);
    rerenderWith({ grid: g, visible: true, tMs: T0 + HOUR });
    expect(hoisted.ops.filter((o) => o === 'put')).toHaveLength(2);
    act(() => simulateStyleReload(map));
    expect(map.layers.get(WAVE_FILL_LAYER)?.layout?.visibility).toBe('visible');
    expect(hoisted.ops.filter((o) => o === 'put')).toHaveLength(3);
    expect(hoisted.puts.at(-1)).toEqual(expectedPaint(g, WATER, 1));
  });

  // A setup deferred by a still-loading style runs from 'styledata', and its
  // own addImage fires 'styledata' again before it returns. The duplicate
  // addSource then threw; from inside another component's effect that
  // unmounted the whole app on a reload that restored a wave plan.
  it('survives setup re-entering through its own addImage', () => {
    const map = waveMap(undefined, { styleLoaded: false });
    renderWaves(map);
    expect(() => act(() => map.fire('styledata'))).not.toThrow();
    expect(map.layerOrder).toEqual([WAVE_FILL_LAYER, WAVE_ARROW_LAYER]);
    expect(lastData(map, WAVE_ARROW_SOURCE).features).toHaveLength(5);
  });

  it('survives the same re-entry on a style reload', () => {
    const map = waveMap();
    renderWaves(map);
    expect(() => act(() => simulateStyleReload(map))).not.toThrow();
    expect(map.layerOrder).toEqual([WAVE_FILL_LAYER, WAVE_ARROW_LAYER]);
    expect(lastData(map, WAVE_ARROW_SOURCE).features).toHaveLength(5);
  });

  it('hides and empties the layers when the plan loses its grid', () => {
    const map = waveMap();
    const { rerenderWith } = renderWaves(map);
    rerenderWith({ grid: undefined });
    expect(map.layers.get(WAVE_FILL_LAYER)?.layout?.visibility).toBe('none');
    expect(lastData(map, WAVE_ARROW_SOURCE).features).toHaveLength(0);
  });

  it('leaves the layers in place, emptied, on unmount', () => {
    const map = waveMap();
    const { unmount } = renderWaves(map);
    hoisted.ops.length = 0;
    unmount();
    expect(map.layers.has(WAVE_FILL_LAYER)).toBe(true);
    expect(hoisted.ops).toEqual(['clear', 'play', 'pause']);
    expect(lastData(map, WAVE_ARROW_SOURCE).features).toHaveLength(0);
  });
});

// The pixel rule itself is pinned in waveMap.test.ts; this pins the wiring.
describe('WaveLayer land clipping (#1854)', () => {
  it('gives a land point no marker, whatever its Hs', () => {
    const coast = (lat: number, lon: number) => (lon > 10.08 && lat > 54.55 ? 0 : 50);
    const map = waveMap();
    renderWaves(map, { grid: grid(), mask: mask(coast) });
    const coords = lastData(map, WAVE_ARROW_SOURCE).features.map((f) =>
      (f.geometry as GeoJSON.Point).coordinates.join(),
    );
    expect(coords).not.toContain('10.1,54.7');
    expect(coords).toContain('10,54.7');
  });
});

describe('WaveLayer tap popup (#1699, #1854)', () => {
  const text = () => (hoisted.popups.at(-1) as RecordedPopup | undefined)?.content?.textContent;

  it('opens on a shaded pixel with height, band, period and travel direction', () => {
    const map = waveMap();
    renderWaves(map);
    click(map, SLIGHT);
    const popup = hoisted.popups.at(-1) as RecordedPopup;
    expect(popup.className).toBe('wave-popup');
    expect(popup.added).toBe(true);
    expect(text()).toContain('Significant wave height: 0.8 m');
    expect(text()).toContain('Sea-state category: slight');
    expect(text()).toContain('Wave period: 4 s');
    expect(text()).toContain('Travel direction: 190°');
  });

  it('stays shut on a no-data cell, on land and outside the raster', () => {
    const map = waveMap();
    renderWaves(map, { mask: mask((lat, lon) => (lon > 10.08 && lat > 54.65 ? 0 : 50)) });
    click(map, NO_DATA);
    click(map, { lat: 54.72, lng: 10.13 });
    click(map, { lat: 54.4, lng: 10.0 });
    expect(hoisted.popups).toHaveLength(0);
    // Positive control: the same map opens on a shaded pixel.
    click(map, SLIGHT);
    expect(hoisted.popups).toHaveLength(1);
  });

  it('reads a missing direction as no data', () => {
    const map = waveMap();
    renderWaves(map);
    click(map, NO_DIRECTION);
    expect(text()).toContain('Wave period: 8 s');
    expect(text()).toContain('Travel direction: no data');
  });

  // R2-4: truncated, so the printed height never names the next band up.
  it.each([
    [2.46, '2.46 m', 'moderate'],
    [2.5, '2.5 m', 'rough'],
    [2.499, '2.49 m', 'moderate'],
  ] as const)('prints %s m as %s beside its %s band', (heightM, shown, band) => {
    const map = waveMap();
    renderWaves(map, { grid: makeWaveGrid(() => ({ heightM, periodS: 4, dirFromDeg: 0 })) });
    click(map, SLIGHT);
    expect(text()).toContain(`Significant wave height: ${shown}`);
    expect(text()).toContain(`Sea-state category: ${band}`);
  });

  // R2-7: MapLibre delivers a click on a DOM marker to the map below it.
  it('yields a tap that landed on a DOM marker, and opens for one beside it', () => {
    const map = waveMap();
    renderWaves(map);
    const marker = document.createElement('div');
    marker.className = 'maplibregl-marker';
    const dot = document.createElement('span');
    marker.append(dot);
    click(map, SLIGHT, dot);
    expect(hoisted.popups).toHaveLength(0);
    click(map, SLIGHT, document.createElement('canvas'));
    expect(hoisted.popups).toHaveLength(1);
  });

  it('yields the tap while a map pick is armed', () => {
    const map = waveMap();
    renderWaves(map, { armed: true });
    click(map, SLIGHT);
    expect(hoisted.popups).toHaveLength(0);
  });

  it('stays shut while the sea state is hidden', () => {
    const map = waveMap();
    renderWaves(map, { visible: false });
    click(map, SLIGHT);
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
    const map = waveMap((_p, opts) => (opts.layers.includes(other) ? [{ id: 1 }] : []));
    map.addLayer({ id: other, type: 'symbol' });
    renderWaves(map);
    click(map, SLIGHT);
    expect(hoisted.popups).toHaveLength(0);
  });

  it('opens when the other interactive layers exist but have nothing under the tap', () => {
    const map = waveMap(() => []);
    map.addLayer({ id: SEAMARKS_LAYER, type: 'symbol' });
    renderWaves(map);
    click(map, SLIGHT);
    expect(hoisted.popups).toHaveLength(1);
    expect(map.queryRenderedFeatures).toHaveBeenCalledWith(
      { x: 10, y: 10 },
      { layers: [SEAMARKS_LAYER] },
    );
  });

  it('closes an open popup when the slider hour changes', () => {
    const map = waveMap();
    const g = grid();
    const { rerenderWith } = renderWaves(map, { grid: g, tMs: T0 });
    click(map, SLIGHT);
    rerenderWith({ grid: g, tMs: T0 + HOUR });
    expect((hoisted.popups[0] as RecordedPopup).removed).toBe(true);
  });
});
