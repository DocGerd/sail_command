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
 * True for a basemap archive and nothing else — the predicate behind sw.ts's
 * first-registered Range→206 route. Matches by SUFFIX only, never by
 * basename: this is what lets it cover a whole SET of archives (today's
 * single core `basemap.pmtiles.png`, plus any future per-region archive
 * under any basename — #1164/#296 §3) with no change here when a second
 * archive ships. `.github/workflows/deploy.yml`'s archive-discovery glob
 * (`data/*.pmtiles*`) relies on this same suffix-only rule; keep the two in
 * sync. Matches BOTH the renamed `.pmtiles.png` shape and the legacy bare
 * `.pmtiles` shape: across the #118 rename the legacy URL stays owned by
 * that route — degrading to a network fetch on precache miss (the
 * post-rename precache holds only the renamed file), self-healing on the
 * update reload. Deliberately NOT a bare `.png` check — ordinary image
 * assets (icons, sprites) must stay with workbox's default precache route.
 */
export function isBasemapArchivePath(pathname: string): boolean {
  return pathname.endsWith('.pmtiles.png') || pathname.endsWith('.pmtiles');
}
