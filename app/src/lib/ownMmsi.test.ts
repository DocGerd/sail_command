import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OWN_MMSI_KEY_PREFIX,
  __ownMmsiListenerCountForKey,
  ownMmsiStorageKey,
  readOwnMmsi,
  usePersistedOwnMmsi,
} from './ownMmsi';
import type { BoatId } from '../data/boats';

// Two REAL catalogue ids. The per-boat claim is about two distinct keys, so
// the ids only have to be distinct — but using real ones keeps this honest if
// `BoatId` ever stops being a bare string union.
const BOAT_A = 'salona-45' as BoatId;
const BOAT_B = 'salona-44-speedy-go' as BoatId;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ownMmsiStorageKey', () => {
  it('derives ONE key per boat, namespaced by the shared prefix', () => {
    expect(ownMmsiStorageKey(BOAT_A)).toBe(`${OWN_MMSI_KEY_PREFIX}salona-45`);
    expect(ownMmsiStorageKey(BOAT_B)).toBe(`${OWN_MMSI_KEY_PREFIX}salona-44-speedy-go`);
    // The whole point of #746's storage shape: two boats can never collide on
    // one entry, so there is no lookup table and therefore no Object.prototype
    // fall-open class to guard against (the #614/PR #656 defect).
    expect(ownMmsiStorageKey(BOAT_A)).not.toBe(ownMmsiStorageKey(BOAT_B));
  });
});

describe('readOwnMmsi', () => {
  it('returns null when nothing is stored for that boat', () => {
    expect(readOwnMmsi(BOAT_A)).toBeNull();
  });

  it('preserves a leading-zero MMSI as a string', () => {
    localStorage.setItem(ownMmsiStorageKey(BOAT_A), '002110000');
    // A numeric round-trip would silently yield 2110000. Coast-station and
    // group identifiers (00MIDxxxx) are exactly the case that breaks.
    expect(readOwnMmsi(BOAT_A)).toBe('002110000');
  });

  it('never throws when localStorage itself throws (private-mode contract)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: access denied');
    });
    expect(() => readOwnMmsi(BOAT_A)).not.toThrow();
    expect(readOwnMmsi(BOAT_A)).toBeNull();
  });
});

describe('usePersistedOwnMmsi', () => {
  it('starts at null and persists a set value under this boat’s own key', () => {
    const { result } = renderHook(() => usePersistedOwnMmsi(BOAT_A));
    expect(result.current[0]).toBeNull();

    act(() => result.current[1]('211234560'));

    expect(result.current[0]).toBe('211234560');
    expect(localStorage.getItem(ownMmsiStorageKey(BOAT_A))).toBe('211234560');
  });

  it('treats the empty string as "no value" and REMOVES the entry', () => {
    localStorage.setItem(ownMmsiStorageKey(BOAT_A), '211234560');
    const { result } = renderHook(() => usePersistedOwnMmsi(BOAT_A));

    act(() => result.current[1](''));

    // Not merely "reads as null": the entry is gone, so a later reader cannot
    // resurrect a cleared MMSI (the usePersistedNumber/#355 reset contract).
    expect(result.current[0]).toBeNull();
    expect(localStorage.getItem(ownMmsiStorageKey(BOAT_A))).toBeNull();
  });

  it('degrades to session-only when the write fails, without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = renderHook(() => usePersistedOwnMmsi(BOAT_A));

    expect(() => act(() => result.current[1]('211234560'))).not.toThrow();
    // The in-memory value still updates so the field the user is typing in
    // does not appear frozen; only persistence is lost.
    expect(result.current[0]).toBe('211234560');
  });

  // ── THE #746 CLAIM ────────────────────────────────────────────────────────
  // This is the row the whole change exists for. It is the mutation target:
  // collapse ownMmsiStorageKey() to a single boat-independent key and ONLY
  // this row (and its BoatPicker sibling) reds.
  it('scopes the value to the boat: B does not see A’s MMSI, and A keeps its own', () => {
    const { result, rerender } = renderHook(({ boatId }) => usePersistedOwnMmsi(boatId), {
      initialProps: { boatId: BOAT_A },
    });

    act(() => result.current[1]('211234560'));
    expect(result.current[0]).toBe('211234560');

    // Switch to boat B: it must NOT inherit A's vessel identity. Inheriting it
    // would suppress the WRONG vessel from the AIS display — silently, which
    // is precisely the defect #746 removes.
    rerender({ boatId: BOAT_B });
    expect(result.current[0]).toBeNull();

    act(() => result.current[1]('244110001'));
    expect(result.current[0]).toBe('244110001');

    // Switch back: A's own value survived B being set.
    rerender({ boatId: BOAT_A });
    expect(result.current[0]).toBe('211234560');

    // And the two live in genuinely separate entries.
    expect(localStorage.getItem(ownMmsiStorageKey(BOAT_A))).toBe('211234560');
    expect(localStorage.getItem(ownMmsiStorageKey(BOAT_B))).toBe('244110001');
  });

  it('re-reads on a boat switch WITHOUT an intervening write', () => {
    // Distinct from the row above, which writes through the hook. Here B's
    // value is already on disk, so this pins the READ path of the switch — a
    // hook that only re-read after its own set() would pass the row above and
    // fail this one.
    localStorage.setItem(ownMmsiStorageKey(BOAT_B), '244110001');
    const { result, rerender } = renderHook(({ boatId }) => usePersistedOwnMmsi(boatId), {
      initialProps: { boatId: BOAT_A },
    });
    expect(result.current[0]).toBeNull();

    rerender({ boatId: BOAT_B });
    expect(result.current[0]).toBe('244110001');
  });

  it('syncs live between two mounted instances of the SAME boat key', () => {
    // App.tsx (feeding <AisTraffic>) and BoatPicker (rendering the field) are
    // mounted at once. Without the listener registry the overlay would keep
    // filtering on the old value until a remount.
    const a = renderHook(() => usePersistedOwnMmsi(BOAT_A));
    const b = renderHook(() => usePersistedOwnMmsi(BOAT_A));

    act(() => a.result.current[1]('211234560'));

    expect(b.result.current[0]).toBe('211234560');
  });

  it('does NOT cross-notify a different boat’s instance', () => {
    const a = renderHook(() => usePersistedOwnMmsi(BOAT_A));
    const b = renderHook(() => usePersistedOwnMmsi(BOAT_B));

    act(() => a.result.current[1]('211234560'));

    expect(b.result.current[0]).toBeNull();
  });

  it('unsubscribes on unmount (registry probed directly, #513 F4 rationale)', () => {
    const key = ownMmsiStorageKey(BOAT_A);
    expect(__ownMmsiListenerCountForKey(key)).toBe(0);

    const { unmount } = renderHook(() => usePersistedOwnMmsi(BOAT_A));
    expect(__ownMmsiListenerCountForKey(key)).toBe(1);

    unmount();
    // Asserting the registry rather than "no crash, right final value":
    // calling a dead instance's setter is a silent no-op under React 18, so
    // a behavioural test cannot tell a real unsubscribe from a leaked one.
    expect(__ownMmsiListenerCountForKey(key)).toBe(0);
  });
});
