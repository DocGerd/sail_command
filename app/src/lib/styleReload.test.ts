import { describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { installStyleSetup } from './styleReload';
import { makeFakeMap } from '../test/fakeMaplibre';

// Direct contract tests for the shared ready-gate + reload re-add hook
// (#153). The component suites (BoatMarker/AisLayer/RouteLayer/DataLayers)
// cover the integrated behavior; this file pins the hook's own mechanics.

const asMap = (m: ReturnType<typeof makeFakeMap>) => m as unknown as MaplibreMap;

describe('installStyleSetup', () => {
  it('runs setup immediately when the style is already loaded', () => {
    const map = makeFakeMap();
    const setup = vi.fn();
    installStyleSetup(asMap(map), setup);
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('defers setup to the one-shot load event while the style is loading', () => {
    const map = makeFakeMap({ styleLoaded: false });
    const setup = vi.fn();
    installStyleSetup(asMap(map), setup);
    expect(setup).not.toHaveBeenCalled();
    map.setStyleLoaded(true);
    map.fire('load');
    expect(setup).toHaveBeenCalledTimes(1);
    // 'load' fires exactly once per map lifetime — a second fire must not
    // re-run setup through a stale once() registration.
    map.fire('load');
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('re-runs setup on every styledata event (the reload re-add path)', () => {
    const map = makeFakeMap();
    const setup = vi.fn();
    installStyleSetup(asMap(map), setup);
    map.fire('styledata');
    map.fire('styledata');
    expect(setup).toHaveBeenCalledTimes(3); // 1 immediate + 2 styledata
  });

  it('the disposer removes the styledata listener', () => {
    const map = makeFakeMap();
    const setup = vi.fn();
    const dispose = installStyleSetup(asMap(map), setup);
    dispose();
    map.fire('styledata');
    expect(setup).toHaveBeenCalledTimes(1); // only the immediate call
  });

  it('the disposer cancels a still-pending load one-shot', () => {
    const map = makeFakeMap({ styleLoaded: false });
    const setup = vi.fn();
    const dispose = installStyleSetup(asMap(map), setup);
    dispose();
    map.setStyleLoaded(true);
    map.fire('load');
    map.fire('styledata');
    expect(setup).not.toHaveBeenCalled();
  });
});
