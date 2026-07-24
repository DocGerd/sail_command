import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAisTraffic,
  useSettledValue,
  type AisClientLike,
  type UseAisTrafficInput,
} from './useAisTraffic';
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
  bboxes: [BBOX],
  corridorBoxes: [],
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

  it('updates the subscription on an existing client rather than recreating it', () => {
    const { clients, createClient } = fakeClients();
    const bbox2: AisBoundingBox = [
      [54.7, 9.4],
      [55.1, 10.2],
    ];
    const { rerender } = renderHook((props) => useAisTraffic(props, { createClient }), {
      initialProps: base,
    });
    rerender({ ...base, bboxes: [bbox2] });
    expect(clients).toHaveLength(1);
    expect(clients[0].bboxes).toEqual([[bbox2]]);
  });

  it('counts only corridor targets in routeCount at the 1 Hz tick', () => {
    const { clients, createClient } = fakeClients();
    const corridor: AisBoundingBox[] = [
      [
        [54, 10],
        [55, 11],
      ],
    ];
    const { result } = renderHook(() =>
      useAisTraffic({ ...base, corridorBoxes: corridor }, { createClient }),
    );
    act(() => {
      // pointInBox over [[54,10],[55,11]] admits (54.5,10.5), rejects (56.0,10.5):
      clients[0].callbacks.onMessage({ kind: 'position', mmsi: '211000001', lat: 54.5, lon: 10.5 });
      clients[0].callbacks.onMessage({ kind: 'position', mmsi: '211000002', lat: 56.0, lon: 10.5 });
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targetCount).toBe(2); // all rendered targets
    expect(result.current.routeCount).toBe(1); // corridor-only subset
  });

  it('reports routeCount 0 when no corridor boxes exist (no plan)', () => {
    const { clients, createClient } = fakeClients();
    const { result } = renderHook(() => useAisTraffic(base, { createClient }));
    act(() => {
      clients[0].callbacks.onMessage({ kind: 'position', mmsi: '211000001', lat: 54.5, lon: 10.5 });
      clients[0].callbacks.onMessage({ kind: 'position', mmsi: '211000002', lat: 56.0, lon: 10.5 });
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.targetCount).toBe(2);
    expect(result.current.routeCount).toBe(0);
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

// #158: the settle gate AisTraffic puts between the per-fix activeLegIndex and
// the corridor recompute. Semantics pinned here: a change is adopted only after
// holding UNINTERRUPTED for settleMs; any change re-arms the window; returning
// to the settled value cancels the pending adoption.
describe('useSettledValue', () => {
  it('returns the initial value immediately (no settle delay on mount)', () => {
    const { result } = renderHook(({ v }) => useSettledValue(v, 2000), {
      initialProps: { v: 3 },
    });
    expect(result.current).toBe(3);
  });

  it('adopts a changed value only once it has held for settleMs (1999 no, 2000 yes)', () => {
    const { result, rerender } = renderHook(({ v }) => useSettledValue(v, 2000), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    expect(result.current).toBe(1); // not adopted synchronously
    act(() => vi.advanceTimersByTime(1999));
    expect(result.current).toBe(1); // settle window still open
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(2); // adopted exactly at settleMs
  });

  it('never adopts under sustained alternation faster than settleMs (12 flips at 1 Hz)', () => {
    // Derivation: adoption needs 2000 ms uninterrupted at a non-settled value;
    // flips every 1000 ms cap the dwell at 1000 ms < 2000 ms ⇒ 0 adoptions.
    const { result, rerender } = renderHook(({ v }) => useSettledValue(v, 2000), {
      initialProps: { v: 1 },
    });
    for (let k = 1; k <= 12; k++) {
      act(() => vi.advanceTimersByTime(1000));
      rerender({ v: k % 2 === 1 ? 2 : 1 });
    }
    expect(result.current).toBe(1);
    // The 12th flip returned to the settled value ⇒ no adoption is pending:
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(1);
  });

  it('cancels a pending adoption when the value returns to the settled one', () => {
    const { result, rerender } = renderHook(({ v }) => useSettledValue(v, 2000), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    act(() => vi.advanceTimersByTime(1500));
    rerender({ v: 1 }); // back to settled before the window closed
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(1);
    // …and a later genuine change still adopts on its own full window:
    rerender({ v: 2 });
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe(2);
  });
});
