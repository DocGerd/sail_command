// #1164 T5: ONE MapLibre basemap source over a composite protocol that routes
// each tile to the core archive or the region archive covering it (maintainer
// ruling on #1164, deliberately not the #296 spike's one-source-per-region:
// `@protomaps/basemaps` layer ids are fixed, so N sources would need N layer
// stacks and double-render shared tiles).
//
// Failure asymmetry:
//  - CORE failures throw, reaching MapLibre's `error` event and MapView's
//    map-error banner exactly as the plain pmtiles protocol did.
//  - REGION failures (unpinned + offline, 404, SW-uncontrolled page) resolve
//    to an EMPTY tile (one console.warn per archive): the area renders blank
//    and never trips the banner or swRecovery. No full-archive Blob fallback for regions (ruling 4).
import { PMTiles, TileType } from 'pmtiles';
import type { Header } from 'pmtiles';
import type { AddProtocolAction, GetResourceResponse, RequestParameters } from 'maplibre-gl';
import {
  CORE_REGION_ID,
  isRegionArchivePath,
  type RegionBbox,
  type RegionManifestEntry,
} from '../lib/basemapRegions';

/** Scheme registered with MapLibre's `addProtocol`. */
export const BASEMAP_SCHEME = 'sc-basemap';
/** The style's source `url` — one composite source, not an archive href. */
export const BASEMAP_SOURCE_URL = `${BASEMAP_SCHEME}://basemap`;
/** BASE_URL-relative manifest path emitted by the build (T2, PR #1220). */
// Twin of the `fileName` in `app/vite.config.ts`'s `regionManifest()`; keep both in sync.
export const REGION_MANIFEST_PATH = 'basemap-regions.json';

// The manifest is precached (#1220), so a network wait this long means lie-fi; the core map waits on it.
export const MANIFEST_TIMEOUT_MS = 3_000;

// Offline, a failed region is retried at most once per window instead of once per tile.
export const REGION_RETRY_MS = 30_000;

const TILE_URL_RE = /^sc-basemap:\/\/basemap\/(\d+)\/(\d+)\/(\d+)$/;

/** The slice of `PMTiles` this module reads; injectable for tests. */
export type BasemapArchive = Pick<PMTiles, 'getHeader' | 'getZxy'>;

/** Web-Mercator tile bounds as `[minLon, minLat, maxLon, maxLat]`. */
export function tileBbox(z: number, x: number, y: number): RegionBbox {
  const n = 2 ** z;
  const lat = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

function isValidBbox(b: unknown): b is RegionBbox {
  if (!Array.isArray(b) || b.length !== 4) return false;
  const [minLon, minLat, maxLon, maxLat] = b as unknown[];
  return (
    typeof minLon === 'number' &&
    typeof minLat === 'number' &&
    typeof maxLon === 'number' &&
    typeof maxLat === 'number' &&
    Number.isFinite(minLon) &&
    Number.isFinite(minLat) &&
    Number.isFinite(maxLon) &&
    Number.isFinite(maxLat) &&
    minLon <= maxLon &&
    minLat <= maxLat
  );
}

/** Positive-area overlap; boxes touching only along an edge do not overlap. */
function overlaps(a: RegionBbox, b: RegionBbox): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export type TileArchiveChoice =
  | { readonly kind: 'core' }
  | { readonly kind: 'region'; readonly entry: RegionManifestEntry }
  | { readonly kind: 'none' };

/**
 * Which archive serves tile z/x/y. CORE WINS wherever the core bbox overlaps
 * the tile: the core is precached and always available, and `pmtiles extract
 * --bbox` keeps whole tiles, so a seam tile the core holds is complete.
 * Otherwise the first overlapping region in manifest order, else `none` (the
 * gap between the core and a disjoint region inside the union bounds). A
 * malformed core bbox fails toward core; a malformed region is never chosen.
 */
export function selectTileArchive(
  z: number,
  x: number,
  y: number,
  coreBbox: RegionBbox,
  regions: readonly RegionManifestEntry[],
): TileArchiveChoice {
  const tile = tileBbox(z, x, y);
  if (!isValidBbox(coreBbox) || overlaps(coreBbox, tile)) return { kind: 'core' };
  const entry = regions.find((r) => isValidBbox(r.bbox) && overlaps(r.bbox, tile));
  return entry ? { kind: 'region', entry } : { kind: 'none' };
}

/**
 * Lazy region entries from `<BASE_URL>basemap-regions.json`. Fails toward
 * `[]` (core only, i.e. today's map) on any fetch/shape problem. Silent for a
 * missing file or a non-JSON answer (vite's SPA fallback serves HTML); warns
 * only for a JSON body that fails validation.
 */
export async function loadRegionEntries(manifestUrl: string): Promise<RegionManifestEntry[]> {
  let body: unknown;
  // Own controller, never a tile's signal: the result is memoised for every request.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const res = await fetch(manifestUrl, { signal: timeout.signal });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return [];
    body = await res.json();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
  const regions = (body as { regions?: unknown } | null)?.regions;
  if (!Array.isArray(regions)) {
    console.warn('[#1164] basemap region manifest has no regions array — core only');
    return [];
  }
  const valid: RegionManifestEntry[] = [];
  for (const r of regions as unknown[]) {
    const e = r as Partial<Record<keyof RegionManifestEntry, unknown>> | null;
    if (
      e !== null &&
      typeof e === 'object' &&
      typeof e.id === 'string' &&
      e.id !== CORE_REGION_ID &&
      typeof e.path === 'string' &&
      isRegionArchivePath(e.path) &&
      typeof e.bytes === 'number' &&
      isValidBbox(e.bbox)
    ) {
      valid.push({ id: e.id, path: e.path, bytes: e.bytes, bbox: e.bbox });
    } else {
      console.warn('[#1164] skipping malformed basemap region manifest entry', r);
    }
  }
  return valid;
}

export interface BasemapProtocolConfig {
  /** Absolute core archive href — the SAME string any Blob fallback was `add`ed under. */
  readonly coreUrl: string;
  /** Absolute BASE_URL href that region `path`s and the manifest resolve against. */
  readonly baseHref: string;
  /** False on SW-uncontrolled pages: no manifest fetch, regions never read (ruling 4). */
  readonly regionsEnabled: boolean;
}

const EMPTY_TILE = (): GetResourceResponse<Uint8Array> => ({ data: new Uint8Array() });

export class CompositeBasemapProtocol {
  readonly #archives = new Map<string, BasemapArchive>();
  readonly #open: (href: string) => BasemapArchive;
  readonly #loadRegions: (manifestUrl: string) => Promise<RegionManifestEntry[]>;
  readonly #regionRetryAt = new Map<string, number>();
  readonly #warnedRegions = new Set<string>();
  #config: BasemapProtocolConfig | null = null;
  #regions: Promise<RegionManifestEntry[]> | null = null;

  constructor(
    open: (href: string) => BasemapArchive = (href) => new PMTiles(href),
    loadRegions: (manifestUrl: string) => Promise<RegionManifestEntry[]> = loadRegionEntries,
  ) {
    this.#open = open;
    this.#loadRegions = loadRegions;
  }

  /**
   * Registers a pre-built archive under its source key — the #118 core Blob
   * fallback (`ensureBasemapProtocolSource`). Survives `configure`.
   */
  add(p: Pick<PMTiles, 'source' | 'getHeader' | 'getZxy'>): void {
    this.#archives.set(p.source.getKey(), p);
  }

  /** Per-mount wiring; must run before the map requests its source. */
  configure(config: BasemapProtocolConfig): void {
    this.#config = config;
    this.#regions = null;
  }

  #requireConfig(): BasemapProtocolConfig {
    if (!this.#config) throw new Error('basemap protocol used before configure()');
    return this.#config;
  }

  // Check-then-set is synchronous, so concurrent first requests for one href share an instance.
  #archive(href: string): BasemapArchive {
    let a = this.#archives.get(href);
    if (!a) {
      a = this.#open(href);
      this.#archives.set(href, a);
    }
    return a;
  }

  #regionEntries(config: BasemapProtocolConfig): Promise<RegionManifestEntry[]> {
    if (!config.regionsEnabled) return Promise.resolve([]);
    this.#regions ??= this.#loadRegions(new URL(REGION_MANIFEST_PATH, config.baseHref).href);
    return this.#regions;
  }

  /** MapLibre `addProtocol` handler (v4 signature). */
  tile: AddProtocolAction = async (params: RequestParameters, abortController: AbortController) => {
    const config = this.#requireConfig();
    const signal = abortController.signal;
    const core = this.#archive(config.coreUrl);

    if (params.type === 'json') {
      const h = await core.getHeader();
      signal.throwIfAborted();
      if (h.minLon >= h.maxLon || h.minLat >= h.maxLat) {
        console.error(
          `Bounds of PMTiles archive ${h.minLon},${h.minLat},${h.maxLon},${h.maxLat} are not valid.`,
        );
      }
      // minzoom/maxzoom come from the core header only (no region header
      // fetch until a region tile is needed): a region must share the core
      // build's zoom range, or MapLibre overzooms it past the core maxzoom.
      // Bounds are the UNION — core-only bounds would stop MapLibre ever
      // requesting a region tile.
      let [minLon, minLat, maxLon, maxLat] = [h.minLon, h.minLat, h.maxLon, h.maxLat];
      for (const r of await this.#regionEntries(config)) {
        minLon = Math.min(minLon, r.bbox[0]);
        minLat = Math.min(minLat, r.bbox[1]);
        maxLon = Math.max(maxLon, r.bbox[2]);
        maxLat = Math.max(maxLat, r.bbox[3]);
      }
      signal.throwIfAborted();
      return {
        data: {
          tiles: [`${params.url}/{z}/{x}/{y}`],
          minzoom: h.minZoom,
          maxzoom: h.maxZoom,
          bounds: [minLon, minLat, maxLon, maxLat],
        },
      };
    }

    const m = TILE_URL_RE.exec(params.url);
    if (!m) throw new Error('Invalid basemap protocol URL');
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];

    const regions = await this.#regionEntries(config);
    if (regions.length === 0) return readTile(core, z, x, y, signal);

    const h = await core.getHeader();
    const choice = selectTileArchive(z, x, y, [h.minLon, h.minLat, h.maxLon, h.maxLat], regions);
    if (choice.kind === 'core') return readTile(core, z, x, y, signal);
    if (choice.kind === 'none') return EMPTY_TILE();

    const href = new URL(choice.entry.path, config.baseHref).href;
    const retryAt = this.#regionRetryAt.get(href);
    if (retryAt !== undefined && Date.now() < retryAt) return EMPTY_TILE();
    const region = this.#archive(href);
    try {
      const out = await readTile(region, z, x, y, signal);
      this.#regionRetryAt.delete(href);
      return out;
    } catch (err) {
      if (signal.aborted) throw err;
      // pmtiles' SharedPromiseCache keeps a REJECTED header promise forever,
      // so a region that failed while unpinned would stay blank after
      // pinning. Drop the instance; the first request after the window rebuilds it.
      if (this.#archives.get(href) === region) this.#archives.delete(href);
      this.#regionRetryAt.set(href, Date.now() + REGION_RETRY_MS);
      if (!this.#warnedRegions.has(href)) {
        this.#warnedRegions.add(href);
        console.warn(`[#1164] basemap region archive unavailable, rendering blank: ${href}`, err);
      }
      return EMPTY_TILE();
    }
  };
}

/** Mirrors pmtiles' `Protocol.tilev4` tile branch for one archive. */
async function readTile(
  archive: BasemapArchive,
  z: number,
  x: number,
  y: number,
  signal: AbortSignal,
): Promise<GetResourceResponse<Uint8Array | null>> {
  const resp = await archive.getZxy(z, x, y, signal);
  signal.throwIfAborted();
  if (resp) {
    const out: GetResourceResponse<Uint8Array> = { data: new Uint8Array(resp.data) };
    if (resp.cacheControl !== undefined) out.cacheControl = resp.cacheControl;
    if (resp.expires !== undefined) out.expires = resp.expires;
    return out;
  }
  const header: Header = await archive.getHeader();
  if (header.tileType === TileType.Mvt || header.tileType === TileType.Mlt) return EMPTY_TILE();
  return { data: null };
}

/** The app's single registered instance (MapView registers `tile`). */
export const basemapProtocol = new CompositeBasemapProtocol();
