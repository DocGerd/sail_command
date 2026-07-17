import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import HarborPicker, { normalizeHarborSearch, rankHarbors } from './HarborPicker';
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
