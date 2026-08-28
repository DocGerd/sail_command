import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import NumberInput, { formatBound, useClampCorrection } from './NumberInput';

afterEach(() => {
  cleanup();
});

describe('NumberInput (#731: the "was I corrected" onCommit signal)', () => {
  it('reports wasClamped=true when a real out-of-range value is pulled UP to min', () => {
    const onCommit = vi.fn();
    render(<NumberInput id="n" value={5} min={2} max={10} step={1} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(2, true);
  });

  it('reports wasClamped=true when a real out-of-range value is pulled DOWN to max', () => {
    const onCommit = vi.fn();
    render(<NumberInput id="n" value={5} min={2} max={10} step={1} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(10, true);
  });

  it('reports wasClamped=false for an in-range commit', () => {
    const onCommit = vi.fn();
    render(<NumberInput id="n" value={5} min={2} max={10} step={1} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(7, false);
  });

  it('reports wasClamped=false for a value already sitting exactly ON a bound', () => {
    const onCommit = vi.fn();
    render(<NumberInput id="n" value={5} min={2} max={10} step={1} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(10, false);
  });

  // #731's own scope: the empty/garbage revert is a DIFFERENT, already-
  // intentionally-silent path — the user never typed a real out-of-range
  // number, so there is nothing to report a correction for.
  it('reverts to the last committed value on an emptied field, reporting wasClamped=false', () => {
    const onCommit = vi.fn();
    render(<NumberInput id="n" value={5} min={2} max={10} step={1} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(5, false);
  });

  it('reverts to the last committed value on garbage input, reporting wasClamped=false', () => {
    const onCommit = vi.fn();
    render(<NumberInput id="n" value={5} min={2} max={10} step={1} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(5, false);
  });
});

describe('useClampCorrection (#731)', () => {
  it('starts with no correction', () => {
    const { result } = renderHook(() => useClampCorrection(0, 10));
    expect(result.current.correctedTo).toBeNull();
  });

  it('reportCommit(n, true) records the corrected value', () => {
    const { result } = renderHook(() => useClampCorrection(0, 10));
    act(() => result.current.reportCommit(10, true));
    expect(result.current.correctedTo).toBe(10);
  });

  it('reportCommit(n, false) clears any standing correction', () => {
    const { result } = renderHook(() => useClampCorrection(0, 10));
    act(() => result.current.reportCommit(10, true));
    expect(result.current.correctedTo).toBe(10);
    act(() => result.current.reportCommit(5, false));
    expect(result.current.correctedTo).toBeNull();
  });

  // The reset story #731 requires: a bounds change (the boat-switch case)
  // must clear a standing correction even though reportCommit was never
  // called again — the notice's own numbers would otherwise describe
  // bounds that no longer apply to this field.
  it('clears a standing correction when min/max change, with NO further reportCommit call', () => {
    const { result, rerender } = renderHook(({ min, max }) => useClampCorrection(min, max), {
      initialProps: { min: 2, max: 10 },
    });
    act(() => result.current.reportCommit(2, true));
    expect(result.current.correctedTo).toBe(2);
    rerender({ min: 1.9, max: 10 });
    expect(result.current.correctedTo).toBeNull();
  });

  it('does NOT clear a standing correction on a re-render with UNCHANGED bounds', () => {
    const { result, rerender } = renderHook(({ min, max }) => useClampCorrection(min, max), {
      initialProps: { min: 2, max: 10 },
    });
    act(() => result.current.reportCommit(2, true));
    rerender({ min: 2, max: 10 });
    expect(result.current.correctedTo).toBe(2);
  });
});

describe('formatBound (#731)', () => {
  it('renders an integer bound with no decimal point', () => {
    expect(formatBound(10, 'en')).toBe('10');
  });

  it('renders a one-decimal bound with the locale decimal separator', () => {
    expect(formatBound(2.2, 'en')).toBe('2.2');
    expect(formatBound(2.2, 'de')).toBe('2,2');
  });
});
