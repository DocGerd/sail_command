// #118: first-load/no-SW basemap transport.
//
// GitHub Pages/Fastly gzip-compresses application/octet-stream and answers
// Range requests with 206 slices OF THE COMPRESSED stream — the browser
// cannot inflate a mid-stream gzip fragment, so every ranged pmtiles read on
// an UNCONTROLLED page failed (net::ERR_CONTENT_DECODING_FAILED). The archive
// is therefore deployed as `.pmtiles.png` (see src/lib/basemap.ts — image/png
// is the proven gzip-exempt, Range-clean content-type on this origin), and
// this module adds the belt-and-suspenders runtime net:
//
//  - a cheap preflight (Range bytes=0-15, require a true 206 whose body
//    starts with the PMTiles magic) run once per page load on uncontrolled
//    pages only, and
//  - on preflight failure, a full-body fetch into a Blob-backed pmtiles
//    Source registered on the module-level Protocol — a complete gzip stream
//    decodes fine; only ranged slices of it are broken.
//
// SW-controlled pages skip all of this: sw.ts's first-registered route slices
// ranges out of the precache, which is always correct (and offline-capable).
import { PMTiles } from 'pmtiles';
import type { Protocol, RangeResponse, Source } from 'pmtiles';

/**
 * A pmtiles Source over an in-memory Blob (mirrors pmtiles' own FileSource,
 * which also omits the trailing signal/etag params). A Blob keeps the ~26 MB
 * archive out of the JS heap; slices are materialized per read only.
 */
export class BlobSource implements Source {
  readonly #blob: Blob;
  readonly #key: string;

  constructor(blob: Blob, key: string) {
    this.#blob = blob;
    this.#key = key;
  }

  getKey(): string {
    return this.#key;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    // Blob.slice clamps past-the-end ranges, matching HTTP Range semantics.
    // Under exactOptionalPropertyTypes, etag/cacheControl/expires are OMITTED
    // (never assigned as explicit undefined).
    return { data: await this.#blob.slice(offset, offset + length).arrayBuffer() };
  }
}

/**
 * True iff the bytes start with the PMTiles magic 'PM' (the same LE-uint16
 * 19792 check pmtiles' own header parser performs).
 */
export function looksLikePmtiles(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4d;
}

/**
 * Preflight: does this origin serve honest Range responses for the archive?
 * True only for a real 206 whose body starts with the PMTiles magic.
 *
 * A non-206 answer is rejected WITHOUT reading the body: a 200-identity
 * answer would otherwise buffer the whole ~26 MB right here (and pmtiles'
 * FetchSource throws on full-body 200s anyway — see sw.ts). The try/catch is
 * load-bearing: the browser THROWS on an un-inflatable gzip-stamped 206
 * slice — that failure IS the #118 signature this probe exists to catch.
 */
export async function pmtilesRangeModeWorks(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-15' } });
    if (res.status !== 206) {
      void res.body?.cancel();
      return false;
    }
    return looksLikePmtiles(new Uint8Array(await res.arrayBuffer()));
  } catch {
    return false;
  }
}

/**
 * Ensures MapLibre can read the basemap archive on this page, before the map
 * is constructed (Protocol.add must win the race against the first tile
 * request). Returns which transport is in effect:
 *
 *  - 'sw-controlled': the SW serves precache ranges; nothing to do.
 *  - 'range-ok': the origin's ranged responses are honest; pmtiles' default
 *    FetchSource is created lazily by the protocol as before.
 *  - 'blob-fallback': ranged responses are broken (#118 regressed, e.g. a
 *    future CDN policy change re-gzipping image/png) — the archive was
 *    fetched whole and registered as an in-memory Blob source.
 *
 * CRITICAL: the registered source's key MUST be the exact string MapLibre
 * parses from the style's 'pmtiles://<key>/{z}/{x}/{y}' reference (Protocol's
 * tilev4 regex capture; the JSON-metadata branch strips the 10-char scheme
 * prefix). MapView passes the IDENTICAL href into both this function and
 * buildStyle for that reason — any drift makes Protocol.get miss and lazily
 * auto-create a FetchSource, silently resurrecting #118.
 */
export async function ensureBasemapProtocolSource(
  protocol: Pick<Protocol, 'add'>,
  url: string,
  controlled: boolean,
): Promise<'sw-controlled' | 'range-ok' | 'blob-fallback'> {
  if (controlled) return 'sw-controlled';
  if (await pmtilesRangeModeWorks(url)) return 'range-ok';
  console.warn(
    '[#118] basemap Range preflight failed (CDN served a compressed/mangled slice) — ' +
      'falling back to one full-body archive fetch',
  );
  const res = await fetch(url);
  if (!res.ok) throw new Error(`basemap fallback fetch failed: HTTP ${res.status}`);
  // Blob, NOT ArrayBuffer: keeps the ~26 MB off the JS heap (mirrors
  // pmtiles' FileSource). A COMPLETE gzip stream decodes correctly — only
  // ranged slices of it are un-inflatable.
  const blob = await res.blob();
  protocol.add(new PMTiles(new BlobSource(blob, url)));
  return 'blob-fallback';
}
