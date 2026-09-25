// #1164 T4: per-region basemap archive pinning + network-free offline
// readiness for a saved plan. Naming/scoping (regionCacheName,
// requiredRegions, RegionManifestEntry, CORE_REGION_ID) plus the ONE
// manifest parser (REGION_MANIFEST_PATH, RegionManifest, parseRegionManifest,
// isValidRegionBbox) live in basemapRegions.ts (T1, merged as PR #1219;
// consolidated there per PR #1224 review r4008717160, since this PR merges
// second). Corridor geometry reuses routeCorridor.ts's routeCorridorBoxes
// rather than re-deriving it — #146's AIS corridor and this pin service
// answer the same "which map area does this plan touch?" question, and
// #146's own fail-toward-"require more" convention (an over-cap corridor
// falls back to viewport-only, i.e. `[]`) is exactly what basemapRegions.ts's
// requiredRegions() already treats as "require every lazy region" — reusing
// the function inherits that guard-asymmetry for free instead of re-arguing
// it here.
//
// SCOPE: pinRegionsForPlan is wired in at pinAfterSave.ts, once per
// save-path consumer (#1233), plus the #295 readiness chip's save button.
// regionReadiness and regionDownloadBytes are read by
// state/useRegionReadiness.ts (#295), which drives that chip.
//
// Guard-asymmetry (CLAUDE.md): every "can't tell" branch here resolves
// toward NOT-READY or PIN-NOTHING, never toward a false "ready" or a
// speculative fetch of an unverified region set.
//   - A malformed/unreachable manifest: pinRegionsForPlan pins NOTHING
//     (never falls back to "fetch every path in the manifest anyway" — an
//     unvalidated shape could name the wrong archive under a schema drift),
//     and regionReadiness reports not-ready.
//   - Anything short of ALL required archives verified present: not-ready.
//     regionReadiness has deliberately no "downloading" state — a
//     network-free snapshot can never tell "in flight right now" from
//     "permanently stuck" (a 404 or a short body), so it would be the
//     false-comfort direction (PWA review r4008640274). The chip's
//     "saving" state is not that: it comes from pinAfterSave.ts's
//     in-memory record of a live pin promise, which REGION_FETCH_STALL_MS
//     below bounds so a stalled (no-progress) download settles as failed.
//   - A cached archive whose stored byte length disagrees with the
//     manifest's: not counted as present — see #118 CLAUDE.md rule "read
//     the decoded blob size, never Content-Length" for why the length is
//     re-derived from the fetched Blob at pin time rather than trusted from
//     a response header.
//
// regionReadiness is deliberately NEVER cached as a boolean anywhere (not on
// Plan, not in IndexedDB) — the PWA review on PR #1219 flagged that
// REGION_CACHE_VERSION is one global knob for every region, so bumping it
// retires every pinned region's cache at once; a cached "ready" flag would
// go instantly stale at that exact moment. Every call re-derives the answer
// from CacheStorage, so a version bump degrades to "not-ready" for free.

import type { Leg, Plan } from '../types';
import { AIS_CORRIDOR_HALF_WIDTH_NM, routeCorridorBoxes } from '../lib/routeCorridor';
import {
  CORE_REGION_ID,
  REGION_MANIFEST_PATH,
  parseRegionManifest,
  regionById,
  regionCacheName,
  requiredRegions,
  type RegionManifest,
  type RegionManifestEntry,
} from '../lib/basemapRegions';
import { looksLikePmtiles } from './basemapSource';
import { getRegionPin, saveRegionPin, type RegionPinRecord } from './db';

/** Every manifest entry (core + lazy) as one lookup-ready array. */
function manifestEntries(manifest: RegionManifest): readonly RegionManifestEntry[] {
  return [manifest.core, ...manifest.regions];
}

/** This deployment's region runtime cache — see basemapRegions.ts's regionCacheName. */
const REGION_CACHE_NAME = regionCacheName(import.meta.env.BASE_URL);

function manifestUrl(): string {
  return import.meta.env.BASE_URL + REGION_MANIFEST_PATH;
}

function archiveUrl(entry: RegionManifestEntry): string {
  return import.meta.env.BASE_URL + entry.path;
}

/**
 * Reads the manifest from CacheStorage ONLY — never touches the network.
 * The manifest is a small build-emitted JSON asset covered by the same
 * precache mechanism as glyph-manifest.json (lib/glyphs.ts's own comment),
 * so `caches.match` (which searches every cache, precache included) finds it
 * whenever the SW has ever installed — exactly the network-free contract
 * regionReadiness needs.
 *
 * `{ ignoreSearch: true }` is load-bearing (PWA review Blocker r4008640242,
 * measured in Chromium): workbox's precache stamps an unhashed asset's cache
 * key with a `?__WB_REVISION__=<rev>` query it derives from the asset's own
 * content, so the bare BASE_URL-relative path this function would otherwise
 * look up never matches what is actually stored — `regionReadiness` would be
 * permanently `not-ready` in a real build despite a healthy precache.
 * Accepted transient: between SW install and activate, two revisions can
 * coexist in the precache and `ignoreSearch` may return either one.
 *
 * Returns `null` on ANY failure (no `caches`, no match, a response that
 * fails to parse or validate) — this is the ONLY manifest reader
 * regionReadiness may call.
 */
async function readManifestFromCache(): Promise<RegionManifest | null> {
  if (!('caches' in globalThis)) return null;
  try {
    const res = await caches.match(manifestUrl(), { ignoreSearch: true });
    if (!res) return null;
    const data: unknown = await res.clone().json();
    return parseRegionManifest(data);
  } catch {
    return null;
  }
}

/**
 * Reads the manifest for pinning: cache first (cheap, and correct once the
 * SW has installed), falling back to a real network fetch — pinning already
 * requires network for the archives themselves, so a plain fetch fallback
 * here (unlike readManifestFromCache) does not weaken any guarantee.
 */
async function fetchManifestForPinning(): Promise<RegionManifest | null> {
  const cached = await readManifestFromCache();
  if (cached) return cached;
  try {
    const res = await fetch(manifestUrl(), { cache: 'no-store' });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return parseRegionManifest(data);
  } catch {
    return null;
  }
}

/**
 * True iff `entry`'s archive is present in the region cache AND its stored
 * length matches the manifest's `bytes` exactly. Storage-only (CacheStorage
 * `match`, no `fetch`) — safe to call from regionReadiness. The stored
 * `content-length` header is one THIS module wrote at pin time from the
 * decoded Blob's own `.size` (never trusted from a network response header —
 * see pinOneRegion), so this equality check is comparing two locally-derived
 * numbers, not re-trusting anything from the network. Deliberately `===`,
 * never `>=`: an OVERSIZED stored length (a corrupted or substituted
 * archive) must not count as present either (conventions review, PR #1225
 * inline r4008643175).
 */
async function isArchivePresent(entry: RegionManifestEntry): Promise<boolean> {
  try {
    const cache = await caches.open(REGION_CACHE_NAME);
    const res = await cache.match(archiveUrl(entry));
    if (!res) return false;
    const len = Number(res.headers.get('content-length'));
    return Number.isFinite(len) && len === entry.bytes;
  } catch {
    return false;
  }
}

/**
 * Every leg from every sail this plan has a result for — union, not just the
 * recommended sail. #324 can render the non-recommended rig's track on the
 * map too, so a corridor derived from the recommended sail ALONE could
 * silently miss a region only the other rig's track crosses. Per this
 * module's guard-asymmetry header, requiring a possibly-unneeded region is
 * the safe direction; requiring too few is not.
 */
function planLegs(plan: Plan): readonly Pick<Leg, 'start' | 'end'>[] {
  const legs: Pick<Leg, 'start' | 'end'>[] = [];
  for (const sail of plan.result.sails) {
    if (sail.result) legs.push(...sail.result.legs);
  }
  return legs;
}

/** Required lazy-region ids for `plan` given an already-fetched `manifest`. */
function requiredRegionIdsForPlan(plan: Plan, manifest: RegionManifest): readonly string[] {
  const corridorBoxes = routeCorridorBoxes(planLegs(plan), null, AIS_CORRIDOR_HALF_WIDTH_NM);
  return requiredRegions(manifestEntries(manifest), corridorBoxes);
}

/**
 * Resolves each required id to its manifest entry. The `.filter` below is
 * for TypeScript's benefit only, not a runtime possibility: `ids` is always
 * `requiredRegions(manifestEntries(manifest), ...)`'s OWN output over this
 * SAME `manifest`, so every id it returns is drawn from `manifest`'s own
 * entries and `regionById` over that same array can never fail to find one
 * (PWA review Minor r4008640282 confirmed this is structurally unreachable —
 * a prior explicit "entries.length !== ids.length -> not-ready" branch here
 * was deleted rather than kept as an untestable guard claiming protection).
 */
function resolveEntries(
  manifest: RegionManifest,
  ids: readonly string[],
): readonly RegionManifestEntry[] {
  const entries = ids.map((id) => regionById(manifestEntries(manifest), id));
  return entries.filter((e): e is RegionManifestEntry => e !== undefined);
}

export type PinRegionsOutcome =
  | { readonly status: 'pinned'; readonly total: number; readonly pinned: number }
  | { readonly status: 'manifest-unavailable' }
  // The archives themselves were fetched/verified (or attempted) — only the
  // pin-INTENT record failed to write (IndexedDB quota, or the
  // cross-deployment DB_VERSION VersionError window the PWA review recorded
  // on db.ts — maintainer ruling: keep the v3 bump, #1164 issue comment
  // 5669811466). Named as a distinct outcome rather than letting
  // pinRegionsForPlan's promise reject after real work already happened
  // (PWA review Minor r4008640266).
  | { readonly status: 'pin-record-failed'; readonly total: number; readonly pinned: number }
  // #1233 Major (offline/PWA review): the plan was deleted while its
  // archives were still being fetched. The archives may still have been
  // cached (harmless and reusable — content-addressed by region, not by
  // plan), but db.ts's saveRegionPin found no matching plan row and wrote
  // no pin-intent record, by design (see its own comment).
  | { readonly status: 'plan-gone'; readonly total: number; readonly pinned: number };

/**
 * Fetches every region archive `plan`'s route corridor requires that is not
 * already cached, verifies each fetched body's decoded byte length against
 * the manifest before caching it (a short/mismatched body is NEVER pinned —
 * `pinned` will simply be less than `total`), and records the plan's pin
 * intent in IndexedDB (services/db.ts's `pins` store) once the required set
 * is known. The CORE archive is never touched here — it is precached
 * unconditionally by the SW build and requiredRegions() already excludes it.
 *
 * Does NOT update anything read by regionReadiness other than CacheStorage
 * itself — readiness is re-derived fresh on every call, never cached.
 */
export async function pinRegionsForPlan(plan: Plan): Promise<PinRegionsOutcome> {
  const manifest = await fetchManifestForPinning();
  if (manifest === null) {
    // Fail closed: cannot determine which regions this plan needs, so pin
    // NOTHING rather than guess — see this module's header comment.
    return { status: 'manifest-unavailable' };
  }

  const ids = requiredRegionIdsForPlan(plan, manifest);
  const entries = resolveEntries(manifest, ids);

  let pinned = 0;
  for (const entry of entries) {
    if (await pinOneRegion(entry)) pinned += 1;
  }

  let writeOutcome: 'saved' | 'plan-gone';
  try {
    writeOutcome = await saveRegionPin(plan.id, (currentPlan) => ({
      planId: plan.id,
      // Recomputed from the plan row `saveRegionPin` reads INSIDE its own
      // transaction, never from the `ids` computed above — #1233 Minor: two
      // same-id pins racing must converge on the corridor the plan ACTUALLY
      // has, regardless of which call's archive downloads happen to finish
      // last.
      regionIds: requiredRegionIdsForPlan(currentPlan, manifest),
      pinnedAtMs: Date.now(),
    }));
  } catch {
    return { status: 'pin-record-failed', total: ids.length, pinned };
  }

  if (writeOutcome === 'plan-gone') {
    return { status: 'plan-gone', total: ids.length, pinned };
  }
  return { status: 'pinned', total: ids.length, pinned };
}

/**
 * The pin INTENT recorded for `planId` by a prior pinRegionsForPlan call, if
 * any — service-level wrapper over db.ts's `pins` store so a future call
 * site (e.g. a saved-plan list, #295) never needs to import services/db.ts
 * directly for this. This is NOT a readiness check: use regionReadiness for
 * that (see this module's header comment on why the two must stay separate).
 */
export async function getRegionPinIntent(planId: string): Promise<RegionPinRecord | undefined> {
  return getRegionPin(planId);
}

/**
 * True iff `blob`'s first two bytes are the PMTiles magic — reuses
 * basemapSource.ts's own `looksLikePmtiles` (the #118 preflight check)
 * rather than re-implementing the magic-number test a second time.
 */
async function isPmtilesBlob(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return looksLikePmtiles(head);
}

// #1233 Major 2 (offline/PWA review): every concurrent caller for the SAME
// archive URL shares ONE in-flight fetch/verify/cache.put instead of each
// starting its own — a bulk plan import, or two plans whose corridors share
// a region, would otherwise fire one full multi-MB download PER PLAN. Keyed
// by the CANONICAL (search-less) url PLUS the manifest's expected byte
// length (#1246: url alone let a waiter across a SW update with two live
// manifests accept a `true` verified against the OTHER manifest's size —
// harmless in practice since isArchivePresent re-checks length on the next
// regionReadiness call, but not exact), so it is stable across every
// `?pin=<token>` cache-busting attempt below. Cleared once the attempt
// settles (success OR failure) so a LATER, separate pin — after this one is
// fully done — starts fresh rather than replaying a stale result forever.
const inFlightRegionFetches = new Map<string, Promise<boolean>>();

function coalescingKey(url: string, bytes: number): string {
  return `${url}::${bytes}`;
}

async function pinOneRegion(entry: RegionManifestEntry): Promise<boolean> {
  const url = archiveUrl(entry);
  const key = coalescingKey(url, entry.bytes);
  // #1246: checked BEFORE the async isArchivePresent read below, not only
  // after it — an attempt already in flight when THIS call starts is caught
  // immediately, closing the gap where isArchivePresent's own await could
  // straddle that in-flight attempt's completion (it finishes and removes
  // itself from the Map while this call is still awaiting, so a check placed
  // only after the await would find neither and start a redundant download).
  const before = inFlightRegionFetches.get(key);
  if (before) return before;
  if (await isArchivePresent(entry)) return true;
  // Re-checked: #1233 Major 2's coalescing depends on this SECOND check — a
  // sibling call may have started (and set) an attempt while THIS call was
  // itself awaiting isArchivePresent above.
  const existing = inFlightRegionFetches.get(key);
  if (existing) return existing;
  const attempt = fetchAndCacheRegion(entry, url).finally(() => {
    inFlightRegionFetches.delete(key);
  });
  inFlightRegionFetches.set(key, attempt);
  return attempt;
}

/**
 * Fetches and caches one region archive, verifying its DECODED size (never
 * the response's Content-Length — a re-gzipping CDN could inflate that
 * transparently, the same #118 lesson `basemapSource.ts` documents) against
 * the manifest before `cache.put`. A short or wrong-length body is left
 * uncached entirely. Idempotent: an already-correctly-cached entry short-
 * circuits without a network request (`pinOneRegion`'s own `isArchivePresent`
 * check — this function is reached only past that gate). Split out of
 * `pinOneRegion` so the coalescing map above can share ONE Promise across
 * every concurrent caller for the same `url` (#1233 Major 2).
 *
 * NEVER `cache.delete`s a stale entry before fetching (successor fix, PR
 * review r4009096166, replacing an earlier `cache.delete`-then-fetch
 * version): measured in Chromium with a real region archive and #1223's
 * route merged in, deleting first is destructive OFFLINE — a length-
 * mismatched (stale) entry the map was still serving 206s from is erased,
 * and if the re-fetch then fails (offline, or a magic/size mismatch), the
 * region is left with NOTHING servable where a moment ago it had a stale
 * but working copy. Instead, the fetch goes through a cache-busting
 * `?pin=<token>` query so #1223's `basemapArchiveRoute.ts` — whose
 * `regionCache.match(request.url)` is an EXACT-URL match with no
 * `ignoreSearch`, and whose `isRegionArchivePath` check reads only
 * `pathname`, ignoring the query — cannot hit the region cache for THIS
 * request and falls straight through to network (the Pages CDN normalises
 * query strings, so the response body is unaffected). Only once the fetched
 * body is verified (magic + exact byte length) does `cache.put` write it
 * under the CANONICAL (search-less) URL, where `put` REPLACES the old
 * value atomically — the stale copy remains servable right up until a
 * verified replacement exists, and is never left absent.
 */
async function fetchAndCacheRegion(entry: RegionManifestEntry, url: string): Promise<boolean> {
  // #1253: a NO-PROGRESS watchdog, not a whole-download deadline — the old
  // deadline was sized for the archive's TOTAL bytes at a fixed floor
  // throughput, so a link steadily BELOW that rate could never finish: every
  // retry re-downloaded the whole body before the fixed deadline fired
  // again. Resetting the timer on every received chunk instead lets a
  // slow-but-still-moving link run to completion, while a genuine stall
  // (#295's original motivation — the chip must not sit at "saving" forever)
  // still fails quickly.
  const deadline = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => deadline.abort(), REGION_FETCH_STALL_MS);
  };
  armStall();
  try {
    // `cache: 'no-store'` (PWA review Minor r4008640259): region archive
    // paths are unhashed, so without it an HTTP-cached copy from a PREVIOUS
    // build could be served whenever its length happens to match the
    // current manifest's. The `?pin=` query is what makes the SW's region-
    // cache lookup miss (see this function's own doc comment); `no-store`
    // is the separate, still-needed guard against the browser's OWN HTTP
    // cache serving a stale body for that busted URL.
    const res = await fetch(`${url}?pin=${Date.now()}`, {
      cache: 'no-store',
      signal: deadline.signal,
    });
    if (!res.ok) return false;
    // Headers arrived: the watchdog is re-armed before reading the body so
    // a slow TTFB does not eat into the first chunk's own allowance.
    armStall();
    const blob = await readBodyWithStallWatchdog(res, armStall);
    if (blob === null) return false;
    // PMTiles magic check (same review): cheap, and mirrors
    // basemapSource.ts's own #118 preflight — reject a body that isn't
    // actually a PMTiles archive before it is ever cached.
    if (!(await isPmtilesBlob(blob))) return false;
    if (blob.size !== entry.bytes) return false;
    const cache = await caches.open(REGION_CACHE_NAME);
    // Stamp our own content-length from the verified Blob size so
    // isArchivePresent's later reads are a cheap header check, never a full
    // body drain (mirrors #118's basemapSource.ts pattern for the same
    // reason).
    await cache.put(url, new Response(blob, { headers: { 'content-length': String(blob.size) } }));
    return true;
  } catch {
    return false;
  } finally {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
  }
}

/**
 * Reads `res`'s body into a Blob, calling `onChunk` after every chunk
 * actually received so the caller's stall watchdog stays armed. Falls back
 * to a plain `res.blob()` when the environment exposes no readable stream —
 * the body is then already buffered whole by the fetch implementation, so
 * there is no per-chunk progress signal to arm on regardless.
 */
async function readBodyWithStallWatchdog(res: Response, onChunk: () => void): Promise<Blob | null> {
  if (!res.body) return res.blob();
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Copied (not just re-wrapped) so the element type is a plain
      // ArrayBuffer-backed Uint8Array — the DOM lib types reader.read()'s
      // value as ArrayBufferLike-backed, which BlobPart rejects.
      chunks.push(new Uint8Array(value));
      onChunk();
    }
    return new Blob(chunks);
  } catch {
    return null;
  }
}

/**
 * Longest gap allowed between two received chunks of a region archive
 * download before it counts as stalled — see fetchAndCacheRegion's own
 * comment for why this replaced a whole-download deadline. Chosen so a
 * genuine stall (#295's original motivation) still fails within roughly the
 * old floor's per-chunk cadence, while a slow-but-moving link is never
 * penalised for its total size.
 */
export const REGION_FETCH_STALL_MS = 60_000;

export type RegionReadinessReason =
  // The manifest could not be read from CacheStorage at all — "uncertain",
  // and per this module's guard-asymmetry header, uncertain fails closed.
  | 'manifest-unavailable'
  // The manifest resolved fine and named N > 0 required regions, but not
  // ALL of them are verified present yet — whether zero are cached
  // (pinRegionsForPlan was never run, or the region cache was retired by a
  // REGION_CACHE_VERSION bump) or some but not all are (a partial pin: one
  // archive 404'd or arrived short-bodied). Both read identically from a
  // network-free snapshot, and neither is distinguishable from "genuinely
  // downloading right now" — see this module's header comment.
  | 'pending';

export type RegionReadiness =
  | { readonly state: 'ready'; readonly done: number; readonly total: number }
  | { readonly state: 'not-ready'; readonly reason: RegionReadinessReason };

export interface RegionReadinessAndBytes {
  readonly readiness: RegionReadiness;
  /** Total bytes the plan's required lazy regions add up to; null when unknown. */
  readonly bytes: number | null;
}

/**
 * Network-free offline-readiness check for `plan`, combined with the total
 * download size — one manifest read, one corridor computation and one
 * isArchivePresent pass, rather than useRegionReadiness.ts running that same
 * work twice (#1253 residual from PR #1249). Reads the manifest from
 * CacheStorage only (readManifestFromCache — never `fetch`) and checks each
 * required archive's presence+byte-length in CacheStorage only
 * (isArchivePresent — also never `fetch`), so this function makes zero
 * network requests under any input, matching the CLAUDE.md/PR #1219 rule
 * that offline readiness must be independently re-derivable, never cached as
 * a boolean that a REGION_CACHE_VERSION bump could silently invalidate.
 *
 * `total === 0` (a plan whose corridor needs no lazy region — e.g. the
 * shipped v0.34.0 single-region deployment, where every plan is trivially
 * ready) reports 'ready' with `done: 0` and `bytes: 0`: the core archive is
 * precached unconditionally, so there is nothing left to wait for.
 */
export async function regionReadinessAndBytes(plan: Plan): Promise<RegionReadinessAndBytes> {
  const manifest = await readManifestFromCache();
  if (manifest === null) {
    return { readiness: { state: 'not-ready', reason: 'manifest-unavailable' }, bytes: null };
  }

  const ids = requiredRegionIdsForPlan(plan, manifest);
  if (ids.length === 0) {
    return { readiness: { state: 'ready', done: 0, total: 0 }, bytes: 0 };
  }

  const entries = resolveEntries(manifest, ids);

  let done = 0;
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes;
    if (await isArchivePresent(entry)) done += 1;
  }

  const readiness: RegionReadiness =
    done === entries.length
      ? { state: 'ready', done, total: entries.length }
      : { state: 'not-ready', reason: 'pending' };
  return { readiness, bytes };
}

/** Readiness alone — see regionReadinessAndBytes for what this shares. */
export async function regionReadiness(plan: Plan): Promise<RegionReadiness> {
  return (await regionReadinessAndBytes(plan)).readiness;
}

/**
 * Total byte size of the lazy region archives `plan` requires — see
 * regionReadinessAndBytes for what this shares. Shown on the #295 chip.
 */
export async function regionDownloadBytes(plan: Plan): Promise<number | null> {
  return (await regionReadinessAndBytes(plan)).bytes;
}

// Re-exported so a future call site (and this file's own tests) can name
// the core id without importing basemapRegions.ts directly for it.
export { CORE_REGION_ID };
