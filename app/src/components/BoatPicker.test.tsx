import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

// Every assertion about ONE boat's row must be scoped to that row.
//
// These tests used to query the whole picker, which was unambiguous only
// because the catalogue held one boat. At three (spec N's two tier-C fleet
// entries joining the Salona 45) a global query matches several option rows —
// and the Salona 44's draft is ALSO 2.1 m, so even a value-specific query
// collides. The queries were never meant to be global; the one-boat catalogue
// merely let them get away with it.
//
// Deliberately NOT fixed by switching to getAllBy... and asserting a count:
// that re-creates the same catalogue-size coupling one level up, so adding a
// fourth boat would break these rows again for a reason that has nothing to
// do with what they test.
//
// Scoped by the radio's `id` rather than by its accessible name: the id is
// `boat-option-${boat.id}`, derived from the stable catalogue id, where a
// name-based lookup would depend on display strings that are proper nouns and
// may legitimately change.
function optionFor(boatId: string): HTMLElement {
  const radio = document.getElementById(`boat-option-${boatId}`);
  expect(radio, `no radio rendered for boat ${boatId}`).not.toBeNull();
  const option = radio!.closest('.boat-option');
  expect(option, `radio for ${boatId} is not inside a .boat-option`).not.toBeNull();
  return option as HTMLElement;
}

describe('#54 BoatPicker against the shipped catalogue', () => {
  it('renders one selectable radio per catalogue boat, with the current one checked', () => {
    renderPicker();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(BOATS.length);
    expect(radios.filter((r) => (r as HTMLInputElement).checked)).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /Salona 45/ })).toBeChecked();
  });

  it('states each boat’s OWN name and draft, inside that boat’s own row', () => {
    renderPicker();
    // The VALUE, not merely "some draft text": a picker that rendered every
    // boat's draft as the catalogue default would look right and be wrong,
    // and draft is the field everything in spec C hangs on.
    //
    // That claim was UNTESTABLE at a one-boat catalogue — one row rendering
    // one draft cannot distinguish "each boat's own" from "the default for
    // all". It is testable now, and this row is what tests it: each boat's
    // draft is asserted INSIDE that boat's option, so a component that piped
    // one boat's draft into every row reds here. The Salona 44 shares the
    // Salona 45's 2.1 m, so the scoping is doing real work even between two
    // boats whose values coincide.
    for (const boat of BOATS) {
      const option = within(optionFor(boat.id));
      expect(option.getByText(`Draft ${boat.draftM.toFixed(1)} m`)).toBeInTheDocument();
      expect(option.getByText(boat.name)).toBeInTheDocument();
    }
    // One hardcoded anchor beside the derived loop, the maskTolerance R6
    // idiom: the loop above takes its expected string from the same catalogue
    // the component reads, so it cannot catch an arithmetic or formatting
    // change that moves both together. This literal can.
    expect(within(optionFor('salona-45')).getByText('Draft 2.1 m')).toBeInTheDocument();
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
    // Scoped to the Salona 45's row. Every boat renders a disclosure, so the
    // summary text alone matches three times; and the AUT 035/26 citation is
    // no longer unique to this boat either — both tier-C notes quote it, since
    // their tables are SCALED FROM this certificate. Six matches globally, two
    // here, and the two are the ones this row is about.
    const option = within(optionFor('salona-45'));
    expect(option.getByText('Polar data & provenance')).toBeInTheDocument();
    expect(option.getByText('Genoa 135 %')).toBeInTheDocument();
    expect(option.getByText('Jib 110 %')).toBeInTheDocument();
    // The catalogue's verbatim source note reaches the DOM — the picker is
    // one of spec N.5's five required label surfaces, and a disclosure that
    // rendered only the tier word would carry no provenance at all.
    // BOTH sails' notes, not one: each sail carries its own provenance and
    // the Salona 45's two differ (a modelled overlay vs the certificate
    // configuration). A disclosure showing only the first would hide the
    // weaker of the two, which is the one that matters.
    expect(option.getAllByText(/AUT 035\/26/)).toHaveLength(2);
  });

  it('shows the keel sentence on exactly the boats whose draft is assumed, and on no other', () => {
    renderPicker();
    // The PREMISE of this row moved, so the row moved with it. It used to read
    // "shows NO keel-assumption sentence for a boat that declares none" and
    // asserted a global absence — which was unambiguous only while the
    // catalogue held one hull-verified boat. Against spec N's catalogue a
    // global /Assumed keel/ query matches the two fleet boats that SHOULD have
    // it, so the old row failed while the behaviour was correct.
    //
    // What it asserts now is the real property, and it is STRONGER than the
    // old one rather than a rescope of it: the shipped catalogue finally
    // contains BOTH kinds, so the presence and the absence can be pinned
    // against each other in one place, on real data.
    //   salona-45            hullVerified: true  -> no sentence (spec J OQ-4's
    //                        model-level reference boat; no individual vessel
    //                        whose papers could disagree)
    //   the two fleet boats  hullVerified: false -> sentence REQUIRED by spec
    //                        N.2, because a wrong keel is invisible in every
    //                        other artifact the app renders
    //
    // This also retires the old row's own caveat that an absence assertion
    // "would pass just as happily against a component that can never render
    // the sentence at all" — the positive half is now in this file, on the
    // real catalogue, instead of only on multiBoat's synthetic `deep-46`.
    let verified = 0;
    let assumed = 0;
    for (const boat of BOATS) {
      const option = within(optionFor(boat.id));
      if (boat.draftProvenance.hullVerified) {
        verified++;
        expect(option.queryByText(/Assumed keel/), boat.id).not.toBeInTheDocument();
      } else {
        assumed++;
        // The keel itself, not merely the phrase: a sentence naming the wrong
        // variant is the failure spec N.2 exists to make visible.
        expect(
          option.getByText(new RegExp(`Assumed keel: ${boat.draftProvenance.keel}`)),
        ).toBeInTheDocument();
      }
    }
    // Both arms must be REACHED, or one half of the property is vacuous — an
    // all-verified catalogue would pass the loop having tested nothing about
    // presence, and vice versa.
    expect(verified, 'no hull-verified boat in the catalogue').toBeGreaterThan(0);
    expect(assumed, 'no assumed-keel boat in the catalogue').toBeGreaterThan(0);
  });

  it('#566: renders every boat’s draftProvenance.note, INCLUDING the hull-verified Salona 45', () => {
    renderPicker();
    // The loop below and the standalone assertion after it both read from
    // the SAME `boat.draftProvenance.note` field (the standalone regex is a
    // hand-COPIED substring of it, not an independently authored value —
    // unlike the draft literal's idiom above, there is no shared FORMULA
    // (`.toFixed(1)` et al.) for a plain string field to protect against, so
    // that "one hardcoded anchor beside the derived loop" framing does not
    // apply here; this correction replaces an earlier version of this
    // comment that claimed it did). What the standalone assertion actually
    // gives is DEFENSE IN DEPTH for #566's specific hazard, not independent
    // coverage the loop lacks: MEASURED by temporarily deleting the loop
    // below, the standalone assertion alone still reds the `keelUnverified
    // &&`-gated mutation on its own. In the file AS WRITTEN, though, the
    // loop catches that same mutation FIRST — `for...of` iterates BOATS in
    // catalogue order (salona-45 is index 0) and a failed `expect()` throws
    // immediately, so the standalone assertion below never even executes in
    // that failure path; it is redundant with the loop's own salona-45
    // iteration for THIS mutation, not an independent backstop for it.
    for (const boat of BOATS) {
      const option = within(optionFor(boat.id));
      expect(option.getByText(boat.draftProvenance.note), boat.id).toBeInTheDocument();
    }
    // Kept anyway as a NAMED, explicit pin for #566's exact hazard (gating
    // the note on `keelUnverified`, as the sibling keel-caveat sentence
    // correctly IS gated, would silently drop the hull-verified reference
    // boat's OWN citation) — a reader can find this specific requirement
    // without tracing through the generic per-boat loop above, and it stays
    // load-bearing on its own if a future refactor ever drops or reorders
    // that loop.
    expect(
      within(optionFor('salona-45')).getByText(/depth data was chosen against/),
    ).toBeInTheDocument();
  });

  it('#701: every radio’s aria-describedby always includes the draft-provenance note, by id', () => {
    renderPicker();
    for (const boat of BOATS) {
      const radio = document.getElementById(`boat-option-${boat.id}`);
      expect(radio, boat.id).not.toBeNull();
      const describedBy = radio!.getAttribute('aria-describedby');
      // Before this fix, a hull-verified boat (today the Salona 45 alone)
      // rendered NO `aria-describedby` at all — the whole attribute was
      // gated on `keelUnverified`, same as the keel caveat it was meant to
      // point at. This assertion is what reds under that regression, since
      // the loop below cannot distinguish "attribute absent" from "id list
      // missing the note" once `.split(' ')` runs on a null string.
      expect(describedBy, `${boat.id}: no aria-describedby at all`).not.toBeNull();
      const ids = describedBy!.split(' ');
      const noteId = `boat-option-${boat.id}-note`;
      expect(ids, boat.id).toContain(noteId);
      const noteEl = document.getElementById(noteId);
      expect(noteEl, `${boat.id}: no element with id ${noteId}`).not.toBeNull();
      expect(noteEl?.textContent, boat.id).toBe(boat.draftProvenance.note);

      const keelId = `boat-option-${boat.id}-keel`;
      if (boat.draftProvenance.hullVerified) {
        // No keel caveat renders for a hull-verified boat, so its id must
        // not be referenced either — a dangling aria-describedby id would be
        // its own, separate accessibility defect.
        expect(ids, boat.id).not.toContain(keelId);
        expect(document.getElementById(keelId), boat.id).toBeNull();
      } else {
        expect(ids, boat.id).toContain(keelId);
        expect(document.getElementById(keelId), boat.id).not.toBeNull();
      }
    }
  });

  it('#707: draftProvenance.note and every sail’s polarProvenance.note carry lang="en" (WCAG 2.1 SC 3.1.2) under the German-default render', () => {
    renderPicker();
    // renderPicker() sets sc-lang to 'en' (see its own comment), but
    // I18nProvider's default UI language is 'de' — the #607 hazard this
    // targets ('the German keel sentence renders immediately before the
    // English note, so a screen reader code-switches mid-block with no
    // warning') only exists under a German document.documentElement.lang,
    // so this asserts the attribute is present REGARDLESS of what the
    // surrounding UI language happens to be, which is the point: the
    // element's own `lang` must be correct independent of the ambient one.
    for (const boat of BOATS) {
      const option = optionFor(boat.id);
      const draftNote = option.querySelector('.boat-option-draft-note');
      expect(draftNote, `${boat.id}: no draft note rendered`).not.toBeNull();
      expect(draftNote?.getAttribute('lang'), boat.id).toBe('en');
      const sailNotes = option.querySelectorAll('.boat-option-sail-note');
      // Every sail's own note, not just the first — mirrors the #566 "BOTH
      // sails' notes" rationale two tests above: a fix that only tagged the
      // first sail note would pass a getBy-style check but leave the
      // second sail's citation mis-tagged.
      expect(sailNotes.length, boat.id).toBe(boat.sails.length);
      for (const note of Array.from(sailNotes)) {
        expect(note.getAttribute('lang'), `${boat.id}: sail note "${note.textContent}"`).toBe('en');
      }
    }
  });

  it('starts with an empty live region rather than a stale announcement', () => {
    renderPicker();
    const status = screen.getByRole('status');
    // Present but empty: a role="status" region must already be in the
    // accessibility tree before its text changes, or assistive tech has no
    // node to observe the mutation on.
    //
    // HONEST SCOPE (PR #563 MINOR 2): these are DOM assertions, and this test
    // renders WITHOUT app.css, so neither can see the cascade — a
    // `display: none` on the empty region would take it out of the
    // accessibility tree while leaving both of these green, which is exactly
    // the MAJOR 1 defect. `test/boatPickerNoticeLiveRegion.test.ts` is the
    // other half and resolves that against the real stylesheet. The class
    // assertion below is what ties the two together: it is spelled out
    // independently on each side rather than derived from one source, so a
    // rename reds one of them instead of silently unhooking the CSS guard.
    expect(status).toBeInTheDocument();
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveClass('boat-picker-notice');
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
