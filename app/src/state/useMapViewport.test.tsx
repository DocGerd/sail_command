import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAP_VIEWPORT_SETTLE_MS, useMapViewport, type ViewportMapLike } from './useMapViewport';

// #830: the settle-gated viewport hook. MapLibre fires `moveend` once per
// gesture, but a held arrow key or a flick with inertia fires it every few
// hundred ms — the gate (CLAUDE.md's #158 rule for per-fix GPS signals,
// applied to moveend-rate signals) keeps the DOM list from re-rendering on
// every one. Fake timers make the gate itself observable: the row pinning
// it reds if the gate is deleted (the value would update immediately).

interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

type Handler = () => void;

function makeViewportMap(initial: Bounds) {
  let bounds = initial;
  const handlers = new Map<string, Set<Handler>>();
  const map = {
    on: vi.fn((type: string, fn: Handler) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
      return map;
    }),
    off: vi.fn((type: string, fn: Handler) => {
      handlers.get(type)?.delete(fn);
      return map;
    }),
    getBounds: () => ({
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north,
    }),
    /** Test-only: move the camera and fire `moveend` like MapLibre would. */
    moveTo(next: Bounds) {
      bounds = next;
      handlers.get('moveend')?.forEach((fn) => fn());
    },
    listenerCount(type: string) {
      return handlers.get(type)?.size ?? 0;
    },
  };
  return map;
}

const A: Bounds = { west: 10.0, south: 54.8, east: 10.2, north: 54.9 };
const B: Bounds = { west: 9.4, south: 54.7, east: 9.6, north: 54.8 };
const C: Bounds = { west: 10.5, south: 55.0, east: 10.7, north: 55.1 };

const asMap = (m: ReturnType<typeof makeViewportMap>) => m as unknown as ViewportMapLike;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useMapViewport (#830)', () => {
  it('returns null without a map', () => {
    const { result } = renderHook(() => useMapViewport(null));
    expect(result.current).toBeNull();
  });

  it('reads the initial viewport synchronously — bounds plus the derived centre — with no settle wait', () => {
    const map = makeViewportMap(A);
    const { result } = renderHook(() => useMapViewport(asMap(map)));
    expect(result.current).toMatchObject({ west: 10.0, south: 54.8, east: 10.2, north: 54.9 });
    // Centre is a float midpoint — compare within tolerance, not bitwise.
    expect(result.current?.centerLon).toBeCloseTo(10.1, 12);
    expect(result.current?.centerLat).toBeCloseTo(54.85, 12);
  });

  it('SETTLE GATE: after moveend the previous viewport is returned until MAP_VIEWPORT_SETTLE_MS elapses', () => {
    const map = makeViewportMap(A);
    const { result } = renderHook(() => useMapViewport(asMap(map)));
    const before = result.current;
    act(() => map.moveTo(B));
    // Still the old viewport — the gate has not opened.
    expect(result.current).toBe(before);
    act(() => vi.advanceTimersByTime(MAP_VIEWPORT_SETTLE_MS - 1));
    expect(result.current).toBe(before);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toMatchObject({ west: 9.4, east: 9.6, centerLon: 9.5 });
    // MUTATION (gate deleted / settleMs -> 0): the first `toBe(before)` reds.
  });

  it('a second moveend inside the window restarts the gate and only the LAST viewport lands', () => {
    const map = makeViewportMap(A);
    const { result } = renderHook(() => useMapViewport(asMap(map)));
    act(() => map.moveTo(B));
    act(() => vi.advanceTimersByTime(MAP_VIEWPORT_SETTLE_MS - 50));
    act(() => map.moveTo(C));
    act(() => vi.advanceTimersByTime(MAP_VIEWPORT_SETTLE_MS - 50));
    // B never surfaced, and C has not yet either.
    expect(result.current).toMatchObject({ west: 10.0 });
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toMatchObject({ west: 10.5, centerLat: 55.05 });
  });

  it('honours a caller-supplied settle time', () => {
    const map = makeViewportMap(A);
    const { result } = renderHook(() => useMapViewport(asMap(map), 1_000));
    act(() => map.moveTo(B));
    act(() => vi.advanceTimersByTime(MAP_VIEWPORT_SETTLE_MS));
    expect(result.current).toMatchObject({ west: 10.0 });
    act(() => vi.advanceTimersByTime(1_000 - MAP_VIEWPORT_SETTLE_MS));
    expect(result.current).toMatchObject({ west: 9.4 });
  });

  it('subscribes to moveend exactly once and unsubscribes the SAME handler on unmount', () => {
    const map = makeViewportMap(A);
    const { unmount } = renderHook(() => useMapViewport(asMap(map)));
    expect(map.listenerCount('moveend')).toBe(1);
    const onCall = map.on.mock.calls.find(([type]) => type === 'moveend');
    expect(onCall).toBeDefined();
    unmount();
    expect(map.listenerCount('moveend')).toBe(0);
    expect(map.off).toHaveBeenCalledWith('moveend', onCall![1]);
  });

  it('a map swap bypasses the gate: the new map’s viewport is returned immediately', () => {
    const first = makeViewportMap(A);
    const second = makeViewportMap(C);
    const { result, rerender } = renderHook(({ m }) => useMapViewport(m), {
      initialProps: { m: asMap(first) },
    });
    expect(result.current).toMatchObject({ west: 10.0 });
    rerender({ m: asMap(second) });
    expect(result.current).toMatchObject({ west: 10.5 });
    expect(first.listenerCount('moveend')).toBe(0);
    expect(second.listenerCount('moveend')).toBe(1);
  });
});
