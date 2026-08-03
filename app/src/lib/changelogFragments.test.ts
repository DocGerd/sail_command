import { describe, it, expect } from 'vitest';
import type { ChangelogRelease } from './changelog';
import {
  assembleFragments,
  normalizeFragmentText,
  parseFragmentFilename,
  withPendingFragments,
  type RawFragment,
} from './changelogFragments';

describe('parseFragmentFilename', () => {
  it('parses a well-formed "<number>.<category>.md" filename', () => {
    expect(parseFragmentFilename('165.fixed.md')).toEqual({ number: '165', category: 'Fixed' });
  });

  it('parses every recognized category label', () => {
    expect(parseFragmentFilename('1.added.md')?.category).toBe('Added');
    expect(parseFragmentFilename('1.changed.md')?.category).toBe('Changed');
    expect(parseFragmentFilename('1.deprecated.md')?.category).toBe('Deprecated');
    expect(parseFragmentFilename('1.removed.md')?.category).toBe('Removed');
    expect(parseFragmentFilename('1.fixed.md')?.category).toBe('Fixed');
    expect(parseFragmentFilename('1.security.md')?.category).toBe('Security');
  });

  it('parses a "-N" disambiguation suffix, keeping the base number', () => {
    expect(parseFragmentFilename('165-2.added.md')).toEqual({ number: '165', category: 'Added' });
  });

  it('returns null for README.md (the directory keeper, never a fragment)', () => {
    expect(parseFragmentFilename('README.md')).toBeNull();
  });

  it('returns null for an unrecognized category', () => {
    expect(parseFragmentFilename('165.improved.md')).toBeNull();
  });

  it('returns null for a missing number', () => {
    expect(parseFragmentFilename('fixed.md')).toBeNull();
  });

  it('returns null for an uppercase category (lowercase-only by design)', () => {
    expect(parseFragmentFilename('165.Fixed.md')).toBeNull();
  });

  it('returns null for a non-.md file', () => {
    expect(parseFragmentFilename('165.fixed.txt')).toBeNull();
  });
});

describe('normalizeFragmentText', () => {
  it('trims a single-line fragment', () => {
    expect(normalizeFragmentText('  Hello world.  \n')).toBe('Hello world.');
  });

  it('collapses blank lines and wrapped continuation lines into single spaces', () => {
    const raw = 'First line\n\nSecond line\n  continued\n';
    expect(normalizeFragmentText(raw)).toBe('First line Second line continued');
  });

  it('strips a leading "- " if a contributor copied the CHANGELOG.md bullet habit', () => {
    expect(normalizeFragmentText('- Some entry.\n')).toBe('Some entry.');
  });

  it('does not strip a dash that is not a leading bullet marker', () => {
    expect(normalizeFragmentText('Pre-existing behavior unchanged.\n')).toBe(
      'Pre-existing behavior unchanged.',
    );
  });

  it('returns an empty string for whitespace-only content', () => {
    expect(normalizeFragmentText('\n\n  \n')).toBe('');
  });
});

describe('assembleFragments', () => {
  it('returns an empty-categories Unreleased release for no fragments', () => {
    expect(assembleFragments([])).toEqual({ version: 'Unreleased', date: null, categories: [] });
  });

  it('groups fragments by category in Keep a Changelog canonical order, not input order', () => {
    const fragments: RawFragment[] = [
      { category: 'Security', text: 'A security fix.' },
      { category: 'Added', text: 'A new thing.' },
      { category: 'Fixed', text: 'A bug fix.' },
    ];
    const release = assembleFragments(fragments);
    expect(release.version).toBe('Unreleased');
    expect(release.date).toBeNull();
    // Canonical order is Added, Changed, Deprecated, Removed, Fixed, Security
    // — NOT the [Security, Added, Fixed] input order above.
    expect(release.categories.map((c) => c.name)).toEqual(['Added', 'Fixed', 'Security']);
  });

  it('keeps multiple entries in the same category in input (file) order', () => {
    const fragments: RawFragment[] = [
      { category: 'Fixed', text: 'First fix.' },
      { category: 'Fixed', text: 'Second fix.' },
    ];
    const release = assembleFragments(fragments);
    expect(release.categories).toEqual([{ name: 'Fixed', entries: ['First fix.', 'Second fix.'] }]);
  });
});

describe('withPendingFragments', () => {
  it('is a no-op (same array reference) when there are no pending fragments', () => {
    const releases: ChangelogRelease[] = [{ version: 'Unreleased', date: null, categories: [] }];
    const pending: ChangelogRelease = { version: 'Unreleased', date: null, categories: [] };
    expect(withPendingFragments(releases, pending)).toBe(releases);
  });

  it('replaces an empty [Unreleased] section with the pending categories', () => {
    const releases: ChangelogRelease[] = [
      { version: 'Unreleased', date: null, categories: [] },
      {
        version: '1.0.0',
        date: '2026-01-01',
        categories: [{ name: 'Added', entries: ['Initial release.'] }],
      },
    ];
    const pending: ChangelogRelease = {
      version: 'Unreleased',
      date: null,
      categories: [{ name: 'Fixed', entries: ['A pending fix (#200).'] }],
    };
    const result = withPendingFragments(releases, pending);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      version: 'Unreleased',
      date: null,
      categories: [{ name: 'Fixed', entries: ['A pending fix (#200).'] }],
    });
    // The other release is untouched.
    expect(result[1]).toBe(releases[1]);
  });

  it('merges into a NON-empty [Unreleased] section, existing entries before pending ones', () => {
    const releases: ChangelogRelease[] = [
      {
        version: 'Unreleased',
        date: null,
        categories: [{ name: 'Fixed', entries: ['A manually-added fix.'] }],
      },
    ];
    const pending: ChangelogRelease = {
      version: 'Unreleased',
      date: null,
      categories: [{ name: 'Fixed', entries: ['A fragment fix.'] }],
    };
    const result = withPendingFragments(releases, pending);
    expect(result[0].categories).toEqual([
      { name: 'Fixed', entries: ['A manually-added fix.', 'A fragment fix.'] },
    ]);
  });

  it('prepends a synthetic Unreleased release when the list has none at all', () => {
    const releases: ChangelogRelease[] = [
      { version: '1.0.0', date: '2026-01-01', categories: [{ name: 'Added', entries: ['X.'] }] },
    ];
    const pending: ChangelogRelease = {
      version: 'Unreleased',
      date: null,
      categories: [{ name: 'Added', entries: ['Y.'] }],
    };
    const result = withPendingFragments(releases, pending);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(pending);
    expect(result[1]).toBe(releases[0]);
  });
});
