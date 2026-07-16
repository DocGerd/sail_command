import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import OptionsPanel from './OptionsPanel';
import { DEFAULT_SETTINGS } from '../types';

afterEach(() => {
  localStorage.clear();
});

const renderPanel = (onChange = vi.fn()) => {
  // Fix the display language to English so label assertions are
  // deterministic regardless of the provider's de default.
  localStorage.setItem('sc-lang', 'en');
  render(
    <I18nProvider>
      <OptionsPanel value={DEFAULT_SETTINGS} onChange={onChange} />
    </I18nProvider>,
  );
  return onChange;
};

describe('OptionsPanel', () => {
  it('renders every setting label with its unit', () => {
    renderPanel();
    expect(screen.getByLabelText('Safety depth (m)')).toBeInTheDocument();
    expect(screen.getByLabelText('Motoring speed (kn)')).toBeInTheDocument();
    expect(screen.getByLabelText('Motor threshold (kn)')).toBeInTheDocument();
    expect(screen.getByLabelText('Maneuver penalty (s)')).toBeInTheDocument();
    expect(screen.getByLabelText('Performance factor (×)')).toBeInTheDocument();
    expect(screen.getByLabelText('Motor enabled')).toBeInTheDocument();
  });

  it('clamps a safetyDepth value above the maximum on blur', () => {
    const onChange = renderPanel();
    const input = screen.getByLabelText('Safety depth (m)');
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(10);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, safetyDepthM: 10 });
  });

  it('clamps a safetyDepth value below the 2.2 m safety floor on blur (never below draft + margin)', () => {
    const onChange = renderPanel();
    const input = screen.getByLabelText('Safety depth (m)');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(2.2);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, safetyDepthM: 2.2 });
  });

  it('does not call onChange when blurring without changing the value', () => {
    const onChange = renderPanel();
    const input = screen.getByLabelText('Safety depth (m)');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('falls back to the last committed value when the field is blurred empty', () => {
    const onChange = renderPanel();
    const input = screen.getByLabelText('Maneuver penalty (s)');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(DEFAULT_SETTINGS.maneuverPenaltyS);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clamps performanceFactor to its 0.5-1.1 bounds', () => {
    const onChange = renderPanel();
    const input = screen.getByLabelText('Performance factor (×)');
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(1.1);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, performanceFactor: 1.1 });
  });

  it('toggles motorEnabled immediately, without waiting for blur', () => {
    const onChange = renderPanel();
    fireEvent.click(screen.getByLabelText('Motor enabled'));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, motorEnabled: false });
  });

  it('describes the motor checkbox with a visible help paragraph via aria-describedby, not a title tooltip', () => {
    renderPanel();
    const input = screen.getByLabelText('Motor enabled');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    // A tooltip would be a `title` attribute — the spec forbids it (gloved touch).
    expect(input).not.toHaveAttribute('title');
    const help = document.getElementById(describedBy!);
    expect(help).not.toBeNull();
    expect(help).toHaveClass('options-help');
    expect(help).toHaveTextContent(/Engine as fallback only/);
    expect(help).toHaveTextContent(/motor speed/);
  });
});
