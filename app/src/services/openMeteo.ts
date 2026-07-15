import type { WindGrid } from '../types';

export const FORECAST_DAYS = 6;
const API = 'https://api.open-meteo.com/v1/forecast';
const LATS = Array.from({ length: 11 }, (_, i) => Number((54.3 + i * 0.1).toFixed(1)));
const LONS = Array.from({ length: 17 }, (_, i) => Number((9.4 + i * 0.1).toFixed(1)));
const RETRY_DELAYS_MS = [1000, 4000];
const REQUEST_TIMEOUT_MS = 15_000;

export type OpenMeteoErrorKind = 'offline' | 'rate-limited' | 'http' | 'malformed';

// NOT structured-clone-safe: Error subclasses lose their prototype chain across
// postMessage/IndexedDB. OpenMeteoError must never cross the worker/IndexedDB
// structured-clone boundary — catch it and convert to a plain message first
// (mirrors the Float32Array structured-clone note on Plan/WindGrid in types.ts).
export class OpenMeteoError extends Error {
  readonly kind: OpenMeteoErrorKind;

  constructor(kind: OpenMeteoErrorKind, message: string) {
    super(message);
    this.name = 'OpenMeteoError';
    this.kind = kind;
  }
}

interface PointResponse {
  hourly: {
    time: number[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
    wind_gusts_10m: number[];
  };
}

function buildUrl(): string {
  const points: string[][] = [];
  for (const lat of LATS) for (const lon of LONS) points.push([String(lat), String(lon)]);
  const p = new URLSearchParams({
    latitude: points.map((x) => x[0]).join(','),
    longitude: points.map((x) => x[1]).join(','),
    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'kn',
    timeformat: 'unixtime',
    timezone: 'UTC',
    forecast_days: String(FORECAST_DAYS),
    models: 'icon_seamless',
  });
  return `${API}?${p}`;
}

// Races a fetch attempt against a rejecting setTimeout timer rather than
// AbortSignal.timeout — vitest fake timers can drive setTimeout but cannot
// drive the internal clock AbortSignal.timeout relies on. The timer is always
// cleared on settle (success or failure) so no handle is left dangling.
function fetchWithTimeout(url: string, fetchFn: typeof fetch): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    fetchFn(url).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function fetchWithRetry(url: string, fetchFn: typeof fetch): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      // A timeout rejects fetchWithTimeout the same way a fetch throw would,
      // so it falls into this catch and is treated as a retryable network
      // failure — same branch, same retry/backoff, same 'offline' on exhaustion.
      res = await fetchWithTimeout(url, fetchFn);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length)
        throw new OpenMeteoError('offline', `network failure: ${String(err)}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    if (res.ok) return res;
    if (res.status === 429)
      throw new OpenMeteoError('rate-limited', 'Open-Meteo minutely limit reached');
    if (res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    // 5xx exhausted its retries maps to 'offline' (not 'http'): a persistently
    // failing server reads to the user as "can't reach the forecast service"
    // the same way a network failure does — this mapping is plan-mandated.
    // Phase E's error copy should cross-check useOnline() before wording this
    // case (decision tracked on the Phase E intake).
    throw new OpenMeteoError(res.status >= 500 ? 'offline' : 'http', `HTTP ${res.status}`);
  }
}

export async function fetchWindGrid(opts?: {
  fetchFn?: typeof fetch;
  fixtureUrl?: string;
}): Promise<WindGrid> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const res = await fetchWithRetry(opts?.fixtureUrl ?? buildUrl(), fetchFn);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new OpenMeteoError('malformed', 'response body is not valid JSON');
  }
  const nPoints = LATS.length * LONS.length;
  if (!Array.isArray(data) || data.length !== nPoints)
    throw new OpenMeteoError(
      'malformed',
      `expected ${nPoints} points, got ${Array.isArray(data) ? data.length : typeof data}`,
    );

  const t0 = (data as PointResponse[])[0]?.hourly?.time;
  if (!Array.isArray(t0) || t0.length === 0)
    throw new OpenMeteoError('malformed', 'point 0 missing hourly.time');
  const timesS = t0;
  const nT = timesS.length;
  const speedKn = new Float32Array(nT * nPoints);
  const dirFromDeg = new Float32Array(nT * nPoints);
  const gustKn = new Float32Array(nT * nPoints);
  for (let p = 0; p < nPoints; p++) {
    const h = data[p]?.hourly;
    if (
      !h ||
      !Array.isArray(h.time) ||
      !Array.isArray(h.wind_speed_10m) ||
      !Array.isArray(h.wind_direction_10m) ||
      !Array.isArray(h.wind_gusts_10m) ||
      h.time.length !== nT ||
      h.wind_speed_10m.length !== nT ||
      h.wind_direction_10m.length !== nT ||
      h.wind_gusts_10m.length !== nT
    ) {
      const missing = [];
      if (!Array.isArray(h?.time)) missing.push('time');
      if (!Array.isArray(h?.wind_speed_10m)) missing.push('wind_speed_10m');
      if (!Array.isArray(h?.wind_direction_10m)) missing.push('wind_direction_10m');
      if (!Array.isArray(h?.wind_gusts_10m)) missing.push('wind_gusts_10m');
      const msg = missing.length > 0
        ? `point ${p} missing hourly.${missing.join(', hourly.')}`
        : `ragged hourly arrays at point ${p}`;
      throw new OpenMeteoError('malformed', msg);
    }
    for (let t = 0; t < nT; t++) {
      const k = t * nPoints + p; // p = latIdx * LONS.length + lonIdx — matches WindGrid layout
      const speed = h.wind_speed_10m[t];
      const dir = h.wind_direction_10m[t];
      const gust = h.wind_gusts_10m[t];
      // null/undefined/string elements must not silently become 0 (calm) —
      // a fake calm can flip a leg from sail to motor. Reject at the source.
      if (!Number.isFinite(speed))
        throw new OpenMeteoError('malformed', `point ${p} hour ${t}: wind_speed_10m is not a finite number`);
      if (!Number.isFinite(dir))
        throw new OpenMeteoError('malformed', `point ${p} hour ${t}: wind_direction_10m is not a finite number`);
      if (!Number.isFinite(gust))
        throw new OpenMeteoError('malformed', `point ${p} hour ${t}: wind_gusts_10m is not a finite number`);
      speedKn[k] = speed;
      dirFromDeg[k] = dir;
      gustKn[k] = gust;
    }
  }
  return {
    lats: LATS,
    lons: LONS,
    timesMs: timesS.map((s) => s * 1000),
    speedKn,
    dirFromDeg,
    gustKn,
    fetchedAtMs: Date.now(),
    model: 'icon_seamless',
  };
}
