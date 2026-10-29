import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { OpenMeteoError } from '../services/openMeteo';
import { makeWindGrid } from '../test/fixtures';
import { makeWaveGrid } from '../test/waveFixtures';
import {
  AREA_FORECAST_DWELL_MS,
  pairAreaForecast,
  useAreaForecast,
  type AreaForecastDeps,
} from './useAreaForecast';
import type { WaveGrid, WindGrid } from '../types';

const NOW = Date.UTC(2026, 9, 14, 12);

function wind(fetchedAtMs: number): WindGrid {
  return { ...makeWindGrid(() => ({ speedKn: 10, dirFromDeg: 225 }), { hours: 2 }), fetchedAtMs };
}
function wave(fetchedAtMs: number): WaveGrid {
  return {
    ...makeWaveGrid(() => ({ heightM: 0.5, periodS: 3, dirFromDeg: 200 })),
    fetchedAtMs,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let onLine = true;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  onLine = true;
  vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => onLine);
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function setup(
  deps: AreaForecastDeps,
  initial: { active: boolean; online?: boolean; planWind?: WindGrid | null } = { active: true },
) {
  return renderHook(
    (p: { active: boolean; online: boolean; planWind: WindGrid | null }) =>
      useAreaForecast(p.active, p.online, p.planWind, null, deps),
    {
      initialProps: {
        active: initial.active,
        online: initial.online ?? true,
        planWind: initial.planWind ?? null,
      },
    },
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useAreaForecast', () => {
  it('fetches nothing before the dwell, and nothing if the tab is left inside it', async () => {
    const fetchWind = vi.fn(() => Promise.resolve(wind(NOW)));
    const { rerender } = setup({ fetchWind, fetchWave: vi.fn() });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS - 1));
    rerender({ active: false, online: true, planWind: null });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS * 2));
    expect(fetchWind).not.toHaveBeenCalled();
  });

  it('fetches wind after the dwell, then waves only once wind settles', async () => {
    const w = deferred<WindGrid>();
    const fetchWind = vi.fn(() => w.promise);
    const fetchWave = vi.fn(() => Promise.resolve(wave(NOW)));
    const { result } = setup({ fetchWind, fetchWave });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    expect(fetchWind).toHaveBeenCalledTimes(1);
    expect(fetchWave).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(true);
    const grid = wind(NOW);
    await act(async () => w.resolve(grid));
    await flush();
    expect(fetchWave).toHaveBeenCalledTimes(1);
    expect(result.current.wind).toBe(grid);
    expect(result.current.wave).not.toBeNull();
    expect(result.current.source).toBe('session');
    expect(result.current.pending).toBe(false);
  });

  it('honours the fixtures, and a wind fixture alone means no waves', async () => {
    window.history.replaceState(null, '', '/?windFixture=w.json');
    const fetchWind = vi.fn(() => Promise.resolve(wind(NOW)));
    const fetchWave = vi.fn(() => Promise.resolve(wave(NOW)));
    const { result } = setup({ fetchWind, fetchWave });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    await flush();
    expect(fetchWind).toHaveBeenCalledWith({ fixtureUrl: 'w.json' });
    expect(fetchWave).not.toHaveBeenCalled();
    expect(result.current.waveError).toBe(false);

    window.history.replaceState(null, '', '/?windFixture=w.json&waveFixture=v.json');
    act(() => result.current.refresh());
    await flush();
    expect(fetchWave).toHaveBeenCalledWith({ fixtureUrl: 'v.json' });
  });

  it('issues no request offline', () => {
    onLine = false;
    const fetchWind = vi.fn(() => Promise.resolve(wind(NOW)));
    const { result } = setup({ fetchWind, fetchWave: vi.fn() }, { active: true, online: false });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS * 3));
    act(() => result.current.refresh());
    expect(fetchWind).not.toHaveBeenCalled();
  });

  it('types a failure with nothing shown, and stays quiet with a grid held', async () => {
    const fetchWind = vi
      .fn<AreaForecastDeps['fetchWind'] & {}>()
      .mockRejectedValueOnce(new OpenMeteoError('http', '500'))
      .mockResolvedValueOnce(wind(NOW))
      .mockRejectedValueOnce(new OpenMeteoError('offline', 'x'));
    const fetchWave = vi.fn(() => Promise.resolve(wave(NOW)));
    const { result } = setup({ fetchWind, fetchWave });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    await flush();
    expect(result.current.errorKey).toBe('error.windService');
    expect(result.current.wind).toBeNull();

    act(() => result.current.refresh());
    await flush();
    expect(result.current.errorKey).toBeNull();
    const held = result.current.wind;
    expect(held).not.toBeNull();

    act(() => result.current.refresh());
    await flush();
    expect(result.current.errorKey).toBeNull();
    expect(result.current.refreshFailed).toBe(true);
    expect(result.current.wind).toBe(held);
  });

  it('flags a wave failure and keeps the wind', async () => {
    const fetchWind = vi.fn(() => Promise.resolve(wind(NOW)));
    const fetchWave = vi.fn(() => Promise.reject(new Error('marine down')));
    const { result } = setup({ fetchWind, fetchWave });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    await flush();
    expect(result.current.wind).not.toBeNull();
    expect(result.current.wave).toBeNull();
    expect(result.current.waveError).toBe(true);
  });

  it('blocks a manual refresh for 60 s after a rate limit', async () => {
    const fetchWind = vi.fn(() => Promise.reject(new OpenMeteoError('rate-limited', '429')));
    const { result } = setup({ fetchWind, fetchWave: vi.fn() });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    await flush();
    expect(result.current.errorKey).toBe('error.rateLimited');
    expect(result.current.cooldownUntilMs).toBe(NOW + AREA_FORECAST_DWELL_MS + 60_000);
    act(() => vi.advanceTimersByTime(59_000));
    act(() => result.current.refresh());
    expect(fetchWind).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1_000));
    act(() => result.current.refresh());
    expect(fetchWind).toHaveBeenCalledTimes(2);
  });

  it('a re-entry inside the rate-limit cooldown fetches nothing, and one after it does', async () => {
    const fetchWind = vi.fn(() => Promise.reject(new OpenMeteoError('rate-limited', '429')));
    const { rerender } = setup({ fetchWind, fetchWave: vi.fn() });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    await flush();
    expect(fetchWind).toHaveBeenCalledTimes(1);
    rerender({ active: false, online: true, planWind: null });
    act(() => vi.advanceTimersByTime(5_000));
    rerender({ active: true, online: true, planWind: null });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS * 2));
    expect(fetchWind).toHaveBeenCalledTimes(1);
    rerender({ active: false, online: true, planWind: null });
    act(() => vi.advanceTimersByTime(60_000));
    rerender({ active: true, online: true, planWind: null });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    expect(fetchWind).toHaveBeenCalledTimes(2);
  });

  it('a manual refresh after the cooldown that fails fast fetches wind exactly once', async () => {
    const fetchWind = vi
      .fn<AreaForecastDeps['fetchWind'] & {}>()
      .mockRejectedValueOnce(new OpenMeteoError('rate-limited', '429'))
      .mockRejectedValue(new OpenMeteoError('http', '500'));
    const { result } = setup({ fetchWind, fetchWave: vi.fn() });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    await flush();
    expect(fetchWind).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(61_000));
    fetchWind.mockClear();
    act(() => result.current.refresh());
    await flush();
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS * 3));
    await flush();
    expect(fetchWind).toHaveBeenCalledTimes(1);
  });

  it('refetches on re-entry only once the held forecast is over an hour old', async () => {
    const fetchWind = vi.fn(() => Promise.resolve(wind(Date.now())));
    const fetchWave = vi.fn(() => Promise.resolve(wave(Date.now())));
    const { rerender } = setup({ fetchWind, fetchWave });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    await flush();
    expect(fetchWind).toHaveBeenCalledTimes(1);

    rerender({ active: false, online: true, planWind: null });
    act(() => vi.advanceTimersByTime(3_600_000 - AREA_FORECAST_DWELL_MS));
    rerender({ active: true, online: true, planWind: null });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    expect(fetchWind).toHaveBeenCalledTimes(1);

    rerender({ active: false, online: true, planWind: null });
    act(() => vi.advanceTimersByTime(2_000));
    rerender({ active: true, online: true, planWind: null });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS));
    expect(fetchWind).toHaveBeenCalledTimes(2);
  });

  it('a recent plan forecast is held, so entry fetches nothing', () => {
    const fetchWind = vi.fn(() => Promise.resolve(wind(NOW)));
    const planWind = wind(NOW - 60_000);
    const { result } = setup({ fetchWind, fetchWave: vi.fn() }, { active: true, planWind });
    act(() => vi.advanceTimersByTime(AREA_FORECAST_DWELL_MS * 2));
    expect(fetchWind).not.toHaveBeenCalled();
    expect(result.current.source).toBe('plan');
    expect(result.current.wind).toBe(planWind);
  });
});

describe('pairAreaForecast', () => {
  it('takes the newest wind and that source’s waves, never mixing sources', () => {
    const s = { wind: wind(NOW), wave: wave(NOW) };
    const older = wind(NOW - 1);
    const newer = wind(NOW + 1);
    expect(pairAreaForecast(s, older, wave(NOW - 1))).toEqual({ ...s, source: 'session' });
    expect(pairAreaForecast(s, newer, null)).toEqual({ wind: newer, wave: null, source: 'plan' });
    expect(pairAreaForecast(null, null, null).source).toBeNull();
  });
});
