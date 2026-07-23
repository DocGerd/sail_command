import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PMTiles } from 'pmtiles';
import {
  BlobSource,
  ensureBasemapProtocolSource,
  looksLikePmtiles,
  pmtilesRangeModeWorks,
} from './basemapSource';

// #118 fallback plumbing for first-load/no-SW visitors. Expectations are
// pinned literals (mutation-honesty, #50) — never derived from the code
// under test.

const ARCHIVE_URL = 'https://example.test/sail_command/data/basemap.pmtiles.png';

/** First 7 bytes of a real PMTiles archive: 'PMTiles' (LE uint16 0x4d50). */
const PM_MAGIC = Uint8Array.from([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]);
/** The #118 live-probe signature: a gzip stream head where PMTiles should be. */
const GZIP_MAGIC = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BlobSource', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const source = new BlobSource(new Blob([bytes]), ARCHIVE_URL);

  it('serves exact byte ranges from the blob', async () => {
    const { data } = await source.getBytes(3, 5);
    expect(data.byteLength).toBe(5);
    expect([...new Uint8Array(data)]).toEqual([3, 4, 5, 6, 7]);
  });

  it('clamps a range running past the end (Blob.slice semantics)', async () => {
    const { data } = await source.getBytes(250, 10);
    expect(data.byteLength).toBe(6);
    expect([...new Uint8Array(data)]).toEqual([250, 251, 252, 253, 254, 255]);
  });

  it('keys the archive on the exact constructor string', () => {
    expect(source.getKey()).toBe(ARCHIVE_URL);
  });
});

describe('looksLikePmtiles', () => {
  it('accepts the PMTiles magic', () => {
    expect(looksLikePmtiles(PM_MAGIC)).toBe(true);
  });

  it('rejects a gzip stream head (the #118 failure signature)', () => {
    expect(looksLikePmtiles(GZIP_MAGIC)).toBe(false);
  });

  it('rejects empty and truncated input', () => {
    expect(looksLikePmtiles(Uint8Array.from([]))).toBe(false);
    expect(looksLikePmtiles(Uint8Array.from([0x50]))).toBe(false);
  });

  it('rejects swapped magic bytes (byte order matters)', () => {
    expect(looksLikePmtiles(Uint8Array.from([0x4d, 0x50]))).toBe(false);
  });
});

describe('pmtilesRangeModeWorks', () => {
  it('passes on a true 206 carrying PMTiles bytes — probing the NETWORK, never the HTTP cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 206,
      arrayBuffer: () => Promise.resolve(PM_MAGIC.slice().buffer),
      body: null,
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(pmtilesRangeModeWorks(ARCHIVE_URL)).resolves.toBe(true);
    // Literal init pin: Chrome can synthesize an honest-looking 206 from an
    // HTTP-cached full body (e.g. cached by a prior blob-fallback 200) —
    // without cache:'no-store' the preflight would mask a still-broken CDN
    // as 'range-ok'.
    expect(fetchMock).toHaveBeenCalledWith(ARCHIVE_URL, {
      headers: { Range: 'bytes=0-15' },
      cache: 'no-store',
    });
  });

  it('fails on a 206 whose body is a compressed-stream slice (gzip magic)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 206,
      arrayBuffer: () => Promise.resolve(GZIP_MAGIC.slice().buffer),
      body: null,
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(pmtilesRangeModeWorks(ARCHIVE_URL)).resolves.toBe(false);
  });

  it('fails on a 200 identity answer WITHOUT buffering the body (27 MB trap)', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const arrayBuffer = vi.fn().mockResolvedValue(PM_MAGIC.slice().buffer);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, arrayBuffer, body: { cancel } });
    vi.stubGlobal('fetch', fetchMock);
    await expect(pmtilesRangeModeWorks(ARCHIVE_URL)).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('fails when fetch itself rejects (the browser throws on un-inflatable gzip-stamped 206s)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('decode error')));
    await expect(pmtilesRangeModeWorks(ARCHIVE_URL)).resolves.toBe(false);
  });
});

describe('ensureBasemapProtocolSource', () => {
  it('skips everything on an SW-controlled page', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const protocol = { add: vi.fn() };
    await expect(ensureBasemapProtocolSource(protocol, ARCHIVE_URL, true)).resolves.toBe(
      'sw-controlled',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(protocol.add).not.toHaveBeenCalled();
  });

  it('keeps the ranged fast path when the preflight sees a true 206 + PM magic', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 206,
      arrayBuffer: () => Promise.resolve(PM_MAGIC.slice().buffer),
      body: null,
    });
    vi.stubGlobal('fetch', fetchMock);
    const protocol = { add: vi.fn() };
    await expect(ensureBasemapProtocolSource(protocol, ARCHIVE_URL, false)).resolves.toBe(
      'range-ok',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The single call was the preflight — it MUST carry the Range header AND
    // bypass the HTTP cache (see the no-store rationale above).
    const init = fetchMock.mock.calls[0]?.[1] as {
      headers?: Record<string, string>;
      cache?: string;
    };
    expect(init.headers).toEqual({ Range: 'bytes=0-15' });
    expect(init.cache).toBe('no-store');
    expect(protocol.add).not.toHaveBeenCalled();
  });

  it('falls back to a full-body Blob source when the preflight sees gzip magic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blob = new Blob([PM_MAGIC]);
    const fetchMock = vi
      .fn()
      // Preflight: corrupted 206 (compressed-stream slice).
      .mockResolvedValueOnce({
        status: 206,
        arrayBuffer: () => Promise.resolve(GZIP_MAGIC.slice().buffer),
        body: null,
      })
      // Fallback: full-body GET decodes fine.
      .mockResolvedValueOnce({ ok: true, status: 200, blob: () => Promise.resolve(blob) });
    vi.stubGlobal('fetch', fetchMock);
    const protocol = { add: vi.fn() };
    await expect(ensureBasemapProtocolSource(protocol, ARCHIVE_URL, false)).resolves.toBe(
      'blob-fallback',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The SECOND call is the full-body GET — it must NOT carry a Range header.
    const secondInit = fetchMock.mock.calls[1]?.[1] as
      { headers?: Record<string, string> } | undefined;
    expect(secondInit?.headers?.['Range']).toBeUndefined();
    expect(protocol.add).toHaveBeenCalledTimes(1);
    // The registered archive MUST be keyed on the exact URL string MapLibre
    // parses out of the style's pmtiles:// reference — any drift silently
    // falls through to a lazily auto-created FetchSource, resurrecting #118.
    const added = protocol.add.mock.calls[0]?.[0] as PMTiles;
    expect(added.source.getKey()).toBe(ARCHIVE_URL);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('#118');
  });

  it('throws when the fallback full-body fetch itself fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 206,
        arrayBuffer: () => Promise.resolve(GZIP_MAGIC.slice().buffer),
        body: null,
      })
      .mockResolvedValueOnce({ ok: false, status: 503, blob: () => Promise.resolve(new Blob()) });
    vi.stubGlobal('fetch', fetchMock);
    const protocol = { add: vi.fn() };
    await expect(ensureBasemapProtocolSource(protocol, ARCHIVE_URL, false)).rejects.toThrow();
    expect(protocol.add).not.toHaveBeenCalled();
  });
});
