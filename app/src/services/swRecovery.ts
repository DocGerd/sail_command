// #27: one-shot recovery from broken pre-SW basemap loads.
//
// On a page NOT yet controlled by the service worker, GitHub Pages (Fastly)
// can answer basemap-archive Range requests with raw byte slices stamped
// `content-encoding: gzip` — the browser fails to gunzip them and MapLibre
// surfaces tile errors (net::ERR_CONTENT_DECODING_FAILED). Once the SW
// controls the page, ranges are sliced from the precache and are always
// correct, so the app self-heals — except the already-errored map stays
// broken until something reloads it.
//
// #118 hardened that window at the source: the archive now ships as
// `data/basemap.pmtiles.png` (image/png is gzip-exempt + Range-clean on this
// origin) and uncontrolled pages run a Range preflight with a Blob-backed
// full-fetch fallback (src/services/basemapSource.ts). This module remains
// the FINAL net behind both, for any uncontrolled-page map error the
// preflight/fallback pair cannot absorb.
//
// This module bridges exactly that window: it records whether MapLibre
// errored while `navigator.serviceWorker.controller` was null, and on the
// FIRST controllerchange reloads the page ONCE. Guards (the hard rules):
//  - never loops: a sessionStorage flag is set BEFORE reloading, and a page
//    that finds the flag (or can't read/write sessionStorage) never arms;
//    a reloaded page is also SW-controlled, so it exits on that check too.
//  - never fires when already controlled at load: armed only when the
//    controller is null at init time.
//  - never masks other errors: MapView's console.error + error banner are
//    untouched; this only adds the single recovery trigger.
//
// Accepted cost: the reload discards planner form state and any in-flight
// route computation (saved plans in IndexedDB are untouched) — acceptable
// because it only fires on a page whose map is already visibly broken, and
// at most once per session.
const RECOVERY_KEY = 'sailcommand-sw-recovery-reloaded';

let sawUncontrolledMapError = false;
let initialized = false;

/**
 * Called by MapView for EVERY MapLibre 'error' event (before its own
 * one-shot banner gate). Only errors that happen while the page is
 * uncontrolled are recorded — those are the only ones the gzip-stamped
 * Range failure mode can produce, and the only ones a post-claim reload
 * can fix. No finer error-type filtering: MapLibre's ErrorEvent shape for
 * resource failures is not stable API, and the recovery is already bounded
 * to one reload per session, so over-recording costs at most that.
 */
export function noteMapError(): void {
  if (!('serviceWorker' in navigator)) return;
  if (!navigator.serviceWorker.controller) sawUncontrolledMapError = true;
}

/**
 * Arms the one-shot recovery (main.tsx, before React renders — so the
 * listener exists before the map can start erroring). `reload` is
 * injectable for tests only; production uses location.reload().
 */
export function initSwRecovery(reload: () => void = () => location.reload()): void {
  if (initialized) return;
  initialized = true;
  if (!('serviceWorker' in navigator)) return;
  // Already controlled at load: the broken-Range window doesn't exist, and
  // later controllerchanges (e.g. a SKIP_WAITING update) must never reload.
  if (navigator.serviceWorker.controller) return;

  try {
    if (sessionStorage.getItem(RECOVERY_KEY) === '1') return;
  } catch {
    // sessionStorage unreadable (privacy mode edge cases): without a
    // working guard a reload could loop — so never recover.
    return;
  }

  // { once: true } implements "on the FIRST controllerchange" literally:
  // if no uncontrolled error happened by then, the recovery disarms for
  // good — errors after control are served by the SW and don't need it.
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => {
      if (!sawUncontrolledMapError) return;
      try {
        sessionStorage.setItem(RECOVERY_KEY, '1');
      } catch {
        return; // guard unwritable → reloading would risk a loop
      }
      reload();
    },
    { once: true },
  );
}
