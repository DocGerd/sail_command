import { act, render, renderHook, screen, fireEvent, within } from '@testing-library/react';
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
  return {
    ...actual,
    findLowerSettingHint: vi.fn(actual.findLowerSettingHint),
    harborAccessAt: vi.fn(actual.harborAccessAt),
  };
});
import HarborPicker, {
  harborAccessCopy,
  unreachableBand,
  useUnreachableBandOf,
  normalizeHarborSearch,
  rankHarbors,
  type HarborWithReachability,
} from './HarborPicker';
import {
  computeHarborAccess,
  findLowerSettingHint,
  harborAccessAt,
  SEED_POINT,
  type LowerSettingHintOutcome,
} from '../lib/harborReachability';
import { BOATS } from '../data/boats';
import { NavMask } from '../lib/mask';
import type { Harbor } from '../types';
import { solverTimeoutMs } from '../test/timeouts';

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

  // PR #1323 review Major 1: there is NO "below the boat's recommended
  // depth" branch — `findLowerSettingHint`'s real floor makes a
  // strictly-below-default 'found' outcome unreachable in production, so
  // keying is by STATE ALONE. Asserted with `depthM: 3.2` (a plausible,
  // at-or-above-default value) for the plain "ok" case.
  it('a "found" hint at "ok" keys by boatLowerSettingAtDefault', () => {
    const hint: LowerSettingHintOutcome = { kind: 'found', hint: { depthM: 3.2, state: 'ok' } };
    expect(harborAccessCopy('unreachable', hint, boat, 3.5, 'en')[1]).toEqual({
      key: 'harborPicker.boatLowerSettingAtDefault',
      vars: { depth: '3.2' },
    });
  });

  // The #1291 "which key wins when a harbour qualifies for both states" rule.
  // `depthM: 1.0` is deliberately BELOW the boat's own default (impossible
  // from the real `findLowerSettingHint`, whose floor IS the default) —
  // proving state-keying holds regardless of depth, i.e. that no depth
  // comparison survives in the fixed code (mutation target for review
  // Major 1: reintroducing a depth branch would re-key this row wrong).
  it('a "found" hint at "shallow-approach" keys by boatLowerSettingAtDefaultShallow, regardless of depth', () => {
    const hint: LowerSettingHintOutcome = {
      kind: 'found',
      hint: { depthM: 1.0, state: 'shallow-approach' },
    };
    expect(harborAccessCopy('unreachable', hint, boat, 3.5, 'en')[1]).toEqual({
      key: 'harborPicker.boatLowerSettingAtDefaultShallow',
      vars: { depth: '1.0' },
    });
  });

  // #1321/PR #1323 review Major 2: `findLowerSettingHint` only searches
  // `[defaultSafetyDepthM(boat), safetyDepthM)`, never the boat's absolute
  // floor (a user CAN dial safety depth down to `minSafetyDepthM(boat)`
  // without a boat switch, per `OptionsPanel.tsx`) — a 'not-found' outcome
  // must therefore claim only "not reachable at or above the recommended
  // depth", never a claim covering settings below it.
  it('#1321: a "not-found" hint adds the scoped "at or above default" line, never a claim about settings below it', () => {
    const hint: LowerSettingHintOutcome = { kind: 'not-found' };
    expect(harborAccessCopy('unreachable', hint, boat, 3.5, 'en')).toEqual([
      { key: 'harborPicker.boatUnreachable', vars: { boat: boat.name, depth: '3.5' } },
      { key: 'harborPicker.boatUnreachableAtOrAboveDefault', vars: { boat: boat.name } },
    ]);
  });

  it('an "exhausted" hint (step budget hit before finishing) adds nothing rather than a wrong claim either way', () => {
    const hint: LowerSettingHintOutcome = { kind: 'exhausted', resumeFromDepthM: 2.9 };
    expect(harborAccessCopy('unreachable', hint, boat, 3.5, 'en')).toEqual([
      { key: 'harborPicker.boatUnreachable', vars: { boat: boat.name, depth: '3.5' } },
    ]);
  });

  // #1721: a checked unreachable band replaces both the live-gate line and the
  // hint lines, and names the range it covers.
  it('#1721: an unreachable band collapses to the range line naming min and max', () => {
    const hint: LowerSettingHintOutcome = { kind: 'not-found' };
    expect(
      harborAccessCopy('unreachable', hint, boat, 3.5, 'en', { minM: 2.2, maxM: 3.5 }),
    ).toEqual([
      {
        key: 'harborPicker.boatUnreachableAcrossRange',
        vars: { boat: boat.name, min: '2.2', max: '3.5' },
      },
    ]);
  });

  it('#1725: a pending scan keeps the factual line and adds the checking line, with no hint line', () => {
    const hint: LowerSettingHintOutcome = { kind: 'found', hint: { depthM: 3.2, state: 'ok' } };
    expect(harborAccessCopy('unreachable', hint, boat, 3.5, 'en', 'pending')).toEqual([
      { key: 'harborPicker.boatUnreachable', vars: { boat: boat.name, depth: '3.5' } },
      { key: 'harborPicker.boatUnreachableChecking', vars: { boat: boat.name } },
    ]);
  });

  it('#1721: without a band the ordinary lines stay', () => {
    expect(harborAccessCopy('unreachable', null, boat, 3.5, 'en', null)[0]?.key).toBe(
      'harborPicker.boatUnreachable',
    );
    expect(harborAccessCopy('unreachable', null, boat, 3.5, 'en')[0]?.key).toBe(
      'harborPicker.boatUnreachable',
    );
  });
});

// #1721: the band scan against a real NavMask. Open water everywhere except a
// pocket of POCKET_DEPTH_DM-decimetre cells (wider than the 1852 m relaxation
// disc) around the harbour, so reachability depends on the gate.
// Flood fills over synthetic masks: instrumented runs need the scaled budget.
describe('unreachableBand (#1721)', { timeout: solverTimeoutMs(20_000) }, () => {
  const easyGo = BOATS.find((b) => b.id === 'salona-44-easy-go')!; // min 2.7, default 3.5
  const POCKET: Harbor = {
    id: 'pocket',
    names: { de: 'Tasche', da: 'Tasche', en: 'Pocket' },
    country: 'DK',
    snap: { lat: 55.0, lon: 10.3 },
  };
  const meta = { west: 9.4, south: 54.3, east: 11.0, north: 55.3, cols: 800, rows: 500 };
  function maskWithPocket(depthDm: number) {
    const data = new Uint8Array(meta.rows * meta.cols).fill(255);
    const row = Math.floor((POCKET.snap.lat - meta.south) * 500);
    const col = Math.floor((POCKET.snap.lon - meta.west) * 500);
    for (let r = row - 40; r <= row + 40; r++)
      for (let c = col - 40; c <= col + 40; c++) data[r * meta.cols + c] = depthDm;
    return new NavMask(meta, data);
  }

  it('covers [min, max(default, live)] when the harbour is unreachable at every gate', () => {
    const mask = maskWithPocket(20); // 2.0 m: below every allowed gate
    expect(unreachableBand(mask, [POCKET], easyGo, 'pocket', 3.5)).toEqual({
      minM: 2.7,
      maxM: 3.5,
    });
    expect(unreachableBand(mask, [POCKET], easyGo, 'pocket', 4.2)).toEqual({
      minM: 2.7,
      maxM: 4.2,
    });
    // A live gate below the default still scans up to the default.
    expect(unreachableBand(mask, [POCKET], easyGo, 'pocket', 3.0)).toEqual({
      minM: 2.7,
      maxM: 3.5,
    });
  });

  it('is null when a lower allowed gate reaches the harbour, though the live gate does not', () => {
    const mask = maskWithPocket(30); // 3.0 m: reachable at gates <= 3.0, not at 3.5
    expect(unreachableBand(mask, [POCKET], easyGo, 'pocket', 3.5)).toBeNull();
  });

  // Land ring (radius 6 cells) around a deep island (radius 2): the snap
  // succeeds but the flood never reaches it, so each such harbour costs a
  // pairwise cellsConnected BFS per gate in a full catalogue classification.
  function island(id: string, lat: number, lon: number): Harbor {
    return { id, names: { de: id, da: id, en: id }, country: 'DK', snap: { lat, lon } };
  }
  const ISLANDS = [0, 1, 2, 3, 4].map((i) => island(`island${i}`, 54.5 + i * 0.05, 10.5));
  const REACHABLE = island('open', 54.4, 9.6);
  // Deep cell inside a 3.0 m ring: 'shallow-approach' while the live gate exceeds the ring.
  const SHALLOW = island('shallow', 54.75, 10.5);
  function maskWithIslands() {
    const data = new Uint8Array(meta.rows * meta.cols).fill(255);
    for (const h of ISLANDS) {
      const row = Math.floor((h.snap.lat - meta.south) * 500);
      const col = Math.floor((h.snap.lon - meta.west) * 500);
      for (let r = row - 6; r <= row + 6; r++)
        for (let c = col - 6; c <= col + 6; c++)
          data[r * meta.cols + c] = Math.max(Math.abs(r - row), Math.abs(c - col)) <= 2 ? 255 : 0;
    }
    const row = Math.floor((SHALLOW.snap.lat - meta.south) * 500);
    const col = Math.floor((SHALLOW.snap.lon - meta.west) * 500);
    for (let r = row - 5; r <= row + 5; r++)
      for (let c = col - 5; c <= col + 5; c++)
        data[r * meta.cols + c] = Math.max(Math.abs(r - row), Math.abs(c - col)) <= 1 ? 255 : 30;
    return new NavMask(meta, data);
  }
  const ALL = [...ISLANDS, REACHABLE, SHALLOW, POCKET];

  it('harborAccessAt agrees with computeHarborAccess for every harbour at every gate of the band', () => {
    const mask = maskWithPocket(30);
    const states = new Set<string>();
    for (let dm = 27; dm <= 35; dm++) {
      const full = computeHarborAccess(mask, ALL, easyGo, dm / 10);
      for (const h of ALL) {
        const single = harborAccessAt(mask, h, easyGo, dm / 10);
        states.add(single);
        expect(single, `${h.id} @ ${dm / 10}`).toBe(full.get(h.id));
      }
    }
    const islands = maskWithIslands();
    for (let dm = 27; dm <= 35; dm++) {
      const full = computeHarborAccess(islands, ALL, easyGo, dm / 10);
      for (const h of ALL) {
        const single = harborAccessAt(islands, h, easyGo, dm / 10);
        states.add(single);
        expect(single, `${h.id} @ ${dm / 10}`).toBe(full.get(h.id));
      }
    }
    // The comparison is exercised on every reachable state, not only one.
    expect([...states].sort()).toEqual(['ok', 'shallow-approach', 'unreachable']);
  });

  // One flood starts with exactly one isNavigable() call on the seed cell.
  function countFloods(mask: NavMask) {
    const seedRow = mask.grid.lat.index(SEED_POINT.lat);
    const seedCol = mask.grid.lon.index(SEED_POINT.lon);
    const seedLat = mask.grid.lat.centre(seedRow);
    const seedLon = mask.grid.lon.centre(seedCol);
    let floods = 0;
    const real = mask.isNavigable.bind(mask);
    vi.spyOn(mask, 'isNavigable').mockImplementation((p, g) => {
      if (p.lat === seedLat && p.lon === seedLon) floods++;
      return real(p, g);
    });
    return () => floods;
  }

  it('scans one flood per gate and classifies only the target harbour', () => {
    const mask = maskWithIslands();
    const floods = countFloods(mask);
    const connected = vi.spyOn(mask, 'cellsConnected');
    expect(unreachableBand(mask, ALL, easyGo, 'island0', 3.5)).toEqual({ minM: 2.7, maxM: 3.5 });
    expect(floods()).toBe(9);
    // One pairwise BFS per gate for the target; a full classification would add the other four islands.
    expect(connected.mock.calls.length).toBeLessThanOrEqual(9);
  });

  it('stops at the first reachable gate', () => {
    const mask = maskWithPocket(30); // reachable from 2.7 m
    const floods = countFloods(mask);
    expect(unreachableBand(mask, ALL, easyGo, 'pocket', 3.5)).toBeNull();
    expect(floods()).toBe(1);
  });
});

// #1725: the scan hook against a stubbed per-gate classifier, one gate per
// macrotask, roughly one step per tick; assertions use slack, not exact counts.
describe('useUnreachableBandOf (#1725)', () => {
  const easyGo = BOATS.find((b) => b.id === 'salona-44-easy-go')!; // gates 2.7 .. 3.5
  const harbor = (id: string): Harbor => ({
    id,
    names: { de: id, da: id, en: id },
    country: 'DK',
    snap: { lat: 55, lon: 10 },
  });
  const HARBOURS = [harbor('a'), harbor('b')];
  const tick = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await tick();
  };
  const callsFor = (id: string) =>
    vi.mocked(harborAccessAt).mock.calls.filter((c) => c[1].id === id).length;

  afterEach(() => {
    vi.mocked(harborAccessAt).mockReset();
  });

  it('is pending until the scan finishes, then yields the band', async () => {
    vi.mocked(harborAccessAt).mockReturnValue('unreachable');
    const mask = {} as NavMask;
    const { result } = renderHook(() => useUnreachableBandOf(mask, HARBOURS, easyGo, 3.5, ['a']));
    expect(result.current('a')).toBe('pending');
    await ticks(3);
    expect(result.current('a')).toBe('pending');
    await ticks(12);
    expect(result.current('a')).toEqual({ minM: 2.7, maxM: 3.5 });
  });

  it('settles to null, not pending, when a gate reaches the harbour', async () => {
    vi.mocked(harborAccessAt).mockReturnValue('ok');
    const mask = {} as NavMask;
    const { result } = renderHook(() => useUnreachableBandOf(mask, HARBOURS, easyGo, 3.5, ['a']));
    expect(result.current('a')).toBe('pending');
    await ticks(4);
    expect(result.current('a')).toBeNull();
  });

  it('is null without a mask', () => {
    const { result } = renderHook(() => useUnreachableBandOf(null, HARBOURS, easyGo, 3.5, ['a']));
    expect(result.current('a')).toBeNull();
  });

  it('stops scanning a harbour that leaves the list mid-scan', async () => {
    vi.mocked(harborAccessAt).mockReturnValue('unreachable');
    const mask = {} as NavMask;
    const { result, rerender } = renderHook(
      ({ ids }) => useUnreachableBandOf(mask, HARBOURS, easyGo, 3.5, ids),
      { initialProps: { ids: ['a'] } },
    );
    await ticks(3);
    const before = callsFor('a');
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(9);
    rerender({ ids: ['b'] });
    await ticks(14);
    expect(callsFor('a')).toBe(before);
    expect(result.current('a')).toBe('pending');
    expect(result.current('b')).toEqual({ minM: 2.7, maxM: 3.5 });
  });

  it('stops scanning after unmount', async () => {
    vi.mocked(harborAccessAt).mockReturnValue('unreachable');
    const mask = {} as NavMask;
    const { unmount } = renderHook(() => useUnreachableBandOf(mask, HARBOURS, easyGo, 3.5, ['a']));
    await ticks(3);
    const before = callsFor('a');
    expect(before).toBeGreaterThan(0);
    unmount();
    await ticks(14);
    expect(callsFor('a')).toBe(before);
  });

  it('rescans from the first gate when the mask changes mid-scan', async () => {
    const maskA = {} as NavMask;
    const maskB = {} as NavMask;
    // maskB reaches the harbour at the lowest gate only.
    vi.mocked(harborAccessAt).mockImplementation((mask, _h, _b, gateM) =>
      mask === maskB && gateM === 2.7 ? 'ok' : 'unreachable',
    );
    const { result, rerender } = renderHook(
      ({ mask }) => useUnreachableBandOf(mask, HARBOURS, easyGo, 3.5, ['a']),
      { initialProps: { mask: maskA } },
    );
    await ticks(4);
    expect(result.current('a')).toBe('pending');
    rerender({ mask: maskB });
    await ticks(14);
    expect(result.current('a')).toBeNull();
    expect(vi.mocked(harborAccessAt).mock.calls.find((c) => c[0] === maskB)?.[3]).toBe(2.7);
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
      within(option).getByText(
        `Not reachable at or above ${boat.name}'s recommended safety depth.`,
      ),
    ).toBeInTheDocument();
  });

  it('#1721: shows the range line when the harbour is unreachable across the checked band', () => {
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
          unreachableBandOf={(id) => (id === 'aabenraa' ? { minM: 2.2, maxM: 3.5 } : null)}
          mask={FAKE_MASK}
        />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aabenraa' } });
    const option = screen.getByRole('option', { name: /Aabenraa/ });
    expect(
      within(option).getByText(
        `The app's depth data finds no connection for ${boat.name} at any safety depth from 2.2 m to 3.5 m.`,
      ),
    ).toBeInTheDocument();
    expect(within(option).queryByText(/Not reachable with/)).not.toBeInTheDocument();
  });

  it('#1725: shows the checking line, not the hint lines, while the band scan is pending', () => {
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
          unreachableBandOf={() => 'pending'}
          mask={FAKE_MASK}
        />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'aabenraa' } });
    const option = screen.getByRole('option', { name: /Aabenraa/ });
    expect(
      within(option).getByText(`Checking other safety depths for ${boat.name}…`),
    ).toBeInTheDocument();
    expect(within(option).getByText(/Not reachable with/)).toBeInTheDocument();
    expect(within(option).queryByText(/Not reachable at or above/)).not.toBeInTheDocument();
    expect(within(option).queryByText(/at any safety depth from/)).not.toBeInTheDocument();
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

  // German "…Shallow" line — the maintainer-DECIDED wording (coordinator
  // addendum on PR #1323, aligned with sibling PR #1324): "Sicherheitstiefe",
  // never "Einstellung", and only ONE "mit" (avoids the design spec's own
  // §7 draft bug, "Mit {depth} m eventuell mit Tiefenwarnung planbar", two
  // "mit" in a row).
  it('the German "…Shallow" line uses the decided wording (one "mit", "Sicherheitstiefe")', () => {
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
        'Eventuell planbar bei 2,8 m Sicherheitstiefe, mit Tiefenwarnung (nur Tiefendaten geprüft).',
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
