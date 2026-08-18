import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BOAT_ID_STORAGE_KEY, isCatalogueBoatId, usePersistedBoatId } from './usePersistedBoatId';
import { BOATS, DEFAULT_BOAT_ID } from '../data/boats';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('#54 usePersistedBoatId', () => {
  it('`set()` WRITES the selection to localStorage', () => {
    // Scoped deliberately to the write. The READ-BACK half cannot be tested
    // here: at a one-entry catalogue the only valid id IS DEFAULT_BOAT_ID, so
    // "read the stored value" and "ignored storage and defaulted" are the
    // same observation — MEASURED, a mutation replacing the whole initialiser
    // with `return DEFAULT_BOAT_ID` left this file 7 passed / 0 failed.
    // usePersistedBoatId.multiBoat.test.ts owns the read-back and mount-read
    // rows against a second catalogue entry, where they discriminate.
    const { result } = renderHook(() => usePersistedBoatId());
    act(() => {
      result.current[1](DEFAULT_BOAT_ID);
    });
    expect(localStorage.getItem(BOAT_ID_STORAGE_KEY)).toBe(DEFAULT_BOAT_ID);
  });

  it('falls back to DEFAULT_BOAT_ID on a stored id that is no longer in the catalogue', () => {
    // The whole reason validation exists: `boatById` THROWS on a miss, so an
    // unvalidated read turns one stale localStorage entry into a blank app on
    // every subsequent load, unclearable from inside the app.
    localStorage.setItem(BOAT_ID_STORAGE_KEY, 'withdrawn-fleet-vessel');
    const { result } = renderHook(() => usePersistedBoatId());
    expect(result.current[0]).toBe(DEFAULT_BOAT_ID);
  });

  it('leaves the unrecognised stored entry in place rather than overwriting it', () => {
    // Deliberate, and separable from the row above: falling back is about
    // what the app USES, this is about what it DESTROYS. Silently rewriting
    // storage here would erase the only record of the user's choice if that
    // id ever returns to the catalogue.
    localStorage.setItem(BOAT_ID_STORAGE_KEY, 'withdrawn-fleet-vessel');
    renderHook(() => usePersistedBoatId());
    expect(localStorage.getItem(BOAT_ID_STORAGE_KEY)).toBe('withdrawn-fleet-vessel');
  });

  it('falls back to DEFAULT_BOAT_ID when nothing is stored at all', () => {
    const { result } = renderHook(() => usePersistedBoatId());
    expect(result.current[0]).toBe(DEFAULT_BOAT_ID);
  });

  it('treats an empty stored string as absent', () => {
    // `''` is neither null nor a catalogue id. Called out because this repo
    // has been bitten by the mirror-image case — an empty value that a
    // truthiness or `??` check silently accepts (CLAUDE.md's `[]`-defeats-`??`
    // rule); `isCatalogueBoatId` is a membership test, so it rejects it.
    localStorage.setItem(BOAT_ID_STORAGE_KEY, '');
    const { result } = renderHook(() => usePersistedBoatId());
    expect(result.current[0]).toBe(DEFAULT_BOAT_ID);
  });
});

describe('#54 isCatalogueBoatId', () => {
  it('accepts every id the catalogue actually ships', () => {
    // Iterating the catalogue rather than naming one id, so a boat added by
    // the parallel fleet work is covered the moment it lands.
    for (const b of BOATS) {
      expect(isCatalogueBoatId(b.id), `catalogue boat ${b.id} must validate`).toBe(true);
    }
    // Non-vacuity twin for the loop above (#411's "a guard's DATA needs a
    // twin"): a catalogue stubbed to [] would leave that loop green over zero
    // rows. This asserts it ran at all.
    expect(BOATS.length).toBeGreaterThan(0);
  });

  it('rejects a non-catalogue string and null', () => {
    // Deliberately NOT a plausible future id such as 'salona-44' (spec N.1
    // has SPEEDY GO! queued as exactly that): a negative row that a real
    // catalogue addition would silently flip to a false is not a test.
    expect(isCatalogueBoatId('not-a-boat')).toBe(false);
    expect(isCatalogueBoatId(null)).toBe(false);
  });
});
