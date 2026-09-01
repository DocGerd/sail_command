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
  // Both bounds go through formatDepthM (fractionDigits defaults to 1), so
  // max renders "10.0" here, not a bare "10" — see the review-fix test
  // below for why raw numbers were wrong in the first place.
  it('#699: discloses the allowed range as visible, described help text', () => {
    renderPanel();
    const input = screen.getByLabelText('Safety depth (m)');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(input).not.toHaveAttribute('title');
    const help = document.getElementById(describedBy!);
    expect(help).toHaveTextContent('Allowed range: 2.2–10.0 m');
  });

  // #699 REVIEW FIX (MAJOR): useT()'s interpolation is a bare String(v)
  // (i18n/index.tsx) — locale-blind, always a decimal POINT. Passing raw
  // numbers as {min}/{max} therefore rendered a German decimal POINT
  // ("Erlaubter Bereich: 2.2-10 m"), contradicting the comma convention
  // every OTHER depth figure in this app uses via formatDepthM — including
  // this very PR's own boat.clamp.notice two components over ("Sicherheitstiefe
  // auf 2,4 m angehoben"). renderPanel() hardcodes English, so this test
  // renders directly under 'de' to reach the gap no other row in this file
  // exercises. MUTATION-CHECKED: reverting SettingsPanel.tsx's help vars to
  // the bare numbers (no formatDepthM) reds this row, rendering the point
  // form instead of the comma form asserted here.
  it('#699: renders the range with the LOCALE decimal separator (German comma, not a point)', () => {
    localStorage.setItem('sc-lang', 'de');
    render(
      <I18nProvider>
        <SettingsPanel
          value={DEFAULT_SETTINGS}
          onChange={vi.fn()}
          boatId={DEFAULT_BOAT_ID}
          onBoatIdChange={vi.fn()}
        />
      </I18nProvider>,
    );
    const input = screen.getByLabelText('Sicherheitstiefe (m)');
    const describedBy = input.getAttribute('aria-describedby');
    const help = document.getElementById(describedBy!);
    expect(help).toHaveTextContent('Erlaubter Bereich: 2,2–10,0 m');
  });

  it('commits safety depth on blur and clamps to its 2.2-10 bounds (same SAFETY_DEPTH_FIELD spec as the inline field)', () => {
    const onChange = renderPanel();
    const input = screen.getByLabelText('Safety depth (m)');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(2.2);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, safetyDepthM: 2.2 });
  });

  // #731: the silent blur-clamp now reports a visible correction. EVERY
  // NumericField (all seven in this panel, not just the ones with a `help`
  // paragraph) mounts its OWN notice element unconditionally, so a
  // section-scoped `within(section).getByRole('status')` throws on multiple
  // matches the moment a section holds more than one NumericField (all four
  // in "Boat & safety" do) — scope to the SPECIFIC field's own `.sc-field`
  // container instead, found via the labeled input's `closest()`.
  //
  // MOUNT SHAPE (PR #758 review round 2): the notice is now ALWAYS mounted
  // (matching BoatPicker's own #563 shape), empty until a correction —
  // never absent — so "no notice" is asserted as EMPTY text content, never
  // as `queryByRole(...)).not.toBeInTheDocument()` (which would now be
  // false for every one of these rows, since the element is always there).
  describe('#731: blur-clamp correction notice', () => {
    function fieldNoticeFor(labelText: string): HTMLElement {
      const input = screen.getByLabelText(labelText);
      const field = input.closest('.sc-field');
      if (!field) throw new Error(`expected a .sc-field ancestor for "${labelText}"`);
      return within(field as HTMLElement).getByRole('status');
    }

    // The assertion that distinguishes always-mounted from conditionally-
    // mounted (PR #758 review round 2): the live region must exist in the
    // DOM BEFORE any correction has happened, or AT has nothing to observe
    // a later text mutation on.
    it('mounts the correction live region BEFORE any correction has occurred', () => {
      renderPanel();
      const el = fieldNoticeFor('Safety depth (m)');
      expect(el).toBeInTheDocument();
      expect(el).toHaveTextContent('');
    });

    it('shows the notice after a real out-of-range commit, unit-less (the label already carries one)', () => {
      const onChange = renderPanel();
      const input = screen.getByLabelText('Safety depth (m)');
      fireEvent.change(input, { target: { value: '1' } });
      fireEvent.blur(input);
      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, safetyDepthM: 2.2 });
      expect(fieldNoticeFor('Safety depth (m)')).toHaveTextContent(
        'Corrected to 2.2 (allowed range 2.2–10)',
      );
    });

    it('shows no notice for an in-range commit', () => {
      renderPanel();
      const input = screen.getByLabelText('Safety depth (m)');
      fireEvent.change(input, { target: { value: '5' } });
      fireEvent.blur(input);
      expect(fieldNoticeFor('Safety depth (m)')).toHaveTextContent('');
    });

    it('shows no notice for the empty-field revert (a different, intentionally silent path)', () => {
      const onChange = renderPanel();
      const input = screen.getByLabelText('Maneuver penalty (s)');
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);
      expect(onChange).not.toHaveBeenCalled();
      expect(fieldNoticeFor('Maneuver penalty (s)')).toHaveTextContent('');
    });

    it('clears a previous notice once a later commit on the same field lands in range', () => {
      renderPanel();
      const input = screen.getByLabelText('Motoring speed (kn)');
      fireEvent.change(input, { target: { value: '25' } });
      fireEvent.blur(input);
      expect(fieldNoticeFor('Motoring speed (kn)')).toHaveTextContent(
        'Corrected to 10 (allowed range 1–10)',
      );
      fireEvent.change(input, { target: { value: '5' } });
      fireEvent.blur(input);
      expect(fieldNoticeFor('Motoring speed (kn)')).toHaveTextContent('');
    });

    // The DoD's own required browser-pass scenario, reproduced here as a
    // unit test: a boat switch that moves safety depth's own bounds
    // (elan-444-piranja's 1.9 m draft -> 2.0 m floor, vs the Salona 45's
    // 2.1 m -> 2.2 m) must not leave a stale "corrected to 2.2" notice
    // standing once the field it was correcting no longer has that floor.
    it('clears a stale notice when a boat switch moves the field bounds out from under it', () => {
      const onChange = vi.fn();
      localStorage.setItem('sc-lang', 'en');
      const { rerender } = render(
        <I18nProvider>
          <SettingsPanel
            value={DEFAULT_SETTINGS}
            onChange={onChange}
            boatId={DEFAULT_BOAT_ID}
            onBoatIdChange={vi.fn()}
          />
        </I18nProvider>,
      );
      const input = screen.getByLabelText('Safety depth (m)');
      fireEvent.change(input, { target: { value: '1' } });
      fireEvent.blur(input);
      expect(fieldNoticeFor('Safety depth (m)')).toHaveTextContent(
        'Corrected to 2.2 (allowed range 2.2–10)',
      );
      rerender(
        <I18nProvider>
          <SettingsPanel
            value={DEFAULT_SETTINGS}
            onChange={onChange}
            boatId="elan-444-piranja"
            onBoatIdChange={vi.fn()}
          />
        </I18nProvider>,
      );
      expect(fieldNoticeFor('Safety depth (m)')).toHaveTextContent('');
    });
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
    // #746: the MMSI assertion that used to close this row is gone — the field
    // moved to BoatPicker. What remains is what this card still legitimately
    // groups; its absence is pinned separately below.
    it('renders "show my position" UNCHECKED against DEFAULT_SETTINGS and the AIS key, grouped under Live & AIS', () => {
      renderPanel();
      const section = sectionOf('Live & AIS');
      expect(within(section).getByLabelText('Show my position')).not.toBeChecked();
      expect(within(section).getByLabelText('AIS API key (aisstream.io)')).toBeInTheDocument();
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
    // #746: the MMSI half of this case moved to BoatPicker.test.tsx with the
    // field. What stays here is the API key's own privacy sentence, which had
    // to survive the split of `options.ais.help` intact.
    it('renders the AIS API-key field with the privacy help text', () => {
      renderPanel();
      expect(screen.getByLabelText('AIS API key (aisstream.io)')).toBeInTheDocument();
      expect(screen.getByText(/stays on this device/)).toBeInTheDocument();
      expect(screen.getByText(/only to aisstream\.io/)).toBeInTheDocument();
    });

    // #746: the account credential and the vessel identity must not share a
    // surface — that pairing is what made a global MMSI look correct. Pins the
    // ABSENCE inside the Live & AIS CARD specifically, not in the panel: this
    // panel also renders BoatPicker, which is exactly where the MMSI field now
    // legitimately lives, so a document-wide `queryByLabelText(/MMSI/)` would
    // fail against the correct implementation (MEASURED — it did).
    it('no longer renders an MMSI field in the Live & AIS card (#746)', () => {
      renderPanel();
      const section = sectionOf('Live & AIS');
      // Non-vacuity control: the card is genuinely found and genuinely holds
      // the key field, so what follows is a real absence rather than an empty
      // container in which every query would come back empty anyway.
      expect(within(section).getByLabelText('AIS API key (aisstream.io)')).toBeInTheDocument();
      expect(within(section).queryByLabelText(/MMSI/)).not.toBeInTheDocument();
      expect(within(section).queryByText('MMSI must be exactly 9 digits.')).not.toBeInTheDocument();
      // ...and it IS still reachable, from the boat surface in the same panel.
      expect(screen.getByLabelText("This boat's MMSI (optional)")).toBeInTheDocument();
    });

    it('commits the AIS API key on change', () => {
      const onChange = renderPanel();
      fireEvent.change(screen.getByLabelText('AIS API key (aisstream.io)'), {
        target: { value: 'my-key' },
      });
      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, aisApiKey: 'my-key' });
    });

    // #746: the three MMSI validation cases that used to live here moved to
    // BoatPicker.test.tsx unchanged in substance — invalid, valid, and empty.
    // They were not dropped in the move; the control they exercise did.
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
