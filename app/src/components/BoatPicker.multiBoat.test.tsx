import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Its own file because `vi.mock` is hoisted per module graph, and
// BoatPicker.test.tsx asserts against the REAL one-entry catalogue. Release 1
// ships one boat, so the switch — and therefore spec C.7's clamp, the whole
// safety point of #539 item 1 — is unreachable without a second entry. Same
// precedent and same shape as services/migratePlan.catalogueRename.test.ts.
//
// `salona-45` is kept verbatim so DEFAULT_BOAT_ID stays resolvable: types.ts
// imports `boatById(DEFAULT_BOAT_ID)` as a VALUE to build DEFAULT_SETTINGS,
// so a mock that dropped it would break the module under test's own imports
// for reasons unrelated to anything here.
vi.mock('../data/boats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/boats')>();
  // #569: an ID lookup, not `BOATS[0]!` — an index is a dependency on
  // catalogue ORDER, so a future reorder (not just growth) would silently
  // swap which boat backs this fixture while every row below stayed green,
  // asserting against the wrong boat. Throws loudly rather than silently
  // falling back to `undefined` if the id is ever renamed.
  const salona = actual.BOATS.find((b) => b.id === 'salona-45');
  if (!salona) throw new Error("fixture donor 'salona-45' missing from the real catalogue");
  const deep = {
    ...salona,
    id: 'deep-46',
    name: 'Deep 46',
    draftM: 2.3,
    // The REAL catalogue field, with the shape data/boats.ts declares. An
    // earlier revision of this fixture invented `keelAssumption`, which the
    // catalogue never wrote — so the component rendered from a field only the
    // fixture supplied and the paragraph was dead for every real fleet boat
    // (the #563/#565 cross-branch Blocker). A fixture that does not match the
    // catalogue's shape proves nothing about the catalogue.
    draftProvenance: {
      keel: 'standard deep keel',
      hullVerified: false,
      note: 'Fixture: builder specification, not checked against the hull.',
    },
    sails: salona.sails.map((s) => ({
      ...s,
      polarProvenance: { tier: 'estimated' as const, note: `estimated note for ${s.id}` },
    })),
  };
  const shoal = {
    ...salona,
    id: 'shoal-40',
    name: 'Shoal 40',
    draftM: 1.6,
    // Inherits the Salona 45's `hullVerified: true` through the spread, which
    // is deliberately the NO-caveat case: it is what makes 'renders it for
    // that boat ONLY' discriminating rather than vacuous.
    sails: salona.sails.map((s) => ({
      ...s,
      polarProvenance: { tier: 'certificate' as const, note: `certificate note for ${s.id}` },
    })),
  };
  const BOATS = [salona, deep, shoal];
  return {
    ...actual,
    BOATS,
    boatById: (id: string) => {
      const b = BOATS.find((x) => x.id === id);
      if (!b) throw new Error(`unknown boat id: ${id}`);
      return b;
    },
  };
});

const { default: BoatPicker } = await import('./BoatPicker');
const { default: SettingsPanel } = await import('./SettingsPanel');
const { I18nProvider } = await import('../i18n');
const { DEFAULT_SETTINGS } = await import('../types');
const { BOATS } = await import('../data/boats');

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type BoatIdish = Parameters<typeof BoatPicker>[0]['boatId'];

function renderPicker(opts: { boatId?: string; safetyDepthM?: number; lang?: string } = {}) {
  localStorage.setItem('sc-lang', opts.lang ?? 'en');
  const onBoatIdChange = vi.fn();
  const onSettingsChange = vi.fn();
  render(
    <I18nProvider>
      <BoatPicker
        boatId={(opts.boatId ?? 'salona-45') as BoatIdish}
        onBoatIdChange={onBoatIdChange}
        settings={{ ...DEFAULT_SETTINGS, safetyDepthM: opts.safetyDepthM ?? 3.0 }}
        onSettingsChange={onSettingsChange}
      />
    </I18nProvider>,
  );
  return { onBoatIdChange, onSettingsChange };
}

function selectBoat(name: RegExp): void {
  fireEvent.click(screen.getByRole('radio', { name }));
}

describe('the mocked catalogue itself', () => {
  // #411's "a guard's DATA needs a twin". Every row below depends on this
  // mock having taken; a factory that silently fell back to the real module
  // would leave the switch rows unable to find a second radio — but the
  // keel/tier rows would fail with confusing "not found" messages instead of
  // naming the real cause. This row names it.
  it('really did install three boats with the intended drafts', () => {
    expect(BOATS.map((b) => b.id)).toEqual(['salona-45', 'deep-46', 'shoal-40']);
    expect(BOATS.map((b) => b.draftM)).toEqual([2.1, 2.3, 1.6]);
  });
});

describe('#54 BoatPicker with a multi-boat catalogue', () => {
  it('renders one radio per boat and checks only the selected one', () => {
    renderPicker({ boatId: 'deep-46' });
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /Deep 46/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Salona 45/ })).not.toBeChecked();
  });

  it('states each boat’s OWN draft', () => {
    // Not "some draft text": a picker rendering the selected boat's draft on
    // every row would look right and be wrong, and draft is the field spec C
    // hangs everything on.
    renderPicker();
    expect(screen.getByText('Draft 2.1 m')).toBeInTheDocument();
    expect(screen.getByText('Draft 2.3 m')).toBeInTheDocument();
    expect(screen.getByText('Draft 1.6 m')).toBeInTheDocument();
  });
});

describe('#539 item 1 / spec C.7: the clamp is WIRED to the boat switch', () => {
  it('clamps a below-minimum safety depth UP, persists it, and announces it', () => {
    // Deep 46 draws 2.30 m, so spec J OQ-1's `draftM + 0.1` floor is 2.4 —
    // above the 2.2 m the user had stored under the shallower default boat.
    const { onBoatIdChange, onSettingsChange } = renderPicker({ safetyDepthM: 2.2 });
    selectBoat(/Deep 46/);

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange.mock.calls[0]![0]).toMatchObject({ safetyDepthM: 2.4 });
    expect(onBoatIdChange).toHaveBeenCalledWith('deep-46');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Safety depth raised to 2.4 m — the minimum for Deep 46.',
    );
  });

  it('NEVER clamps down: a generous stored depth survives a switch to a shoal boat', () => {
    // The direction that matters. Shoal 40's floor is 1.7 m; a user who chose
    // 4.0 m deliberately keeps it, and nothing is announced because nothing
    // changed. A clamp implemented as "set to the new boat's floor" would
    // pass the row above and fail here.
    const { onBoatIdChange, onSettingsChange } = renderPicker({ safetyDepthM: 4.0 });
    selectBoat(/Shoal 40/);

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(onBoatIdChange).toHaveBeenCalledWith('shoal-40');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('does not announce when the stored depth sits EXACTLY on the new floor', () => {
    // The `>=` boundary, at the wiring level rather than inside
    // clampSettingsToBoat (lib/boatSettings.test.ts owns the function's own
    // boundary row). A `>` here would announce a change that never happened.
    const { onSettingsChange } = renderPicker({ safetyDepthM: 2.4 });
    selectBoat(/Deep 46/);
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('clears a previous clamp notice on a later switch that clamps nothing', () => {
    // Otherwise the announcement outlives the action that caused it and
    // claims a change the second switch did not make.
    renderPicker({ safetyDepthM: 2.2 });
    selectBoat(/Deep 46/);
    expect(screen.getByRole('status')).not.toBeEmptyDOMElement();
    selectBoat(/Shoal 40/);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('announces in German too, with the depth and boat interpolated', () => {
    // i18n KEY parity is compiler-enforced; PLACEHOLDER parity is not — a de
    // string spelling `{tiefe}` would render the brace literally and this is
    // the only thing that would notice.
    //
    // #596: the depth figure is now locale-aware (formatDepthM) like every
    // other user-visible depth in the app, so the German render reads
    // "2,4 m" — a decimal COMMA, not the English "2.4 m" this row pinned
    // before #596 fixed the mixed-convention hazard.
    renderPicker({ safetyDepthM: 2.2, lang: 'de' });
    selectBoat(/Deep 46/);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sicherheitstiefe auf 2,4 m angehoben – Mindestwert für Deep 46.',
    );
  });

  it('leaves the other per-boat defaults alone', () => {
    // settingsDefaultsForBoat also derives motorSpeedKn and maneuverPenaltyS,
    // and spec C.7 covers NEITHER. Overwriting a user's tuned crew values on
    // a boat switch would be clamping a preference — the direction the spec
    // forbids even for the one field it does cover.
    const { onSettingsChange } = renderPicker({ safetyDepthM: 2.2 });
    selectBoat(/Deep 46/);
    const next = onSettingsChange.mock.calls[0]![0] as typeof DEFAULT_SETTINGS;
    expect(next.motorSpeedKn).toBe(DEFAULT_SETTINGS.motorSpeedKn);
    expect(next.maneuverPenaltyS).toBe(DEFAULT_SETTINGS.maneuverPenaltyS);
  });
});

describe('#54 spec N.2: the keel assumption is disclosed on the picker', () => {
  it('renders the unchecked-draft sentence for a boat that declares one', () => {
    renderPicker();
    expect(
      screen.getByText(
        "Assumed keel: standard deep keel. Not checked against this vessel's papers.",
      ),
    ).toBeInTheDocument();
  });

  it('links the caveat to the radio via aria-describedby, so arrowing onto the boat reaches it', () => {
    // PR #563 MINOR 4. Arrow keys move between RADIOS and skip everything
    // else in the group — native behaviour no container role changes — so
    // without this the spec N.2 mitigation is invisible to a screen-reader
    // user navigating the list. MEASURED: deleting the `aria-describedby`
    // spread left the two BoatPicker files 26/26 green before this row.
    //
    // It must be the DESCRIPTION, not the name: the accessible name stays
    // the boat + draft + tier, and the paragraph is what the caveat lives in.
    renderPicker();
    const radio = screen.getByRole('radio', { name: /Deep 46/ });
    const describedBy = radio.getAttribute('aria-describedby');
    expect(describedBy).toBe('boat-option-deep-46-keel');
    const caveat = document.getElementById(describedBy!);
    expect(caveat?.textContent).toContain('Assumed keel');
    // ...and the caveat must NOT have leaked into the accessible NAME, which
    // is the failure mode the picker's own comment rejects folding it in for.
    expect(radio.getAttribute('aria-label')).toBeNull();
    expect(screen.getByRole('radio', { name: /Deep 46/ })).toBeInTheDocument();
  });

  it('omits aria-describedby entirely for a boat that declares no assumption', () => {
    // `exactOptionalPropertyTypes`: the prop is OMITTED rather than set to
    // `undefined`. A radio pointing at an id that renders nothing is a
    // dangling reference, and some AT announces nothing at all for one.
    renderPicker();
    expect(screen.getByRole('radio', { name: /Salona 45/ }).hasAttribute('aria-describedby')).toBe(
      false,
    );
  });

  it('renders it for that boat ONLY, not for every row', () => {
    // The discriminating half of BoatPicker.test.tsx's absence row: exactly
    // one of three boats declares an assumption, so a component that rendered
    // the sentence unconditionally would pass the row above and fail here.
    renderPicker();
    expect(screen.getAllByText(/Assumed keel:/)).toHaveLength(1);
  });
});

describe('#566: draftProvenance.note renders per boat, INCLUDING the hull-verified boat', () => {
  it('renders the fixture-authored note for a boat with an assumed keel', () => {
    renderPicker();
    const option = screen
      .getByRole('radio', { name: /Deep 46/ })
      .closest('.boat-option')! as HTMLElement;
    expect(
      within(option).getByText('Fixture: builder specification, not checked against the hull.'),
    ).toBeInTheDocument();
  });

  it('ALSO renders the note for the hull-verified boat, which has NO keel caveat at all', () => {
    // Shoal 40 inherits Salona 45's `draftProvenance` UNCHANGED via the
    // fixture's spread (`hullVerified: true`, no keel-caveat sentence) — the
    // exact discriminating case #566 exists for. A `keelUnverified &&`-gated
    // render would show NOTHING here: no keel caveat (correctly, that fact
    // really is false for this boat) AND no note either (incorrectly — the
    // note is a citation that exists for every boat, verified or not).
    renderPicker();
    const option = screen
      .getByRole('radio', { name: /Shoal 40/ })
      .closest('.boat-option')! as HTMLElement;
    expect(within(option).queryByText(/Assumed keel/)).not.toBeInTheDocument();
    expect(within(option).getByText(/depth data was chosen against/)).toBeInTheDocument();
  });
});

describe('#54 spec G.3/N.5: the provenance tier is visible per boat', () => {
  it('labels an all-estimated boat "Estimated" and a certificate boat "Certificate"', () => {
    renderPicker();
    const chipOf = (name: RegExp): Element | null =>
      screen
        .getByRole('radio', { name })
        .closest('.boat-option')!
        .querySelector('.boat-option-facts .chip');
    expect(chipOf(/Deep 46/)?.textContent).toBe('Estimated');
    expect(chipOf(/Shoal 40/)?.textContent).toBe('Certificate');
    // The mixed boat reduces to its WEAKEST sail tier — see the real-catalogue
    // file for why that direction is the safe one.
    expect(chipOf(/Salona 45/)?.textContent).toBe('Modelled');
  });

  it('carries a tier-specific class so the caution styling can attach', () => {
    renderPicker();
    const chip = screen
      .getByRole('radio', { name: /Deep 46/ })
      .closest('.boat-option')!
      .querySelector('.boat-option-facts .chip');
    expect(chip?.className).toContain('chip-polar-tier-estimated');
  });
});

describe('#539 item 2: SAFETY_DEPTH_FIELD.min follows the SELECTED boat', () => {
  function renderSettings(boatId: string) {
    localStorage.setItem('sc-lang', 'en');
    render(
      <I18nProvider>
        <SettingsPanel
          value={DEFAULT_SETTINGS}
          onChange={vi.fn()}
          boatId={boatId as BoatIdish}
          onBoatIdChange={vi.fn()}
        />
      </I18nProvider>,
    );
    return screen.getByLabelText('Safety depth (m)');
  }

  it('renders the deep boat’s 2.4 m floor on the Boat tab’s own field', () => {
    // The RENDERED attribute, not the exported helper: OptionsPanel's
    // `safetyDepthFieldFor` could be perfectly correct while the panel still
    // passed the module-level default-boat constant to the input, which is
    // exactly the pre-#539 state.
    expect(renderSettings('deep-46')).toHaveAttribute('min', '2.4');
  });

  it('renders the shoal boat’s 1.7 m floor', () => {
    expect(renderSettings('shoal-40')).toHaveAttribute('min', '1.7');
  });

  it('still renders 2.2 m for the catalogue default boat', () => {
    // Reduces-to-today: the pre-#539 literal must be exactly what the default
    // boat still derives, or #539 item 2 changed behaviour for today's users.
    expect(renderSettings('salona-45')).toHaveAttribute('min', '2.2');
  });
});
