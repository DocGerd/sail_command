import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { __listenerCountForKey, usePersistedToggle } from './usePersistedToggle';

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

// #681 x #813: cross-instance live sync. Two simultaneously-mounted hook
// instances for the SAME key — the shape DataLayers.tsx (always-mounted,
// drives the map layer) and RouteLegend.tsx (folded-in checkbox, only
// mounted once a plan is active) now use for the hazard-hatch toggle, where
// DataLayers stays mounted whether or not RouteLegend is. Mirrors
// usePersistedNumber.test.ts's own #353 PR2 battery exactly — same shape,
// boolean sibling.
describe('usePersistedToggle cross-instance sync (#681 x #813)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('set() in ONE instance is observed by a second, simultaneously-mounted instance of the SAME key', () => {
    const a = renderHook(() => usePersistedToggle('sc-test-toggle-sync', true));
    const b = renderHook(() => usePersistedToggle('sc-test-toggle-sync', true));
    expect(a.result.current[0]).toBe(true);
    expect(b.result.current[0]).toBe(true);
    act(() => a.result.current[1](false));
    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(false);
    a.unmount();
    b.unmount();
  });

  it('set() in the SECOND instance is observed by the first — sync is not directional', () => {
    const a = renderHook(() => usePersistedToggle('sc-test-toggle-sync', true));
    const b = renderHook(() => usePersistedToggle('sc-test-toggle-sync', true));
    act(() => b.result.current[1](false));
    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(false);
    a.unmount();
    b.unmount();
  });

  it('a second instance keeps working after an unrelated first instance for the same key unmounts', () => {
    const a = renderHook(() => usePersistedToggle('sc-test-toggle-sync', true));
    a.unmount();
    const b = renderHook(() => usePersistedToggle('sc-test-toggle-sync', true));
    act(() => b.result.current[1](false));
    expect(b.result.current[0]).toBe(false);
    b.unmount();
  });

  // Same rationale as usePersistedNumber.test.ts's own identically-named
  // test: a "no crash" assertion cannot tell a real unsubscribe from a
  // leaked one that happens not to matter under React 18's silent
  // setState-on-unmounted no-op. This probe reads the registry directly.
  it('unsubscribes its listener on unmount — the registry count returns to 0, not merely "no crash"', () => {
    expect(__listenerCountForKey('sc-test-toggle-sync')).toBe(0);
    const a = renderHook(() => usePersistedToggle('sc-test-toggle-sync', true));
    expect(__listenerCountForKey('sc-test-toggle-sync')).toBe(1);
    const b = renderHook(() => usePersistedToggle('sc-test-toggle-sync', true));
    expect(__listenerCountForKey('sc-test-toggle-sync')).toBe(2);
    a.unmount();
    expect(__listenerCountForKey('sc-test-toggle-sync')).toBe(1);
    b.unmount();
    expect(__listenerCountForKey('sc-test-toggle-sync')).toBe(0);
  });

  it('does not cross-notify a DIFFERENT key', () => {
    const a = renderHook(() => usePersistedToggle('sc-test-toggle-sync-a', true));
    const b = renderHook(() => usePersistedToggle('sc-test-toggle-sync-b', true));
    act(() => a.result.current[1](false));
    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(true);
    a.unmount();
    b.unmount();
  });
});
