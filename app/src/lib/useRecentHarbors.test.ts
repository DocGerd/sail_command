import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRecentHarbors, parseRecentHarbors } from './useRecentHarbors';

const KEY = 'sc-recent-harbors';

// Expectations are hand-derived from the LRU contract (most-recent-first,
// de-duped, capped at 5, JSON array in storage) — never read back from the hook.
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('parseRecentHarbors', () => {
  it('returns an empty list for missing storage', () => {
    expect(parseRecentHarbors(null)).toEqual([]);
  });

  it('returns an empty list for malformed JSON', () => {
    expect(parseRecentHarbors('not json {')).toEqual([]);
  });

  it('returns an empty list when the parsed value is not an array', () => {
    expect(parseRecentHarbors('"flensburg"')).toEqual([]);
    expect(parseRecentHarbors('{"0":"flensburg"}')).toEqual([]);
  });

  it('drops non-string entries', () => {
    expect(parseRecentHarbors('["a",1,null,"b",true]')).toEqual(['a', 'b']);
  });

  it('trims an oversized stored array to the cap of 5', () => {
    expect(parseRecentHarbors('["a","b","c","d","e","f","g"]')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('useRecentHarbors', () => {
  it('starts empty on a fresh profile', () => {
    const { result } = renderHook(() => useRecentHarbors());
    expect(result.current.recent).toEqual([]);
  });

  it('hydrates the initial list from storage', () => {
    localStorage.setItem(KEY, '["flensburg","marstal"]');
    const { result } = renderHook(() => useRecentHarbors());
    expect(result.current.recent).toEqual(['flensburg', 'marstal']);
  });

  it('remembers most-recent-first and persists a JSON array', () => {
    const { result } = renderHook(() => useRecentHarbors());
    act(() => result.current.remember('a'));
    act(() => result.current.remember('b'));
    expect(result.current.recent).toEqual(['b', 'a']);
    expect(localStorage.getItem(KEY)).toBe('["b","a"]');
  });

  it('de-dupes by moving a repeated id back to the front', () => {
    const { result } = renderHook(() => useRecentHarbors());
    act(() => result.current.remember('a'));
    act(() => result.current.remember('b'));
    act(() => result.current.remember('a'));
    expect(result.current.recent).toEqual(['a', 'b']);
  });

  it('caps the list at 5, dropping the oldest', () => {
    const { result } = renderHook(() => useRecentHarbors());
    for (const id of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      act(() => result.current.remember(id));
    }
    expect(result.current.recent).toEqual(['h6', 'h5', 'h4', 'h3', 'h2']);
  });

  it('starts empty (no crash) when stored data is malformed', () => {
    localStorage.setItem(KEY, '{ broken');
    const { result } = renderHook(() => useRecentHarbors());
    expect(result.current.recent).toEqual([]);
  });

  it('falls back to an empty list (no crash) when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const { result } = renderHook(() => useRecentHarbors());
    expect(result.current.recent).toEqual([]);
  });

  it('still updates in-session (no crash) when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useRecentHarbors());
    act(() => result.current.remember('a'));
    expect(result.current.recent).toEqual(['a']);
  });
});
