import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
// #1291: `findLowerSettingHint` is the one call HarborPicker makes into
// `harborReachability.ts` that needs a REAL `NavMask` (it walks
// `mask.meta`/`floodAtGate`) — wrapping it as a spy over its real
// implementation lets the render-level test below hand HarborPicker a
// canned outcome without constructing one, while every other test in this
// file (which never passes `boat`/`mask` props at all) never reaches this
// call site and is unaffected.
vi.mock('../lib/harborReachability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/harborReachability')>();
  return { ...actual, findLowerSettingHint: vi.fn(actual.findLowerSettingHint) };
});
import HarborPicker, {
  harborAccessCopy,
  normalizeHarborSearch,
  rankHarbors,
  type HarborWithReachability,
} from './HarborPicker';
import { findLowerSettingHint, type LowerSettingHintOutcome } from '../lib/harborReachability';
import { BOATS } from '../data/boats';
import { defaultSafetyDepthM } from '../lib/boatDepth';
import { formatDepthM } from '../lib/depthDisclosure';
import type { Harbor } from '../types';

// Mirrors real data shapes from app/public/data/harbors.json: a harbor whose
// three names are identical and contain 'æ'/'ø' (diacritic search target), a
// harbor whose German name genuinely differs from its Danish/English names
// (cross-field match target), and a harbor without an approachNote.
const AEROESKOEBING: Harbor = {
  id: 'aeroeskoebing',
  names: { de: 'Ærøskøbing', da: 'Ærøskøbing', en: 'Ærøskøbing' },
  country: 'DK',
  snap: { lat: 54.8935, lon: 10.416 },
  approachNote: {
    de: 'Betonntes Anfahrtsfahrwasser durch Flachwasser.',
    en: 'Buoyed approach channel through flats.',
  },
};

const AABENRAA: Harbor = {
  id: 'aabenraa',
  names: { de: 'Apenrade', da: 'Aabenraa', en: 'Aabenraa' },
  country: 'DK',
  snap: { lat: 55.0345, lon: 9.427 },
};

const FLENSBURG: Harbor = {
  id: 'flensburg',
  names: { de: 'Flensburg', da: 'Flensborg', en: 'Flensburg' },
  country: 'DE',
  snap: { lat: 54.795, lon: 9.435 },
  approachNote: {
    de: 'Vielbefahrene Förde, Fährverkehr beachten.',
    en: 'Busy fjord, watch for ferry traffic.',
  },
};

const HARBORS = [AEROESKOEBING, AABENRAA, FLENSBURG];

// #652: mirrors the real shipped shape — one of the five #9
// KNOWN_DISCONNECTED harbors, with BOTH an approachNote (as real "arnis"
// does) AND knownDisconnected: true, so the disclosure and caveat lines
// must coexist rather than one crowding out the other.
const ARNIS: HarborWithReachability = {
  id: 'arnis',
  names: { de: 'Arnis', da: 'Arnæs', en: 'Arnis' },
  country: 'DE',
  snap: { lat: 54.6254, lon: 9.9316 },
  approachNote: {
    de: 'Oberhalb der Kappelner Brücke.',
    en: 'Above the Kappeln bridge.',
  },
  knownDisconnected: true,
};

// Distinct, caveat-free set for pinning rank ORDER by hand (no locale-collation
// ambiguity, no caveat text folded into option accessible names).
const mkHarbor = (id: string, name: string): Harbor => ({
  id,
  names: { de: name, da: name, en: name },
  country: 'DK',
  snap: { lat: 0, lon: 0 },
});
const RANK_AABENRAA = mkHarbor('aabenraa', 'Aabenraa');
const RANK_ASSENS = mkHarbor('assens', 'Assens');
const RANK_MARSTAL = mkHarbor('marstal', 'Marstal');
const RANK_ENKHUIZEN = mkHarbor('enkhuizen', 'Enkhuizen');
const RANK_SET = [RANK_MARSTAL, RANK_AABENRAA, RANK_ASSENS]; // deliberately unsorted input

afterEach(() => {
  localStorage.clear();
});

const renderPicker = (onSelect = vi.fn(), harbors = HARBORS, recentIds: string[] = []) => {
  // Fix the display language to English so assertions on rendered name text
  // are deterministic regardless of the provider's de default.
  localStorage.setItem('sc-lang', 'en');
  render(
    <I18nProvider>
      <HarborPicker harbors={harbors} recentIds={recentIds} onSelect={onSelect} />
    </I18nProvider>,
  );
  return onSelect;
};

const optionNames = () => screen.getAllByRole('option').map((el) => el.textContent);

describe('normalizeHarborSearch', () => {
  it('lowercases, strips combining marks, and maps ø/æ before comparison', () => {
    expect(normalizeHarborSearch('Ærøskøbing')).toBe('aeroskobing');
    expect(normalizeHarborSearch('Glücksburg')).toBe('glucksburg');
  });
});

// Order expectations are derived BY HAND from the ranking contract (prefix
// group before substring group; alphabetical by normalized display name within
// each group; recents-first, then alphabetical, on the empty query), never read
// back from the function under test (repo lesson #50).
describe('rankHarbors', () => {
  it('ranks exact-prefix matches ahead of substring-only matches, alpha within each group', () => {
    // Query 'a': "Aabenraa"/"Assens" start with a (prefix); "Marstal" only
    // contains an a (substring). Prefix group sorts aabenraa < assens.
    const ranked = rankHarbors(RANK_SET, 'a', 'en', []);
    expect(ranked.map((h) => h.id)).toEqual(['aabenraa', 'assens', 'marstal']);
  });

  it('puts a prefix match ahead of an alphabetically-earlier substring match', () => {
    // Query 'en': "Enkhuizen" starts with en (prefix); "Assens" only contains
    // en (substring) yet sorts alphabetically BEFORE it. Prefix-first must win,
    // so the order diverges from pure alphabetical — a mutant that drops the
    // prefix/substring split (plain alpha sort) would yield ['assens',
    // 'enkhuizen'] and fail here.
    const ranked = rankHarbors([RANK_ASSENS, RANK_ENKHUIZEN], 'en', 'en', []);
    expect(ranked.map((h) => h.id)).toEqual(['enkhuizen', 'assens']);
  });

  it('on an empty query lists recents first (in recency order), then the rest alphabetically', () => {
    const ranked = rankHarbors(RANK_SET, '', 'en', ['marstal', 'aabenraa']);
    expect(ranked.map((h) => h.id)).toEqual(['marstal', 'aabenraa', 'assens']);
  });

  it('skips recent ids that no longer resolve to a harbor', () => {
    const ranked = rankHarbors(RANK_SET, '', 'en', ['ghost', 'assens']);
    expect(ranked.map((h) => h.id)).toEqual(['assens', 'aabenraa', 'marstal']);
  });

  it('excludes non-matching harbors entirely for a non-empty query', () => {
    const ranked = rankHarbors(RANK_SET, 'mar', 'en', []);
    expect(ranked.map((h) => h.id)).toEqual(['marstal']);
  });
});

describe('HarborPicker combobox', () => {
  it('exposes the ARIA combobox contract on the input', () => {
    renderPicker();
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-controls');
    // Popup is closed until focus/typing — the full list is never inline.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  // #737: the caller (PlannerPanel) is the one that decides WHEN this is
  // true — never a HarborPicker-internal default — so the unit-level
  // contract to pin here is just "the prop drives the DOM", verified both
  // ways (true focuses, omitted/false does not).
  it('#737: focuses the input on mount when autoFocus is true', () => {
    localStorage.setItem('sc-lang', 'en');
    render(
      <I18nProvider>
        <HarborPicker harbors={HARBORS} recentIds={[]} onSelect={vi.fn()} autoFocus />
      </I18nProvider>,
    );
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('#737: does not focus the input on mount when autoFocus is omitted', () => {
    renderPicker();
    expect(screen.getByRole('combobox')).not.toHaveFocus();
  });

  it('opens a listbox of options on focus and closes it on Escape', () => {
    renderPicker();
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(HARBORS.length);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('finds Ærøskøbing when searching the diacritic-free "aero" and hides non-matches', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aero' } });
    expect(screen.getByRole('option', { name: /Ærøskøbing/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Aabenraa/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Flensburg/ })).not.toBeInTheDocument();
  });

  it('matches on the German name field even when it differs from Danish/English', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'apenrade' } });
    expect(screen.getByRole('option', { name: /Aabenraa/ })).toBeInTheDocument();
  });

  it('matches on the Danish/English name field even when German differs', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aabenraa' } });
    expect(screen.getByRole('option', { name: /Aabenraa/ })).toBeInTheDocument();
  });

  it('shows the depth caveat as the muted secondary line of an option', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aero' } });
    const option = screen.getByRole('option', { name: /Ærøskøbing/ });
    expect(within(option).getByText('Buoyed approach channel through flats.')).toBeInTheDocument();
  });

  it('renders no caveat line for a harbor without one', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aabenraa' } });
    const option = screen.getByRole('option', { name: /Aabenraa/ });
    expect(within(option).queryByText(/approach/i)).not.toBeInTheDocument();
  });

  // #652: the picker must disclose a known-disconnected harbor BEFORE a
  // solve, and must NOT disclose it for an ordinary harbor — both directions
  // matter (a guard that only checks the positive case can't tell "always
  // renders the note" from "renders it correctly").
  it('discloses a known-disconnected harbor in its option row', () => {
    renderPicker(vi.fn(), [...HARBORS, ARNIS]);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'arnis' } });
    const option = screen.getByRole('option', { name: /Arnis/ });
    expect(
      within(option).getByText(
        'Not reachable by the router at any depth setting — a limit of the depth data, not a statement about the water.',
      ),
    ).toBeInTheDocument();
  });

  it('renders no known-disconnected disclosure for an ordinary harbor', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aabenraa' } });
    const option = screen.getByRole('option', { name: /Aabenraa/ });
    expect(within(option).queryByText(/not reachable/i)).not.toBeInTheDocument();
  });

  // Coexists with the depth caveat rather than replacing it (real "arnis"
  // ships both an approachNote and knownDisconnected: true).
  it('renders both the disclosure and the depth caveat when a harbor has both', () => {
    renderPicker(vi.fn(), [...HARBORS, ARNIS]);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'arnis' } });
    const option = screen.getByRole('option', { name: /Arnis/ });
    expect(within(option).getByText(/not reachable/i)).toBeInTheDocument();
    expect(within(option).getByText('Above the Kappeln bridge.')).toBeInTheDocument();
  });

  it('shows harbor name and caveat in German when that is the active language', () => {
    localStorage.setItem('sc-lang', 'de');
    render(
      <I18nProvider>
        <HarborPicker harbors={HARBORS} recentIds={[]} onSelect={vi.fn()} />
      </I18nProvider>,
    );
    fireEvent.focus(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: /Apenrade/ })).toBeInTheDocument();
    expect(screen.getByText('Betonntes Anfahrtsfahrwasser durch Flachwasser.')).toBeInTheDocument();
  });

  it('shows the no-results message and reports the popup collapsed when nothing matches', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzznotaharbor' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No harbors match your search.')).toBeInTheDocument();
    // No listbox element is rendered, so aria-expanded must not claim otherwise.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
  });

  it('orders recently-used harbors first on the empty query, then the rest alphabetically', () => {
    // Recents [flensburg, aeroeskoebing]; the remaining Aabenraa follows.
    // Hand-derived, not read from the component: option names in DOM order.
    renderPicker(vi.fn(), HARBORS, ['flensburg', 'aeroeskoebing']);
    fireEvent.focus(screen.getByRole('combobox'));
    expect(optionNames()).toEqual([
      expect.stringContaining('Flensburg'),
      expect.stringContaining('Ærøskøbing'),
      'Aabenraa',
    ]);
  });

  it('moves the active option with ↑/↓ (wrapping) and tracks it via aria-activedescendant', () => {
    renderPicker();
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    // Empty-query alpha order: Aabenraa, Ærøskøbing, Flensburg. First is active.
    const [aabenraa, aeroe, flensburg] = screen.getAllByRole('option');
    expect(aabenraa).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', aabenraa.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(aeroe).toHaveAttribute('aria-selected', 'true');
    expect(aabenraa).toHaveAttribute('aria-selected', 'false');
    expect(input).toHaveAttribute('aria-activedescendant', aeroe.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(flensburg).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', flensburg.id);

    // Wrap past the last option back to the first.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(aabenraa).toHaveAttribute('aria-selected', 'true');

    // ↑ from the first wraps to the last.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(flensburg).toHaveAttribute('aria-selected', 'true');
  });

  it('scrolls the active option into view as it moves with the keyboard', () => {
    // jsdom leaves scrollIntoView undefined; install a mock so the effect's DOM
    // call is observable. configurable lets later tests/GC drop it harmlessly.
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    renderPicker();
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    scrollIntoView.mockClear(); // ignore the mount/focus scroll; assert on nav
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('selects the active option on Enter', () => {
    const onSelect = renderPicker();
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    // Active = first (Aabenraa); ArrowDown → Ærøskøbing, then Enter selects it.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(AEROESKOEBING);
  });

  it('selects the harbor and passes the full object when an option is clicked', () => {
    const onSelect = renderPicker();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aero' } });
    fireEvent.click(screen.getByRole('option', { name: /Ærøskøbing/ }));
    expect(onSelect).toHaveBeenCalledWith(AEROESKOEBING);
  });
});

// #1291/§13 item 2: `harborAccessCopy`'s ordered-marker precedence table,
// tested directly (no render needed) — HarborPicker/PlannerPanel's OWN
// wiring around it is covered by the render-level describe below and by
// PlannerPanel.test.tsx's matching block.
describe('harborAccessCopy (#1291/§13 item 2 precedence table)', () => {
  // Salona 44 (SPEEDY GO!): draftM 2.1 -> defaultSafetyDepthM 3.0.
  const boat = BOATS[1];
  const defaultDepthM = defaultSafetyDepthM(boat);

  it('known-disconnected wins over every boat-scoped state and needs neither boat nor depth', () => {
    expect(harborAccessCopy('known-disconnected', null, undefined, undefined, 'en')).toEqual([
      { key: 'harborPicker.knownDisconnected' },
    ]);
    // Even when a hint/boat/depth ARE supplied, known-disconnected still wins
    // — it is a per-HARBOUR fact, independent of the boat-scoped ones.
    expect(
      harborAccessCopy(
        'known-disconnected',
        { kind: 'found', hint: { depthM: 2.5, state: 'ok' } },
        boat,
        3.5,
        'en',
      ),
    ).toEqual([{ key: 'harborPicker.knownDisconnected' }]);
  });

  it('renders nothing for "ok" and for a not-yet-computed (undefined) state', () => {
    expect(harborAccessCopy('ok', null, boat, 3.5, 'en')).toEqual([]);
    expect(harborAccessCopy(undefined, null, boat, 3.5, 'en')).toEqual([]);
  });

  it('renders nothing for a boat-scoped state when boat or depth is unavailable', () => {
    expect(harborAccessCopy('unreachable', null, undefined, 3.5, 'en')).toEqual([]);
    expect(harborAccessCopy('unreachable', null, boat, undefined, 'en')).toEqual([]);
    expect(harborAccessCopy('shallow-approach', null, undefined, 3.5, 'en')).toEqual([]);
  });

  it('"shallow-approach" renders only the boatShallow line — no hint search applies (it already routes)', () => {
    expect(harborAccessCopy('shallow-approach', null, boat, 3.5, 'en')).toEqual([
      { key: 'harborPicker.boatShallow', vars: { boat: boat.name } },
    ]);
  });

  it('"unreachable" with no hint renders only the base line', () => {
    expect(harborAccessCopy('unreachable', null, boat, 3.5, 'en')).toEqual([
      { key: 'harborPicker.boatUnreachable', vars: { boat: boat.name, depth: '3.5' } },
    ]);
  });

  it('a "found" hint at "ok" below the default keys by boatLowerSetting', () => {
    const hint: LowerSettingHintOutcome = { kind: 'found', hint: { depthM: 2.8, state: 'ok' } };
    expect(harborAccessCopy('unreachable', hint, boat, 3.5, 'en')).toEqual([
      { key: 'harborPicker.boatUnreachable', vars: { boat: boat.name, depth: '3.5' } },
      {
        key: 'harborPicker.boatLowerSetting',
        vars: { depth: '2.8', boat: boat.name, default: formatDepthM(defaultDepthM, 'en') },
      },
    ]);
  });

  // The #1291 "which key wins when a harbour qualifies for both states" rule:
  // keyed by the hint's OWN reached state (shallow-approach here), never by
  // the harbor's own (unreachable) state.
  it('a "found" hint at "shallow-approach" below the default keys by boatLowerSettingShallow', () => {
    const hint: LowerSettingHintOutcome = {
      kind: 'found',
      hint: { depthM: 2.8, state: 'shallow-approach' },
    };
    expect(harborAccessCopy('unreachable', hint, boat, 3.5, 'en')[1]).toEqual({
      key: 'harborPicker.boatLowerSettingShallow',
      vars: { depth: '2.8', boat: boat.name, default: formatDepthM(defaultDepthM, 'en') },
    });
  });

  it("a hint depth at or above the default uses the AtDefault phrasing regardless of the hint's own state", () => {
    const hint: LowerSettingHintOutcome = {
      kind: 'found',
      hint: { depthM: defaultDepthM, state: 'shallow-approach' },
    };
    expect(harborAccessCopy('unreachable', hint, boat, 3.5, 'en')[1]).toEqual({
      key: 'harborPicker.boatLowerSettingAtDefault',
      vars: { depth: formatDepthM(defaultDepthM, 'en') },
    });
  });

  // #1321: `findLowerSettingHint` only searches down to
  // `defaultSafetyDepthM(boat)`, never the boat's absolute floor — a
  // 'not-found' outcome must read as "not found in the searched range",
  // never as an unscoped "at any depth" claim.
  it('#1321: a "not-found" hint adds the scoped "any setting it keeps" line, never an unscoped claim', () => {
    const hint: LowerSettingHintOutcome = { kind: 'not-found' };
    expect(harborAccessCopy('unreachable', hint, boat, 3.5, 'en')).toEqual([
      { key: 'harborPicker.boatUnreachable', vars: { boat: boat.name, depth: '3.5' } },
      { key: 'harborPicker.boatUnreachableAnySetting', vars: { boat: boat.name } },
    ]);
  });

  it('an "exhausted" hint (step budget hit before finishing) adds nothing rather than a wrong claim either way', () => {
    const hint: LowerSettingHintOutcome = { kind: 'exhausted', resumeFromDepthM: 2.9 };
    expect(harborAccessCopy('unreachable', hint, boat, 3.5, 'en')).toEqual([
      { key: 'harborPicker.boatUnreachable', vars: { boat: boat.name, depth: '3.5' } },
    ]);
  });
});

// #1291: HarborPicker's OWN wiring around harborAccessCopy — deriving the
// per-option access state from the caller-supplied `harborAccess` map and
// calling `findLowerSettingHint` (mocked above) for the unreachable case.
describe('HarborPicker option row: #1291 per-boat access markers', () => {
  const boat = BOATS[1]; // SPEEDY GO! — a NON-default boat, per #1291's e2e requirement.
  const FAKE_MASK = {} as never;

  afterEach(() => {
    vi.mocked(findLowerSettingHint).mockReset();
  });

  it('shows the base "not reachable" line and the #1321-scoped hint line for an unreachable harbor', () => {
    localStorage.setItem('sc-lang', 'en');
    vi.mocked(findLowerSettingHint).mockReturnValue({ kind: 'not-found' });
    render(
      <I18nProvider>
        <HarborPicker
          harbors={HARBORS}
          recentIds={[]}
          onSelect={vi.fn()}
          boat={boat}
          safetyDepthM={3.5}
          harborAccess={new Map([['aabenraa', 'unreachable']])}
          mask={FAKE_MASK}
        />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aabenraa' } });
    const option = screen.getByRole('option', { name: /Aabenraa/ });
    expect(
      within(option).getByText(`Not reachable with ${boat.name} at 3.5 m safety depth.`),
    ).toBeInTheDocument();
    expect(
      within(option).getByText(`Not reachable with ${boat.name} at any setting it keeps.`),
    ).toBeInTheDocument();
  });

  it('shows the shallow-approach line for that state, with no hint search', () => {
    localStorage.setItem('sc-lang', 'en');
    render(
      <I18nProvider>
        <HarborPicker
          harbors={HARBORS}
          recentIds={[]}
          onSelect={vi.fn()}
          boat={boat}
          safetyDepthM={3.5}
          harborAccess={new Map([['aabenraa', 'shallow-approach']])}
          mask={FAKE_MASK}
        />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aabenraa' } });
    const option = screen.getByRole('option', { name: /Aabenraa/ });
    expect(
      within(option).getByText(`Only via a shallower approach with ${boat.name} — depth warning.`),
    ).toBeInTheDocument();
    expect(findLowerSettingHint).not.toHaveBeenCalled();
  });

  // German #13 item 2 word-order fix, verbatim.
  it('#13 item 2: the German "…Shallow" line uses the FIXED word order', () => {
    vi.mocked(findLowerSettingHint).mockReturnValue({
      kind: 'found',
      hint: { depthM: 2.8, state: 'shallow-approach' },
    });
    localStorage.setItem('sc-lang', 'de');
    render(
      <I18nProvider>
        <HarborPicker
          harbors={HARBORS}
          recentIds={[]}
          onSelect={vi.fn()}
          boat={boat}
          safetyDepthM={3.5}
          harborAccess={new Map([['aabenraa', 'unreachable']])}
          mask={FAKE_MASK}
        />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'apenrade' } });
    const option = screen.getByRole('option', { name: /Apenrade/ });
    expect(
      within(option).getByText(
        // `default` is `defaultSafetyDepthM(boat)` (3.0 for the 2.1 m-draft
        // Salona 44), NOT the `safetyDepthM` prop (3.5) — a different number
        // deliberately, so a swap of the two would fail this string match.
        `Bei 2,8 m Sicherheitstiefe eventuell planbar, mit Tiefenwarnung, unter der für ${boat.name} empfohlenen Sicherheitstiefe von 3,0 m (nur Tiefendaten geprüft).`,
      ),
    ).toBeInTheDocument();
  });

  it('renders no per-boat marker for an "ok" harbor, and no marker at all until harborAccess/boat/depth are supplied', () => {
    renderPicker(vi.fn(), HARBORS); // renderPicker itself sets lang 'en'.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aabenraa' } });
    const option = screen.getByRole('option', { name: /Aabenraa/ });
    expect(within(option).queryByText(/not reachable/i)).not.toBeInTheDocument();
    expect(within(option).queryByText(/may route/i)).not.toBeInTheDocument();
  });
});
