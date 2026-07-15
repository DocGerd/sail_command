import { describe, expect, it, vi } from 'vitest';
import { fetchWindGrid, OpenMeteoError, FORECAST_DAYS } from './openMeteo';

// Grid-bounds literals (not the same Array.from formula openMeteo.ts uses to
// build these — re-deriving via the identical formula would let a bug in the
// source's own bounds silently pass here too).
const LATS = [54.3, 54.4, 54.5, 54.6, 54.7, 54.8, 54.9, 55.0, 55.1, 55.2, 55.3];
const LONS = [
  9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 10.0, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 11.0,
];
const NPOINTS = LATS.length * LONS.length; // 187

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
  const timesS = Array.from({ length: hourlyLength }, (_, i) => Math.floor(Date.now() / 1000) + i * 3600);

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
  // Step 1: Flattening order test — verify that grid.speedKn is indexed correctly
  it('should flatten points in correct order: grid.speedKn[(t*nPoints+p)] recovers point index', async () => {
    const fakeData = buildFakeResponse(); // each point p has speed = p
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeData), { status: 200 })
    );

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

  // Step 2: URL assertion test — verify all 187 coordinates in correct order
  it('should build URL with 187 comma-separated latitude,longitude pairs in correct order', async () => {
    const fakeData = buildFakeResponse();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeData), { status: 200 })
    );

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
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('', { status: 429 })
    );

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
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('', { status: 404 })
    );

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
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('', { status: 200 })
    );

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

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeData), { status: 200 })
    );

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

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeData), { status: 200 })
    );

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

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeData), { status: 200 })
    );

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
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeData), { status: 200 })
    );

    const fixtureUrl = 'https://example.com/fixture';
    await fetchWindGrid({ fetchFn: mockFetch as unknown as typeof fetch, fixtureUrl });

    expect(mockFetch).toHaveBeenCalledWith(fixtureUrl);
  });
});
