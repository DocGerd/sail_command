import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import NumberInput, { formatBound, resolveNumberCommit, useClampCorrection } from './NumberInput';

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

// #731 review round 2: Infinity/-Infinity are SPEC'D by the finite guard's
// own doc comment ("false on every OTHER commit path") but were untested —
// and cannot be tested through the rendered `<input type="number">` at all.
// Measured directly against jsdom (matching the WHATWG "rules for parsing
// floating-point number values" algorithm, which every spec-compliant
// browser implements): assigning a value whose Number() parse overflows to
// Infinity — e.g. "1e400" — sanitizes the input's `.value` to `''` BEFORE
// this component's onChange ever runs, so `draft` can never actually equal
// such a string when reached through the real widget. A `fireEvent.change`
// test asserting the Infinity case would be silently VACUOUS: the mutation
// it exists to catch could never fire, because the empty-string branch
// would take over regardless of what the finite guard does with Infinity.
// `resolveNumberCommit` is tested directly instead, bypassing the DOM
// entirely, so the guard's FULL domain is actually exercised.
describe('resolveNumberCommit (#731 review round 2: Infinity is reachable only here, not via the DOM)', () => {
  it('reverts on a positive-Infinity draft, reporting wasClamped=false', () => {
    expect(resolveNumberCommit('Infinity', 5, 2, 10)).toEqual({ next: 5, wasClamped: false });
  });

  it('reverts on a negative-Infinity draft, reporting wasClamped=false', () => {
    expect(resolveNumberCommit('-Infinity', 5, 2, 10)).toEqual({ next: 5, wasClamped: false });
  });

  // Equivalence check against the DOM-level rows above, so this function is
  // proven to be the SAME logic `handleBlur` delegates to, not a parallel
  // implementation that could drift from it.
  it('matches the DOM-level clamp/revert rows for ordinary inputs', () => {
    expect(resolveNumberCommit('1', 5, 2, 10)).toEqual({ next: 2, wasClamped: true });
    expect(resolveNumberCommit('99', 5, 2, 10)).toEqual({ next: 10, wasClamped: true });
    expect(resolveNumberCommit('7', 5, 2, 10)).toEqual({ next: 7, wasClamped: false });
    expect(resolveNumberCommit('', 5, 2, 10)).toEqual({ next: 5, wasClamped: false });
    expect(resolveNumberCommit('abc', 5, 2, 10)).toEqual({ next: 5, wasClamped: false });
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
