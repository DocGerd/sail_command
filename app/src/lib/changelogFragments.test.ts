import { describe, it, expect, vi } from 'vitest';
import type { ChangelogRelease } from './changelog';
import {
  assembleFragments,
  buildFragments,
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

  it('re-sorts a cross-category merge into canonical order, not Map insertion order (review finding)', () => {
    // Reviewer's exact reproduction: existing carries 'Fixed', pending
    // carries 'Added'. Insertion order would yield ["Fixed","Added"];
    // Keep a Changelog's canonical order is ["Added","Fixed"].
    const releases: ChangelogRelease[] = [
      {
        version: 'Unreleased',
        date: null,
        categories: [{ name: 'Fixed', entries: ['manual fix'] }],
      },
    ];
    const pending = assembleFragments([{ category: 'Added', text: 'frag add' }]);
    const result = withPendingFragments(releases, pending);
    expect(result[0].categories.map((c) => c.name)).toEqual(['Added', 'Fixed']);
    expect(result[0].categories).toEqual([
      { name: 'Added', entries: ['frag add'] },
      { name: 'Fixed', entries: ['manual fix'] },
    ]);
  });

  it('sorts an unrecognized existing category name (free-form CHANGELOG.md text) AFTER the six canonical ones', () => {
    const releases: ChangelogRelease[] = [
      {
        version: 'Unreleased',
        date: null,
        categories: [{ name: 'Housekeeping', entries: ['manual note'] }],
      },
    ];
    const pending = assembleFragments([{ category: 'Fixed', text: 'frag fix' }]);
    const result = withPendingFragments(releases, pending);
    expect(result[0].categories.map((c) => c.name)).toEqual(['Fixed', 'Housekeeping']);
  });
});

describe('buildFragments', () => {
  function readerFor(files: Record<string, string>): (filename: string) => string {
    return (filename) => {
      const content = files[filename];
      if (content === undefined) throw new Error(`unexpected read: ${filename}`);
      return content;
    };
  }

  it('skips README.md (the directory keeper) without a warning', () => {
    const warn = vi.fn();
    const result = buildFragments(['README.md'], readerFor({ 'README.md': 'ignored' }), warn);
    expect(result).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns [] for an empty filename list', () => {
    expect(buildFragments([], readerFor({}))).toEqual([]);
  });

  it('reads and normalizes well-formed fragments', () => {
    const files = {
      '1.added.md': 'A new thing (#1).\n',
      '2.fixed.md': 'A bug fix\nwrapped onto a second line (#2).\n',
    };
    const result = buildFragments(Object.keys(files), readerFor(files));
    expect(result).toEqual([
      { category: 'Added', text: 'A new thing (#1).' },
      { category: 'Fixed', text: 'A bug fix wrapped onto a second line (#2).' },
    ]);
  });

  it('sorts by filename, independent of input order', () => {
    const files = { '2.fixed.md': 'Second.', '1.added.md': 'First.' };
    const result = buildFragments(['2.fixed.md', '1.added.md'], readerFor(files));
    expect(result.map((f) => f.text)).toEqual(['First.', 'Second.']);
  });

  it('warns and skips a malformed filename, without throwing', () => {
    const warn = vi.fn();
    const files = { 'notafragment.md': 'ignored', '1.added.md': 'kept' };
    const result = buildFragments(Object.keys(files), readerFor(files), warn);
    expect(result).toEqual([{ category: 'Added', text: 'kept' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('notafragment.md');
  });

  it('warns and skips a whitespace-only fragment file, so it never ships as a blank list item', () => {
    const warn = vi.fn();
    const files = { '101.changed.md': '   \n\n  ', '1.added.md': 'kept' };
    const result = buildFragments(Object.keys(files), readerFor(files), warn);
    expect(result).toEqual([{ category: 'Added', text: 'kept' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('101.changed.md');
    expect(warn.mock.calls[0][0]).toContain('empty');
  });

  it('defaults to a no-op warn callback when none is passed (does not throw)', () => {
    const files = { 'notafragment.md': 'ignored' };
    expect(() => buildFragments(Object.keys(files), readerFor(files))).not.toThrow();
  });
});
