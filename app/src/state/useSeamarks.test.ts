import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SeamarkFeatureCollection } from '../lib/seamarkGeoJson';

vi.mock('../services/assets', () => ({ loadRoutingAssets: vi.fn() }));
import { loadRoutingAssets } from '../services/assets';
import { useSeamarks } from './useSeamarks';

const FC: SeamarkFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [9.5, 54.8] },
      properties: { seamarkType: 'buoy_cardinal' },
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

// #615: a ~30-line twin of useNavMask.ts / useNavMask.test.ts — same
// acquisition path (loadRoutingAssets's fetch-once singleton), same
// null-until-resolved contract, same fail-open on rejection.
describe('useSeamarks', () => {
  it('starts null and resolves to the loaded collection (the SAME object, no copy)', async () => {
    vi.mocked(loadRoutingAssets).mockResolvedValue({ seamarks: FC } as never);

    const { result } = renderHook(() => useSeamarks());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(FC));
  });

  it('stays null when the assets fail to load, warns, and does not throw', async () => {
    vi.mocked(loadRoutingAssets).mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useSeamarks());
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
