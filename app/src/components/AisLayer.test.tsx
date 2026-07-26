import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AisLayer, {
  AIS_LABEL_LAYER,
  AIS_SOURCE,
  AIS_VECTOR_LAYER,
  AIS_VESSEL_LAYER,
  ARROW_IMAGE,
  DOT_IMAGE,
  registerAisImages,
} from './AisLayer';
import { makeFakeMap, simulateStyleReload } from '../test/fakeMaplibre';
import type { AisTargetSnapshot } from '../lib/aisTargets';

// #153: AisLayer's source/layer wiring against the shared fake map (jsdom has
// no MapLibre runtime — the BoatMarker.test.tsx approach). registerAisImages
// is a no-op here (test setup stubs canvas getContext to null); what IS
// pinned is the setup gating, the style-RELOAD re-add with the CURRENT
// targets, idempotence on routine 'styledata', and unmount disarming.

vi.mock('maplibre-gl', () => ({
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

// Moving target with a course: aisFeatureCollection emits a vessel Point AND
// a COG-vector LineString for it (2 features).
const MOVING: AisTargetSnapshot = {
  mmsi: '211000001',
  position: { lat: 54.8, lon: 9.5 },
  sogKn: 5,
  cogDeg: 90,
  lastUpdateMs: 0,
  tier: 'fresh',
};

// No course, no SOG: exactly ONE vessel Point feature, no vector.
const DRIFTING: AisTargetSnapshot = {
  mmsi: '219000002',
  position: { lat: 54.9, lon: 10.1 },
  lastUpdateMs: 0,
  tier: 'fresh',
};

// Latest AIS-source content: the last setData payload if any update ran, else
// the data the source was created with (BoatMarker.test.tsx's vectorData).
function aisData(map: ReturnType<typeof makeFakeMap>): GeoJSON.FeatureCollection {
  const src = map.sources.get(AIS_SOURCE);
  if (!src) throw new Error('AIS source not added');
  const calls = src.setData.mock.calls;
  return calls.length > 0
    ? (calls[calls.length - 1][0] as GeoJSON.FeatureCollection)
    : (src.def.data as GeoJSON.FeatureCollection);
}

describe('AisLayer setup', () => {
  it('adds the AIS source and its three layers once the style is ready', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<AisLayer targets={[]} />);
    expect(map.sources.has(AIS_SOURCE)).toBe(true);
    expect(map.layers.get(AIS_VECTOR_LAYER)?.type).toBe('line');
    expect(map.layers.get(AIS_VESSEL_LAYER)?.type).toBe('symbol');
    expect(map.layers.get(AIS_LABEL_LAYER)?.type).toBe('symbol');
    for (const id of [AIS_VECTOR_LAYER, AIS_VESSEL_LAYER, AIS_LABEL_LAYER]) {
      expect(map.layers.get(id)?.source).toBe(AIS_SOURCE);
    }
  });

  it('paints targets that arrived before the style finished', () => {
    const map = makeFakeMap({ styleLoaded: false });
    hoisted.map = map;
    render(<AisLayer targets={[MOVING]} />);
    expect(map.sources.size).toBe(0);
    map.setStyleLoaded(true);
    map.fire('load');
    // Vessel Point + COG vector for the moving target, at its position.
    const data = aisData(map);
    expect(data.features).toHaveLength(2);
    expect((data.features[0].geometry as GeoJSON.Point).coordinates).toEqual([9.5, 54.8]);
  });
});

describe('AisLayer style reload (#153)', () => {
  it('re-adds the source and all three layers after a style reload', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<AisLayer targets={[]} />);
    simulateStyleReload(map);
    expect(map.sources.has(AIS_SOURCE)).toBe(true);
    expect(map.layers.has(AIS_VECTOR_LAYER)).toBe(true);
    expect(map.layers.has(AIS_VESSEL_LAYER)).toBe(true);
    expect(map.layers.has(AIS_LABEL_LAYER)).toBe(true);
  });

  it('re-adds with the LATEST targets, not the mount-time ones', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { rerender } = render(<AisLayer targets={[MOVING]} />);
    rerender(<AisLayer targets={[DRIFTING]} />);
    simulateStyleReload(map);
    // DRIFTING has no course and no SOG: exactly one vessel Point at ITS
    // position — a mount-closure re-add would repaint MOVING's two features.
    const data = aisData(map);
    expect(data.features).toHaveLength(1);
    expect((data.features[0].geometry as GeoJSON.Point).coordinates).toEqual([10.1, 54.9]);
    expect(data.features[0].properties?.mmsi).toBe('219000002');
  });

  it('keeps painting new snapshots on the re-added source', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { rerender } = render(<AisLayer targets={[DRIFTING]} />);
    simulateStyleReload(map);
    rerender(<AisLayer targets={[MOVING]} />);
    const data = aisData(map);
    expect(data.features).toHaveLength(2);
    expect(data.features[0].properties?.mmsi).toBe('211000001');
  });

  it('routine styledata firings neither re-create nor repaint anything', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    render(<AisLayer targets={[MOVING]} />);
    const addSourceCalls = map.addSource.mock.calls.length;
    const setDataCalls = map.sources.get(AIS_SOURCE)?.setData.mock.calls.length;
    map.fire('styledata');
    expect(map.addSource.mock.calls.length).toBe(addSourceCalls);
    expect(map.sources.get(AIS_SOURCE)?.setData.mock.calls.length).toBe(setDataCalls);
  });

  it('unmount removes the re-add hook: a later style reload cannot resurrect the layers', () => {
    const map = makeFakeMap();
    hoisted.map = map;
    const { unmount } = render(<AisLayer targets={[MOVING]} />);
    unmount();
    simulateStyleReload(map);
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });
});

// #192 review (finding 4): registerAisImages had zero contract coverage even
// though this PR is the one that changed it — jsdom's canvas getContext is
// globally stubbed to null (src/test/setup.ts), which is why every test above
// treats image registration as an opaque no-op. Same technique as
// seamarkGlyphs.test.ts's registerSeamarkImages tests: spy document.createElement
// so it hands back a recording fake 2D context instead of the real (null) one.
describe('registerAisImages (#192 canvas/pixelRatio/scale registration contract)', () => {
  // Hand-derived from AisLayer.tsx's own constants (LOGICAL_SIZE=32,
  // CANVAS_SIZE=64) — not read back from the implementation. Every
  // coordinate below is LOGICAL_SIZE=32 geometry (bow/wings for the arrow,
  // centre+radius for the dot); the scale factor every drawn image must
  // apply, exactly once, before any path op.
  const AIS_SCALE = 64 / 32;
  const EXPECTED_OPS = [
    // Arrow: moveTo(16,3) -> lineTo(25,27) -> lineTo(16,21) -> lineTo(7,27) -> close -> fill -> stroke.
    `scale:${AIS_SCALE},${AIS_SCALE}`,
    'begin',
    'M16,3',
    'L25,27',
    'L16,21',
    'L7,27',
    'close',
    'fill',
    'stroke',
    // Dot: arc(16,16,6) -> fill -> stroke.
    `scale:${AIS_SCALE},${AIS_SCALE}`,
    'begin',
    'A16,16,6',
    'fill',
    'stroke',
  ];

  function recordingAisContext(log: string[]): CanvasRenderingContext2D {
    const ctx = {
      scale: (x: number, y: number) => log.push(`scale:${x},${y}`),
      beginPath: () => log.push('begin'),
      moveTo: (x: number, y: number) => log.push(`M${x},${y}`),
      lineTo: (x: number, y: number) => log.push(`L${x},${y}`),
      closePath: () => log.push('close'),
      arc: (cx: number, cy: number, r: number) => log.push(`A${cx},${cy},${r}`),
      fill: () => log.push('fill'),
      stroke: () => log.push('stroke'),
      getImageData: () => ({}) as ImageData,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
    };
    return ctx as unknown as CanvasRenderingContext2D;
  }

  it('registers arrow + dot at a 64x64 raster, pixelRatio 2, with one scale(64/32,64/32) transform each', () => {
    const log: string[] = [];
    const ctx = recordingAisContext(log);
    const canvases: { width: number; height: number }[] = [];
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        const canvas = { width: 0, height: 0, getContext: () => ctx };
        canvases.push(canvas);
        return canvas as unknown as HTMLCanvasElement;
      }
      return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
    });
    const addImage = vi.fn();
    const map = { hasImage: () => false, addImage } as unknown as Parameters<
      typeof registerAisImages
    >[0];

    try {
      registerAisImages(map);
    } finally {
      createSpy.mockRestore();
    }

    expect(addImage).toHaveBeenCalledTimes(2);
    expect(addImage.mock.calls[0][0]).toBe(ARROW_IMAGE);
    expect(addImage.mock.calls[1][0]).toBe(DOT_IMAGE);

    // Registration contract: 64x64 raster, pixelRatio 2 — a regression that
    // drops pixelRatio (#191's original bug class) or reverts the canvas
    // size must fail here.
    expect(canvases).toHaveLength(2);
    for (const canvas of canvases) {
      expect(canvas.width).toBe(64);
      expect(canvas.height).toBe(64);
    }
    expect(addImage.mock.calls[0][2]).toEqual({ pixelRatio: 2 });
    expect(addImage.mock.calls[1][2]).toEqual({ pixelRatio: 2 });

    // Explicit scale-count/factor guard, plus the full ordered op log so a
    // wrong/missing/duplicated ctx.scale() or a mutated geometry constant
    // both fail.
    const scaleCalls = log.filter((op) => op.startsWith('scale:'));
    expect(scaleCalls).toEqual([
      `scale:${AIS_SCALE},${AIS_SCALE}`,
      `scale:${AIS_SCALE},${AIS_SCALE}`,
    ]);
    expect(log).toEqual(EXPECTED_OPS);
  });

  it('skips an image the map already has registered', () => {
    const log: string[] = [];
    const ctx = recordingAisContext(log);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
      }
      return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
    });
    const addImage = vi.fn();
    const map = {
      hasImage: (id: string) => id === ARROW_IMAGE,
      addImage,
    } as unknown as Parameters<typeof registerAisImages>[0];

    try {
      registerAisImages(map);
    } finally {
      createSpy.mockRestore();
    }

    expect(addImage).toHaveBeenCalledTimes(1);
    expect(addImage.mock.calls[0][0]).toBe(DOT_IMAGE);
  });
});
