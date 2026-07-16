import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGlyphWarmup } from './glyphWarmup';
import { GLYPH_CACHE_NAME } from '../lib/glyphs';

// jsdom provides neither navigator.serviceWorker nor the Cache API — both
// are stubbed per test (mirroring geolocation.test.ts's stubGlobal pattern).

class FakeSwContainer extends EventTarget {
  controller: object | null = null;
}

interface Env {
  sw: FakeSwContainer;
  fetchMock: ReturnType<typeof vi.fn>;
  cacheKeys: { url: string }[];
  cachesOpen: ReturnType<typeof vi.fn>;
  setOnline: (v: boolean) => void;
}

function stubEnv({
  controlled = true,
  online = true,
  manifest = [] as string[] | null,
  cachedUrls = [] as string[],
}: {
  controlled?: boolean;
  online?: boolean;
  manifest?: string[] | Record<string, unknown> | null;
  cachedUrls?: string[];
} = {}): Env {
  const sw = new FakeSwContainer();
  if (controlled) sw.controller = {};
  let onLine = online;

  vi.stubGlobal('navigator', {
    serviceWorker: sw,
    get onLine() {
      return onLine;
    },
  });

  const cacheKeys = cachedUrls.map((url) => ({ url }));
  const cachesOpen = vi.fn(async () => ({ keys: async () => cacheKeys }));
  vi.stubGlobal('caches', { open: cachesOpen });

  // Immediate idle: keeps the tests synchronous-ish without fake timers.
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
    cb();
    return 0;
  });

  const fetchMock = vi.fn(async (input: string) => {
    if (input.includes('glyph-manifest.json')) {
      if (manifest === null) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    return new Response(new Uint8Array(8), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);

  return { sw, fetchMock, cacheKeys, cachesOpen, setOnline: (v) => (onLine = v) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runGlyphWarmup', () => {
  it("returns 'skipped' without touching the network when serviceWorker is unsupported", async () => {
    const { fetchMock } = stubEnv();
    vi.stubGlobal('navigator', { onLine: true }); // no serviceWorker property

    await expect(runGlyphWarmup()).resolves.toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 'skipped' without fetching when offline", async () => {
    const { fetchMock } = stubEnv({ online: false });

    await expect(runGlyphWarmup()).resolves.toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 'skipped' with a console.warn when the manifest is missing (stale SW serves a 404)", async () => {
    const { fetchMock } = stubEnv({ manifest: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runGlyphWarmup()).resolves.toBe('skipped');
    // Only the manifest attempt — no glyph fetches on a failed manifest —
    // but never a SILENT skip: the degraded offline coverage is surfaced.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('glyph manifest unavailable'));
  });

  it("returns 'skipped' with a console.warn on a malformed manifest", async () => {
    stubEnv({ manifest: { not: 'an array' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runGlyphWarmup()).resolves.toBe('skipped');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('glyph manifest unavailable'));
  });

  it('defers everything until the SW takes control of the page', async () => {
    const { sw, fetchMock } = stubEnv({
      controlled: false,
      manifest: ['basemap-assets/fonts/Noto Sans Regular/0-255.pbf'],
    });

    const outcome = runGlyphWarmup();
    // Let any (wrongly) eager work flush before asserting nothing happened.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));

    await expect(outcome).resolves.toBe('done');
    expect(fetchMock).toHaveBeenCalled();
  });

  it("fetches only the ranges missing from the runtime cache and reports 'done'", async () => {
    const base = 'http://localhost:3000/basemap-assets/fonts/Noto%20Sans%20Regular';
    const { fetchMock, cachesOpen } = stubEnv({
      manifest: [
        'basemap-assets/fonts/Noto Sans Regular/0-255.pbf',
        'basemap-assets/fonts/Noto Sans Regular/256-511.pbf',
      ],
      cachedUrls: [`${base}/0-255.pbf`],
    });

    await expect(runGlyphWarmup()).resolves.toBe('done');

    expect(cachesOpen).toHaveBeenCalledWith(GLYPH_CACHE_NAME);
    const glyphFetches = fetchMock.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.endsWith('.pbf'));
    // Only the missing range, with the space URL-encoded exactly as the
    // Cache API will key it.
    expect(glyphFetches).toEqual([`${base}/256-511.pbf`]);
  });

  it("keeps going past individual fetch failures and reports 'partial'", async () => {
    const { fetchMock } = stubEnv({
      manifest: [
        'basemap-assets/fonts/Noto Sans Regular/0-255.pbf',
        'basemap-assets/fonts/Noto Sans Regular/256-511.pbf',
        'basemap-assets/fonts/Noto Sans Regular/512-767.pbf',
      ],
    });
    fetchMock.mockImplementation(async (input: string) => {
      if (input.includes('glyph-manifest.json')) {
        return new Response(
          JSON.stringify([
            'basemap-assets/fonts/Noto Sans Regular/0-255.pbf',
            'basemap-assets/fonts/Noto Sans Regular/256-511.pbf',
            'basemap-assets/fonts/Noto Sans Regular/512-767.pbf',
          ]),
          { status: 200 },
        );
      }
      if (input.includes('256-511')) throw new TypeError('network down');
      return new Response(new Uint8Array(8), { status: 200 });
    });

    await expect(runGlyphWarmup()).resolves.toBe('partial');
    // 1 manifest + all 3 ranges attempted despite the middle one failing.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("stops between batches when the connection drops and reports 'partial'", async () => {
    // 9 missing ranges = 2 batches (batch size 8); the connection "drops"
    // during the first batch, so the second must never start.
    const paths = Array.from(
      { length: 9 },
      (_, i) => `basemap-assets/fonts/Noto Sans Regular/${i * 256}-${i * 256 + 255}.pbf`,
    );
    const env = stubEnv({ manifest: paths });
    env.fetchMock.mockImplementation(async (input: string) => {
      if (input.includes('glyph-manifest.json')) {
        return new Response(JSON.stringify(paths), { status: 200 });
      }
      env.setOnline(false);
      return new Response(new Uint8Array(8), { status: 200 });
    });

    await expect(runGlyphWarmup()).resolves.toBe('partial');
    // 1 manifest + first batch of 8 — the 9th range was never fetched.
    expect(env.fetchMock).toHaveBeenCalledTimes(9);
  });
});

describe('scheduleGlyphWarmup', () => {
  it('runs once per page load and publishes the outcome on window.__sailGlyphWarmup', async () => {
    const { fetchMock } = stubEnv({
      manifest: ['basemap-assets/fonts/Noto Sans Regular/0-255.pbf'],
    });
    // Fresh module instance: scheduleGlyphWarmup memoizes at module scope.
    vi.resetModules();
    const { scheduleGlyphWarmup } = await import('./glyphWarmup');

    const first = scheduleGlyphWarmup();
    const second = scheduleGlyphWarmup();
    expect(second).toBe(first);

    await expect(first).resolves.toBe('done');
    expect(window.__sailGlyphWarmup).toBe('done');
    // Manifest fetched exactly once — the second call reused the first run.
    const manifestFetches = fetchMock.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.includes('glyph-manifest.json'));
    expect(manifestFetches).toHaveLength(1);
  });
});
