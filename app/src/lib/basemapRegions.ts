// #1164 basemap split (T1): naming, deployment-scoped region cache names,
// and the required-region rule for per-region lazy basemap archives. Pure
// module — no fetch, no ServiceWorker, no IndexedDB, no MapLibre; sw.ts
// (T3), the pin service (T4) and the map wiring (T5) consume these as plain
// functions. Design source: docs/spikes/296-lazy-load-map-data.md; naming
// and cache scoping settled by the maintainer rulings comment on #1164
// (2026-09-14): a composite pmtiles protocol (not one MapLibre source per
// region), flat archive paths, and fail-toward-not-ready readiness.

import { deploymentSlug } from './glyphs';
import type { AisBoundingBox } from '../services/aisStream';

/** Manifest id of the always-precached core archive (`data/basemap.pmtiles.png`). */
export const CORE_REGION_ID = 'core';

/**
 * Basename prefix for a per-region basemap archive. Regions sit FLAT under
 * `data/` (maintainer ruling: `data/region-<id>.pmtiles.png`), never in a
 * subdirectory — `deploy.yml`'s smoke-probe and archive-discovery globs are
 * `data/*.pmtiles*` and do not recurse, so a subdirectory would silently
 * escape both.
 */
export const REGION_ARCHIVE_PREFIX = 'region-';

/**
 * `[minLon, minLat, maxLon, maxLat]` — the shape and axis order T2 (PR #1220)
 * emits from the PMTiles header (`pmtilesHeaderBbox()`,
 * `app/vite.config.ts`). Deliberately basemap-owned, NOT `AisBoundingBox`
 * (`[[latMin, lonMin], [latMax, lonMax]]`, a different tuple shape AND a
 * different axis order): reusing the AIS type here would couple two
 * unrelated domains and, worse, silently accept a lat/lon-swapped or
 * lon/lat-ordered value as if it were valid (review finding on PR #1219).
 */
export type RegionBbox = readonly [minLon: number, minLat: number, maxLon: number, maxLat: number];

/** One entry of the build-emitted region manifest (`dist/basemap-regions.json`, T2). */
export interface RegionManifestEntry {
  /** CORE_REGION_ID for the always-precached core archive; a region slug otherwise. */
  readonly id: string;
  /** BASE_URL-relative archive path, e.g. `data/region-abc.pmtiles.png`. */
  readonly path: string;
  /** Decoded archive size in bytes, read from the built file — never Content-Length (T4). */
  readonly bytes: number;
  /** See RegionBbox — read from the PMTiles header, never hand-authored. */
  readonly bbox: RegionBbox;
}

/**
 * True for a per-region basemap archive path — the core archive is
 * EXCLUDED. Checks the BASENAME only, so it works whether `pathname` is bare
 * or BASE_URL-prefixed (prod vs `/uat/`). Matches both the `.pmtiles.png`
 * masquerade (#118) and a bare `.pmtiles` suffix, mirroring
 * `basemap.ts`'s `isBasemapArchivePath` — which already matches EVERY
 * archive (region or core) by suffix alone and needs no change for regions
 * (its own #1164/#296 comment says so); this predicate exists only where a
 * region archive must be told apart from the core one, e.g. sw.ts's route
 * (precache -> region runtime cache -> network, T3) and the pin service's
 * "which ids are lazy" question (T4).
 */
export function isRegionArchivePath(pathname: string): boolean {
  const basename = pathname.slice(pathname.lastIndexOf('/') + 1);
  return (
    basename.startsWith(REGION_ARCHIVE_PREFIX) &&
    (basename.endsWith('.pmtiles.png') || basename.endsWith('.pmtiles'))
  );
}

/** Family prefix shared by every deployment's region runtime caches. */
export const REGION_CACHE_PREFIX = 'sailcommand-regions-';

/** Cache version — bump to retire the current runtime cache (mirrors GLYPH_CACHE_VERSION). */
export const REGION_CACHE_VERSION = 'v1';

/** Delimiter separating the deployment slug from the version — see glyphs.ts's prefix-trap note. */
const SLUG_VERSION_DELIM = '@';

function deploymentScopedPrefix(base: string): string {
  return `${REGION_CACHE_PREFIX}${deploymentSlug(base)}${SLUG_VERSION_DELIM}`;
}

/**
 * The runtime cache name for pinned region archives of the deployment served
 * at `base` (#96 pattern, reusing glyphs.ts's `deploymentSlug` rather than
 * re-deriving it — prod and `/uat/` are two SWs on ONE origin, so this MUST
 * stay deployment-scoped or one SW's activate cleanup would evict the
 * other's pinned regions).
 */
export function regionCacheName(base: string): string {
  return `${REGION_CACHE_PREFIX}${deploymentSlug(base)}${SLUG_VERSION_DELIM}${REGION_CACHE_VERSION}`;
}

/**
 * True for a retired region cache of the deployment served at `base` — the
 * same deployment's slug but a non-current version. sw.ts's activate
 * handler (T3) deletes exactly these, and only this deployment's: matching
 * on the deployment-SCOPED prefix (slug + '@'), never a bare
 * `startsWith(slug)`, is what keeps prod's slug from also matching UAT's
 * (`sail_command` is a textual prefix of `sail_command-uat`) — see
 * glyphs.ts's `isRetiredGlyphCache` for the full prefix-trap reasoning this
 * mirrors byte-for-byte.
 */
export function isRetiredRegionCache(name: string, base: string): boolean {
  return name.startsWith(deploymentScopedPrefix(base)) && name !== regionCacheName(base);
}

/**
 * True for a well-formed RegionBbox: every coordinate finite AND
 * minLon <= maxLon AND minLat <= maxLat. A malformed value (NaN,
 * +/-Infinity, or a reversed min/max — e.g. a T2 bug transcribing the
 * PMTiles header's named fields into the wrong tuple slots) must NOT be
 * treated as "provably non-intersecting" by boxesIntersect below.
 */
function isValidRegionBbox(b: RegionBbox): boolean {
  const [minLon, minLat, maxLon, maxLat] = b;
  return (
    Number.isFinite(minLon) &&
    Number.isFinite(minLat) &&
    Number.isFinite(maxLon) &&
    Number.isFinite(maxLat) &&
    minLon <= maxLon &&
    minLat <= maxLat
  );
}

/** Same well-formedness check for an AIS-domain corridor box. */
function isValidCorridorBox(b: AisBoundingBox): boolean {
  const [[latMin, lonMin], [latMax, lonMax]] = b;
  return (
    Number.isFinite(latMin) &&
    Number.isFinite(lonMin) &&
    Number.isFinite(latMax) &&
    Number.isFinite(lonMax) &&
    latMin <= latMax &&
    lonMin <= lonMax
  );
}

/**
 * Inclusive-edges overlap test between a region's RegionBbox and a
 * corridor's AisBoundingBox (two DIFFERENT tuple shapes and axis orders —
 * see RegionBbox's own comment) — touching boxes count as intersecting
 * (routeCorridor.ts's convention).
 *
 * FAIL-CLOSED on a malformed operand (review finding on PR #1219): if
 * EITHER box fails isValidRegionBbox/isValidCorridorBox, this returns
 * `true` unconditionally rather than attempting a comparison whose result
 * would be meaningless. Requiring a region on bad geometry is the safe
 * direction — under-requiring (silently excluding a region that a malformed
 * bbox happens to make LOOK non-intersecting) is what would leave a plan
 * "offline-ready" while actually missing tiles, the same guard-asymmetry
 * this module's requiredRegions() already applies to an empty corridor.
 */
function boxesIntersect(region: RegionBbox, corridor: AisBoundingBox): boolean {
  if (!isValidRegionBbox(region) || !isValidCorridorBox(corridor)) {
    return true;
  }
  const [minLon, minLat, maxLon, maxLat] = region;
  const [[latMin, lonMin], [latMax, lonMax]] = corridor;
  return minLon <= lonMax && lonMin <= maxLon && minLat <= latMax && latMin <= maxLat;
}

/**
 * Look up a manifest entry by id via `Object.hasOwn` — never `in`, which
 * walks the prototype chain, so an id equal to an `Object.prototype` member
 * name (e.g. "toString") would otherwise resolve through the chain instead
 * of missing (CLAUDE.md's `in`-vs-`Object.hasOwn` rule, #614). Manifest
 * entries are build-emitted (T2), not literally untrusted, but a lookup
 * table keyed by ANY string must not rely on the id list happening to avoid
 * those names.
 */
export function regionById(
  entries: readonly RegionManifestEntry[],
  id: string,
): RegionManifestEntry | undefined {
  const index: Record<string, RegionManifestEntry> = {};
  for (const entry of entries) index[entry.id] = entry;
  return Object.hasOwn(index, id) ? index[id] : undefined;
}

/**
 * Region ids that must be pinned for the given corridor to be "offline
 * ready". The CORE archive is never included — it is precached
 * unconditionally and is never a pin target. A lazy region is required when
 * its bbox intersects (inclusive edges) ANY corridor box.
 *
 * FAIL-CLOSED on an empty corridor (#1164 plan §3.3): `routeCorridor.ts`'s
 * `routeCorridorBoxes()` returns `[]` when the summed area exceeds
 * `AIS_CORRIDOR_MAX_AREA_NM2` — that means "the cap dropped coverage", never
 * "nothing is needed". Reading `[]` as "require nothing" would report a plan
 * "offline-ready" having pinned zero regions — the expensive failure
 * direction for a readiness claim, per CLAUDE.md's guard-asymmetry rule (an
 * absent-measurement path must fail toward the expensive-but-safe outcome).
 * An empty corridor therefore requires EVERY lazy region in the manifest.
 *
 * ALSO FAIL-CLOSED on a malformed bbox on EITHER side (a manifest entry's
 * RegionBbox or a corridor box) — see boxesIntersect's own comment. Such an
 * entry is required against ANY non-empty corridor, and a single malformed
 * corridor box makes EVERY lazy region required (boxesIntersect returns
 * `true` unconditionally for that pairing, which `.some()` then propagates).
 */
export function requiredRegions(
  entries: readonly RegionManifestEntry[],
  corridorBoxes: readonly AisBoundingBox[],
): readonly string[] {
  const lazy = entries.filter((entry) => entry.id !== CORE_REGION_ID);
  if (corridorBoxes.length === 0) {
    return lazy.map((entry) => entry.id);
  }
  return lazy
    .filter((entry) => corridorBoxes.some((box) => boxesIntersect(entry.bbox, box)))
    .map((entry) => entry.id);
}
