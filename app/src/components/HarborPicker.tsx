import { useMemo, useState } from 'react';
import type { Harbor } from '../types';
import { useLang, useT } from '../i18n';

export interface HarborPickerProps {
  harbors: Harbor[];
  onSelect: (harbor: Harbor) => void;
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

export default function HarborPicker({ harbors, onSelect }: HarborPickerProps) {
  const [query, setQuery] = useState('');
  const [lang] = useLang();
  const t = useT();

  const results = useMemo(() => {
    const normalizedQuery = normalizeHarborSearch(query);
    return harbors.filter((h) => matchesQuery(h, normalizedQuery));
  }, [harbors, query]);

  return (
    <div className="harbor-picker">
      <label htmlFor="harbor-picker-search">{t('harborPicker.searchLabel')}</label>
      <input
        id="harbor-picker-search"
        type="text"
        role="searchbox"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul>
        {results.map((h) => (
          <li key={h.id}>
            <button type="button" onClick={() => onSelect(h)}>
              {h.names[lang]}
            </button>
            {h.approachNote && <p className="approach-note">{h.approachNote[lang]}</p>}
          </li>
        ))}
      </ul>
      {results.length === 0 && <p>{t('harborPicker.noResults')}</p>}
    </div>
  );
}
