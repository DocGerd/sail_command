import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWakeLock } from './useWakeLock';

class FakeSentinel extends EventTarget {
  released = false;
  release = vi.fn(async () => {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  });
}

let sentinels: FakeSentinel[];
let request: ReturnType<typeof vi.fn>;

function installWakeLock(impl?: () => Promise<FakeSentinel>) {
  request = vi.fn(
    impl ??
      (async () => {
        const s = new FakeSentinel();
        sentinels.push(s);
        return s;
      }),
  );
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const flush = () => act(async () => {});

beforeEach(() => {
  sentinels = [];
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  installWakeLock();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'wakeLock');
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('useWakeLock', () => {
  it('reports unsupported without throwing when navigator.wakeLock is absent', async () => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    const { result } = renderHook(() => useWakeLock(true));
    await flush();
    expect(result.current).toEqual({ supported: false, held: false, error: null });
  });

  it('does not request a lock while not wanted', async () => {
    const { result } = renderHook(() => useWakeLock(false));
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(result.current).toEqual({ supported: true, held: false, error: null });
  });

  it('acquires a screen lock when wanted', async () => {
    const { result } = renderHook(() => useWakeLock(true));
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith('screen');
    expect(result.current).toEqual({ supported: true, held: true, error: null });
  });

  it('releases when no longer wanted, and re-acquires when wanted again', async () => {
    const { result, rerender } = renderHook(({ w }) => useWakeLock(w), {
      initialProps: { w: true },
    });
    await flush();
    rerender({ w: false });
    await flush();
    expect(sentinels[0]!.released).toBe(true);
    expect(result.current.held).toBe(false);
    rerender({ w: true });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.held).toBe(true);
  });

  it('releases on unmount', async () => {
    const { unmount } = renderHook(() => useWakeLock(true));
    await flush();
    unmount();
    expect(sentinels[0]!.released).toBe(true);
  });

  it('flips held to false on a browser-initiated sentinel release event', async () => {
    const { result } = renderHook(() => useWakeLock(true));
    await flush();
    expect(result.current.held).toBe(true);
    await act(async () => {
      await sentinels[0]!.release();
    });
    expect(result.current.held).toBe(false);
  });

  it('re-acquires when the page becomes visible again after a release', async () => {
    const { result } = renderHook(() => useWakeLock(true));
    await flush();
    act(() => setVisibility('hidden'));
    await act(async () => {
      await sentinels[0]!.release();
    });
    expect(result.current.held).toBe(false);
    act(() => setVisibility('visible'));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.held).toBe(true);
  });

  it('does not request while hidden, and does not double-request while still held', async () => {
    const { result } = renderHook(() => useWakeLock(true));
    await flush();
    act(() => setVisibility('visible'));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      await sentinels[0]!.release();
    });
    act(() => setVisibility('hidden'));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.held).toBe(false);
  });

  it('does not request when mounted while the page is hidden, then acquires on visible', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const { result } = renderHook(() => useWakeLock(true));
    await flush();
    expect(request).not.toHaveBeenCalled();
    act(() => setVisibility('visible'));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.held).toBe(true);
  });

  it('does not issue a second request while one is still pending', async () => {
    installWakeLock(() => new Promise<FakeSentinel>(() => {}));
    renderHook(() => useWakeLock(true));
    act(() => setVisibility('visible'));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('releases a request that resolves after the caller stopped wanting it', async () => {
    let resolve!: (s: FakeSentinel) => void;
    installWakeLock(() => new Promise<FakeSentinel>((r) => (resolve = r)));
    const { result, rerender } = renderHook(({ w }) => useWakeLock(w), {
      initialProps: { w: true },
    });
    rerender({ w: false });
    const late = new FakeSentinel();
    await act(async () => {
      resolve(late);
    });
    expect(late.released).toBe(true);
    expect(result.current.held).toBe(false);
  });

  it('surfaces a rejected request, stays unheld, and does not retry on its own', async () => {
    installWakeLock(async () => {
      throw new DOMException('Low battery', 'NotAllowedError');
    });
    const { result } = renderHook(() => useWakeLock(true));
    await flush();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({
      supported: true,
      held: false,
      error: 'NotAllowedError: Low battery',
    });
  });

  it('retries on the next visible transition and clears the error on success', async () => {
    let fail = true;
    installWakeLock(async () => {
      if (fail) throw new Error('denied');
      const s = new FakeSentinel();
      sentinels.push(s);
      return s;
    });
    const { result } = renderHook(() => useWakeLock(true));
    await flush();
    expect(result.current.error).toBe('Error: denied');
    fail = false;
    act(() => setVisibility('visible'));
    await flush();
    expect(result.current).toEqual({ supported: true, held: true, error: null });
  });

  it('leaks no sentinel under StrictMode double-invoke', async () => {
    const { result, unmount } = renderHook(() => useWakeLock(true), { reactStrictMode: true });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.held).toBe(true);
    const live = sentinels.filter((s) => !s.released);
    expect(live).toHaveLength(1);
    unmount();
    expect(sentinels.every((s) => s.released)).toBe(true);
  });

  it('ignores a rejection that settles after the caller stopped wanting the lock', async () => {
    let reject!: (e: Error) => void;
    installWakeLock(() => new Promise<FakeSentinel>((_, r) => (reject = r)));
    const { result, rerender } = renderHook(({ w }) => useWakeLock(w), {
      initialProps: { w: true },
    });
    rerender({ w: false });
    await act(async () => {
      reject(new Error('late'));
    });
    expect(result.current).toEqual({ supported: true, held: false, error: null });
  });

  it('a stale release event from a superseded sentinel does not clear the new lock', async () => {
    const { result, rerender } = renderHook(({ w }) => useWakeLock(w), {
      initialProps: { w: true },
    });
    await flush();
    const first = sentinels[0]!;
    // Real browsers dispatch `release` in a later task than release() returns.
    first.release.mockImplementation(async () => {
      first.released = true;
      setTimeout(() => first.dispatchEvent(new Event('release')), 0);
    });
    rerender({ w: false });
    rerender({ w: true });
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(result.current.held).toBe(true);
  });
});
