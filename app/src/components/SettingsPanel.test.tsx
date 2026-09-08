import 'fake-indexeddb/auto';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import SettingsPanel, { clampSettingsToBounds, CLAMPED_FIELD_SPECS } from './SettingsPanel';
import { safetyDepthFieldFor } from './OptionsPanel';
import { DEFAULT_BOAT_ID, boatById } from '../data/boats';
import { __resetDbForTests, listPlans, listWaypoints, type SavedWaypoint } from '../services/db';
import * as db from '../services/db';
import { buildExportEnvelope, exportEnvelopeToJson } from '../lib/planExport';
import {
  DEFAULT_SETTINGS,
  defaultBoatSnapshot,
  PLAN_SCHEMA_VERSION,
  type Plan,
  type Settings,
} from '../types';

afterEach(() => {
  localStorage.clear();
});

beforeEach(async () => {
  await __resetDbForTests();
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

// #849 part (a): local import/export. Builds fixtures with the SAME
// serializer under test (buildExportEnvelope/exportEnvelopeToJson) rather
// than a hand-typed JSON literal, so this exercises the real component
// wiring around planExport.ts's already mutation-checked round-trip
// (planExport.test.ts), not a second, divergent reimplementation of it.
function makeTestPlan(id: string): Plan {
  return {
    id,
    name: 'Flensburg → Marstal',
    createdAtMs: 1700000000000,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: { lat: 54.3, lon: 9.4 },
      destination: { lat: 55.0, lon: 10.0 },
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: 1700000000000,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    // #1068 review MAJOR: sized to satisfy WindField's dimension invariant
    // exactly (1 lat * 1 lon * 2 times = 2) — see planExport.test.ts's
    // matching comment for why this matters now that decodeWindGrid
    // enforces it.
    windGrid: {
      lats: [54.0],
      lons: [9.0],
      timesMs: [1000, 2000],
      speedKn: new Float32Array([5.1, 6.2]),
      dirFromDeg: new Float32Array([90, 95]),
      gustKn: new Float32Array([7.1, 8.2]),
      fetchedAtMs: 1700000000000,
      model: 'open-meteo',
    },
    result: {
      status: 'ok',
      sails: [
        {
          sailId: 'genoa',
          result: {
            sailId: 'genoa',
            legs: [],
            etaMs: 1700003600000,
            durationMs: 3600000,
            distanceNm: 42.5,
            maneuverCount: 2,
            motorDistanceNm: 0,
          },
          reason: null,
        },
        { sailId: 'fock', result: null, reason: null },
      ],
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: { lat: 54.3, lon: 9.4 },
      snappedDestination: { lat: 55.0, lon: 10.0 },
    },
  };
}

const TEST_WAYPOINT: SavedWaypoint = {
  id: 'wp-849',
  name: 'off Holnis',
  lat: 54.83,
  lon: 9.87,
  createdAtMs: 1700000000000,
};

const IMPORTED_SETTINGS: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 3.5 };

function getFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('backup file input not found');
  return input;
}

describe('SettingsPanel (#849 local import/export)', () => {
  it('renders the Backup card with export and import controls', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Backup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
  });

  it('export writes a JSON blob download containing the live settings', async () => {
    // Same pattern as RouteSummary.test.tsx's GPX-export test: reassign the
    // static methods directly (rather than vi.stubGlobal, which would
    // replace the URL constructor itself) and restore them in `finally`.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature must accept a Blob for the tuple-typed assertion below
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    // jsdom does not implement navigation — stub the click the component
    // fires on its synthetic <a download> so the test doesn't warn/throw.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      renderPanel();
      // handleExport is async (it reads plans/waypoints from IndexedDB
      // before building the blob) but the onClick handler fires it without
      // awaiting — fireEvent.click cannot observe that work, so wait for it.
      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

      const blob = createObjectURL.mock.calls[0][0] as Blob;
      expect(blob.type).toBe('application/json');
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it('import writes plans and waypoints to IndexedDB, applies settings, and reports a success notice', async () => {
    const plan = makeTestPlan('imported-1');
    const envelope = buildExportEnvelope([plan], IMPORTED_SETTINGS, [TEST_WAYPOINT]);
    const json = exportEnvelopeToJson(envelope);
    const onChange = renderPanel();

    const file = new File([json], 'sailcommand-export.json', { type: 'application/json' });
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [file] } });
    });

    // The success paragraph joins several sentences into ONE text node
    // (see SettingsPanel.tsx's handleImportFile), so a substring matcher is
    // needed rather than an exact-text lookup.
    const notice = await screen.findByText((content) =>
      content.startsWith('1 route(s) and 1 waypoint(s) imported.'),
    );
    expect(notice).toHaveTextContent('Settings from the file were applied.');
    expect(onChange).toHaveBeenCalledWith(IMPORTED_SETTINGS);

    const plans = await listPlans();
    expect(plans.some((p) => p.kind === 'ok' && p.id === 'imported-1')).toBe(true);
    const waypoints = await listWaypoints();
    expect(waypoints).toEqual([TEST_WAYPOINT]);
  });

  it('reports a clear error, and touches no storage, for a file that is not a SailCommand export', async () => {
    renderPanel();
    const file = new File(['not json at all {{{'], 'garbage.json', {
      type: 'application/json',
    });
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [file] } });
    });

    expect(
      await screen.findByText('This is not a valid SailCommand export file.'),
    ).toBeInTheDocument();
    expect(await listPlans()).toHaveLength(0);
    expect(await listWaypoints()).toHaveLength(0);
  });

  // #1068 review MINOR 1: an out-of-range imported settings value must be
  // CLAMPED to the same FieldSpec bounds manual entry enforces, not applied
  // verbatim and not used to reject the whole file.
  it('clamps out-of-range imported settings to the same bounds manual entry enforces', async () => {
    const outOfRange: Settings = {
      ...DEFAULT_SETTINGS,
      performanceFactor: -50, // PERFORMANCE_FACTOR_FIELD: 0.5-1.1
      motorSpeedKn: 999, // MOTOR_SPEED_FIELD: 1-10
      safetyDepthM: 0.1, // below any boat's minimum (default boat: 2.2)
    };
    const envelope = buildExportEnvelope([], outOfRange, []);
    const onChange = renderPanel();

    const file = new File([exportEnvelopeToJson(envelope)], 'settings.json', {
      type: 'application/json',
    });
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [file] } });
    });

    const notice = await screen.findByText((content) =>
      content.startsWith('0 route(s) and 0 waypoint(s)'),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    const applied = onChange.mock.calls[0][0] as Settings;
    expect(applied.performanceFactor).toBe(0.5); // -50 is below the min, clamps UP to min
    expect(applied.motorSpeedKn).toBe(10);
    expect(applied.safetyDepthM).toBe(2.2);
    // A field that WAS in range must not be touched by clamping.
    expect(applied.maneuverPenaltyS).toBe(outOfRange.maneuverPenaltyS);
    // #1071: the clamp must not be silent — the notice must name every
    // field it actually moved (order follows clampedFieldLabels: the
    // boat-derived safety depth field first, then the fixed FieldSpec list).
    expect(notice).toHaveTextContent(
      'Some settings from the file were out of range and were adjusted: ' +
        'Safety depth (m), Motoring speed (kn), Performance factor (×).',
    );
  });

  // #1071: the mirror of the test above — when nothing needed clamping, the
  // disclosure must NOT fire. An unconditional notice would be exactly as
  // misleading as the silent one #1071 replaces.
  it('does not report a clamp notice when the imported settings need no clamping', async () => {
    const envelope = buildExportEnvelope([], IMPORTED_SETTINGS, []);
    renderPanel();

    const file = new File([exportEnvelopeToJson(envelope)], 'settings.json', {
      type: 'application/json',
    });
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [file] } });
    });

    const notice = await screen.findByText((content) =>
      content.startsWith('0 route(s) and 0 waypoint(s)'),
    );
    expect(notice).toHaveTextContent('Settings from the file were applied.');
    expect(notice).not.toHaveTextContent('were out of range');
  });

  // #1084 review MINOR 1: nothing previously tied CLAMPED_FIELD_SPECS's
  // membership to the fields clampSettingsToBounds actually clamps; the two
  // matched by inspection only, so a future field added to one and not the
  // other would regress silently (the notice under-reporting a real clamp —
  // #1071's original defect, re-entering through a side door). This is the
  // SOLVER_LABELS shape CLAUDE.md records: a guard's DATA needs a twin, not
  // just its detection logic.
  //
  // The two sides here are genuinely INDEPENDENT sources, unlike the MAJOR
  // test below (which must hand-write its expected labels rather than read
  // them from CLAMPED_FIELD_SPECS, or a swapped row would drift with it):
  // `observedClampedKeys` comes from clampSettingsToBounds's OWN behaviour —
  // feed it a settings object that violates every bound and see which keys
  // actually moved — while `declaredKeys` comes from CLAMPED_FIELD_SPECS's
  // declaration. Deriving one from the other here would defeat the point;
  // deriving them independently is what makes this a real structural check.
  it('#1084: CLAMPED_FIELD_SPECS covers exactly the fields clampSettingsToBounds clamps (excluding the boat-derived safetyDepthM, handled separately)', () => {
    const violatingEveryBound: Settings = {
      ...DEFAULT_SETTINGS,
      safetyDepthM: -1,
      depthComfortMarginM: -1,
      motorSpeedKn: -1,
      motorThresholdKn: -1,
      sailPreferenceKn: -1,
      maneuverPenaltyS: -1,
      performanceFactor: -1,
    };
    const boat = boatById(DEFAULT_BOAT_ID);
    const clamped = clampSettingsToBounds(violatingEveryBound, safetyDepthFieldFor(boat));
    const observedClampedKeys = new Set(
      (Object.keys(violatingEveryBound) as (keyof Settings)[]).filter(
        (k) => violatingEveryBound[k] !== clamped[k],
      ),
    );
    // safetyDepthM is intentionally OUTSIDE CLAMPED_FIELD_SPECS — it is
    // clamped separately, against the boat-derived `safetyDepthField`, not a
    // fixed FieldSpec — so it is excluded from this comparison by design,
    // not because the twin test is blind to it (clampedFieldLabels checks it
    // via its own dedicated `if` above the CLAMPED_FIELD_SPECS loop).
    observedClampedKeys.delete('safetyDepthM');
    const declaredKeys = new Set(CLAMPED_FIELD_SPECS.map((s) => s.key));
    expect(observedClampedKeys).toEqual(declaredKeys);
  });

  // #1084 review MAJOR: the test above only ever moved THREE of the seven
  // clamped fields (performanceFactor, motorSpeedKn, safetyDepthM), so
  // clampSettingsToBounds's other three — motorThresholdKn, sailPreferenceKn,
  // depthComfortMarginM — had never been exercised as CHANGED by any test.
  // The reviewer mutation-proved the gap: swapping the
  // MOTOR_THRESHOLD_FIELD/SAIL_PREFERENCE_FIELD rows in production's
  // CLAMPED_FIELD_SPECS left the whole suite green, which would have shipped
  // a disclosure naming the WRONG field ("your motor threshold moved" when
  // it was really the sail preference, or vice versa) with zero test signal.
  //
  // This table is written OUT BY HAND, independent of production's
  // CLAMPED_FIELD_SPECS — it must NOT import or otherwise derive from that
  // array. Deriving the expected label from the same table under test would
  // make the two rows drift TOGETHER: swap MOTOR_THRESHOLD_FIELD and
  // SAIL_PREFERENCE_FIELD in production and this test's own expectation
  // would swap with it, staying green through the exact defect it exists to
  // catch. Every out-of-range value is chosen to fall outside ONLY that
  // field's own bounds (see OptionsPanel.tsx's FieldSpec constants) while
  // every other field stays at its DEFAULT_SETTINGS value, which is in range
  // for every field — so the notice this produces must name EXACTLY one field.
  const EXPECTED_CLAMP_LABELS: ReadonlyArray<{
    field: keyof Settings;
    outOfRangeValue: number;
    expectedLabel: string;
  }> = [
    { field: 'safetyDepthM', outOfRangeValue: 0.1, expectedLabel: 'Safety depth (m)' },
    {
      field: 'depthComfortMarginM',
      outOfRangeValue: -1,
      expectedLabel: 'Depth comfort margin (m)',
    },
    { field: 'motorSpeedKn', outOfRangeValue: 999, expectedLabel: 'Motoring speed (kn)' },
    { field: 'motorThresholdKn', outOfRangeValue: 999, expectedLabel: 'Motor threshold (kn)' },
    { field: 'sailPreferenceKn', outOfRangeValue: 999, expectedLabel: 'Sail preference (kn)' },
    { field: 'maneuverPenaltyS', outOfRangeValue: -1, expectedLabel: 'Maneuver penalty (s)' },
    { field: 'performanceFactor', outOfRangeValue: -50, expectedLabel: 'Performance factor (×)' },
  ];

  it.each(EXPECTED_CLAMP_LABELS)(
    '#1084: names $field ("$expectedLabel") and only $field when it alone is out of range',
    async ({ field, outOfRangeValue, expectedLabel }) => {
      const outOfRange: Settings = { ...DEFAULT_SETTINGS, [field]: outOfRangeValue };
      const envelope = buildExportEnvelope([], outOfRange, []);
      renderPanel();

      const file = new File([exportEnvelopeToJson(envelope)], 'settings.json', {
        type: 'application/json',
      });
      await act(async () => {
        fireEvent.change(getFileInput(), { target: { files: [file] } });
      });

      const notice = await screen.findByText((content) =>
        content.startsWith('0 route(s) and 0 waypoint(s)'),
      );
      expect(notice).toHaveTextContent(
        `Some settings from the file were out of range and were adjusted: ${expectedLabel}.`,
      );
    },
  );

  // #1084 review MINOR 2: `-0 !== 0` is `false`, so a hand-edited backup's
  // `-0` on a min-0 field (`JSON.parse('-0')` is valid JSON) clamping to `+0`
  // used to go undetected. `JSON.stringify` itself NORMALISES `-0` to the
  // text "0" and so cannot produce this input — the raw JSON text below is
  // edited by hand, after stringifying, to inject the literal `-0` a real
  // hand-edited file could contain.
  it('#1084: detects a -0 -> +0 clamp that a plain `!==` comparison would miss', async () => {
    const zeroed: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 0 };
    const envelope = buildExportEnvelope([], zeroed, []);
    const json = exportEnvelopeToJson(envelope).replace(
      '"depthComfortMarginM":0',
      '"depthComfortMarginM":-0',
    );
    // Guard the string-surgery itself: if the replace ever fails to match
    // (a field-ordering or serializer change), fail loudly here rather than
    // silently sending the untouched +0 JSON and reading a false pass below.
    expect(json).toContain('"depthComfortMarginM":-0');
    renderPanel();

    const file = new File([json], 'settings.json', { type: 'application/json' });
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [file] } });
    });

    const notice = await screen.findByText((content) =>
      content.startsWith('0 route(s) and 0 waypoint(s)'),
    );
    expect(notice).toHaveTextContent(
      'Some settings from the file were out of range and were adjusted: Depth comfort margin (m).',
    );
  });

  // #1068 review MINOR 2: plans and waypoints must be written INDEPENDENTLY —
  // a failing plan write must neither block nor be masked by an unrelated,
  // otherwise-healthy waypoint import, and the partial failure must be
  // legible to the user (not silently swallowed).
  it('a failing plan write does not block an unrelated waypoint import, and is reported', async () => {
    const planA = makeTestPlan('plan-a');
    const planB = makeTestPlan('plan-b');
    const envelope = buildExportEnvelope([planA, planB], null, [TEST_WAYPOINT]);
    // Rejects only the FIRST savePlan call (plan-a, in map order); plan-b's
    // call falls through to the real fake-indexeddb implementation.
    vi.spyOn(db, 'savePlan').mockRejectedValueOnce(new Error('quota exceeded'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderPanel();
    const file = new File([exportEnvelopeToJson(envelope)], 'x.json', {
      type: 'application/json',
    });
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [file] } });
    });

    const notice = await screen.findByText((content) =>
      content.startsWith('1 route(s) and 1 waypoint(s) imported.'),
    );
    // The waypoint import SUCCEEDED (and is reported as such) despite the
    // plan write failing — this is the independence the fix is about.
    expect(notice).toHaveTextContent('1 parsed route(s) could not be saved to this device.');

    const plans = await listPlans();
    expect(plans.filter((p) => p.kind === 'ok').map((p) => p.id)).toEqual(['plan-b']);
    const waypoints = await listWaypoints();
    expect(waypoints).toEqual([TEST_WAYPOINT]);

    consoleErrorSpy.mockRestore();
  });
});
