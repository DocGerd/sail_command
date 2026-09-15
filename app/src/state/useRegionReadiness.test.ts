import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Plan } from '../types';
import type { RegionReadiness } from '../services/regionPinning';
import { regionReadiness } from '../services/regionPinning';
import { __resetPinActivityForTests, createPinAfterSave } from '../services/pinAfterSave';
import { readinessStatus, useRegionReadiness } from './useRegionReadiness';

vi.mock('../services/regionPinning', () => ({
  regionReadiness: vi.fn(),
  pinRegionsForPlan: vi.fn(),
}));

const READY: RegionReadiness = { state: 'ready', done: 1, total: 1 };
const PENDING: RegionReadiness = { state: 'not-ready', reason: 'pending' };

const plan = (id: string, createdAtMs = 1): Plan => ({ id, createdAtMs }) as unknown as Plan;

function setController(controller: object | null): void {
  Object.defineProperty(navigator, 'serviceWorker', { value: { controller }, configurable: true });
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
    vi.mocked(regionReadiness).mockReset();
  });

  it('starts as "checking", then reports the checked readiness', async () => {
    vi.mocked(regionReadiness).mockResolvedValue(READY);
    const { result } = renderHook(() => useRegionReadiness(plan('p1')));
    expect(result.current.status).toBe('checking');
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('a failed readiness check resolves to not-ready, never ready', async () => {
    vi.mocked(regionReadiness).mockRejectedValue(new Error('caches blew up'));
    const { result } = renderHook(() => useRegionReadiness(plan('p1')));
    await waitFor(() => expect(result.current.status).toBe('not-ready'));
  });

  it('shows "pinning" during a pin, then re-checks readiness once it settles', async () => {
    vi.mocked(regionReadiness).mockResolvedValue(PENDING);
    const p = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p));
    await waitFor(() => expect(result.current.status).toBe('not-ready'));

    let finish!: () => void;
    const pin = createPinAfterSave(
      () => new Promise((r) => (finish = () => r({ status: 'pinned', total: 1, pinned: 1 }))),
    );
    act(() => pin(p));
    await waitFor(() => expect(result.current.status).toBe('pinning'));

    vi.mocked(regionReadiness).mockResolvedValue(READY);
    await act(async () => finish());
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('surfaces a pin that settled without verifying every archive as "failed"', async () => {
    vi.mocked(regionReadiness).mockResolvedValue(PENDING);
    const p = plan('p1');
    const { result } = renderHook(() => useRegionReadiness(p));
    const pin = createPinAfterSave(() => Promise.resolve({ status: 'manifest-unavailable' }));
    await act(async () => pin(p));
    await waitFor(() => expect(result.current.status).toBe('failed'));
  });

  it("a previous plan's readiness never shows for the next plan", async () => {
    vi.mocked(regionReadiness).mockResolvedValueOnce(READY);
    const { result, rerender } = renderHook(({ p }) => useRegionReadiness(p), {
      initialProps: { p: plan('p1') },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(regionReadiness).mockReturnValue(new Promise(() => {}));
    rerender({ p: plan('p2') });
    expect(result.current.status).toBe('checking');
  });

  it('canRetry follows the service-worker gate', () => {
    vi.mocked(regionReadiness).mockReturnValue(new Promise(() => {}));
    setController(null);
    const { result } = renderHook(() => useRegionReadiness(plan('p1')));
    expect(result.current.canRetry).toBe(false);
  });
});
