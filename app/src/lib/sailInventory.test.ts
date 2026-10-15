import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOATS, sailIdsOf } from '../data/boats';
import type { BoatId, SailId } from '../data/boats';
import {
  SAIL_INVENTORY_KEY_PREFIX,
  __sailInventoryListenerCountForKey,
  readSailInventory,
  sailInventoryStorageKey,
  usePersistedSailInventory,
} from './sailInventory';

// Boats and sails are read off the catalogue, never spelled as literals.
const TWO_HEADSAIL_BOATS = BOATS.filter((b) => b.sails.length >= 2);
const BOAT_A = TWO_HEADSAIL_BOATS[0]!;
const BOAT_B = TWO_HEADSAIL_BOATS[1]!;
const ID_A = BOAT_A.id as BoatId;
const ID_B = BOAT_B.id as BoatId;
const ALL = sailIdsOf(BOAT_A);
const FIRST = ALL[0]!;
const SECOND = ALL[1]!;
const KEY_A = sailInventoryStorageKey(ID_A);

const PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);

function store(value: unknown): void {
  localStorage.setItem(KEY_A, typeof value === 'string' ? value : JSON.stringify(value));
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('test fixtures are non-vacuous', () => {
  it('the catalogue offers two boats with two or more headsails, and the prototype list is non-empty', () => {
    expect(TWO_HEADSAIL_BOATS.length).toBeGreaterThanOrEqual(2);
    expect(ID_A).not.toBe(ID_B);
    expect(ALL.length).toBeGreaterThanOrEqual(2);
    expect(PROTOTYPE_NAMES.length).toBeGreaterThan(0);
  });
});

describe('sailInventoryStorageKey', () => {
  it('is one key per boat under the shared prefix', () => {
    expect(KEY_A).toBe(`${SAIL_INVENTORY_KEY_PREFIX}${ID_A}`);
    expect(KEY_A).not.toBe(sailInventoryStorageKey(ID_B));
  });
});

describe('readSailInventory', () => {
  it('defaults to every headsail aboard, nothing hoisted', () => {
    expect(readSailInventory(ID_A)).toEqual({ headsailIds: ALL, hoistedSailId: null });
  });

  it.each([
    ['malformed JSON', '{"v":1,"aboard":'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON number', '42'],
    ['a JSON string', '"x"'],
    ['a foreign version', { v: 2, aboard: [SECOND], hoisted: null }],
    ['a string version', { v: '1', aboard: [SECOND], hoisted: null }],
    ['no version', { aboard: [SECOND], hoisted: null }],
    ['a non-array aboard', { v: 1, aboard: SECOND, hoisted: null }],
    ['an object aboard', { v: 1, aboard: { [SECOND]: true }, hoisted: null }],
  ])('reads %s as the default', (_name, stored) => {
    store(stored);
    expect(readSailInventory(ID_A)).toEqual({ headsailIds: ALL, hoistedSailId: null });
  });

  it('honours a well-formed single-sail entry', () => {
    store({ v: 1, aboard: [SECOND], hoisted: null });
    expect(readSailInventory(ID_A)).toEqual({ headsailIds: [SECOND], hoistedSailId: null });
  });

  it('drops unknown ids and keeps the known ones', () => {
    store({ v: 1, aboard: ['no-such-sail', SECOND, 7, null], hoisted: null });
    expect(readSailInventory(ID_A).headsailIds).toEqual([SECOND]);
  });

  it('reads as every headsail when no stored id is known', () => {
    store({ v: 1, aboard: ['no-such-sail', 7], hoisted: null });
    expect(readSailInventory(ID_A).headsailIds).toEqual(ALL);
  });

  it('reads an empty stored set as every headsail', () => {
    store({ v: 1, aboard: [], hoisted: null });
    expect(readSailInventory(ID_A).headsailIds).toEqual(ALL);
  });

  it('returns catalogue order whatever order was stored, and collapses duplicates', () => {
    store({ v: 1, aboard: [...ALL].reverse().concat(ALL), hoisted: null });
    expect(readSailInventory(ID_A).headsailIds).toEqual(ALL);
  });

  it.each(PROTOTYPE_NAMES.map((name) => [name]))(
    'does not treat the Object.prototype member %s as an aboard sail',
    (name) => {
      store({ v: 1, aboard: [name, SECOND], hoisted: name });
      expect(readSailInventory(ID_A)).toEqual({ headsailIds: [SECOND], hoistedSailId: null });
    },
  );

  it.each(PROTOTYPE_NAMES.map((name) => [name]))(
    'reads a stored set of only the Object.prototype member %s as every headsail',
    (name) => {
      store({ v: 1, aboard: [name], hoisted: name });
      expect(readSailInventory(ID_A)).toEqual({ headsailIds: ALL, hoistedSailId: null });
    },
  );

  it('keeps a hoisted sail that is aboard', () => {
    store({ v: 1, aboard: ALL, hoisted: FIRST });
    expect(readSailInventory(ID_A).hoistedSailId).toBe(FIRST);
  });

  it('drops a hoisted sail that is not aboard', () => {
    store({ v: 1, aboard: [SECOND], hoisted: FIRST });
    expect(readSailInventory(ID_A)).toEqual({ headsailIds: [SECOND], hoistedSailId: null });
  });

  it('drops a hoisted value that is not a sail id', () => {
    store({ v: 1, aboard: ALL, hoisted: 7 });
    expect(readSailInventory(ID_A).hoistedSailId).toBeNull();
  });

  it('never throws when localStorage throws, and reads the default', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: access denied');
    });
    expect(() => readSailInventory(ID_A)).not.toThrow();
    expect(readSailInventory(ID_A).headsailIds).toEqual(ALL);
  });

  it.each(PROTOTYPE_NAMES.map((name) => [name]))(
    'does not throw for the Object.prototype member %s used as a boat id',
    (name) => {
      expect(() => readSailInventory(name as BoatId)).not.toThrow();
    },
  );

  it('keeps boats independent', () => {
    store({ v: 1, aboard: [SECOND], hoisted: null });
    expect(readSailInventory(ID_B).headsailIds).toEqual(sailIdsOf(BOAT_B));
  });
});

describe('usePersistedSailInventory', () => {
  it('starts at the default', () => {
    const { result } = renderHook(() => usePersistedSailInventory(ID_A));
    expect(result.current[0]).toEqual({ headsailIds: ALL, hoistedSailId: null });
  });

  it('persists a set under this boat’s own key in the documented shape', () => {
    const { result } = renderHook(() => usePersistedSailInventory(ID_A));
    act(() => result.current[1].setHeadsails([SECOND]));
    expect(result.current[0].headsailIds).toEqual([SECOND]);
    expect(JSON.parse(localStorage.getItem(KEY_A)!)).toEqual({
      v: 1,
      aboard: [SECOND],
      hoisted: null,
    });
    expect(localStorage.getItem(sailInventoryStorageKey(ID_B))).toBeNull();
  });

  it('stores catalogue order, not click order', () => {
    const { result } = renderHook(() => usePersistedSailInventory(ID_A));
    act(() => result.current[1].setHeadsails([...ALL].reverse()));
    expect(result.current[0].headsailIds).toEqual(ALL);
    expect(JSON.parse(localStorage.getItem(KEY_A)!).aboard).toEqual(ALL);
  });

  it('ignores setHeadsails([]): no state change, no write, no notification', () => {
    store({ v: 1, aboard: [SECOND], hoisted: null });
    const before = localStorage.getItem(KEY_A);
    const a = renderHook(() => usePersistedSailInventory(ID_A));
    const b = renderHook(() => usePersistedSailInventory(ID_A));
    const stateA = a.result.current[0];
    const stateB = b.result.current[0];
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    act(() => a.result.current[1].setHeadsails([]));

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY_A)).toBe(before);
    expect(a.result.current[0]).toBe(stateA);
    expect(b.result.current[0]).toBe(stateB);
    expect(a.result.current[0].headsailIds).toEqual([SECOND]);
  });

  it('ignores a set containing no catalogue sail', () => {
    const { result } = renderHook(() => usePersistedSailInventory(ID_A));
    act(() => result.current[1].setHeadsails(['no-such-sail' as SailId]));
    expect(result.current[0].headsailIds).toEqual(ALL);
    expect(localStorage.getItem(KEY_A)).toBeNull();
  });

  it.each(PROTOTYPE_NAMES.map((name) => [name]))(
    'ignores a set holding only the Object.prototype member %s',
    (name) => {
      const { result } = renderHook(() => usePersistedSailInventory(ID_A));
      act(() => result.current[1].setHeadsails([name as SailId]));
      expect(result.current[0].headsailIds).toEqual(ALL);
      expect(localStorage.getItem(KEY_A)).toBeNull();
    },
  );

  it('drops a departing hoisted sail in the same write: hoist -> one sail -> all aboard leaves it null', () => {
    store({ v: 1, aboard: ALL, hoisted: FIRST });
    const { result } = renderHook(() => usePersistedSailInventory(ID_A));
    expect(result.current[0].hoistedSailId).toBe(FIRST);

    act(() => result.current[1].setHeadsails([SECOND]));
    expect(result.current[0].hoistedSailId).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY_A)!).hoisted).toBeNull();

    act(() => result.current[1].setHeadsails(ALL));
    expect(result.current[0].hoistedSailId).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY_A)!).hoisted).toBeNull();
  });

  it('keeps a hoisted sail that stays aboard', () => {
    store({ v: 1, aboard: ALL, hoisted: FIRST });
    const { result } = renderHook(() => usePersistedSailInventory(ID_A));
    act(() => result.current[1].setHeadsails([FIRST]));
    expect(result.current[0].hoistedSailId).toBe(FIRST);
    expect(JSON.parse(localStorage.getItem(KEY_A)!).hoisted).toBe(FIRST);
  });

  it('keeps two hook instances for the same boat in sync', () => {
    const a = renderHook(() => usePersistedSailInventory(ID_A));
    const b = renderHook(() => usePersistedSailInventory(ID_A));
    act(() => a.result.current[1].setHeadsails([SECOND]));
    expect(b.result.current[0].headsailIds).toEqual([SECOND]);
  });

  it('does not notify another boat’s instance', () => {
    const a = renderHook(() => usePersistedSailInventory(ID_A));
    const b = renderHook(() => usePersistedSailInventory(ID_B));
    const before = b.result.current[0];
    act(() => a.result.current[1].setHeadsails([SECOND]));
    expect(b.result.current[0]).toBe(before);
  });

  it('unsubscribes on unmount', () => {
    const baseline = __sailInventoryListenerCountForKey(KEY_A);
    const { unmount } = renderHook(() => usePersistedSailInventory(ID_A));
    expect(__sailInventoryListenerCountForKey(KEY_A)).toBe(baseline + 1);
    unmount();
    expect(__sailInventoryListenerCountForKey(KEY_A)).toBe(baseline);
  });

  it('re-reads on a boat switch instead of serving the previous boat’s inventory', () => {
    store({ v: 1, aboard: [SECOND], hoisted: null });
    const { result, rerender } = renderHook(({ id }) => usePersistedSailInventory(id), {
      initialProps: { id: ID_A },
    });
    expect(result.current[0].headsailIds).toEqual([SECOND]);
    rerender({ id: ID_B });
    expect(result.current[0].headsailIds).toEqual(sailIdsOf(BOAT_B));
    rerender({ id: ID_A });
    expect(result.current[0].headsailIds).toEqual([SECOND]);
  });

  it('moves its subscription to the new boat’s key on a boat switch', () => {
    const KEY_B = sailInventoryStorageKey(ID_B);
    const baselineA = __sailInventoryListenerCountForKey(KEY_A);
    const baselineB = __sailInventoryListenerCountForKey(KEY_B);
    const { result, rerender } = renderHook(({ id }) => usePersistedSailInventory(id), {
      initialProps: { id: ID_A },
    });
    expect(__sailInventoryListenerCountForKey(KEY_A)).toBe(baselineA + 1);

    rerender({ id: ID_B });
    expect(__sailInventoryListenerCountForKey(KEY_A)).toBe(baselineA);
    expect(__sailInventoryListenerCountForKey(KEY_B)).toBe(baselineB + 1);

    const other = renderHook(() => usePersistedSailInventory(ID_B));
    const secondB = sailIdsOf(BOAT_B)[1]!;
    act(() => other.result.current[1].setHeadsails([secondB]));
    expect(result.current[0].headsailIds).toEqual([secondB]);

    // Boat A's key no longer reaches the switched instance.
    const stale = renderHook(() => usePersistedSailInventory(ID_A));
    act(() => stale.result.current[1].setHeadsails([SECOND]));
    expect(result.current[0].headsailIds).toEqual([secondB]);
  });

  it('degrades to session-only when localStorage throws on every access', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const a = renderHook(() => usePersistedSailInventory(ID_A));
    const b = renderHook(() => usePersistedSailInventory(ID_A));
    expect(() => act(() => a.result.current[1].setHeadsails([SECOND]))).not.toThrow();
    expect(a.result.current[0].headsailIds).toEqual([SECOND]);
    expect(b.result.current[0].headsailIds).toEqual([SECOND]);
  });
});
