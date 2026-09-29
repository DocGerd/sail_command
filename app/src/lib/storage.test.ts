import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeGetItem, safeKeys, safeSetItem } from './storage';

describe('safeGetItem/safeSetItem', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips a value through real localStorage', () => {
    expect(safeSetItem('k', 'v')).toBe(true);
    expect(safeGetItem('k')).toBe('v');
  });

  it('returns null for a missing key', () => {
    expect(safeGetItem('missing')).toBeNull();
  });

  it('getItem returns null instead of throwing when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(safeGetItem('k')).toBeNull();
  });

  it('setItem returns false instead of throwing when localStorage.setItem throws (e.g. private-mode quota)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(safeSetItem('k', 'v')).toBe(false);
  });
});

describe('safeKeys', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('lists every stored key', () => {
    localStorage.setItem('a', '1');
    localStorage.setItem('b', '2');
    expect(safeKeys().sort()).toEqual(['a', 'b']);
  });

  it('returns an empty list when enumeration throws', () => {
    localStorage.setItem('a', '1');
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(safeKeys()).toEqual([]);
  });
});
