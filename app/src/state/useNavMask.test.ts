import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavMask } from '../lib/mask';
import type { MaskMeta } from '../types';

const META: MaskMeta = { west: 9.0, south: 54.0, east: 9.1, north: 54.1, cols: 4, rows: 4 };

vi.mock('../services/assets', () => ({ loadRoutingAssets: vi.fn() }));
import { loadRoutingAssets } from '../services/assets';
import { useNavMask } from './useNavMask';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useNavMask', () => {
  it('starts null and resolves to a NavMask', async () => {
    vi.mocked(loadRoutingAssets).mockResolvedValue({
      maskMeta: META,
      maskBuffer: new Uint8Array(META.rows * META.cols).fill(255).buffer,
    } as never);

    const { result } = renderHook(() => useNavMask());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBeInstanceOf(NavMask));
  });

  it('stays null when the assets fail to load, and does not throw', async () => {
    vi.mocked(loadRoutingAssets).mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useNavMask());
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
