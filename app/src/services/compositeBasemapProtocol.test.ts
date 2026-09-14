import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestParameters } from 'maplibre-gl';
import type { RegionBbox, RegionManifestEntry } from '../lib/basemapRegions';
import {
  CompositeBasemapProtocol,
  loadRegionEntries,
  MANIFEST_TIMEOUT_MS,
  REGION_RETRY_MS,
  selectTileArchive,
  tileBbox,
  type BasemapArchive,
} from './compositeBasemapProtocol';

// #1164 T5. Tile coordinates and bounds below are pinned literals computed
// from the Web-Mercator formula by hand (z10, n=1024), never from tileBbox.
// jsdom renders nothing: "no map error" here means the handler RESOLVES
// rather than rejects — real rendering is T6's e2e.

const BASE = 'https://example.test/sail_command/';
const CORE_URL = `${BASE}data/basemap.pmtiles.png`;
const REGION_URL = `${BASE}data/region-east.pmtiles.png`;
const CORE_BBOX: RegionBbox = [9.4, 54.3, 11.0, 55.3];

// z10 row 324 spans lat 54.7753..54.9776; columns: 540 = lon 9.84..10.20
// (core only), 543 = 10.898..11.25 (straddles lon 11.0), 544 = 11.25..11.60,
// 547 = 12.30..12.66.
const Y = 324;

function region(bbox: RegionBbox, id = 'east'): RegionManifestEntry {
  return { id, path: 'data/region-east.pmtiles.png', bytes: 1000, bbox };
}

const params = (url: string, type?: RequestParameters['type']): RequestParameters =>
  type === undefined ? { url } : { url, type };

function fakeArchive(
  bbox: RegionBbox,
  tile: () => Promise<{ data: ArrayBuffer } | undefined>,
): BasemapArchive & { getZxy: ReturnType<typeof vi.fn> } {
  const header = {
    minLon: bbox[0],
    minLat: bbox[1],
    maxLon: bbox[2],
    maxLat: bbox[3],
    minZoom: 0,
    maxZoom: 15,
    tileType: 1, // TileType.Mvt
  };
  return {
    getHeader: vi.fn(() => Promise.resolve(header)),
    getZxy: vi.fn(tile),
  } as unknown as BasemapArchive & { getZxy: ReturnType<typeof vi.fn> };
}

const bytes =
  (...b: number[]) =>
  () =>
    Promise.resolve({ data: Uint8Array.from(b).buffer });

function setup(opts: {
  regions: RegionManifestEntry[];
  regionTile?: () => Promise<{ data: ArrayBuffer } | undefined>;
  coreTile?: () => Promise<{ data: ArrayBuffer } | undefined>;
  regionsEnabled?: boolean;
}) {
  const core = fakeArchive(CORE_BBOX, opts.coreTile ?? bytes(1));
  const opened: string[] = [];
  const open = vi.fn((href: string) => {
    opened.push(href);
    if (href === CORE_URL) return core;
    return fakeArchive([12, 54.3, 13, 55.3], opts.regionTile ?? bytes(2));
  });
  const loadRegions = vi.fn(() => Promise.resolve(opts.regions));
  const p = new CompositeBasemapProtocol(open, loadRegions);
  p.configure({ coreUrl: CORE_URL, baseHref: BASE, regionsEnabled: opts.regionsEnabled ?? true });
  return { p, core, opened, loadRegions };
}

const tileUrl = (x: number) => `sc-basemap://basemap/10/${x}/${Y}`;
const data = async (r: Promise<{ data: unknown }>) => [...((await r).data as Uint8Array)];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tileBbox', () => {
  it('z0 covers the whole Web-Mercator square', () => {
    const [w, s, e, n] = tileBbox(0, 0, 0);
    expect([w, e]).toEqual([-180, 180]);
    expect(s).toBeCloseTo(-85.0511287798, 9);
    expect(n).toBeCloseTo(85.0511287798, 9);
  });

  it('z10/543/324 spans lon 10.8984375..11.25', () => {
    const [w, s, e, n] = tileBbox(10, 543, Y);
    expect([w, e]).toEqual([10.8984375, 11.25]);
    expect(s).toBeCloseTo(54.7753458594, 9);
    expect(n).toBeCloseTo(54.9776136707, 9);
  });
});

describe('selectTileArchive', () => {
  const east = region([10.8, 54.3, 12.0, 55.3]);

  it('core wins a tile both the core and a region overlap', () => {
    expect(selectTileArchive(10, 543, Y, CORE_BBOX, [east])).toEqual({ kind: 'core' });
  });

  it('a tile outside the core goes to the overlapping region', () => {
    expect(selectTileArchive(10, 544, Y, CORE_BBOX, [east])).toEqual({
      kind: 'region',
      entry: east,
    });
  });

  it('a tile touching the core bbox only along an edge is not core', () => {
    // Core maxLon 11.25 == tile 544's west edge: zero-area contact.
    const core: RegionBbox = [9.4, 54.3, 11.25, 55.3];
    expect(selectTileArchive(10, 544, Y, core, [east]).kind).toBe('region');
  });

  it('a tile in the gap between core and a disjoint region is none', () => {
    const far = region([12.3, 54.3, 13.0, 55.3]);
    expect(selectTileArchive(10, 544, Y, CORE_BBOX, [far])).toEqual({ kind: 'none' });
  });

  it('the first overlapping region in manifest order wins', () => {
    const a = region([11.2, 54.3, 12.0, 55.3], 'a');
    const b = region([11.2, 54.3, 12.0, 55.3], 'b');
    expect(selectTileArchive(10, 544, Y, CORE_BBOX, [a, b])).toEqual({ kind: 'region', entry: a });
  });

  it('a malformed core bbox fails toward core', () => {
    const bad: RegionBbox = [Number.NaN, 54.3, 11.0, 55.3];
    expect(selectTileArchive(10, 547, Y, bad, [east]).kind).toBe('core');
  });

  it('a malformed region bbox is never selected', () => {
    const reversed = region([12.0, 54.3, 10.8, 55.3]);
    expect(selectTileArchive(10, 544, Y, CORE_BBOX, [reversed]).kind).toBe('none');
  });
});

describe('CompositeBasemapProtocol.tile', () => {
  const east = region([11.2, 54.3, 12.0, 55.3]);

  it('serves a core tile from the core archive', async () => {
    const { p, opened } = setup({ regions: [east] });
    expect(await data(p.tile(params(tileUrl(540)), new AbortController()))).toEqual([1]);
    expect(opened).toEqual([CORE_URL]);
  });

  it('serves a region tile from the region archive', async () => {
    const { p, opened } = setup({ regions: [east] });
    expect(await data(p.tile(params(tileUrl(544)), new AbortController()))).toEqual([2]);
    expect(opened).toEqual([CORE_URL, REGION_URL]);
  });

  it('a failing REGION read resolves to an empty tile, never rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { p } = setup({
      regions: [east],
      regionTile: () => Promise.reject(new Error('offline')),
    });
    const res = await p.tile(params(tileUrl(544)), new AbortController());
    expect(res.data).toBeInstanceOf(Uint8Array);
    expect((res.data as Uint8Array).byteLength).toBe(0);
  });

  it('a failed region archive is dropped and reopened after the retry window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const { p, opened } = setup({
      regions: [east],
      regionTile: () => (fail ? Promise.reject(new Error('offline')) : bytes(7)()),
    });
    await p.tile(params(tileUrl(544)), new AbortController());
    fail = false;
    vi.advanceTimersByTime(REGION_RETRY_MS);
    expect(await data(p.tile(params(tileUrl(544)), new AbortController()))).toEqual([7]);
    expect(opened.filter((h) => h === REGION_URL)).toHaveLength(2);
  });

  it('within the retry window a failed region is not reopened (no offline storm)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { p, opened } = setup({
      regions: [east],
      regionTile: () => Promise.reject(new Error('offline')),
    });
    await p.tile(params(tileUrl(544)), new AbortController());
    vi.advanceTimersByTime(REGION_RETRY_MS - 1);
    for (const x of [544, 545, 544]) {
      const res = await p.tile(params(tileUrl(x)), new AbortController());
      expect((res.data as Uint8Array).byteLength).toBe(0);
    }
    expect(opened.filter((h) => h === REGION_URL)).toHaveLength(1);
  });

  it('warns once per region archive across repeated failures', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { p, opened } = setup({
      regions: [east],
      regionTile: () => Promise.reject(new Error('offline')),
    });
    await p.tile(params(tileUrl(544)), new AbortController());
    vi.advanceTimersByTime(REGION_RETRY_MS);
    await p.tile(params(tileUrl(545)), new AbortController());
    expect(opened.filter((h) => h === REGION_URL)).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(REGION_URL);
  });

  it('concurrent first requests into one region share a single archive', async () => {
    const { p, opened } = setup({ regions: [east] });
    await Promise.all(
      [544, 545].map((x) => p.tile(params(tileUrl(x)), new AbortController())),
    );
    expect(opened.filter((h) => h === REGION_URL)).toHaveLength(1);
  });

  it('loads the BASE_URL-relative manifest once across requests', async () => {
    const { p, loadRegions } = setup({ regions: [east] });
    await p.tile(params('sc-basemap://basemap', 'json'), new AbortController());
    await p.tile(params(tileUrl(540)), new AbortController());
    await p.tile(params(tileUrl(544)), new AbortController());
    expect(loadRegions).toHaveBeenCalledTimes(1);
    expect(loadRegions).toHaveBeenCalledWith('https://example.test/sail_command/basemap-regions.json');
  });

  it('an ABORTED region read rejects rather than resolving empty', async () => {
    const ac = new AbortController();
    const { p } = setup({
      regions: [east],
      regionTile: () => {
        ac.abort();
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      },
    });
    await expect(p.tile(params(tileUrl(544)), ac)).rejects.toThrow();
  });

  it('a failing CORE read rejects (reaches MapLibre error, as before)', async () => {
    const { p } = setup({
      regions: [east],
      coreTile: () => Promise.reject(new Error('core down')),
    });
    await expect(p.tile(params(tileUrl(540)), new AbortController())).rejects.toThrow('core down');
  });

  it('a failing CORE read rejects with zero regions too', async () => {
    const { p } = setup({ regions: [], coreTile: () => Promise.reject(new Error('core down')) });
    await expect(p.tile(params(tileUrl(540)), new AbortController())).rejects.toThrow('core down');
  });

  it('a gap tile resolves empty without opening any region archive', async () => {
    const far = region([12.3, 54.3, 13.0, 55.3]);
    const { p, opened } = setup({ regions: [far] });
    const res = await p.tile(params(tileUrl(544)), new AbortController());
    expect((res.data as Uint8Array).byteLength).toBe(0);
    expect(opened).toEqual([CORE_URL]);
  });

  it('regionsEnabled false: no manifest load, every tile read from the core', async () => {
    const { p, opened, loadRegions } = setup({ regions: [east], regionsEnabled: false });
    expect(await data(p.tile(params(tileUrl(544)), new AbortController()))).toEqual([1]);
    expect(loadRegions).not.toHaveBeenCalled();
    expect(opened).toEqual([CORE_URL]);
  });

  it('an archive added before configure (#118 Blob fallback) serves the core', async () => {
    const open = vi.fn(() => fakeArchive(CORE_BBOX, bytes(9)));
    const p = new CompositeBasemapProtocol(open, () => Promise.resolve([]));
    const blob = fakeArchive(CORE_BBOX, bytes(5));
    p.add({ ...blob, source: { getKey: () => CORE_URL } } as unknown as Parameters<
      CompositeBasemapProtocol['add']
    >[0]);
    p.configure({ coreUrl: CORE_URL, baseHref: BASE, regionsEnabled: true });
    expect(await data(p.tile(params(tileUrl(540)), new AbortController()))).toEqual([5]);
    expect(open).not.toHaveBeenCalled();
  });

  it('TileJSON: zero regions returns the core header verbatim', async () => {
    const { p } = setup({ regions: [] });
    const res = await p.tile(params('sc-basemap://basemap', 'json'), new AbortController());
    expect(res.data).toEqual({
      tiles: ['sc-basemap://basemap/{z}/{x}/{y}'],
      minzoom: 0,
      maxzoom: 15,
      bounds: [9.4, 54.3, 11.0, 55.3],
    });
  });

  it('TileJSON: bounds are the union of the core and every region', async () => {
    const { p } = setup({ regions: [region([12.3, 54.0, 13.0, 55.5])] });
    const res = await p.tile(params('sc-basemap://basemap', 'json'), new AbortController());
    expect((res.data as { bounds: number[] }).bounds).toEqual([9.4, 54.0, 13.0, 55.5]);
  });

  it('rejects before configure', async () => {
    const p = new CompositeBasemapProtocol(() => fakeArchive(CORE_BBOX, bytes(1)));
    await expect(p.tile(params(tileUrl(540)), new AbortController())).rejects.toThrow(
      'before configure',
    );
  });
});

describe('loadRegionEntries', () => {
  const URL_ = `${BASE}basemap-regions.json`;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  it('keeps valid regions and drops the core and malformed entries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = region([12.3, 54.3, 13.0, 55.3]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({
            core: { id: 'core', path: 'data/basemap.pmtiles.png', bytes: 1, bbox: CORE_BBOX },
            regions: [
              good,
              { ...good, id: 'core' },
              { ...good, path: 'data/basemap.pmtiles.png' },
              { ...good, bbox: [13, 54, 12, 55] },
            ],
          }),
        ),
      ),
    );
    expect(await loadRegionEntries(URL_)).toEqual([good]);
  });

  it('a 404 yields no regions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 404 }))),
    );
    expect(await loadRegionEntries(URL_)).toEqual([]);
  });

  it('an HTML SPA fallback yields no regions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
        ),
      ),
    );
    expect(await loadRegionEntries(URL_)).toEqual([]);
  });

  it('a manifest fetch that hangs past the timeout yields no regions', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('t', 'AbortError')));
          }),
      ),
    );
    let settled: RegionManifestEntry[] | undefined;
    void loadRegionEntries(URL_).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(MANIFEST_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual([]);
  });

  it('a network failure yields no regions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    expect(await loadRegionEntries(URL_)).toEqual([]);
  });
});
