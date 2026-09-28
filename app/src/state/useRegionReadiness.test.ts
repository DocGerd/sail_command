import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Plan } from '../types';
import type { RegionReadiness, RegionReadinessAndBytes } from '../services/regionPinning';
import { pinRegionsForPlan, regionReadinessAndBytes } from '../services/regionPinning';
import { __resetPinActivityForTests, createPinAfterSave } from '../services/pinAfterSave';
import { readinessStatus, useRegionReadiness } from './useRegionReadiness';

vi.mock('../services/regionPinning', () => ({
  regionReadinessAndBytes: vi.fn(),
  pinRegionsForPlan: vi.fn(),
}));

// #1253: the hook now calls ONE combined function instead of regionReadiness
// + regionDownloadBytes separately — this wraps a bare readiness value into
// that combined shape so most test bodies read unchanged.
function combined(readiness: RegionReadiness, bytes: number | null = 0): RegionReadinessAndBytes {
  return { readiness, bytes };
}

const READY: RegionReadiness = { state: 'ready', done: 1, total: 1 };
const PENDING: RegionReadiness = { state: 'not-ready', reason: 'pending' };

const plan = (id: string, createdAtMs = 1): Plan => ({ id, createdAtMs }) as unknown as Plan;

// A controllerchange-capable fake: `controller` is mutable so a test can model
// sw.ts's clientsClaim taking a page mid-session.
let sw: EventTarget & { controller: object | null };
function setController(controller: object | null): void {
  sw = Object.assign(new EventTarget(), { controller });
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
}
function claimPage(): void {
  sw.controller = {};
  sw.dispatchEvent(new Event('controllerchange'));
}
function setSaveData(saveData: boolean | undefined): void {
  Object.defineProperty(navigator, 'connection', {
    value: saveData === undefined ? undefined : { saveData },
    configurable: true,
  });
}

describe('readinessStatus (#295)', () => {
  it.each([
    [null, undefined, 'checking'],
    [READY, undefined, 'ready'],
    [READY, 'failed', 'ready'],
    [READY, 'pinning', 'ready'],
    [PENDING, undefined, 'not-ready'],
    [PENDING, 'pinning', 'pinning'],
    [PENDING, 'failed', 'failed'],
    [null, 'pinning', 'pinning'],
    [{ state: 'not-ready', reason: 'manifest-unavailable' }, undefined, 'not-ready'],
  ] as const)('readiness %j + activity %j -> %s', (readiness, activity, expected) => {
    expect(readinessStatus(readiness, activity)).toBe(expected);
  });
});

describe('useRegionReadiness (#295)', () => {
  beforeEach(() => {
    __resetPinActivityForTests();
    setController({});
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    Reflect.deleteProperty(navigator, 'connection');
    vi.mocked(regionReadinessAndBytes).mockReset();
    vi.mocked(pinRegionsForPlan).mockReset();
  });

  it('starts as "checking", then reports the checked readiness', async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValue(combined(READY));
    const p1 = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p1));
    expect(result.current.status).toBe('checking');
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('a failed readiness check resolves to not-ready, never ready', async () => {
    vi.mocked(regionReadinessAndBytes).mockRejectedValue(new Error('caches blew up'));
    const p1 = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p1));
    await waitFor(() => expect(result.current.status).toBe('not-ready'));
  });

  it('shows "pinning" during a pin, then re-checks readiness once it settles', async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValue(combined(PENDING));
    const p = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p));
    await waitFor(() => expect(result.current.status).toBe('not-ready'));

    let finish!: () => void;
    const pin = createPinAfterSave(
      () => new Promise((r) => (finish = () => r({ status: 'pinned', total: 1, pinned: 1 }))),
    );
    act(() => pin(p));
    await waitFor(() => expect(result.current.status).toBe('pinning'));

    vi.mocked(regionReadinessAndBytes).mockResolvedValue(combined(READY));
    await act(async () => finish());
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('surfaces a pin that settled without verifying every archive as "failed"', async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValue(combined(PENDING));
    const p = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p));
    const pin = createPinAfterSave(() => Promise.resolve({ status: 'manifest-unavailable' }));
    await act(async () => pin(p));
    await waitFor(() => expect(result.current.status).toBe('failed'));
  });

  it("a previous plan's readiness never shows for the next plan", async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValueOnce(combined(READY));
    const { result, rerender } = renderHook(({ p }) => useRegionReadiness(p), {
      initialProps: { p: plan('p1') },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(regionReadinessAndBytes).mockReturnValue(new Promise(() => {}));
    rerender({ p: plan('p2') });
    expect(result.current.status).toBe('checking');
  });

  // PWA review r4016341229-adjacent Major (r4016341215): replanWithVias keeps
  // id AND createdAtMs, so only object identity marks the new corridor.
  it('a via replan (same id and createdAtMs, new plan object) re-checks and never shows the old "ready"', async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValueOnce(combined(READY));
    const { result, rerender } = renderHook(({ p }) => useRegionReadiness(p), {
      initialProps: { p: plan('p1', 7) },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(regionReadinessAndBytes).mockReturnValue(new Promise(() => {}));
    rerender({ p: plan('p1', 7) });
    expect(result.current.status).toBe('checking');
    expect(regionReadinessAndBytes).toHaveBeenCalledTimes(2);
  });

  it('holds "pinning" after the pin settles until the re-check lands, never flashing "not-ready"', async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValue(combined(PENDING));
    const p = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p));
    let finish!: () => void;
    const pin = createPinAfterSave(
      () => new Promise((r) => (finish = () => r({ status: 'pinned', total: 1, pinned: 1 }))),
    );
    act(() => pin(p));
    await waitFor(() => expect(result.current.status).toBe('pinning'));
    let land!: (r: RegionReadinessAndBytes) => void;
    vi.mocked(regionReadinessAndBytes).mockReturnValue(new Promise((r) => (land = r)));
    await act(async () => finish());
    expect(result.current.status).toBe('pinning');
    await act(async () => land(combined(READY)));
    expect(result.current.status).toBe('ready');
  });

  it('the service worker taking control enables retry, re-checks, and pins the plan once', async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValue(
      combined({ state: 'not-ready', reason: 'manifest-unavailable' }),
    );
    vi.mocked(pinRegionsForPlan).mockReturnValue(new Promise(() => {}));
    setController(null);
    const p = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p));
    await waitFor(() => expect(result.current.status).toBe('not-ready'));
    expect(result.current.canRetry).toBe(false);
    const checksBefore = vi.mocked(regionReadinessAndBytes).mock.calls.length;

    act(() => claimPage());
    expect(result.current.canRetry).toBe(true);
    await waitFor(() => expect(pinRegionsForPlan).toHaveBeenCalledTimes(1));
    expect(pinRegionsForPlan).toHaveBeenCalledWith(p);
    expect(vi.mocked(regionReadinessAndBytes).mock.calls.length).toBeGreaterThan(checksBefore);
  });

  it('under Save-Data the service worker taking control re-checks but downloads nothing', async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValue(
      combined({ state: 'not-ready', reason: 'manifest-unavailable' }),
    );
    setSaveData(true);
    setController(null);
    const p1 = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p1));
    await waitFor(() => expect(result.current.status).toBe('not-ready'));
    const checksBefore = vi.mocked(regionReadinessAndBytes).mock.calls.length;
    // The claim is the only trigger here: no pin runs, so activity never moves.
    act(() => claimPage());
    expect(result.current.canRetry).toBe(true);
    await waitFor(() =>
      expect(vi.mocked(regionReadinessAndBytes).mock.calls.length).toBeGreaterThan(checksBefore),
    );
    expect(pinRegionsForPlan).not.toHaveBeenCalled();
  });

  it("the chip's save button downloads even under Save-Data", async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValue(combined(PENDING));
    vi.mocked(pinRegionsForPlan).mockReturnValue(new Promise(() => {}));
    setSaveData(true);
    const p = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p));
    await waitFor(() => expect(result.current.status).toBe('not-ready'));
    act(() => result.current.retry());
    await waitFor(() => expect(pinRegionsForPlan).toHaveBeenCalledWith(p));
  });

  it('re-checks when the page becomes visible again', async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValueOnce(combined(READY));
    const p1 = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p1));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.mocked(regionReadinessAndBytes).mockResolvedValue(combined(PENDING));
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    visibility.mockReturnValue('visible');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(result.current.status).toBe('not-ready'));
  });

  it('reports the required download size, and none when nothing is needed', async () => {
    vi.mocked(regionReadinessAndBytes).mockResolvedValue(combined(PENDING, 12_603_919));
    const { result, rerender } = renderHook(({ p }) => useRegionReadiness(p), {
      initialProps: { p: plan('p1') },
    });
    await waitFor(() => expect(result.current.bytes).toBe(12_603_919));
    vi.mocked(regionReadinessAndBytes).mockResolvedValue(combined(PENDING, 0));
    rerender({ p: plan('p2') });
    await waitFor(() => expect(result.current.status).toBe('not-ready'));
    expect(result.current.bytes).toBeNull();
  });

  it('canRetry follows the service-worker gate', () => {
    vi.mocked(regionReadinessAndBytes).mockReturnValue(new Promise(() => {}));
    setController(null);
    const p1 = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p1));
    expect(result.current.canRetry).toBe(false);
  });
});
