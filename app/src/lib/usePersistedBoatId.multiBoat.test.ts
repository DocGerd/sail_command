import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Its own file because `vi.mock` is hoisted per module graph, and
// usePersistedBoatId.test.ts asserts against the REAL one-entry catalogue.
//
// WHY THIS FILE EXISTS AT ALL, measured rather than assumed: at a one-boat
// catalogue the only valid stored id IS `DEFAULT_BOAT_ID`, so "reads the
// stored id" and "ignores storage and returns the default" are the SAME
// OBSERVATION. A mutation replacing the whole initialiser with
// `return DEFAULT_BOAT_ID` left the single-catalogue file **8 passed / 0
// failed** — the mount-read rows could not reach the behaviour they claimed
// to pin. Both of them live here now, against a second catalogue entry that
// makes the two outcomes distinguishable; the same mutation reds this file.
vi.mock('../data/boats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/boats')>();
  const salona = actual.BOATS[0]!;
  const deep = { ...salona, id: 'deep-46', name: 'Deep 46', draftM: 2.3 };
  const BOATS = [salona, deep];
  return {
    ...actual,
    BOATS,
    boatById: (id: string) => {
      const b = BOATS.find((x) => x.id === id);
      if (!b) throw new Error(`unknown boat id: ${id}`);
      return b;
    },
  };
});

const { BOAT_ID_STORAGE_KEY, usePersistedBoatId } = await import('./usePersistedBoatId');
const { BOATS, DEFAULT_BOAT_ID } = await import('../data/boats');

type BoatIdish = Parameters<ReturnType<typeof usePersistedBoatId>[1]>[0];
const OTHER = 'deep-46' as BoatIdish;

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the mocked catalogue itself', () => {
  it('really did install a SECOND boat that is not the default', () => {
    // #411's "a guard's DATA needs a twin". If the mock silently fell back to
    // the real module, every row below would collapse back into the vacuous
    // one-boat case and keep reporting success.
    expect(BOATS.map((b) => b.id)).toEqual(['salona-45', 'deep-46']);
    expect(OTHER).not.toBe(DEFAULT_BOAT_ID);
  });
});

describe('#54 usePersistedBoatId against a multi-boat catalogue', () => {
  it('reads a stored NON-default catalogue id on mount', () => {
    localStorage.setItem(BOAT_ID_STORAGE_KEY, OTHER);
    const { result } = renderHook(() => usePersistedBoatId());
    expect(result.current[0]).toBe(OTHER);
  });

  it('round-trips a NON-default selection into a fresh hook instance', () => {
    const first = renderHook(() => usePersistedBoatId());
    expect(first.result.current[0]).toBe(DEFAULT_BOAT_ID);
    act(() => {
      first.result.current[1](OTHER);
    });
    expect(first.result.current[0]).toBe(OTHER);
    expect(localStorage.getItem(BOAT_ID_STORAGE_KEY)).toBe(OTHER);

    cleanup();
    const second = renderHook(() => usePersistedBoatId());
    expect(second.result.current[0]).toBe(OTHER);
  });

  it('still falls back to the default when the stored id leaves the catalogue', () => {
    // The fallback path with a real alternative present, so "fell back" is not
    // trivially the same value as "read successfully".
    localStorage.setItem(BOAT_ID_STORAGE_KEY, 'withdrawn-fleet-vessel');
    const { result } = renderHook(() => usePersistedBoatId());
    expect(result.current[0]).toBe(DEFAULT_BOAT_ID);
  });
});
