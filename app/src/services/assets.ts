import type { Harbor, MaskMeta, PolarTable } from '../types';

export interface RoutingAssets {
  maskMeta: MaskMeta;
  maskBuffer: ArrayBuffer;
  polarGenoa: PolarTable;
  polarFock: PolarTable;
  harbors: Harbor[];
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
  ]).then(([maskMeta, maskBuffer, polarGenoa, polarFock, harbors]) => ({
    maskMeta,
    maskBuffer,
    polarGenoa,
    polarFock,
    harbors,
  }));
  return cached;
}
