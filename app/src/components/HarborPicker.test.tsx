import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import HarborPicker, { normalizeHarborSearch } from './HarborPicker';
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

afterEach(() => {
  localStorage.clear();
});

const renderPicker = (onSelect = vi.fn()) => {
  // Fix the display language to English so assertions on rendered name text
  // are deterministic regardless of the provider's de default.
  localStorage.setItem('sc-lang', 'en');
  render(
    <I18nProvider>
      <HarborPicker harbors={HARBORS} onSelect={onSelect} />
    </I18nProvider>,
  );
  return onSelect;
};

describe('normalizeHarborSearch', () => {
  it('lowercases, strips combining marks, and maps ø/æ before comparison', () => {
    expect(normalizeHarborSearch('Ærøskøbing')).toBe('aeroskobing');
    expect(normalizeHarborSearch('Glücksburg')).toBe('glucksburg');
  });
});

describe('HarborPicker', () => {
  it('finds Ærøskøbing when searching the diacritic-free "aero"', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'aero' } });
    expect(screen.getByRole('button', { name: 'Ærøskøbing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aabenraa' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Flensburg' })).not.toBeInTheDocument();
  });

  it('matches on the German name field even when it differs from Danish/English', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'apenrade' } });
    expect(screen.getByRole('button', { name: 'Aabenraa' })).toBeInTheDocument();
  });

  it('matches on the Danish/English name field even when German differs', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'aabenraa' } });
    expect(screen.getByRole('button', { name: 'Aabenraa' })).toBeInTheDocument();
  });

  it('shows the approach note under the harbor name when present, in the current language', () => {
    renderPicker();
    expect(screen.getByText('Buoyed approach channel through flats.')).toBeInTheDocument();
    expect(screen.getByText('Busy fjord, watch for ferry traffic.')).toBeInTheDocument();
  });

  it('omits the approach note block for harbors that have none', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'aabenraa' } });
    expect(screen.getByRole('button', { name: 'Aabenraa' })).toBeInTheDocument();
    expect(screen.queryByText(/approach/i)).not.toBeInTheDocument();
  });

  it('calls onSelect with the full harbor object when a result is clicked', () => {
    const onSelect = renderPicker();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'aero' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ærøskøbing' }));
    expect(onSelect).toHaveBeenCalledWith(AEROESKOEBING);
  });

  it('displays the harbor name and approach note in German when that is the active language', () => {
    localStorage.setItem('sc-lang', 'de');
    render(
      <I18nProvider>
        <HarborPicker harbors={HARBORS} onSelect={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: 'Apenrade' })).toBeInTheDocument();
    expect(screen.getByText('Betonntes Anfahrtsfahrwasser durch Flachwasser.')).toBeInTheDocument();
  });

  it('shows all harbors when the search is empty and none when nothing matches', () => {
    renderPicker();
    expect(screen.getAllByRole('button')).toHaveLength(HARBORS.length);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzznotaharbor' } });
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
