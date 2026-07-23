// #118: the basemap archive is deployed as `data/basemap.pmtiles.png` — a
// deliberate masquerade, NOT a PNG. GitHub Pages/Fastly gzip-compresses
// application/octet-stream responses and answers Range requests with 206
// slices OF THE COMPRESSED stream, which the browser cannot inflate
// (net::ERR_CONTENT_DECODING_FAILED) — breaking the vector basemap for every
// first-load/no-SW visitor. image/png is the only content-type verified
// gzip-exempt AND Range-clean on this origin, and Pages derives the MIME type
// from the FINAL extension. Do not "clean up" the extension — that would
// resurrect #118. See also pipeline/extract_basemap.sh and sw.ts.

/** BASE_URL-relative path of the deployed basemap archive. */
export const BASEMAP_PATH = 'data/basemap.pmtiles.png';

/**
 * True for the basemap archive and nothing else — the predicate behind
 * sw.ts's first-registered Range→206 route. Matches BOTH the renamed
 * `.pmtiles.png` shape and the legacy bare `.pmtiles` shape: an
 * already-installed SW updating across the #118 rename must keep owning the
 * old URL until its precache turns over. Deliberately NOT a bare `.png`
 * check — ordinary image assets (icons, sprites) must stay with workbox's
 * default precache route.
 */
export function isBasemapArchivePath(pathname: string): boolean {
  return pathname.endsWith('.pmtiles.png') || pathname.endsWith('.pmtiles');
}
