import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import SettingsPanel from './SettingsPanel';
import { DEFAULT_BOAT_ID } from '../data/boats';
import { DEFAULT_SETTINGS } from '../types';

afterEach(() => {
  localStorage.clear();
});

const renderPanel = (onChange = vi.fn()) => {
  // Fix the display language to English so label/heading assertions are
  // deterministic regardless of the provider's de default.
  localStorage.setItem('sc-lang', 'en');
  render(
    <I18nProvider>
      <SettingsPanel
        value={DEFAULT_SETTINGS}
        onChange={onChange}
        boatId={DEFAULT_BOAT_ID}
        onBoatIdChange={vi.fn()}
      />
    </I18nProvider>,
  );
  return onChange;
};

/** The `.sc-card` container a given h2 section heading sits inside — the
 * grouping this test file verifies against, since `Card` renders a plain
 * `<h2 className="sc-card-title">`, not an ARIA region. */
function sectionOf(headingName: string | RegExp): HTMLElement {
  const heading = screen.getByRole('heading', { name: headingName });
  const section = heading.closest('.sc-card');
  if (!section)
    throw new Error(`expected an .sc-card ancestor for heading "${String(headingName)}"`);
  return section as HTMLElement;
}

describe('SettingsPanel (#299 Boat tab)', () => {
  it('renders the three grouped section headings', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Boat & safety' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Propulsion' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Live & AIS' })).toBeInTheDocument();
  });

  // §3.3/#299 (corrected after PR #486 review — issue #299's design
  // question 2 says safety depth belongs in BOTH places, this panel as its
  // canonical home): safety depth DOES render here now, leading the "Boat &
  // safety" group, from the SAME SAFETY_DEPTH_FIELD spec + commitSetting
  // PlannerPanel's inline compact-row field also uses — one value, two
  // renders. See App.test.tsx's dedicated single-source-of-truth test for
  // the cross-surface pin (this file only renders SettingsPanel standalone,
  // so it cannot exercise "edit in one surface, see it in the other" itself).
  it('renders safety depth leading the Boat & safety group, from its default value', () => {
    renderPanel();
    const section = sectionOf('Boat & safety');
    const input = within(section).getByLabelText('Safety depth (m)');
    expect(input).toHaveValue(DEFAULT_SETTINGS.safetyDepthM);
  });

  // #699: this was the one numeric field in the Boat tab without a help
  // paragraph at all — its allowed range existed only as native min/max
  // attributes. Mirrors the depth-comfort-margin test right below for the
  // wiring shape (aria-describedby -> a real element, not a title tooltip).
  it('#699: discloses the allowed range as visible, described help text', () => {
    renderPanel();
    const input = screen.getByLabelText('Safety depth (m)');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(input).not.toHaveAttribute('title');
    const help = document.getElementById(describedBy!);
    expect(help).toHaveTextContent('Allowed range: 2.2–10 m');
  });

  it('commits safety depth on blur and clamps to its 2.2-10 bounds (same SAFETY_DEPTH_FIELD spec as the inline field)', () => {
    const onChange = renderPanel();
    const input = screen.getByLabelText('Safety depth (m)');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(2.2);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, safetyDepthM: 2.2 });
  });

  describe('Boat & safety group', () => {
    it('renders the depth comfort margin field with its default value and help paragraph, grouped under Boat & safety', () => {
      renderPanel();
      const section = sectionOf('Boat & safety');
      const input = within(section).getByLabelText('Depth comfort margin (m)');
      expect(input).toHaveValue(DEFAULT_SETTINGS.depthComfortMarginM);
      const describedBy = input.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(input).not.toHaveAttribute('title');
      const help = document.getElementById(describedBy!);
      expect(help).toHaveTextContent(/0 disables the preference/);
    });

    it('commits the depth comfort margin on blur and clamps to its 0-5 bounds', () => {
      const onChange = renderPanel();
      const input = screen.getByLabelText('Depth comfort margin (m)');
      fireEvent.change(input, { target: { value: '1.5' } });
      fireEvent.blur(input);
      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, depthComfortMarginM: 1.5 });
      fireEvent.change(input, { target: { value: '99' } });
      fireEvent.blur(input);
      expect(input).toHaveValue(5);
    });

    it('renders maneuver penalty and performance factor grouped under Boat & safety, not Propulsion', () => {
      renderPanel();
      const boatSafety = sectionOf('Boat & safety');
      expect(within(boatSafety).getByLabelText('Maneuver penalty (s)')).toBeInTheDocument();
      expect(within(boatSafety).getByLabelText('Performance factor (×)')).toBeInTheDocument();
      const propulsion = sectionOf('Propulsion');
      expect(within(propulsion).queryByLabelText('Maneuver penalty (s)')).not.toBeInTheDocument();
      expect(within(propulsion).queryByLabelText('Performance factor (×)')).not.toBeInTheDocument();
    });

    it('clamps performanceFactor to its 0.5-1.1 bounds', () => {
      const onChange = renderPanel();
      const input = screen.getByLabelText('Performance factor (×)');
      fireEvent.change(input, { target: { value: '2' } });
      fireEvent.blur(input);
      expect(input).toHaveValue(1.1);
      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, performanceFactor: 1.1 });
    });

    it('falls back to the last committed value when maneuver penalty is blurred empty', () => {
      const onChange = renderPanel();
      const input = screen.getByLabelText('Maneuver penalty (s)');
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);
      expect(input).toHaveValue(DEFAULT_SETTINGS.maneuverPenaltyS);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('Propulsion group', () => {
    it('renders motor enabled, motor speed/threshold and sail preference grouped under Propulsion', () => {
      renderPanel();
      const propulsion = sectionOf('Propulsion');
      expect(within(propulsion).getByLabelText('Motor enabled')).toBeInTheDocument();
      expect(within(propulsion).getByLabelText('Motoring speed (kn)')).toBeInTheDocument();
      expect(within(propulsion).getByLabelText('Motor threshold (kn)')).toBeInTheDocument();
      expect(within(propulsion).getByLabelText('Sail preference (kn)')).toBeInTheDocument();
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
      expect(input).not.toHaveAttribute('title');
      const help = document.getElementById(describedBy!);
      expect(help).toHaveTextContent(/motoring speed/);
    });

    it('clamps a value above the maximum on blur (motoring speed, max 10)', () => {
      const onChange = renderPanel();
      const input = screen.getByLabelText('Motoring speed (kn)');
      fireEvent.change(input, { target: { value: '25' } });
      fireEvent.blur(input);
      expect(input).toHaveValue(10);
      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, motorSpeedKn: 10 });
    });

    it('renders the sail preference field with its default value and help paragraph', () => {
      renderPanel();
      const input = screen.getByLabelText('Sail preference (kn)');
      expect(input).toHaveValue(DEFAULT_SETTINGS.sailPreferenceKn);
      const describedBy = input.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const help = document.getElementById(describedBy!);
      expect(help).toHaveTextContent(/give up to keep sailing/);
    });

    it('commits the sail preference on blur and clamps to its 0-10 bounds', () => {
      const onChange = renderPanel();
      const input = screen.getByLabelText('Sail preference (kn)');
      fireEvent.change(input, { target: { value: '1.5' } });
      fireEvent.blur(input);
      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, sailPreferenceKn: 1.5 });
      fireEvent.change(input, { target: { value: '99' } });
      fireEvent.blur(input);
      expect(input).toHaveValue(10);
    });

    // Ported from OptionsPanel.test.tsx (PR #486 review, Minor 4) before
    // deleting that now-dead component/test file — a blur that never
    // changed the value must not fire a redundant onChange.
    it('does not call onChange when blurring without changing the value', () => {
      const onChange = renderPanel();
      const input = screen.getByLabelText('Motoring speed (kn)');
      fireEvent.focus(input);
      fireEvent.blur(input);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('Live & AIS group', () => {
    it('renders "show my position" UNCHECKED against DEFAULT_SETTINGS and the AIS fields, grouped under Live & AIS', () => {
      renderPanel();
      const section = sectionOf('Live & AIS');
      expect(within(section).getByLabelText('Show my position')).not.toBeChecked();
      expect(within(section).getByLabelText('AIS API key (aisstream.io)')).toBeInTheDocument();
      expect(within(section).getByLabelText('Your MMSI (optional)')).toBeInTheDocument();
    });

    it('toggling "show my position" ON calls onChange with showOwnship: true, immediately', () => {
      const onChange = renderPanel();
      fireEvent.click(screen.getByLabelText('Show my position'));
      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, showOwnship: true });
    });

    // Ported from OptionsPanel.test.tsx (PR #486 review, Minor 4).
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

    // Ported from OptionsPanel.test.tsx (PR #486 review, Minor 4).
    it('renders the AIS API-key and MMSI fields with the privacy help text', () => {
      renderPanel();
      expect(screen.getByLabelText('AIS API key (aisstream.io)')).toBeInTheDocument();
      expect(screen.getByLabelText('Your MMSI (optional)')).toBeInTheDocument();
      expect(screen.getByText(/stay on this device/)).toBeInTheDocument();
      expect(screen.getByText(/only to aisstream\.io/)).toBeInTheDocument();
      expect(screen.getByText(/never transmitted/)).toBeInTheDocument();
    });

    it('commits the AIS API key on change', () => {
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
          <SettingsPanel
            value={{ ...DEFAULT_SETTINGS, ownMmsi: '123' }}
            onChange={vi.fn()}
            boatId={DEFAULT_BOAT_ID}
            onBoatIdChange={vi.fn()}
          />
        </I18nProvider>,
      );
      expect(screen.getByText('MMSI must be exactly 9 digits.')).toBeInTheDocument();
      expect(screen.getByLabelText('Your MMSI (optional)')).toHaveAttribute('aria-invalid', 'true');
    });

    it('shows no MMSI validation message for a valid 9-digit value', () => {
      localStorage.setItem('sc-lang', 'en');
      render(
        <I18nProvider>
          <SettingsPanel
            value={{ ...DEFAULT_SETTINGS, ownMmsi: '211234560' }}
            onChange={vi.fn()}
            boatId={DEFAULT_BOAT_ID}
            onBoatIdChange={vi.fn()}
          />
        </I18nProvider>,
      );
      expect(screen.queryByText('MMSI must be exactly 9 digits.')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Your MMSI (optional)')).toHaveAttribute(
        'aria-invalid',
        'false',
      );
    });

    // Ported from OptionsPanel.test.tsx (PR #486 review, Minor 4).
    it('shows no MMSI validation message when the field is empty (feature simply off)', () => {
      renderPanel();
      expect(screen.queryByText('MMSI must be exactly 9 digits.')).not.toBeInTheDocument();
    });
  });

  // #353 PR2: the seamark size slider + display-category radiogroup. Both
  // persist via usePersistedNumber (localStorage, NOT the `Settings`/
  // IndexedDB `value` prop this file's other fields use) — asserted here by
  // reading `localStorage` directly, mirroring PanelResizer.test.tsx's own
  // convention for the #355 panel-width control.
  describe('Map display group (#353 PR2)', () => {
    it('renders the size slider at its default (100%, no stored override) and the category radiogroup defaulting to Standard, grouped under Map display', () => {
      renderPanel();
      const section = sectionOf('Map display');
      const slider = within(section).getByRole('slider', { name: 'Symbol size (seamarks)' });
      expect(slider).toHaveValue('1');
      expect(within(section).getByText('100%')).toBeInTheDocument();
      expect(within(section).getByRole('radio', { name: 'Base' })).not.toBeChecked();
      expect(within(section).getByRole('radio', { name: 'Standard' })).toBeChecked();
      expect(within(section).getByRole('radio', { name: 'All' })).not.toBeChecked();
    });

    it('a stored size override renders as the persisted value/percent, not the default', () => {
      localStorage.setItem('sc-seamark-size-scale', '1.3');
      renderPanel();
      const section = sectionOf('Map display');
      expect(within(section).getByRole('slider', { name: 'Symbol size (seamarks)' })).toHaveValue(
        '1.3',
      );
      expect(within(section).getByText('130%')).toBeInTheDocument();
    });

    it('dragging the size slider persists the new value to localStorage and updates the percent readout', () => {
      renderPanel();
      const slider = screen.getByRole('slider', { name: 'Symbol size (seamarks)' });
      fireEvent.change(slider, { target: { value: '0.7' } });
      expect(localStorage.getItem('sc-seamark-size-scale')).toBe('0.7');
      expect(screen.getByText('70%')).toBeInTheDocument();
    });

    it('the size slider clamps to its bounds (0.5-1.5) — a MapLibre collision-safety bound, not just an input attribute', () => {
      renderPanel();
      const slider = screen.getByRole('slider', { name: 'Symbol size (seamarks)' });
      expect(slider).toHaveAttribute('min', '0.5');
      expect(slider).toHaveAttribute('max', '1.5');
    });

    it('selecting Base persists tier 0 and checks only Base', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('radio', { name: 'Base' }));
      expect(localStorage.getItem('sc-seamark-display-tier')).toBe('0');
      expect(screen.getByRole('radio', { name: 'Base' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Standard' })).not.toBeChecked();
      expect(screen.getByRole('radio', { name: 'All' })).not.toBeChecked();
    });

    it('selecting All persists tier 2', () => {
      renderPanel();
      fireEvent.click(screen.getByRole('radio', { name: 'All' }));
      expect(localStorage.getItem('sc-seamark-display-tier')).toBe('2');
      expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
    });

    // #513 R4: the REAL pipeline (usePersistedNumber -> toSeamarkDisplayTier),
    // not just the pure function in isolation. `seamarkGlyphs.test.ts`
    // already pins `toSeamarkDisplayTier(-1)` === ALL, but that alone proved
    // nothing about what actually renders: before this fix, both call sites
    // read `usePersistedNumber('sc-seamark-display-tier', BASE, ALL)`, whose
    // OWN clamp laundered a stored `-1` into `0` (= BASE) before
    // `toSeamarkDisplayTier` ever saw anything but an in-range number — a
    // unit test that passed while the integrated behaviour did the opposite.
    // This seeds the SAME corrupt value the unit test uses, through
    // localStorage (the real transport), and checks the rendered radio.
    it('a corrupt negative stored value (a hand-edited "-1") renders as All, never Base — the pipeline, not just the pure function', () => {
      localStorage.setItem('sc-seamark-display-tier', '-1');
      renderPanel();
      expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Base' })).not.toBeChecked();
    });

    // #513 F3: the old text claimed "larger symbols never hide other
    // marks", which is false at z>=12 (icon-overlap: 'always' — nothing is
    // culled there, so bigger icons overlap MORE). The corrected text
    // states BOTH regimes, so this asserts both halves rather than a single
    // substring — a fix that only patched the false clause without adding
    // the true one would still pass a narrower regex.
    it('describes the size slider with a visible, ACCURATE help paragraph (both zoom regimes) via aria-describedby', () => {
      renderPanel();
      const slider = screen.getByRole('slider', { name: 'Symbol size (seamarks)' });
      const describedBy = slider.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const help = document.getElementById(describedBy!);
      expect(help).toHaveTextContent(/collision spacing scales with the symbols/);
      expect(help).toHaveTextContent(/larger symbols overlap each other more/);
      expect(help).not.toHaveTextContent(/never hide other marks/);
    });

    it('states the non-optional Base floor in the category help text', () => {
      renderPanel();
      expect(screen.getByText(/always shown, even at "Base"/)).toBeInTheDocument();
    });

    // #513 F7 (content half): the old help text said only what Base keeps,
    // never what the DEFAULT (Standard) hides — a user reading it concluded
    // nothing important was hidden, when 810 marks were (F1's Blocker). #521
    // (2026-08-21 ruling) then reversed the cable/pipeline carve-out to
    // "All" entirely — the DEFAULT (Standard) tier no longer hides anything
    // in the specialPurpose family, and the help text must say so
    // explicitly (a stale "except submarine cable and pipeline markers"
    // claim would ship a lie the moment the behaviour changed).
    it('states that the DEFAULT (Standard) tier now shows cable and pipeline markers, not that it hides them (#521)', () => {
      renderPanel();
      expect(
        screen.getByText(/shows everything, including submarine cable and pipeline markers/),
      ).toBeInTheDocument();
    });

    // #513 F6: the announced value must match what a sighted user sees, not
    // the raw range-input number.
    it('the size slider announces the same percent text the visible readout shows, via aria-valuetext', () => {
      renderPanel();
      const slider = screen.getByRole('slider', { name: 'Symbol size (seamarks)' });
      expect(slider).toHaveAttribute('aria-valuetext', '100%');
      fireEvent.change(slider, { target: { value: '0.6' } });
      // Re-query: SettingsPanel is the value's SOURCE of truth (controlled
      // by the persisted hook), so the re-rendered slider is what carries
      // the updated announcement.
      expect(screen.getByRole('slider', { name: 'Symbol size (seamarks)' })).toHaveAttribute(
        'aria-valuetext',
        '60%',
      );
      expect(screen.getByText('60%')).toBeInTheDocument();
    });

    // #513 F6: the visible percent readout must not ALSO be a live region —
    // `aria-valuetext` above already carries the announcement, and a live
    // `<output>` would double-speak on every drag tick.
    it('the percent readout output element opts out of its implicit live-region role', () => {
      renderPanel();
      expect(screen.getByText('100%')).toHaveAttribute('aria-live', 'off');
    });

    // #513 F7: the radiogroup's help paragraph was rendered but never
    // referenced — orphaned from assistive tech. Verify the REAL
    // association (id equality both ways), not just that both elements
    // exist independently.
    it('associates the category radiogroup with its help paragraph via aria-describedby', () => {
      renderPanel();
      const radiogroup = screen.getByRole('radiogroup', { name: 'Displayed seamarks' });
      const describedBy = radiogroup.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const help = document.getElementById(describedBy!);
      expect(help).not.toBeNull();
      expect(help).toHaveTextContent(/always shown, even at "Base"/);
    });
  });
});
