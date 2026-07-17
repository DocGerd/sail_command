import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { Harbor } from '../types';
import { useLang, useT, type Lang } from '../i18n';

export interface HarborPickerProps {
  harbors: Harbor[];
  // Harbor ids most-recently-selected (most-recent-first). Ordered ahead of the
  // alphabetical rest in the empty-query state so round-trip harbors are one tap
  // away. Owned by PlannerPanel's useRecentHarbors.
  recentIds: string[];
  onSelect: (harbor: Harbor) => void;
  // Fired when the user dismisses the popup WITHOUT selecting — Esc, or blur
  // without a pick. Lets a caller that reopened the combobox over an already-
  // committed endpoint (the "Ändern" flow) revert to the collapsed row rather
  // than strand an empty search box while the old selection silently persists.
  onCancel?: () => void;
}

// Diacritic-insensitive normalization for harbor-name search. Lowercase
// FIRST: 'Æ'/'Ø' have no NFD decomposition (they aren't accented letters,
// just distinct letters), so the ø/æ replacements below only ever see them
// once toLowerCase() has already folded them to 'æ'/'ø'.
// eslint-disable-next-line react-refresh/only-export-components
export function normalizeHarborSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replaceAll('ø', 'o')
    .replaceAll('æ', 'ae');
}

function matchesQuery(harbor: Harbor, normalizedQuery: string): boolean {
  if (normalizedQuery === '') return true;
  return (
    normalizeHarborSearch(harbor.names.de).includes(normalizedQuery) ||
    normalizeHarborSearch(harbor.names.da).includes(normalizedQuery) ||
    normalizeHarborSearch(harbor.names.en).includes(normalizedQuery)
  );
}

function startsWithQuery(harbor: Harbor, normalizedQuery: string): boolean {
  return (
    normalizeHarborSearch(harbor.names.de).startsWith(normalizedQuery) ||
    normalizeHarborSearch(harbor.names.da).startsWith(normalizedQuery) ||
    normalizeHarborSearch(harbor.names.en).startsWith(normalizedQuery)
  );
}

/**
 * Orders the harbors for the listbox.
 *
 * - Empty query: recently-used first (in `recentIds` order, de-duped, existing
 *   harbors only), then the remaining harbors alphabetically.
 * - Non-empty query: only matches, with exact-prefix matches ahead of
 *   substring-only matches; alphabetical (by normalized display name) is the
 *   final tiebreak within each group, so the result is deterministic — no
 *   locale-dependent collation.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function rankHarbors(
  harbors: Harbor[],
  query: string,
  lang: Lang,
  recentIds: string[],
): Harbor[] {
  const nq = normalizeHarborSearch(query);
  const alpha = (a: Harbor, b: Harbor): number => {
    const na = normalizeHarborSearch(a.names[lang]);
    const nb = normalizeHarborSearch(b.names[lang]);
    return na < nb ? -1 : na > nb ? 1 : 0;
  };

  if (nq === '') {
    const byId = new Map(harbors.map((h) => [h.id, h]));
    const seen = new Set<string>();
    const recent: Harbor[] = [];
    for (const id of recentIds) {
      const h = byId.get(id);
      if (h && !seen.has(id)) {
        recent.push(h);
        seen.add(id);
      }
    }
    const rest = harbors.filter((h) => !seen.has(h.id)).sort(alpha);
    return [...recent, ...rest];
  }

  const matched = harbors.filter((h) => matchesQuery(h, nq));
  const prefix = matched.filter((h) => startsWithQuery(h, nq)).sort(alpha);
  const substring = matched.filter((h) => !startsWithQuery(h, nq)).sort(alpha);
  return [...prefix, ...substring];
}

/**
 * Accessible harbor combobox (WAI-ARIA combobox + listbox pattern). The input
 * carries role="combobox" with aria-expanded / aria-controls / aria-autocomplete
 * and aria-activedescendant pointing at the active option; the popup is a
 * role="listbox" of role="option" rows. ↑/↓ move the active option (wrapping),
 * Enter selects it, Esc closes, blur/select closes. Origin and destination each
 * mount their own instance simultaneously, so every id derives from a per-
 * instance useId() base — no cross-instance collision on the option ids the
 * active-descendant wiring depends on.
 */
export default function HarborPicker({
  harbors,
  recentIds,
  onSelect,
  onCancel,
}: HarborPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [lang] = useLang();
  const t = useT();
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const results = useMemo(
    () => rankHarbors(harbors, query, lang, recentIds),
    [harbors, query, lang, recentIds],
  );

  // Keep the active option visible: with the aria-activedescendant pattern DOM
  // focus stays on the input, so the browser never auto-scrolls the listbox —
  // past the visible rows (and on the ArrowUp→last wrap) the highlight would sit
  // off-screen. This is a genuine DOM side-effect (not a setState), so an effect
  // is the right tool. `block: 'nearest'` scrolls the minimum needed.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = document.getElementById(`${baseId}-option-${activeIndex}`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, baseId]);

  // Opening (focus) or changing the query resets the active option to the top
  // (best-ranked) match, so Enter takes the first match and the highlight is
  // predictable. Reset happens on those events rather than in an effect (which
  // would cascade renders). aria-activedescendant / Enter are guarded against a
  // stale index if `results` shrinks from an unrelated prop change while open.
  const openList = () => {
    setOpen(true);
    setActiveIndex(0);
  };

  const choose = (harbor: Harbor) => {
    onSelect(harbor);
    setQuery('');
    setOpen(false);
  };

  const move = (delta: number) => {
    if (results.length === 0) return;
    setActiveIndex((i) => {
      if (i < 0) return delta > 0 ? 0 : results.length - 1;
      return (i + delta + results.length) % results.length;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (open) move(1);
        else setOpen(true);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (open) move(-1);
        else setOpen(true);
        break;
      case 'Enter':
        if (open && activeIndex >= 0 && activeIndex < results.length) {
          e.preventDefault();
          choose(results[activeIndex]);
        }
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          setOpen(false);
          onCancel?.();
        }
        break;
    }
  };

  // Dismiss without a selection (Esc handled above, or focus leaving the input).
  // An option click keeps focus on the input (its onMouseDown preventDefault),
  // and a keyboard/click selection unmounts this combobox, so neither path
  // reaches here — onCancel only fires on a genuine abandon.
  const onBlur = () => {
    setOpen(false);
    onCancel?.();
  };

  const showNoResults = open && query !== '' && results.length === 0;

  return (
    <div className="harbor-picker">
      <label htmlFor={inputId}>{t('harborPicker.searchLabel')}</label>
      <input
        id={inputId}
        className="harbor-picker-input"
        type="text"
        role="combobox"
        // Reflects whether the popup element actually exists — the listbox is
        // not rendered in the no-results state, so expanded must be false there.
        aria-expanded={open && results.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && activeIndex >= 0 && activeIndex < results.length
            ? optionId(activeIndex)
            : undefined
        }
        placeholder={t('harborPicker.searchPlaceholder')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          openList();
        }}
        onFocus={openList}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {open && results.length > 0 && (
        <ul
          className="harbor-picker-listbox"
          role="listbox"
          id={listboxId}
          aria-label={t('harborPicker.resultsLabel')}
        >
          {results.map((h, i) => {
            const caveat = h.approachNote?.[lang];
            return (
              <li
                key={h.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className="harbor-picker-option"
                // Keep focus on the input so the input's onBlur doesn't close the
                // popup before the click lands; the click then selects.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(h)}
              >
                <span className="harbor-picker-name">{h.names[lang]}</span>
                {caveat && <span className="harbor-picker-caveat">{caveat}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {showNoResults && <p className="harbor-picker-empty">{t('harborPicker.noResults')}</p>}
    </div>
  );
}
