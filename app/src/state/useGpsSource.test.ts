import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGpsSource } from './useGpsSource';
import type { GpsErrorKind, GpsFix } from '../services/geolocation';

function fix(timestampMs: number, accuracyM = 8): GpsFix {
  return { point: { lat: 54.79, lon: 9.43 }, cogDeg: 91, sogKn: 6, accuracyM, timestampMs };
}

function fakeWatch() {
  const watches: {
    onFix: (f: GpsFix) => void;
    onError: (k: GpsErrorKind) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  }[] = [];
  const wp = vi.fn((onFix: (f: GpsFix) => void, onError: (k: GpsErrorKind) => void) => {
    const unsubscribe = vi.fn();
    watches.push({ onFix, onError, unsubscribe });
    return unsubscribe;
  });
  const latest = () => watches[watches.length - 1];
  return {
    wp,
    watches,
    emitFix: (f: GpsFix) => latest().onFix(f),
    emitError: (k: GpsErrorKind) => latest().onError(k),
  };
}

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
  localStorage.clear();
});

describe('useGpsSource', () => {
  it('does not watch while inactive', () => {
    const { wp } = fakeWatch();
    const { result } = renderHook(() => useGpsSource(false, wp));
    expect(wp).not.toHaveBeenCalled();
    expect(result.current.state).toBe('waiting');
    expect(result.current.fix).toBeNull();
  });

  it('walks waiting -> fresh -> stale (10 s) -> lost (30 s) -> fresh', () => {
    const { wp, emitFix } = fakeWatch();
    const { result } = renderHook(() => useGpsSource(true, wp));
    expect(result.current.state).toBe('waiting');
    expect(result.current.ageS).toBeNull();

    act(() => emitFix(fix(1000)));
    expect(result.current.state).toBe('fresh');

    act(() => void vi.advanceTimersByTime(9_999));
    expect(result.current.state).toBe('fresh');
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.state).toBe('stale');
    expect(result.current.ageS).toBe(10);

    act(() => void vi.advanceTimersByTime(5_000));
    expect(result.current.ageS).toBe(15);

    act(() => void vi.advanceTimersByTime(14_999));
    expect(result.current.state).toBe('stale');
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.state).toBe('lost');
    expect(result.current.fix).not.toBeNull();

    act(() => emitFix(fix(2000)));
    expect(result.current.state).toBe('fresh');
    expect(result.current.ageS).toBe(0);
  });

  it('reroute: allowed while fresh and stale with good accuracy, blocked when lost or inaccurate', () => {
    const { wp, emitFix } = fakeWatch();
    const { result } = renderHook(() => useGpsSource(true, wp));
    expect(result.current.reroute).toMatchObject({ allowed: false, reason: 'waiting' });

    act(() => emitFix(fix(1000)));
    expect(result.current.reroute.allowed).toBe(true);
    act(() => void vi.advanceTimersByTime(12_000));
    expect(result.current.state).toBe('stale');
    expect(result.current.reroute.allowed).toBe(true);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(result.current.reroute).toMatchObject({ allowed: false, reason: 'lost' });

    act(() => emitFix(fix(2000, 150)));
    expect(result.current.reroute).toMatchObject({
      allowed: false,
      reason: 'accuracy',
      accuracyM: 150,
      thresholdM: 100,
    });
  });

  it('a stationary device that never calls back again goes stale then lost', () => {
    const { wp, emitFix } = fakeWatch();
    const { result } = renderHook(() => useGpsSource(true, wp));
    act(() => emitFix(fix(1000)));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current.state).toBe('stale');
    act(() => void vi.advanceTimersByTime(20_000));
    expect(result.current.state).toBe('lost');
  });

  it.each([60_000, -60_000])(
    'a %i ms device-clock offset leaves a healthy stream fresh',
    (offset) => {
      const { wp, emitFix } = fakeWatch();
      const { result } = renderHook(() => useGpsSource(true, wp));
      for (let i = 0; i < 40; i++) {
        act(() => emitFix(fix(Date.now() + offset)));
        act(() => void vi.advanceTimersByTime(1_000));
        expect(result.current.state).toBe('fresh');
      }
    },
  );

  it('a TIMEOUT error while fixes keep arriving changes nothing and keeps the watch', () => {
    const { wp, watches, emitFix, emitError } = fakeWatch();
    const { result } = renderHook(() => useGpsSource(true, wp));
    act(() => emitFix(fix(1000)));
    act(() => emitError('timeout'));
    expect(result.current.state).toBe('fresh');
    expect(result.current.hintVisible).toBe(false);
    expect(watches[0].unsubscribe).not.toHaveBeenCalled();
    act(() => emitFix(fix(2000)));
    expect(result.current.state).toBe('fresh');
  });

  it('POSITION_UNAVAILABLE does not change the state either', () => {
    const { wp, emitFix, emitError } = fakeWatch();
    const { result } = renderHook(() => useGpsSource(true, wp));
    act(() => emitFix(fix(1000)));
    act(() => emitError('unavailable'));
    expect(result.current.state).toBe('fresh');
    expect(result.current.denied).toBe(false);
  });

  it('a re-delivered cached fix with an unchanged device timestamp does not refresh the age', () => {
    const { wp, emitFix } = fakeWatch();
    const { result } = renderHook(() => useGpsSource(true, wp));
    act(() => emitFix(fix(1000)));
    act(() => void vi.advanceTimersByTime(12_000));
    expect(result.current.state).toBe('stale');
    act(() => emitFix(fix(1000)));
    expect(result.current.state).toBe('stale');
    expect(result.current.ageS).toBe(12);
  });

  it('PERMISSION_DENIED is terminal until a new fix arrives', () => {
    const { wp, emitFix, emitError } = fakeWatch();
    const { result } = renderHook(() => useGpsSource(true, wp));
    act(() => emitFix(fix(1000)));
    act(() => emitError('denied'));
    expect(result.current.state).toBe('denied');
    expect(result.current.denied).toBe(true);
    expect(result.current.reroute).toMatchObject({ allowed: false, reason: 'denied' });
    act(() => emitFix(fix(2000)));
    expect(result.current.state).toBe('fresh');
  });

  it('re-arms with a NEW watch on visibilitychange to visible and on pageshow, not when hidden', () => {
    const { wp, watches } = fakeWatch();
    renderHook(() => useGpsSource(true, wp));
    expect(wp).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(wp).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(wp).toHaveBeenCalledTimes(2);
    expect(watches[0].unsubscribe).toHaveBeenCalledTimes(1);

    act(() => void window.dispatchEvent(new Event('pageshow')));
    expect(wp).toHaveBeenCalledTimes(3);
    expect(watches[1].unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a fix from the re-armed watch recovers from denied', () => {
    const { wp, watches, emitError } = fakeWatch();
    const { result } = renderHook(() => useGpsSource(true, wp));
    act(() => emitError('denied'));
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current.state).toBe('denied');
    act(() => watches[1].onFix(fix(5000)));
    expect(result.current.state).toBe('fresh');
  });

  it('unsubscribes, removes listeners and clears the track when deactivated', () => {
    const { wp, watches, emitFix } = fakeWatch();
    const { result, rerender } = renderHook(({ a }) => useGpsSource(a, wp), {
      initialProps: { a: true },
    });
    act(() => emitFix(fix(1000)));
    rerender({ a: false });
    expect(watches[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(result.current.fix).toBeNull();
    expect(result.current.state).toBe('waiting');

    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(wp).toHaveBeenCalledTimes(1);

    rerender({ a: true });
    expect(result.current.fix).toBeNull();
  });

  it('claims the one-time hint on denied and unavailable, never on timeout', () => {
    const { wp, emitError } = fakeWatch();
    const { result } = renderHook(() => useGpsSource(true, wp));
    act(() => emitError('timeout'));
    expect(result.current.hintVisible).toBe(false);
    expect(localStorage.getItem('sc-gps-hint-shown')).toBeNull();
    act(() => emitError('unavailable'));
    expect(result.current.hintVisible).toBe(true);
    act(() => result.current.dismissHint());
    expect(result.current.hintVisible).toBe(false);
    expect(localStorage.getItem('sc-gps-hint-shown')).toBe('1');
  });
});
