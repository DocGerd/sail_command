import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeGetItem, safeSetItem } from './storage';

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
