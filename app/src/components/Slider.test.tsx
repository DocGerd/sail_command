import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Slider from './Slider';

describe('Slider (#353)', () => {
  it('renders a range input carrying min/max/step/value', () => {
    render(<Slider id="s" value={1} min={0.5} max={1.5} step={0.1} onChange={vi.fn()} />);
    const input = screen.getByRole('slider');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('type', 'range');
    expect(input).toHaveAttribute('min', '0.5');
    expect(input).toHaveAttribute('max', '1.5');
    expect(input).toHaveAttribute('step', '0.1');
    expect(input).toHaveValue('1');
  });

  it('calls onChange with a NUMBER (not the raw string event value) on drag/input', () => {
    const onChange = vi.fn();
    render(<Slider id="s" value={1} min={0.5} max={1.5} step={0.1} onChange={onChange} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '1.3' } });
    expect(onChange).toHaveBeenCalledWith(1.3);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(typeof onChange.mock.calls[0][0]).toBe('number');
  });

  it('forwards aria-describedby when given, and omits it when not', () => {
    const { rerender } = render(
      <Slider
        id="s"
        value={1}
        min={0}
        max={2}
        step={0.1}
        onChange={vi.fn()}
        aria-describedby="help"
      />,
    );
    expect(screen.getByRole('slider')).toHaveAttribute('aria-describedby', 'help');
    rerender(<Slider id="s" value={1} min={0} max={2} step={0.1} onChange={vi.fn()} />);
    expect(screen.getByRole('slider')).not.toHaveAttribute('aria-describedby');
  });

  it('carries the shared .sc-slider class for app.css styling', () => {
    render(<Slider id="s" value={1} min={0} max={2} step={0.1} onChange={vi.fn()} />);
    expect(screen.getByRole('slider')).toHaveClass('sc-slider');
  });

  // #513 F6: a screen reader announces `aria-valuetext` in place of the raw
  // numeric `value` when present — without it, a percent-displaying caller
  // like SettingsPanel's size control would announce "0.5"/"1"/"1.5" while
  // the visible text reads "50%"/"100%"/"150%", disagreeing with itself.
  it('forwards aria-valuetext when given, and omits it when not', () => {
    const { rerender } = render(
      <Slider
        id="s"
        value={1}
        min={0.5}
        max={1.5}
        step={0.1}
        onChange={vi.fn()}
        aria-valuetext="100%"
      />,
    );
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '100%');
    rerender(<Slider id="s" value={1} min={0.5} max={1.5} step={0.1} onChange={vi.fn()} />);
    expect(screen.getByRole('slider')).not.toHaveAttribute('aria-valuetext');
  });
});
