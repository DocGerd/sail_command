import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSheetTop } from './useSheetTop';

let callbacks: Array<() => void> = [];
let disconnects = 0;

class FakeResizeObserver {
  private cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe() {
    callbacks.push(this.cb);
    this.cb();
  }
  disconnect() {
    disconnects += 1;
    callbacks = callbacks.filter((c) => c !== this.cb);
  }
}

describe('#1854 useSheetTop', () => {
  let sheet: HTMLDivElement;
  let top = 531;

  beforeEach(() => {
    callbacks = [];
    disconnects = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    sheet = document.createElement('div');
    sheet.className = 'app-bottom-sheet';
    sheet.getBoundingClientRect = () => ({ top }) as DOMRect;
    document.body.appendChild(sheet);
  });

  afterEach(() => {
    sheet.remove();
    vi.unstubAllGlobals();
  });

  it('reads the sheet top and follows a resize', () => {
    const { result } = renderHook(() => useSheetTop(true));
    expect(result.current).toBe(531);
    top = 600;
    act(() => callbacks.forEach((c) => c()));
    expect(result.current).toBe(600);
    top = 531;
  });

  it('is null and observes nothing when disabled', () => {
    const { result } = renderHook(() => useSheetTop(false));
    expect(result.current).toBeNull();
    expect(callbacks).toHaveLength(0);
  });

  it('is null without a sheet, and disconnects on unmount', () => {
    sheet.remove();
    expect(renderHook(() => useSheetTop(true)).result.current).toBeNull();
    document.body.appendChild(sheet);
    const { unmount } = renderHook(() => useSheetTop(true));
    unmount();
    expect(disconnects).toBe(1);
  });
});
