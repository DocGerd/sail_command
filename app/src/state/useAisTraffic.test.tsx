import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAisTraffic, type AisClientLike, type UseAisTrafficInput } from './useAisTraffic';
import type { AisBoundingBox, AisStreamCallbacks, ParsedAisData } from '../services/aisStream';

const BBOX: AisBoundingBox = [
  [54.6, 9.3],
  [55.0, 10.1],
];
const POS: ParsedAisData = { kind: 'position', mmsi: '211234560', lat: 54.79, lon: 9.43, sogKn: 6 };

function fakeClients() {
  const clients: {
    apiKey: string;
    callbacks: AisStreamCallbacks;
    started: AisBoundingBox[][];
    bboxes: AisBoundingBox[][];
    stopped: number;
  }[] = [];
  const createClient = (apiKey: string, callbacks: AisStreamCallbacks): AisClientLike => {
    const rec = {
      apiKey,
      callbacks,
      started: [] as AisBoundingBox[][],
      bboxes: [] as AisBoundingBox[][],
      stopped: 0,
    };
    clients.push(rec);
    return {
      start: (b) => rec.started.push(b),
      updateSubscription: (b) => rec.bboxes.push(b),
      stop: () => (rec.stopped += 1),
    };
  };
  return { clients, createClient };
}

const base: UseAisTrafficInput = {
  apiKey: 'KEY',
  ownMmsi: undefined,
  bbox: BBOX,
  online: true,
  visible: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useAisTraffic', () => {
  it('is off and creates no client when no key is configured', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() =>
      useAisTraffic({ ...base, apiKey: undefined }, { createClient }),
    );
    expect(clients).toHaveLength(0);
    expect(result.current.status).toBe('off');
  });

  it('starts a client and reports connecting when key+online+visible+bbox all hold', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() => useAisTraffic(base, { createClient }));
    expect(clients).toHaveLength(1);
    expect(clients[0].started).toEqual([[BBOX]]);
    expect(result.current.status).toBe('connecting');
  });

  it('reports live and publishes a target snapshot at the 1 Hz tick', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() => useAisTraffic(base, { createClient }));
    act(() => {
      clients[0].callbacks.onStatus('live');
      clients[0].callbacks.onMessage(POS);
    });
    expect(result.current.status).toBe('live');
    expect(result.current.targets).toHaveLength(0); // not published until the tick
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targets).toHaveLength(1);
    expect(result.current.targetCount).toBe(1);
  });

  it('filters the ownship out of the published snapshot', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() =>
      useAisTraffic({ ...base, ownMmsi: '211234560' }, { createClient }),
    );
    act(() => clients[0].callbacks.onMessage(POS));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targets).toHaveLength(0);
  });

  it('goes offline and stops the client, but keeps already-received targets', () => {
    const { clients, createClient } = fakeClients();
    const { result, rerender } = renderHook((props) => useAisTraffic(props, { createClient }), {
      initialProps: base,
    });
    act(() => clients[0].callbacks.onMessage(POS));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targets).toHaveLength(1);

    rerender({ ...base, online: false });
    expect(clients[0].stopped).toBe(1);
    expect(result.current.status).toBe('offline');
    // Targets persist and keep aging while mounted.
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targets).toHaveLength(1);
  });

  it('drops targets older than 10 minutes via the tick sweeper', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() => useAisTraffic(base, { createClient }));
    act(() => clients[0].callbacks.onMessage(POS));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targets).toHaveLength(1);
    act(() => vi.advanceTimersByTime(600_001)); // > 10 min
    expect(result.current.targets).toHaveLength(0);
  });

  it('surfaces the terminal keyError status', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() => useAisTraffic(base, { createClient }));
    act(() => clients[0].callbacks.onStatus('keyError'));
    expect(result.current.status).toBe('keyError');
  });

  it('updates the bbox on an existing client rather than recreating it', () => {
    const { clients, createClient } = fakeClients();
    const bbox2: AisBoundingBox = [
      [54.7, 9.4],
      [55.1, 10.2],
    ];
    const { rerender } = renderHook((props) => useAisTraffic(props, { createClient }), {
      initialProps: base,
    });
    rerender({ ...base, bbox: bbox2 });
    expect(clients).toHaveLength(1);
    expect(clients[0].bboxes).toEqual([[bbox2]]);
  });

  it('recreates the client when the API key changes (keyError reset)', () => {
    const { clients, createClient } = fakeClients();
    const { rerender } = renderHook((props) => useAisTraffic(props, { createClient }), {
      initialProps: base,
    });
    rerender({ ...base, apiKey: 'KEY2' });
    expect(clients).toHaveLength(2);
    expect(clients[0].stopped).toBe(1);
    expect(clients[1].apiKey).toBe('KEY2');
  });

  it('stops the client and clears the store on unmount', () => {
    const { clients, createClient } = fakeClients();
    const { unmount } = renderHook(() => useAisTraffic(base, { createClient }));
    unmount();
    expect(clients[0].stopped).toBeGreaterThanOrEqual(1);
  });
});
