import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOwnshipGps } from './useOwnshipGps';
import type { GpsErrorKind, GpsFix } from '../services/geolocation';

const FIX: GpsFix = { point: { lat: 54.79, lon: 9.43 }, cogDeg: 91.4, sogKn: 6.3, accuracyM: 9 };

function fakeWatchPosition() {
  let onFixCb: ((fix: GpsFix) => void) | null = null;
  let onErrorCb: ((kind: GpsErrorKind) => void) | null = null;
  const unsubscribe = vi.fn();
  const wp = vi.fn((onFix: (fix: GpsFix) => void, onError: (kind: GpsErrorKind) => void) => {
    onFixCb = onFix;
    onErrorCb = onError;
    return unsubscribe;
  });
  return {
    wp,
    unsubscribe,
    emitFix: (fix: GpsFix) => {
      if (!onFixCb) throw new Error('watchPosition was never subscribed');
      onFixCb(fix);
    },
    emitError: (kind: GpsErrorKind) => {
      if (!onErrorCb) throw new Error('watchPosition was never subscribed');
      onErrorCb(kind);
    },
  };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('useOwnshipGps', () => {
  it('does not subscribe to watchPosition, and exposes a null fix, while disabled', () => {
    const { wp } = fakeWatchPosition();
    const { result } = renderHook(() => useOwnshipGps(false, wp));

    expect(wp).not.toHaveBeenCalled();
    expect(result.current.fix).toBeNull();
  });

  it('subscribes to watchPosition when enabled, and exposes the emitted fix verbatim', () => {
    const { wp, emitFix } = fakeWatchPosition();
    const { result } = renderHook(() => useOwnshipGps(true, wp));

    expect(wp).toHaveBeenCalledTimes(1);
    expect(result.current.fix).toBeNull();

    act(() => emitFix(FIX));

    expect(result.current.fix).toEqual(FIX);
  });

  it('unsubscribes and clears the fix when enabled flips back to false', () => {
    const { wp, unsubscribe, emitFix } = fakeWatchPosition();
    const { result, rerender } = renderHook(({ enabled }) => useOwnshipGps(enabled, wp), {
      initialProps: { enabled: true },
    });

    act(() => emitFix(FIX));
    expect(result.current.fix).toEqual(FIX);

    rerender({ enabled: false });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(result.current.fix).toBeNull();
  });

  it("a 'denied' error claims the shared one-time hint (lib/gpsHint.ts's storage key)", () => {
    const { wp, emitError } = fakeWatchPosition();
    const { result } = renderHook(() => useOwnshipGps(true, wp));

    expect(result.current.hintVisible).toBe(false);

    act(() => emitError('denied'));

    expect(result.current.hintVisible).toBe(true);
    // Same storage key LiveView.test.tsx pins for its own denial hint — this
    // is the concrete evidence the two consumers share ONE claim, not two.
    expect(localStorage.getItem('sc-gps-hint-shown')).toBe('1');
  });

  it('does not show the hint at all if another GPS consumer already claimed it (e.g. LiveView, in a prior session)', () => {
    localStorage.setItem('sc-gps-hint-shown', '1');
    const { wp, emitError } = fakeWatchPosition();
    const { result } = renderHook(() => useOwnshipGps(true, wp));

    act(() => emitError('unavailable'));

    expect(result.current.hintVisible).toBe(false);
  });

  it('dismissHint hides the hint without touching the storage claim', () => {
    const { wp, emitError } = fakeWatchPosition();
    const { result } = renderHook(() => useOwnshipGps(true, wp));

    act(() => emitError('denied'));
    expect(result.current.hintVisible).toBe(true);

    act(() => result.current.dismissHint());

    expect(result.current.hintVisible).toBe(false);
    expect(localStorage.getItem('sc-gps-hint-shown')).toBe('1');
  });
});
