import type { WindGrid } from '../types';

export const FORECAST_DAYS = 6;
const API = 'https://api.open-meteo.com/v1/forecast';
const LATS = Array.from({ length: 11 }, (_, i) => Number((54.3 + i * 0.1).toFixed(1)));
const LONS = Array.from({ length: 17 }, (_, i) => Number((9.4 + i * 0.1).toFixed(1)));
const RETRY_DELAYS_MS = [1000, 4000];

export type OpenMeteoErrorKind = 'offline' | 'rate-limited' | 'http' | 'malformed';

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

async function fetchWithRetry(url: string, fetchFn: typeof fetch): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url);
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
      h.time.length !== nT ||
      h.wind_speed_10m.length !== nT ||
      h.wind_direction_10m.length !== nT ||
      h.wind_gusts_10m.length !== nT
    )
      throw new OpenMeteoError('malformed', `ragged hourly arrays at point ${p}`);
    for (let t = 0; t < nT; t++) {
      const k = t * nPoints + p; // p = latIdx * LONS.length + lonIdx — matches WindGrid layout
      speedKn[k] = h.wind_speed_10m[t];
      dirFromDeg[k] = h.wind_direction_10m[t];
      gustKn[k] = h.wind_gusts_10m[t];
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
