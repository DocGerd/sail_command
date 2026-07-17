import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePersistedToggle } from './usePersistedToggle';

// Expectations here are hand-derived from the storage contract ('1' = on,
// '0' = off, anything else = default), never read back from the hook itself.
describe('usePersistedToggle', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns the default when no value is stored (fresh profile => overlays ON)', () => {
    const { result } = renderHook(() => usePersistedToggle('sc-test-toggle', true));
    expect(result.current[0]).toBe(true);
  });

  it('respects a default of false when no value is stored', () => {
    const { result } = renderHook(() => usePersistedToggle('sc-test-toggle', false));
    expect(result.current[0]).toBe(false);
  });

  it("a stored '0' overrides a true default (explicit off survives reload)", () => {
    localStorage.setItem('sc-test-toggle', '0');
    const { result } = renderHook(() => usePersistedToggle('sc-test-toggle', true));
    expect(result.current[0]).toBe(false);
  });

  it("a stored '1' overrides a false default", () => {
    localStorage.setItem('sc-test-toggle', '1');
    const { result } = renderHook(() => usePersistedToggle('sc-test-toggle', false));
    expect(result.current[0]).toBe(true);
  });

  it('an unrecognized stored value falls back to the default', () => {
    localStorage.setItem('sc-test-toggle', 'true'); // legacy/garbage, not '1'/'0'
    const { result } = renderHook(() => usePersistedToggle('sc-test-toggle', false));
    expect(result.current[0]).toBe(false);
  });

  it("setting the toggle updates state and persists '1'/'0' under the key", () => {
    const { result } = renderHook(() => usePersistedToggle('sc-test-toggle', true));
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem('sc-test-toggle')).toBe('0');
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem('sc-test-toggle')).toBe('1');
  });

  it('a remount after set() reads the persisted value back', () => {
    const first = renderHook(() => usePersistedToggle('sc-test-toggle', true));
    act(() => first.result.current[1](false));
    first.unmount();
    const second = renderHook(() => usePersistedToggle('sc-test-toggle', true));
    expect(second.result.current[0]).toBe(false);
  });

  it('falls back to the default (no crash) when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const { result } = renderHook(() => usePersistedToggle('sc-test-toggle', true));
    expect(result.current[0]).toBe(true);
  });

  it('still flips in-session (no crash) when localStorage.setItem throws (private-mode quota)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const { result } = renderHook(() => usePersistedToggle('sc-test-toggle', true));
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
  });
});
