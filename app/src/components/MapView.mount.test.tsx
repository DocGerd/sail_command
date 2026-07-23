import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #118 mount lifecycle of MapView's async effect: the basemap transport
// check (services/basemapSource.ts) resolves BEFORE map construction, and
// the `cancelled` flag must close the unmount-during-fetch window. These
// tests pin that window plus the error routing of post-await construction
// throws — none of it is observable through App.test.tsx's happy paths.

const hoisted = vi.hoisted(() => ({
  mapCtorCalls: [] as unknown[],
  // Set per-test to make the FakeMap constructor throw (WebGL init failure).
  mapCtorError: { current: null as Error | null },
  protocolAddCalls: [] as unknown[],
  removeCalls: { count: 0 },
}));

vi.mock('maplibre-gl', () => {
  class FakeMap {
    constructor(options: unknown) {
      hoisted.mapCtorCalls.push(options);
      if (hoisted.mapCtorError.current) throw hoisted.mapCtorError.current;
    }
    on() {}
    off() {}
    addControl() {}
    getContainer() {
      // Detached, control-less div: collapseAttributionAtLoad no-ops.
      return document.createElement('div');
    }
    remove() {
      hoisted.removeCalls.count += 1;
    }
  }
  class FakeAttributionControl {}
  return { Map: FakeMap, AttributionControl: FakeAttributionControl, addProtocol: vi.fn() };
});

vi.mock('pmtiles', () => {
  class FakeProtocol {
    tile = () => {};
    add(p: unknown) {
      hoisted.protocolAddCalls.push(p);
    }
  }
  class FakePMTiles {
    source: unknown;
    constructor(source: unknown) {
      this.source = source;
    }
  }
  return { Protocol: FakeProtocol, PMTiles: FakePMTiles };
});

import MapView from './MapView';

/** First 7 bytes of a real PMTiles archive — makes the preflight pass. */
const PM_MAGIC = Uint8Array.from([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]);

function ok206() {
  return {
    status: 206,
    arrayBuffer: () => Promise.resolve(PM_MAGIC.slice().buffer),
    body: null,
  };
}

async function flushAsyncMount() {
  // The mount IIFE awaits fetch → arrayBuffer before constructing; a couple
  // of macrotask turns inside act() flushes the whole chain deterministically.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  hoisted.mapCtorCalls.length = 0;
  hoisted.mapCtorError.current = null;
  hoisted.protocolAddCalls.length = 0;
  hoisted.removeCalls.count = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MapView async mount (#118 cancelled-flag window)', () => {
  it('unmount while the preflight hangs: no map construction, no protocol.add', async () => {
    // A fetch that never settles — the honest "still in flight" state.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const { unmount } = render(<MapView tapActive={false} onTap={() => {}} />);
    await flushAsyncMount();
    unmount();
    await flushAsyncMount();
    expect(hoisted.mapCtorCalls.length).toBe(0);
    expect(hoisted.protocolAddCalls.length).toBe(0);
  });

  it('preflight resolving AFTER unmount: continuation is skipped, nothing constructed', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const { unmount } = render(<MapView tapActive={false} onTap={() => {}} />);
    await flushAsyncMount();
    unmount();
    // Deliver a PASSING preflight only after the component is gone.
    resolveFetch?.(ok206());
    await flushAsyncMount();
    expect(hoisted.mapCtorCalls.length).toBe(0);
    expect(hoisted.protocolAddCalls.length).toBe(0);
  });

  it('post-await construction throw routes into the map-error path (console.error + one-shot onMapError)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok206()));
    hoisted.mapCtorError.current = new Error('WebGL context creation failed');
    const onMapError = vi.fn();
    render(<MapView tapActive={false} onTap={() => {}} onMapError={onMapError} />);
    await flushAsyncMount();
    // Pre-#118 a sync constructor throw crashed loudly; the async mount must
    // not downgrade that to a silent floating rejection.
    expect(onMapError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it('StrictMode double-mount: two preflights, but only the second mount constructs a map', async () => {
    // Dev-only StrictMode remounts run the preflight twice by design (the
    // accepted cost documented at the effect head); the first mount's
    // continuation must be cancelled before it can construct.
    const fetchMock = vi.fn().mockResolvedValue(ok206());
    vi.stubGlobal('fetch', fetchMock);
    render(
      <StrictMode>
        <MapView tapActive={false} onTap={() => {}} />
      </StrictMode>,
    );
    await flushAsyncMount();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hoisted.mapCtorCalls.length).toBe(1);
    expect(hoisted.protocolAddCalls.length).toBe(0);
  });
});
