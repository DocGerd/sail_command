import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePersistedNumber } from './usePersistedNumber';

// Blind spot (CLAUDE.md framing rule): jsdom's localStorage is real (unlike
// offsetHeight/ResizeObserver), so this file fully covers the storage
// contract and the clamp math. It cannot detect anything about the DOM
// consequence of a value (grid layout, CSS var writes) — that is
// PanelResizer.test.tsx's and the e2e spec's job respectively.
describe('usePersistedNumber', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns null when nothing is stored (no override — caller default governs)', () => {
    const { result } = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
    expect(result.current[0]).toBeNull();
  });

  it('a stored numeric value round-trips within bounds', () => {
    localStorage.setItem('sc-test-num', '150');
    const { result } = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
    expect(result.current[0]).toBe(150);
  });

  it.each(['abc', '', 'NaN', 'Infinity', '-Infinity'])(
    'garbage %j falls back to null, not a spurious number',
    (garbage) => {
      localStorage.setItem('sc-test-num', garbage);
      const { result } = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
      expect(result.current[0]).toBeNull();
    },
  );

  it('a stored value above max clamps on read (#355: the external-monitor-to-laptop bug)', () => {
    localStorage.setItem('sc-test-num', '1920');
    const { result } = renderHook(() => usePersistedNumber('sc-test-num', 320, 700));
    expect(result.current[0]).toBe(700);
  });

  it('a stored value below min clamps on read', () => {
    localStorage.setItem('sc-test-num', '10');
    const { result } = renderHook(() => usePersistedNumber('sc-test-num', 320, 700));
    expect(result.current[0]).toBe(320);
  });

  it('set() clamps and persists the clamped value, not the raw input', () => {
    const { result } = renderHook(() => usePersistedNumber('sc-test-num', 320, 700));
    act(() => result.current[1](900));
    expect(result.current[0]).toBe(700);
    expect(localStorage.getItem('sc-test-num')).toBe('700');
  });

  it('set(null) clears the stored override entirely (reset), not merely the in-memory value', () => {
    localStorage.setItem('sc-test-num', '500');
    const { result } = renderHook(() => usePersistedNumber('sc-test-num', 320, 700));
    expect(result.current[0]).toBe(500);
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    expect(localStorage.getItem('sc-test-num')).toBeNull();
  });

  it('a remount after set() reads the persisted value back', () => {
    const first = renderHook(() => usePersistedNumber('sc-test-num', 320, 700));
    act(() => first.result.current[1](450));
    first.unmount();
    const second = renderHook(() => usePersistedNumber('sc-test-num', 320, 700));
    expect(second.result.current[0]).toBe(450);
  });

  it('a bounds change (viewport shrink) reclamps the RETURNED value without mutating storage', () => {
    localStorage.setItem('sc-test-num', '600');
    const { result, rerender } = renderHook(
      ({ min, max }: { min: number; max: number }) => usePersistedNumber('sc-test-num', min, max),
      { initialProps: { min: 320, max: 700 } },
    );
    expect(result.current[0]).toBe(600);
    rerender({ min: 320, max: 400 }); // narrow viewport: bounds collapse
    expect(result.current[0]).toBe(400); // displayed value is safe...
    expect(localStorage.getItem('sc-test-num')).toBe('600'); // ...but the real preference survives
    rerender({ min: 320, max: 700 }); // back to wide: the original preference reappears
    expect(result.current[0]).toBe(600);
  });

  it('falls back to null (no crash) when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const { result } = renderHook(() => usePersistedNumber('sc-test-num', 320, 700));
    expect(result.current[0]).toBeNull();
  });

  it('still updates in-session (no crash) when localStorage.setItem throws (private-mode quota)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const { result } = renderHook(() => usePersistedNumber('sc-test-num', 320, 700));
    act(() => result.current[1](450));
    expect(result.current[0]).toBe(450);
  });
});
