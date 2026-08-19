import type { Harbor, MaskMeta, PolarTable } from '../types';
import type { SeamarkFeatureCollection } from '../lib/seamarkGeoJson';
import { BOATS, polarKey } from '../data/boats';

export interface RoutingAssets {
  maskMeta: MaskMeta;
  maskBuffer: ArrayBuffer;
  // #54 spec F.3: every catalogue boat's polars, keyed `${boatId}/${sailId}`
  // by polarKey(). Replaces the two named fields — the catalogue is the only
  // enumeration of what exists, so a new boat needs no change here.
  polars: Readonly<Record<string, PolarTable>>;
  harbors: Harbor[];
  // #7: fetched alongside harbors.json (same offline-precached asset tier —
  // small, plan-independent, useful before any route exists). Presentation
  // only; never touched by the routing worker.
  seamarks: SeamarkFeatureCollection;
}

// Build-time committed assets under app/public/data/ — fetched once and
// cached for the lifetime of the page. Never re-fetched or invalidated at
// runtime (pipeline/ regenerates them; the app just trusts what shipped).
let cached: Promise<RoutingAssets> | null = null;

async function fetchOk(path: string): Promise<Response> {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
  if (!res.ok) throw new Error(`failed to fetch ${path}: HTTP ${res.status}`);
  return res;
}

function fetchJson<T>(path: string): Promise<T> {
  return fetchOk(path).then((res) => res.json() as Promise<T>);
}

function fetchBuffer(path: string): Promise<ArrayBuffer> {
  return fetchOk(path).then((res) => res.arrayBuffer());
}

// #54: the catalogue IS the manifest — one entry per boat × sail, replacing
// the two hardcoded fetch paths. Module scope so it is built once rather than
// on every (usually cache-hitting) call below.
const POLAR_SPECS = BOATS.flatMap((b) =>
  b.sails.map((s) => ({ key: polarKey(b.id, s.id), asset: s.polarAsset })),
);

/** Fetched once, module-cached; BASE_URL-relative. */
export function loadRoutingAssets(): Promise<RoutingAssets> {
  cached ??= Promise.all([
    fetchJson<MaskMeta>('data/mask.meta.json'),
    fetchBuffer('data/mask.bin'),
    Promise.all(POLAR_SPECS.map((p) => fetchJson<PolarTable>(p.asset))),
    fetchJson<Harbor[]>('data/harbors.json'),
    fetchJson<SeamarkFeatureCollection>('data/seamarks.json'),
  ]).then(([maskMeta, maskBuffer, polarTables, harbors, seamarks]) => ({
    maskMeta,
    maskBuffer,
    polars: Object.fromEntries(POLAR_SPECS.map((p, i) => [p.key, polarTables[i]])),
    harbors,
    seamarks,
  }));
  // A rejection (e.g. a transient network blip on first load) must not pin
  // every later call to the same dead promise — reset the singleton so the
  // next call retries. Attached as a side-effect reaction on `cached`
  // itself, not chained into the returned value, so the actual awaiter
  // below still observes the original rejection rather than a swallowed one.
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
