import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { I18nProvider } from '../i18n';
import { de } from '../i18n/dict.de';
import { en } from '../i18n/dict.en';
import type { ChangelogRelease } from '../lib/changelog';
import ChangelogView from './ChangelogView';

// Constructed by hand — expectations below are literals read off this data,
// not derived from the component (mutation-check discipline).
const RELEASES: ChangelogRelease[] = [
  { version: 'Unreleased', date: null, categories: [] },
  {
    version: '1.2.0',
    date: '2026-07-20',
    categories: [
      {
        name: 'Added',
        entries: ['First added entry (#2, #3).', 'Second added entry.'],
      },
      { name: 'Fixed', entries: ['A fix entry (#4).'] },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-07-01',
    categories: [{ name: 'Added', entries: ['Initial release.'] }],
  },
];

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('ChangelogView', () => {
  it('renders versions with dates, category headings, and entry texts from parsed content', () => {
    render(
      <I18nProvider>
        <ChangelogView releases={RELEASES} />
      </I18nProvider>,
    );

    // textContent, not accessible name: dom-accessibility-api trims the
    // date span's leading space out of the computed name, but the rendered
    // text users see is 'version — date' (toHaveTextContent normalizes).
    expect(screen.getByRole('heading', { name: /1\.2\.0/ })).toHaveTextContent(
      '1.2.0 — 2026-07-20',
    );
    expect(screen.getByRole('heading', { name: /1\.0\.0/ })).toHaveTextContent(
      '1.0.0 — 2026-07-01',
    );
    // Two releases each contribute an 'Added' category heading.
    expect(screen.getAllByRole('heading', { name: 'Added' })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Fixed' })).toBeInTheDocument();
    expect(screen.getByText('First added entry (#2, #3).')).toBeInTheDocument();
    expect(screen.getByText('A fix entry (#4).')).toBeInTheDocument();
    expect(screen.getByText('Initial release.')).toBeInTheDocument();
  });

  it('renders issue/PR refs as plain text, never as links (offline honesty)', () => {
    render(
      <I18nProvider>
        <ChangelogView releases={RELEASES} />
      </I18nProvider>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('skips a release whose categories hold no entries (empty Unreleased)', () => {
    render(
      <I18nProvider>
        <ChangelogView releases={RELEASES} />
      </I18nProvider>,
    );
    expect(screen.queryByRole('heading', { name: 'Unreleased' })).not.toBeInTheDocument();
  });

  it('shows the maintained-in-English note in German by default and in English when toggled', () => {
    const { unmount } = render(
      <I18nProvider>
        <ChangelogView releases={RELEASES} />
      </I18nProvider>,
    );
    expect(screen.getByText(de['about.changelog.langNote'])).toBeInTheDocument();
    unmount();

    localStorage.setItem('sc-lang', 'en');
    render(
      <I18nProvider>
        <ChangelogView releases={RELEASES} />
      </I18nProvider>,
    );
    expect(screen.getByText(en['about.changelog.langNote'])).toBeInTheDocument();
  });
});
