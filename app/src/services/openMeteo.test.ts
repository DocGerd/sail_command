import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearWindGridCache,
  fetchWindGrid,
  OpenMeteoError,
  FORECAST_DAYS,
  GRID_CACHE_TTL_MS,
} from './openMeteo';

// Grid-bounds literals (not the same Array.from formula openMeteo.ts uses to
// build these — re-deriving via the identical formula would let a bug in the
// source's own bounds silently pass here too).
const LATS = [54.3, 54.4, 54.5, 54.6, 54.7, 54.8, 54.9, 55.0, 55.1, 55.2, 55.3, 55.4, 55.5, 55.6];
const LONS = [
  9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 10.0, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 11.0,
  11.1, 11.2, 11.3, 11.4, 11.5, 11.6,
];
const NPOINTS = LATS.length * LONS.length; // 322

interface FakePoint {
  hourly: {
    time: number[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
    wind_gusts_10m: number[];
  };
}

function buildFakeResponse(speedPerPoint: number[] = []): FakePoint[] {
  if (speedPerPoint.length === 0) {
    // Default: each point's speed encodes its index
    speedPerPoint = Array.from({ length: NPOINTS }, (_, i) => i);
  }

  const hourlyLength = 144; // 6 days * 24 hours
  const timesS = Array.from(
    { length: hourlyLength },
    (_, i) => Math.floor(Date.now() / 1000) + i * 3600,
  );

  const points: FakePoint[] = [];
  for (let p = 0; p < NPOINTS; p++) {
    points.push({
      hourly: {
        time: timesS,
        wind_speed_10m: Array(hourlyLength).fill(speedPerPoint[p]),
        wind_direction_10m: Array(hourlyLength).fill(p % 360),
        wind_gusts_10m: Array(hourlyLength).fill(speedPerPoint[p] * 1.3),
      },
    });
  }
  return points;
}

describe('openMeteo', () => {
  beforeEach(() => {
    clearWindGridCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Step 1: Flattening order test — verify that grid.speedKn is indexed correctly
  it('should flatten points in correct order: grid.speedKn[(t*nPoints+p)] recovers point index', async () => {
    const fakeData = buildFakeResponse(); // each point p has speed = p
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    const grid = await fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });

    // Verify the flattening contract: at time t=0, point p, we should get speedKn[p]
    // Full formula: index = (t * nPoints + p) where nPoints = LATS.length * LONS.length
    // Point index p corresponds to (latIdx, lonIdx) where p = latIdx * LONS.length + lonIdx
    for (let latIdx = 0; latIdx < LATS.length; latIdx++) {
      for (let lonIdx = 0; lonIdx < LONS.length; lonIdx++) {
        const p = latIdx * LONS.length + lonIdx;
        const t = 0;
        const k = t * NPOINTS + p;
        expect(grid.speedKn[k]).toBe(p);
      }
    }
  });

  // Step 2: URL assertion test — verify all 322 coordinates in correct order
  it('should build URL with 322 comma-separated latitude,longitude pairs in correct order', async () => {
    const fakeData = buildFakeResponse();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    await fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0]?.[0] as unknown as string;

    // Verify URL structure (note: URLSearchParams encodes commas as %2C)
    expect(url).toContain('api.open-meteo.com');
    expect(url).toContain('hourly=wind_speed_10m%2Cwind_direction_10m%2Cwind_gusts_10m');
    expect(url).toContain('wind_speed_unit=kn');
    expect(url).toContain('timeformat=unixtime');
    expect(url).toContain('timezone=UTC');
    expect(url).toContain(`forecast_days=${FORECAST_DAYS}`);
    expect(url).toContain('models=icon_seamless');

    // Extract and verify latitude/longitude coordinates
    const params = new URLSearchParams(url.split('?')[1]);
    const latsStr = params.get('latitude');
    const lonsStr = params.get('longitude');
    expect(latsStr).toBeDefined();
    expect(lonsStr).toBeDefined();
    const lats = latsStr!.split(',').map(Number);
    const lons = lonsStr!.split(',').map(Number);

    expect(lats).toHaveLength(NPOINTS);
    expect(lons).toHaveLength(NPOINTS);

    // Verify order: should iterate lat first (outer), lon second (inner)
    for (let latIdx = 0; latIdx < LATS.length; latIdx++) {
      for (let lonIdx = 0; lonIdx < LONS.length; lonIdx++) {
        const idx = latIdx * LONS.length + lonIdx;
        expect(lats[idx]).toBe(LATS[latIdx]);
        expect(lons[idx]).toBe(LONS[lonIdx]);
      }
    }
  });

  // Step 3: Retry with 500-then-200, using fake timers
  it('should retry on 500 with 1s/4s backoff and succeed', async () => {
    vi.useFakeTimers();

    const fakeData = buildFakeResponse();
    const mockFetch = vi.fn();
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(fakeData), { status: 200 }));

    const promise = fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });

    // Advance through first retry delay (1s)
    await vi.advanceTimersByTimeAsync(1000);
    // Advance through second retry delay (4s)
    await vi.advanceTimersByTimeAsync(4000);

    const grid = await promise;
    expect(grid.speedKn).toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  // Step 3b: Persistent network failure exhausts both retries → OpenMeteoError('offline')
  it('should throw OpenMeteoError with kind="offline" after exhausting retries on persistent network failure', async () => {
    vi.useFakeTimers();

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const promise = fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });
    let caught: unknown;
    const done = promise.catch((err) => {
      caught = err;
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(4000);
    await done;

    expect(caught).toBeInstanceOf(OpenMeteoError);
    expect((caught as OpenMeteoError).kind).toBe('offline');
    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  // Step 3c: Persistent HTTP 500 exhausts both retries → OpenMeteoError('offline')
  it('should throw OpenMeteoError with kind="offline" after exhausting retries on persistent HTTP 500', async () => {
    vi.useFakeTimers();

    const mockFetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const promise = fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });
    let caught: unknown;
    const done = promise.catch((err) => {
      caught = err;
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(4000);
    await done;

    expect(caught).toBeInstanceOf(OpenMeteoError);
    expect((caught as OpenMeteoError).kind).toBe('offline');
    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  // Step 3d: A never-settling fetch must not hang forever — each attempt times
  // out after REQUEST_TIMEOUT_MS and is treated as a retryable network failure,
  // same attempt count and outcome as a persistent throw.
  it('should throw OpenMeteoError with kind="offline" after 3 attempts each time out', async () => {
    vi.useFakeTimers();

    const REQUEST_TIMEOUT_MS = 15_000; // mirrors openMeteo.ts's internal constant
    const mockFetch = vi.fn(() => new Promise<Response>(() => {})); // never settles
    const promise = fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });
    let caught: unknown;
    const done = promise.catch((err) => {
      caught = err;
    });

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS); // attempt 1 times out
    await vi.advanceTimersByTimeAsync(1000); // backoff before attempt 2
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS); // attempt 2 times out
    await vi.advanceTimersByTimeAsync(4000); // backoff before attempt 3
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS); // attempt 3 times out
    await done;

    expect(caught).toBeInstanceOf(OpenMeteoError);
    expect((caught as OpenMeteoError).kind).toBe('offline');
    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  // Step 4: 429 rate-limited error, no retry
  it('should throw OpenMeteoError with kind="rate-limited" on HTTP 429', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));

    try {
      await fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenMeteoError);
      expect((err as OpenMeteoError).kind).toBe('rate-limited');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  });

  // Step 5a: Non-429 4xx error, no retry
  it('should throw OpenMeteoError with kind="http" on non-429 4xx', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));

    try {
      await fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenMeteoError);
      expect((err as OpenMeteoError).kind).toBe('http');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  });

  // Step 5b: Non-JSON 200 body → malformed
  it('should throw OpenMeteoError with kind="malformed" on HTTP 200 with non-JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

    try {
      await fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenMeteoError);
      expect((err as OpenMeteoError).kind).toBe('malformed');
    }
  });

  // Step 5c: Ragged arrays should throw malformed
  it('should throw OpenMeteoError with kind="malformed" on ragged hourly arrays', async () => {
    const fakeData = buildFakeResponse();
    // Break the second point's wind_speed_10m array to be too short
    fakeData[1].hourly.wind_speed_10m = Array(100).fill(0);

    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    try {
      await fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenMeteoError);
      expect((err as OpenMeteoError).kind).toBe('malformed');
    }
  });

  // Step 5d: Missing hourly array field (e.g., wind_gusts_10m entirely absent)
  it('should throw OpenMeteoError with kind="malformed" when hourly field is missing', async () => {
    const fakeData = buildFakeResponse();
    // Remove wind_gusts_10m from point 42's hourly object
    const incomplete = {
      time: fakeData[42].hourly.time,
      wind_speed_10m: fakeData[42].hourly.wind_speed_10m,
      wind_direction_10m: fakeData[42].hourly.wind_direction_10m,
    } as Record<string, number[]>;
    fakeData[42] = { hourly: incomplete } as unknown as FakePoint;

    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    try {
      await fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenMeteoError);
      expect((err as OpenMeteoError).kind).toBe('malformed');
      expect((err as OpenMeteoError).message).toContain('point 42');
      expect((err as OpenMeteoError).message).toContain('wind_gusts_10m');
    }
  });

  // Step 5e: A null element in an hourly array (e.g. a gap in the forecast
  // response) must not silently become 0 (calm) — a fake calm can flip a leg
  // from sail to motor, so it's rejected as malformed instead.
  it('should throw OpenMeteoError with kind="malformed" when an hourly element is null', async () => {
    const fakeData = buildFakeResponse();
    (fakeData[7].hourly.wind_speed_10m as (number | null)[])[3] = null;

    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    try {
      await fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenMeteoError);
      expect((err as OpenMeteoError).kind).toBe('malformed');
      expect((err as OpenMeteoError).message).toContain('point 7');
      expect((err as OpenMeteoError).message).toContain('wind_speed_10m');
    }
  });

  // Step 6: fixtureUrl should bypass the API URL
  it('should use fixtureUrl to bypass the API URL', async () => {
    const fakeData = buildFakeResponse();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    const fixtureUrl = 'https://example.com/fixture';
    await fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch, fixtureUrl });

    expect(mockFetch).toHaveBeenCalledWith(fixtureUrl);
  });

  describe('429 handling (#1712)', () => {
    const limited = (reason: string, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ error: true, reason }), { status: 429, headers });
    const okJson = JSON.stringify(buildFakeResponse());
    const ok = () => new Response(okJson, { status: 200 });
    const asFetch = (f: unknown) => f as typeof fetch;

    it.each([
      'Too many concurrent requests',
      'Minutely API request limit exceeded. Please try again in the next minute.',
    ])('retries a transient 429 (%s) with backoff and then succeeds', async (reason) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const mockFetch = vi.fn().mockResolvedValueOnce(limited(reason)).mockResolvedValueOnce(ok());
      const promise = fetchWindGrid({ fetchFn: asFetch(mockFetch) });

      await vi.advanceTimersByTimeAsync(999);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it.each([
      'Hourly API request limit exceeded. Please try again in the next hour.',
      'Daily API request limit exceeded. Please try again tomorrow.',
    ])('never retries a quota 429 (%s) and reports kind "http"', async (reason) => {
      const mockFetch = vi.fn().mockImplementation(async () => limited(reason));
      const err = await fetchWindGrid({ fetchFn: asFetch(mockFetch) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OpenMeteoError);
      expect((err as OpenMeteoError).kind).toBe('http');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 429 whose reason is unrecognised', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => limited('something else'));
      const err = await fetchWindGrid({ fetchFn: asFetch(mockFetch) }).catch((e: unknown) => e);
      expect((err as OpenMeteoError).kind).toBe('rate-limited');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('honours Retry-After instead of the computed backoff', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(limited('Too many concurrent requests', { 'Retry-After': '7' }))
        .mockResolvedValueOnce(ok());
      const promise = fetchWindGrid({ fetchFn: asFetch(mockFetch) });

      await vi.advanceTimersByTimeAsync(6999);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('gives up as rate-limited, without waiting, when Retry-After exceeds the wait budget', async () => {
      const mockFetch = vi
        .fn()
        .mockImplementation(async () =>
          limited('Too many concurrent requests', { 'Retry-After': '120' }),
        );
      const err = await fetchWindGrid({ fetchFn: asFetch(mockFetch) }).catch((e: unknown) => e);
      expect((err as OpenMeteoError).kind).toBe('rate-limited');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('stops retrying a persistent transient 429 once the wait budget is spent', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const mockFetch = vi
        .fn()
        .mockImplementation(async () => limited('Too many concurrent requests'));
      const done = fetchWindGrid({ fetchFn: asFetch(mockFetch) }).catch((e: unknown) => e);

      // Waits of 1+2+4+8 s fit the budget; the next 16 s would not.
      await vi.advanceTimersByTimeAsync(15_000);
      const err = await done;
      expect((err as OpenMeteoError).kind).toBe('rate-limited');
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it.each([
      ['0', '0'],
      ['-1', '-1'],
      ['a past HTTP date', 'Wed, 21 Oct 2015 07:28:00 GMT'],
      ['a fractional value', '0.5'],
    ])('bounds retries when Retry-After is %s', async (_label, header) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const mockFetch = vi
        .fn()
        .mockImplementation(async () =>
          limited('Too many concurrent requests', { 'Retry-After': header }),
        );
      const done = fetchWindGrid({ fetchFn: asFetch(mockFetch) }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(60_000);
      const err = await done;
      expect((err as OpenMeteoError).kind).toBe('rate-limited');
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('counts request time against the wait budget', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const mockFetch = vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(limited('Too many concurrent requests')), 10_000);
          }),
      );
      const done = fetchWindGrid({ fetchFn: asFetch(mockFetch) }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(60_000);
      const err = await done;
      expect((err as OpenMeteoError).kind).toBe('rate-limited');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('treats a 429 body that never arrives as an unrecognised reason', async () => {
      vi.useFakeTimers();
      const stalled = {
        ok: false,
        status: 429,
        headers: new Headers(),
        text: () => new Promise<string>(() => {}),
        json: () => new Promise<unknown>(() => {}),
      };
      const mockFetch = vi.fn().mockResolvedValue(stalled);
      const done = fetchWindGrid({ fetchFn: asFetch(mockFetch) }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(2000);
      const err = await done;
      expect((err as OpenMeteoError).kind).toBe('rate-limited');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('caps 429 retries by count even when every wait is short', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mockFetch = vi
        .fn()
        .mockImplementation(async () =>
          limited('Too many concurrent requests', { 'Retry-After': '0' }),
        );
      const done = fetchWindGrid({ fetchFn: asFetch(mockFetch) }).catch((e: unknown) => e);

      // Waits of 0.5+1+2+4 s; a fifth retry would still fit the wait budget.
      await vi.advanceTimersByTimeAsync(60_000);
      const err = await done;
      expect((err as OpenMeteoError).kind).toBe('rate-limited');
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('never lets Retry-After shorten the backoff below its floor', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(limited('Too many concurrent requests', { 'Retry-After': '0' }))
        .mockResolvedValueOnce(ok());
      const promise = fetchWindGrid({ fetchFn: asFetch(mockFetch) });

      await vi.advanceTimersByTimeAsync(499);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it.each([['2.5'], ['1e3']])(
      'ignores a Retry-After that is not whole seconds or an HTTP date (%s)',
      async (header) => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const mockFetch = vi
          .fn()
          .mockResolvedValueOnce(limited('Too many concurrent requests', { 'Retry-After': header }))
          .mockResolvedValueOnce(ok());
        const promise = fetchWindGrid({ fetchFn: asFetch(mockFetch) });

        await vi.advanceTimersByTimeAsync(1000);
        await promise;
        expect(mockFetch).toHaveBeenCalledTimes(2);
      },
    );

    it('bounds a 429 budget followed by network timeouts by the overall retry budget', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const startedAt = Date.now();
      let calls = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        calls++;
        if (calls > 2) return new Promise<Response>(() => {});
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(limited('Too many concurrent requests')), 12_000);
        });
      });
      let settledAt = 0;
      const done = fetchWindGrid({ fetchFn: asFetch(mockFetch) })
        .catch((e: unknown) => e)
        .then((e) => {
          settledAt = Date.now();
          return e;
        });

      await vi.advanceTimersByTimeAsync(120_000);
      const err = await done;
      expect((err as OpenMeteoError).kind).toBe('offline');
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(settledAt - startedAt).toBeLessThanOrEqual(60_000);
    });

    it('bounds a 429 budget followed by slow 5xx responses by the overall retry budget', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      let calls = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        calls++;
        return new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                calls <= 2
                  ? limited('Too many concurrent requests')
                  : new Response('', { status: 500 }),
              ),
            calls <= 2 ? 12_000 : 14_000,
          );
        });
      });
      const done = fetchWindGrid({ fetchFn: asFetch(mockFetch) }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(120_000);
      const err = await done;
      expect((err as OpenMeteoError).kind).toBe('offline');
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('does not spend the 5xx retry allowance on 429 backoff', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(limited('Too many concurrent requests'))
        .mockResolvedValueOnce(limited('Too many concurrent requests'))
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(ok());
      const promise = fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 1000 + 4000);
      await promise;
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });
  });

  it('maps a 200 whose body never arrives to kind "offline"', async () => {
    vi.useFakeTimers();
    const stalled = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise<string>(() => {}),
      json: () => new Promise<unknown>(() => {}),
    };
    const mockFetch = vi.fn().mockResolvedValue(stalled);
    const done = fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch }).catch(
      (e: unknown) => e,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    const err = await done;
    expect(err).toBeInstanceOf(OpenMeteoError);
    expect((err as OpenMeteoError).kind).toBe('offline');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  describe('retry jitter (#1712)', () => {
    const okJson = JSON.stringify(buildFakeResponse());
    const asFetch = (f: unknown) => f as typeof fetch;

    it('retries a 5xx before the nominal delay when the jitter draw is low', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(new Response(okJson, { status: 200 }));
      const promise = fetchWindGrid({ fetchFn: asFetch(mockFetch) });

      await vi.advanceTimersByTimeAsync(499);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries a 429 before the nominal delay when the jitter draw is low', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ reason: 'Too many concurrent requests' }), { status: 429 }),
        )
        .mockResolvedValueOnce(new Response(okJson, { status: 200 }));
      const promise = fetchWindGrid({ fetchFn: asFetch(mockFetch) });

      await vi.advanceTimersByTimeAsync(499);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('grid reuse (#1712)', () => {
    const okJson = JSON.stringify(buildFakeResponse());
    const okFetch = () =>
      vi.fn().mockImplementation(async () => new Response(okJson, { status: 200 }));
    const asFetch = (f: unknown) => f as typeof fetch;

    it('reuses the grid for an identical query within the TTL and refetches after it', async () => {
      vi.useFakeTimers();
      const mockFetch = okFetch();
      await fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      await vi.advanceTimersByTimeAsync(GRID_CACHE_TTL_MS - 1);
      await fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('keeps the original fetchedAtMs on a cache hit', async () => {
      vi.useFakeTimers();
      const mockFetch = okFetch();
      const first = await fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      await vi.advanceTimersByTimeAsync(60_000);
      const second = await fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      expect(second.fetchedAtMs).toBe(first.fetchedAtMs);
    });

    it('hands every caller its own copy of every array', async () => {
      const mockFetch = okFetch();
      const a = await fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      const b = await fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      for (const key of ['speedKn', 'dirFromDeg', 'gustKn'] as const) {
        expect(b[key]).not.toBe(a[key]);
        expect(b[key].buffer).not.toBe(a[key].buffer);
      }
      for (const key of ['lats', 'lons', 'timesMs'] as const) expect(b[key]).not.toBe(a[key]);

      const speed1 = b.speedKn[1];
      const time0 = b.timesMs[0];
      a.speedKn[1] = -99;
      a.lats[0] = -99;
      a.timesMs[0] = -99;
      b.speedKn[2] = -98;
      b.lats[1] = -98;
      const c = await fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      expect(b.speedKn[1]).toBe(speed1);
      expect(c.speedKn[1]).toBe(speed1);
      expect(c.speedKn[2]).toBe(2);
      expect(c.lats[1]).toBe(54.4);
      expect(c.lats[0]).toBe(54.3);
      expect(c.timesMs[0]).toBe(time0);
    });

    it('coalesces simultaneous identical requests into one fetch with separate copies', async () => {
      const mockFetch = okFetch();
      const [a, b] = await Promise.all([
        fetchWindGrid({ fetchFn: asFetch(mockFetch) }),
        fetchWindGrid({ fetchFn: asFetch(mockFetch) }),
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(a.speedKn.buffer).not.toBe(b.speedKn.buffer);
      expect(a.speedKn).toEqual(b.speedKn);
    });

    it('does not cache a failure, nor leave it in flight', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockImplementation(async () => new Response(okJson, { status: 200 }));
      await expect(fetchWindGrid({ fetchFn: asFetch(mockFetch) })).rejects.toBeInstanceOf(
        OpenMeteoError,
      );
      await fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('never reuses or stores a fixtureUrl fetch', async () => {
      const mockFetch = okFetch();
      const fixtureUrl = 'https://example.com/fixture';
      await fetchWindGrid({ fetchFn: asFetch(mockFetch), fixtureUrl });
      await fetchWindGrid({ fetchFn: asFetch(mockFetch), fixtureUrl });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      await fetchWindGrid({ fetchFn: asFetch(mockFetch) });
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(String(mockFetch.mock.calls[2]?.[0])).toContain('api.open-meteo.com');
    });

    it('does not serve a grid fetched through a different fetch function', async () => {
      const first = okFetch();
      const second = okFetch();
      await fetchWindGrid({ fetchFn: asFetch(first) });
      await fetchWindGrid({ fetchFn: asFetch(second) });
      expect(second).toHaveBeenCalledTimes(1);
    });
  });
});
