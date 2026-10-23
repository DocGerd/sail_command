import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Plan } from '../types';
import { regionReadinessAndBytes } from '../services/regionPinning';
import { __resetPinActivityForTests } from '../services/pinAfterSave';
import { useLiveReadiness, type LiveReadinessInput } from './useLiveReadiness';

vi.mock('../services/regionPinning', () => ({
  regionReadinessAndBytes: vi.fn(),
  pinRegionsForPlan: vi.fn(),
}));

const H = 3_600_000;
const T0 = 1_800_000_000_000;

// A 6 h grid from T0; the plan departs at T0 + 1 h and arrives at T0 + 3 h.
const PLAN = {
  id: 'p1',
  createdAtMs: 1,
  request: { departureMs: T0 + H },
  windGrid: { timesMs: [T0, T0 + 2 * H, T0 + 4 * H, T0 + 6 * H] },
} as unknown as Plan;
const ARRIVAL = T0 + 3 * H;

const READY_INPUT: LiveReadinessInput = {
  wakeLockSupported: true,
  aisStatus: 'live',
  gpsDenied: false,
};

class FakePermissionStatus extends EventTarget {
  state: PermissionState;
  constructor(state: PermissionState) {
    super();
    this.state = state;
  }
  set(state: PermissionState) {
    this.state = state;
    this.dispatchEvent(new Event('change'));
  }
}

function setPermissions(value: unknown): void {
  Object.defineProperty(navigator, 'permissions', { value, configurable: true });
}

// Stable across renders: the hook's effects key on these identities.
const atT0 = () => T0;
const glyphsYes = () => Promise.resolve(true);
const glyphsPending = () => new Promise<boolean>(() => {});
const glyphsThrow = () => Promise.reject(new Error('boom'));

const readyIds = (checks: { id: string; ready: boolean }[]) =>
  checks.filter((c) => c.ready).map((c) => c.id);

describe('useLiveReadiness (#1807)', () => {
  let perm: FakePermissionStatus;

  beforeEach(() => {
    __resetPinActivityForTests();
    vi.mocked(regionReadinessAndBytes).mockReset();
    vi.mocked(regionReadinessAndBytes).mockResolvedValue({
      readiness: { state: 'ready', done: 1, total: 1 },
      bytes: 0,
    });
    perm = new FakePermissionStatus('granted');
    setPermissions({ query: vi.fn(() => Promise.resolve(perm)) });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'permissions');
    vi.useRealTimers();
  });

  it('reports all six checks ready when every source confirms', async () => {
    const { result } = renderHook(() =>
      useLiveReadiness(PLAN, ARRIVAL, READY_INPUT, { now: atT0, glyphComplete: glyphsYes }),
    );
    await waitFor(() =>
      expect(readyIds(result.current)).toEqual([
        'regions',
        'glyphs',
        'gps',
        'forecast',
        'wakeLock',
        'ais',
      ]),
    );
  });

  it('fails closed when nothing can be read', async () => {
    Reflect.deleteProperty(navigator, 'permissions');
    vi.mocked(regionReadinessAndBytes).mockRejectedValue(new Error('no caches'));
    const { result } = renderHook(() =>
      useLiveReadiness(
        PLAN,
        ARRIVAL,
        { wakeLockSupported: false, aisStatus: null, gpsDenied: false },
        { now: atT0, glyphComplete: glyphsThrow },
      ),
    );
    await waitFor(() => expect(vi.mocked(regionReadinessAndBytes)).toHaveBeenCalled());
    await act(async () => {});
    expect(readyIds(result.current)).toEqual(['forecast']);
    expect(result.current.find((c) => c.id === 'gps')?.detailKey).toBe('live.ready.gps.unknown');
  });

  it('follows a permission change without restarting GPS', async () => {
    perm = new FakePermissionStatus('prompt');
    const query = vi.fn(() => Promise.resolve(perm));
    setPermissions({ query });
    const { result } = renderHook(() =>
      useLiveReadiness(PLAN, ARRIVAL, READY_INPUT, { now: atT0, glyphComplete: glyphsYes }),
    );
    await waitFor(() =>
      expect(result.current.find((c) => c.id === 'gps')?.detailKey).toBe('live.ready.gps.prompt'),
    );
    act(() => perm.set('granted'));
    expect(result.current.find((c) => c.id === 'gps')?.ready).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('lets the GPS source denial override a granted query', async () => {
    const { result } = renderHook(() =>
      useLiveReadiness(
        PLAN,
        ARRIVAL,
        { ...READY_INPUT, gpsDenied: true },
        { now: atT0, glyphComplete: glyphsYes },
      ),
    );
    await waitFor(() => expect(readyIds(result.current)).toContain('glyphs'));
    expect(result.current.find((c) => c.id === 'gps')?.detailKey).toBe('live.ready.gps.denied');
  });

  it('re-evaluates forecast coverage as the clock passes the last start that still fits', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // Latest start that still fits: T0 + 4 h (2 h passage, grid ends T0 + 6 h).
    let nowMs = T0 + 4 * H - 30_000;
    const clock = () => nowMs;
    const { result } = renderHook(() =>
      useLiveReadiness(PLAN, ARRIVAL, READY_INPUT, { now: clock, glyphComplete: glyphsPending }),
    );
    expect(result.current.find((c) => c.id === 'forecast')?.ready).toBe(true);
    nowMs = T0 + 4 * H + 30_000;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.find((c) => c.id === 'forecast')?.ready).toBe(false);
  });

  it('re-reads glyph coverage when the page becomes visible again', async () => {
    let complete = false;
    const glyphComplete = vi.fn(() => Promise.resolve(complete));
    const { result } = renderHook(() =>
      useLiveReadiness(PLAN, ARRIVAL, READY_INPUT, { now: atT0, glyphComplete }),
    );
    await waitFor(() => expect(glyphComplete).toHaveBeenCalledTimes(1));
    expect(result.current.find((c) => c.id === 'glyphs')?.ready).toBe(false);
    complete = true;
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      visibility.mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      visibility.mockReturnValue('visible');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await waitFor(() => expect(result.current.find((c) => c.id === 'glyphs')?.ready).toBe(true));
    } finally {
      visibility.mockRestore();
    }
  });
});
