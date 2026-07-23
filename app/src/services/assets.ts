import type { Harbor, MaskMeta, PolarTable } from '../types';
import type { SeamarkFeatureCollection } from '../lib/seamarkGeoJson';

export interface RoutingAssets {
  maskMeta: MaskMeta;
  maskBuffer: ArrayBuffer;
  polarGenoa: PolarTable;
  polarFock: PolarTable;
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

/** Fetched once, module-cached; BASE_URL-relative. */
export function loadRoutingAssets(): Promise<RoutingAssets> {
  cached ??= Promise.all([
    fetchJson<MaskMeta>('data/mask.meta.json'),
    fetchBuffer('data/mask.bin'),
    fetchJson<PolarTable>('data/polar-genoa.json'),
    fetchJson<PolarTable>('data/polar-fock.json'),
    fetchJson<Harbor[]>('data/harbors.json'),
    fetchJson<SeamarkFeatureCollection>('data/seamarks.json'),
  ]).then(([maskMeta, maskBuffer, polarGenoa, polarFock, harbors, seamarks]) => ({
    maskMeta,
    maskBuffer,
    polarGenoa,
    polarFock,
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
