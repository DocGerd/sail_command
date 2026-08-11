import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { __listenerCountForKey, usePersistedNumber } from './usePersistedNumber';

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

  // #353 PR2: cross-instance live sync. Two simultaneously-mounted hook
  // instances for the SAME key — the shape SettingsPanel.tsx (writer) and
  // DataLayers.tsx (reader) now use for the seamark size/display-tier
  // controls, where DataLayers stays mounted whether or not the Settings tab
  // (SettingsPanel) is. Before this, a `set()` in one instance only updated
  // ITS OWN React state; a sibling instance would not observe the change
  // until it happened to unmount/remount and re-read localStorage.
  describe('cross-instance sync (#353 PR2)', () => {
    it('set() in ONE instance is observed by a second, simultaneously-mounted instance of the SAME key', () => {
      const a = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
      const b = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
      expect(a.result.current[0]).toBeNull();
      expect(b.result.current[0]).toBeNull();
      act(() => a.result.current[1](150));
      expect(a.result.current[0]).toBe(150);
      expect(b.result.current[0]).toBe(150);
      a.unmount();
      b.unmount();
    });

    it('set(null) in one instance is observed as a reset by a second instance', () => {
      localStorage.setItem('sc-test-num', '150');
      const a = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
      const b = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
      expect(b.result.current[0]).toBe(150);
      act(() => a.result.current[1](null));
      expect(b.result.current[0]).toBeNull();
      a.unmount();
      b.unmount();
    });

    it('a DIFFERENT key never cross-notifies — two keys stay fully independent', () => {
      const a = renderHook(() => usePersistedNumber('sc-test-num-a', 0, 10));
      const b = renderHook(() => usePersistedNumber('sc-test-num-b', 0, 10));
      act(() => a.result.current[1](5));
      expect(a.result.current[0]).toBe(5);
      expect(b.result.current[0]).toBeNull();
      a.unmount();
      b.unmount();
    });

    // Renamed from "an UNMOUNTED instance is not notified (no crash, no
    // stale listener)" (#513 F4): that name claimed to guard against a
    // leaked unsubscribe, but calling a dead instance's `setRaw` is a
    // silent no-op under React 18 (the "setState on an unmounted
    // component" warning was removed there), so nothing this test could
    // observe would change if the cleanup below were deleted entirely —
    // MEASURED: it does not. This test still checks something real (a
    // fresh SECOND instance keeps working after an unrelated first one
    // unmounted), just not "unsubscribe happened" — see the next test for
    // the guard that actually reds under that mutation.
    it('a second instance keeps working after an unrelated first instance for the same key unmounts', () => {
      const a = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
      a.unmount();
      const b = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
      act(() => b.result.current[1](180));
      expect(b.result.current[0]).toBe(180);
      b.unmount();
    });

    // The actual unsubscribe guard (#513 F4). Discriminating experiment run
    // against this exact test, pasted in the PR report: deleting the
    // cleanup body in usePersistedNumber.ts —
    //   return () => {
    //     listeners.delete(setRaw);
    //     if (listeners.size === 0) listenersByKey.delete(key);
    //   };
    // — reds this test (count stays 1 instead of returning to 0) while the
    // OLD test above stays green throughout, which is exactly the vacuity
    // the old test's name overclaimed. `__listenerCountForKey` reads the
    // module registry directly rather than inferring the lifecycle from an
    // externally-observable (and, per the above, unobservable) side effect.
    it('unsubscribes its listener on unmount — the registry count returns to 0, not merely "no crash"', () => {
      expect(__listenerCountForKey('sc-test-num')).toBe(0);
      const a = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
      expect(__listenerCountForKey('sc-test-num')).toBe(1);
      const b = renderHook(() => usePersistedNumber('sc-test-num', 100, 200));
      expect(__listenerCountForKey('sc-test-num')).toBe(2);
      a.unmount();
      expect(__listenerCountForKey('sc-test-num')).toBe(1);
      b.unmount();
      expect(__listenerCountForKey('sc-test-num')).toBe(0);
    });
  });
});
