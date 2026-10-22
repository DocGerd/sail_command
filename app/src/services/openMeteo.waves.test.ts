import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWaveUrl,
  clearWaveGridCache,
  clearWindGridCache,
  fetchWaveGrid,
  fetchWindGrid,
  OpenMeteoError,
  WAVE_MODEL,
} from './openMeteo';
import { seaStateBand, wavePointsAtHour } from '../lib/waves';
import { buildWaveFixture } from '../../scripts/wave-fixture.mjs';

// Literal lattice, not openMeteo.ts's formula (same reason as openMeteo.test.ts).
const N_LATS = 14;
const N_LONS = 23;
const NPOINTS = N_LATS * N_LONS;
const HOURS = 72; // deliberately not wind's 144: the marine axis may differ

type Series = (number | null)[];
interface FakeWavePoint {
  hourly: { time: unknown; wave_height?: Series; wave_direction?: Series; wave_period?: Series };
}

function buildWaveResponse(
  value: (p: number, t: number) => { h: number | null; d: number | null; per: number | null } = (
    p,
    t,
  ) => ({ h: p + t * 1000, d: p % 360, per: 3 + (p % 7) }),
): FakeWavePoint[] {
  const t0 = 1_800_000_000;
  const time = Array.from({ length: HOURS }, (_, i) => t0 + i * 3600);
  return Array.from({ length: NPOINTS }, (_, p) => {
    const vals = time.map((_, t) => value(p, t));
    return {
      hourly: {
        time,
        wave_height: vals.map((v) => v.h),
        wave_direction: vals.map((v) => v.d),
        wave_period: vals.map((v) => v.per),
      },
    };
  });
}

const respond = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('fetchWaveGrid (#1699)', () => {
  beforeEach(() => {
    clearWaveGridCache();
    clearWindGridCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('requests the marine endpoint on the wind lattice with the named model', () => {
    const url = new URL(buildWaveUrl());
    expect(url.origin + url.pathname).toBe('https://marine-api.open-meteo.com/v1/marine');
    const q = url.searchParams;
    expect(q.get('hourly')).toBe('wave_height,wave_direction,wave_period');
    expect(q.get('timeformat')).toBe('unixtime');
    expect(q.get('timezone')).toBe('UTC');
    expect(q.get('forecast_days')).toBe('6');
    expect(q.get('models')).toBe('ewam');
    expect(q.get('latitude')!.split(',')).toHaveLength(NPOINTS);
    expect(q.get('latitude')!.split(',')[N_LONS]).toBe('54.4');
    expect(q.get('longitude')!.split(',')[N_LONS - 1]).toBe('11.6');
  });

  it('flattens with the WindGrid index and records the model', async () => {
    const grid = await fetchWaveGrid({ fetchFn: respond(buildWaveResponse()) });
    expect(grid.model).toBe(WAVE_MODEL);
    expect(grid.timesMs).toHaveLength(HOURS);
    expect(grid.timesMs[1]! - grid.timesMs[0]!).toBe(3_600_000);
    expect(grid.waveHeightM).toHaveLength(HOURS * NPOINTS);
    // k = t * nPoints + latIdx * nLons + lonIdx; value encodes p + 1000 t.
    expect(grid.waveHeightM[2 * NPOINTS + 3 * N_LONS + 5]).toBe(3 * N_LONS + 5 + 2000);
    expect(grid.waveDirFromDeg[NPOINTS + 40]).toBe(40);
    expect(grid.wavePeriodS[41]).toBe(3 + (41 % 7));
  });

  it('stores null and non-numeric elements as NaN, never 0, and accepts an all-null point', async () => {
    const body = buildWaveResponse((p, t) =>
      p === 7 ? { h: null, d: null, per: null } : { h: t === 1 ? null : 0.4, d: 200, per: 5 },
    );
    (body[8]!.hourly.wave_height as unknown[])[0] = 'x';
    const grid = await fetchWaveGrid({ fetchFn: respond(body) });
    for (let t = 0; t < HOURS; t++) {
      expect(Number.isNaN(grid.waveHeightM[t * NPOINTS + 7])).toBe(true);
      expect(Number.isNaN(grid.wavePeriodS[t * NPOINTS + 7])).toBe(true);
      expect(Number.isNaN(grid.waveDirFromDeg[t * NPOINTS + 7])).toBe(true);
    }
    expect(Number.isNaN(grid.waveHeightM[NPOINTS])).toBe(true); // hour 1 null
    expect(Number.isNaN(grid.waveHeightM[8])).toBe(true); // non-numeric
    expect(grid.waveHeightM[9]).toBeCloseTo(0.4, 6);
    expect(seaStateBand(grid.waveHeightM[7]!)).toBe('no-data');
  });

  it.each<[string, (b: FakeWavePoint[]) => unknown]>([
    ['wrong point count', (b) => b.slice(1)],
    ['not an array', () => ({ hourly: {} })],
    ['missing time on point 0', (b) => ((b[0]!.hourly.time = undefined), b)],
    ['empty time axis', (b) => b.map(() => ({ hourly: { time: [] } }))],
    ['missing field array', (b) => (delete b[5]!.hourly.wave_period, b)],
    ['ragged field array', (b) => (b[5]!.hourly.wave_height!.pop(), b)],
    [
      'ragged time array',
      (b) => (
        (b[5]!.hourly = { ...b[5]!.hourly, time: (b[5]!.hourly.time as number[]).slice(1) }),
        b
      ),
    ],
    [
      'non-hourly time step',
      (b) => {
        const time = (b[0]!.hourly.time as number[]).slice();
        time[3] = time[2]! + 1800;
        return b.map((p) => ({ hourly: { ...p.hourly, time } }));
      },
    ],
    [
      'descending time',
      (b) => {
        const time = (b[0]!.hourly.time as number[]).slice().reverse();
        return b.map((p) => ({ hourly: { ...p.hourly, time } }));
      },
    ],
  ])('throws malformed on %s', async (_label, mutate) => {
    const err = await fetchWaveGrid({ fetchFn: respond(mutate(buildWaveResponse())) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpenMeteoError);
    expect((err as OpenMeteoError).kind).toBe('malformed');
  });

  it('shares the wind retry/429 classification', async () => {
    const quota = new Response(JSON.stringify({ reason: 'Daily API request limit exceeded' }), {
      status: 429,
    });
    const err = await fetchWaveGrid({
      fetchFn: vi.fn().mockResolvedValue(quota) as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect((err as OpenMeteoError).kind).toBe('http');
  });

  it('caches by its own URL, never serving or reading the wind cache', async () => {
    const fetchFn = respond(buildWaveResponse());
    const a = await fetchWaveGrid({ fetchFn });
    const b = await fetchWaveGrid({ fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(b.waveHeightM).not.toBe(a.waveHeightM);
    // The same fetchFn on the wind path must still hit the network.
    await fetchWindGrid({ fetchFn }).catch(() => undefined);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchFn).mock.calls[1]![0]).toMatch(/^https:\/\/api\.open-meteo\.com\//);
  });

  it('loads a fixture URL without the cache', async () => {
    const fetchFn = respond(buildWaveResponse());
    await fetchWaveGrid({ fetchFn, fixtureUrl: 'test-fixtures/wave-bands.json' });
    await fetchWaveGrid({ fetchFn, fixtureUrl: 'test-fixtures/wave-bands.json' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchFn).mock.calls[0]![0]).toBe('test-fixtures/wave-bands.json');
  });
});

describe('gen-wave-fixture builder (#1699)', () => {
  it('parses through the fixture path and shows every band, no data and varied directions', async () => {
    const fixtureText = JSON.stringify(buildWaveFixture(1_800_000_000));
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(fixtureText, { status: 200 })) as unknown as typeof fetch;
    const grid = await fetchWaveGrid({ fetchFn, fixtureUrl: 'test-fixtures/wave-bands.json' });
    expect(grid.timesMs).toHaveLength(144);
    const pts = wavePointsAtHour(grid, 0);
    const bands = new Set(pts.map((p) => seaStateBand(p.heightM)));
    expect([...bands].sort()).toEqual(['calm', 'moderate', 'no-data', 'rough', 'slight', 'smooth']);
    expect(pts.filter((p) => Number.isNaN(p.heightM))).toHaveLength(5);
    expect(new Set(pts.map((p) => p.dirFromDeg).filter(Number.isFinite)).size).toBeGreaterThan(20);
    expect(new Set(pts.map((p) => p.periodS).filter(Number.isFinite)).size).toBeGreaterThan(3);
  });
});
