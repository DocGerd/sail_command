import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import BoatPicker from './BoatPicker';
import { BOATS, DEFAULT_BOAT_ID } from '../data/boats';
import { DEFAULT_SETTINGS } from '../types';

// The REAL catalogue, deliberately. BoatPicker.multiBoat.test.tsx mocks a
// three-boat one for the switch/clamp behaviour; this file is the "release 1
// ships one boat and the picker must still read as a picker" half, which a
// mocked catalogue could not check at all.

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderPicker() {
  localStorage.setItem('sc-lang', 'en');
  const onBoatIdChange = vi.fn();
  const onSettingsChange = vi.fn();
  render(
    <I18nProvider>
      <BoatPicker
        boatId={DEFAULT_BOAT_ID}
        onBoatIdChange={onBoatIdChange}
        settings={DEFAULT_SETTINGS}
        onSettingsChange={onSettingsChange}
      />
    </I18nProvider>,
  );
  return { onBoatIdChange, onSettingsChange };
}

describe('#54 BoatPicker against the shipped catalogue', () => {
  it('renders one selectable radio per catalogue boat, with the current one checked', () => {
    renderPicker();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(BOATS.length);
    expect(radios.filter((r) => (r as HTMLInputElement).checked)).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /Salona 45/ })).toBeChecked();
  });

  it('names the boat and states its draft', () => {
    renderPicker();
    // The VALUE, not merely "some draft text": a picker that rendered every
    // boat's draft as the catalogue default would look right and be wrong,
    // and draft is the field everything in spec C hangs on.
    expect(screen.getByText('Draft 2.1 m')).toBeInTheDocument();
    expect(screen.getByText('Salona 45')).toBeInTheDocument();
  });

  it('shows the WEAKEST of the boat’s per-sail provenance tiers, not the strongest', () => {
    renderPicker();
    // The Salona 45 ships a tier-A `fock` beside a tier-B `genoa`. The
    // boat-level chip must read "Modelled" — picking the strongest would be
    // the expensive failure direction (see lib/boatProvenance.ts). Scoped to
    // the label so the per-sail chips inside the disclosure cannot satisfy it.
    const label = screen.getByRole('radio', { name: /Salona 45/ }).closest('.boat-option');
    expect(label).not.toBeNull();
    const boatLevelChip = label!.querySelector('.boat-option-facts .chip');
    expect(boatLevelChip?.textContent).toBe('Modelled');
  });

  it('exposes every sail’s own tier and source note behind the provenance disclosure', () => {
    renderPicker();
    expect(screen.getByText('Polar data & provenance')).toBeInTheDocument();
    expect(screen.getByText('Genoa 135 %')).toBeInTheDocument();
    expect(screen.getByText('Jib 110 %')).toBeInTheDocument();
    // The catalogue's verbatim source note reaches the DOM — the picker is
    // one of spec N.5's five required label surfaces, and a disclosure that
    // rendered only the tier word would carry no provenance at all.
    // BOTH sails' notes, not one: each sail carries its own provenance and
    // the Salona 45's two differ (a modelled overlay vs the certificate
    // configuration). A disclosure showing only the first would hide the
    // weaker of the two, which is the one that matters.
    expect(screen.getAllByText(/AUT 035\/26/)).toHaveLength(2);
  });

  it('shows NO keel-assumption sentence for a boat that declares none', () => {
    renderPicker();
    // The Salona 45 is spec J OQ-4's model-level reference boat, not a fleet
    // hull whose keel was assumed, so it carries no `keelAssumption`. The
    // positive case — that the sentence DOES render when one is declared —
    // is BoatPicker.multiBoat.test.tsx's `deep-46` row; an absence assertion
    // alone would pass just as happily against a component that can never
    // render the sentence at all.
    expect(screen.queryByText(/Assumed keel/)).not.toBeInTheDocument();
  });

  it('starts with an empty live region rather than a stale announcement', () => {
    renderPicker();
    const status = screen.getByRole('status');
    // Present but empty: a role="status" region must already be in the
    // accessibility tree before its text changes, or assistive tech has no
    // node to observe the mutation on.
    expect(status).toBeInTheDocument();
    expect(status).toBeEmptyDOMElement();
  });

  it('clicking the already-selected boat writes nothing and announces nothing', () => {
    // HONEST SCOPE, because this row is weaker than it looks. It pins the
    // OBSERVABLE behaviour (a one-entry catalogue cannot be nudged into a
    // spurious settings write or clamp notice), NOT BoatPicker's
    // `nextId === boatId` early return: clicking a radio that is already
    // checked fires no `change` event at all per the HTML activation
    // behaviour jsdom implements, so the handler is never entered and
    // deleting that early return would leave this row green. The guard stays
    // as a defensive no-op for a future non-radio control; nothing here
    // claims to exercise it. Switch behaviour is covered for real in
    // BoatPicker.multiBoat.test.tsx, where a second entry makes a change
    // event reachable.
    const { onBoatIdChange, onSettingsChange } = renderPicker();
    fireEvent.click(screen.getByRole('radio', { name: /Salona 45/ }));
    expect(onBoatIdChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
