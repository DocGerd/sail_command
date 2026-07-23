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
  it('renders the five advanced settings and does NOT render safety depth (pulled into the compact row)', () => {
    renderPanel();
    expect(screen.getByLabelText('Motoring speed (kn)')).toBeInTheDocument();
    expect(screen.getByLabelText('Motor threshold (kn)')).toBeInTheDocument();
    expect(screen.getByLabelText('Maneuver penalty (s)')).toBeInTheDocument();
    expect(screen.getByLabelText('Performance factor (×)')).toBeInTheDocument();
    expect(screen.getByLabelText('Motor enabled')).toBeInTheDocument();
    // §3.3: safety depth is one of the two most-changed inputs and lives in
    // PlannerPanel's compact row now, not behind this advanced group.
    expect(screen.queryByLabelText('Safety depth (m)')).not.toBeInTheDocument();
  });

  it('clamps a value above the maximum on blur (motoring speed, max 10)', () => {
    const onChange = renderPanel();
    const input = screen.getByLabelText('Motoring speed (kn)');
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(10);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, motorSpeedKn: 10 });
  });

  it('does not call onChange when blurring without changing the value', () => {
    const onChange = renderPanel();
    const input = screen.getByLabelText('Motoring speed (kn)');
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

  // #25 addendum: standalone "show my position" ownship marker toggle.
  it('renders the "show my position" checkbox UNCHECKED against DEFAULT_SETTINGS (opt-in, default off)', () => {
    renderPanel();
    expect(screen.getByLabelText('Show my position')).not.toBeChecked();
  });

  it('toggling "show my position" ON calls onChange with showOwnship: true, immediately (no blur needed)', () => {
    const onChange = renderPanel();
    fireEvent.click(screen.getByLabelText('Show my position'));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, showOwnship: true });
  });

  it('describes the ownship checkbox with a visible help paragraph via aria-describedby, not a title tooltip', () => {
    renderPanel();
    const input = screen.getByLabelText('Show my position');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(input).not.toHaveAttribute('title');
    const help = document.getElementById(describedBy!);
    expect(help).not.toBeNull();
    expect(help).toHaveClass('options-help');
    // Framing (#25 addendum): the caveat travels with the toggle, not just
    // the app-wide disclaimer.
    expect(help).toHaveTextContent(/not a navigation device/);
  });

  // #25 AIS group.
  it('renders the AIS API-key and MMSI fields with the privacy help text', () => {
    renderPanel();
    expect(screen.getByLabelText('AIS API key (aisstream.io)')).toBeInTheDocument();
    expect(screen.getByLabelText('Your MMSI (optional)')).toBeInTheDocument();
    expect(screen.getByText(/stay on this device/)).toBeInTheDocument();
    expect(screen.getByText(/only to aisstream\.io/)).toBeInTheDocument();
    expect(screen.getByText(/never transmitted/)).toBeInTheDocument();
  });

  it('commits the API key on change', () => {
    const onChange = renderPanel();
    fireEvent.change(screen.getByLabelText('AIS API key (aisstream.io)'), {
      target: { value: 'my-key' },
    });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, aisApiKey: 'my-key' });
  });

  it('shows the MMSI validation message for a non-empty, non-9-digit value', () => {
    localStorage.setItem('sc-lang', 'en');
    render(
      <I18nProvider>
        <OptionsPanel value={{ ...DEFAULT_SETTINGS, ownMmsi: '123' }} onChange={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText('MMSI must be exactly 9 digits.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your MMSI (optional)')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows no MMSI validation message for a valid 9-digit value', () => {
    localStorage.setItem('sc-lang', 'en');
    render(
      <I18nProvider>
        <OptionsPanel value={{ ...DEFAULT_SETTINGS, ownMmsi: '211234560' }} onChange={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.queryByText('MMSI must be exactly 9 digits.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your MMSI (optional)')).toHaveAttribute('aria-invalid', 'false');
  });

  it('shows no MMSI validation message when the field is empty (feature simply off)', () => {
    renderPanel();
    expect(screen.queryByText('MMSI must be exactly 9 digits.')).not.toBeInTheDocument();
  });
});
