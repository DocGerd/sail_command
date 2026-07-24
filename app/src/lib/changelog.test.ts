import { describe, it, expect } from 'vitest';
import realChangelog from '../../../CHANGELOG.md?raw';
import { parseChangelog } from './changelog';

// Hand-written fixture — every expectation below is pinned as a literal
// derived by reading THIS string, never from parser output (mutation-check
// discipline: a tautological expectation would survive any parser bug).
const FIXTURE = `# Changelog

All notable changes, preamble prose with [an inline link](https://example.com).

### Not a category — before the first release heading, must be ignored

## [Unreleased]

### Added

- New unreleased thing (#1).

## [1.2.0] - 2026-07-20

### Added

- First added entry (#2, #3).
- Second added entry
  wrapped onto a continuation line.

### Fixed

- A fix entry (#4).

## [1.0.0] - 2026-07-01

### Added

- Initial release.

[Unreleased]: https://example.com/compare/v1.2.0...HEAD
[1.2.0]: https://example.com/compare/v1.0.0...v1.2.0
[1.0.0]: https://example.com/releases/tag/v1.0.0
`;

describe('parseChangelog', () => {
  it('splits the fixture into three releases, newest first, with pinned versions and dates', () => {
    const releases = parseChangelog(FIXTURE);
    expect(releases).toHaveLength(3);
    expect(releases.map((r) => r.version)).toEqual(['Unreleased', '1.2.0', '1.0.0']);
    expect(releases.map((r) => r.date)).toEqual([null, '2026-07-20', '2026-07-01']);
  });

  it('parses categories and entries with pinned literal texts', () => {
    const releases = parseChangelog(FIXTURE);
    const v120 = releases[1];
    expect(v120.categories.map((c) => c.name)).toEqual(['Added', 'Fixed']);
    expect(v120.categories[0].entries).toEqual([
      'First added entry (#2, #3).',
      'Second added entry wrapped onto a continuation line.',
    ]);
    expect(v120.categories[1].entries).toEqual(['A fix entry (#4).']);
  });

  it('ignores the H1, preamble prose, and even a category heading before the first release', () => {
    const releases = parseChangelog(FIXTURE);
    // The bogus pre-release '### Not a category' heading must not leak into
    // the first parsed release.
    expect(releases[0].categories.map((c) => c.name)).toEqual(['Added']);
    expect(releases[0].categories[0].entries).toEqual(['New unreleased thing (#1).']);
  });

  it('drops the trailing link-reference block instead of appending it to the last entry', () => {
    const releases = parseChangelog(FIXTURE);
    const last = releases[2];
    expect(last.categories).toHaveLength(1);
    // Pinned literal: if link refs were mis-treated as continuations, this
    // entry would have URLs glued onto it.
    expect(last.categories[0].entries).toEqual(['Initial release.']);
  });

  it('returns [] for an empty string and for a preamble-only document', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('# Changelog\n\nJust prose, no releases.\n')).toEqual([]);
  });

  it('keeps a release with no categories as an empty section (view filters it, parser does not)', () => {
    const releases = parseChangelog(
      '## [Unreleased]\n\n## [1.0.0] - 2026-01-02\n\n### Added\n\n- X.\n',
    );
    expect(releases).toHaveLength(2);
    expect(releases[0]).toEqual({ version: 'Unreleased', date: null, categories: [] });
  });

  it('drops a stray dash entry that appears before any category heading', () => {
    const releases = parseChangelog(
      '## [1.0.0] - 2026-01-02\n\n- orphan entry\n\n### Added\n\n- Real entry.\n',
    );
    expect(releases[0].categories).toEqual([{ name: 'Added', entries: ['Real entry.'] }]);
  });

  it('parses the real committed CHANGELOG.md: pinned oldest release and full version order', () => {
    const releases = parseChangelog(realChangelog);
    // Historical facts, immutable: the version list may GROW at the front
    // (new releases / Unreleased entries), but the released tail is fixed.
    const versions = releases.map((r) => r.version);
    expect(versions.slice(-5)).toEqual(['0.3.0', '0.2.0', '0.1.2', '0.1.1', '0.1.0']);
    const oldest = releases[releases.length - 1];
    expect(oldest.date).toBe('2026-07-16');
    expect(oldest.categories.map((c) => c.name)).toEqual(['Added']);
    expect(oldest.categories[0].entries).toHaveLength(9);
    // No release section may parse to zero entries except Unreleased.
    for (const release of releases) {
      if (release.version === 'Unreleased') continue;
      const total = release.categories.reduce((n, c) => n + c.entries.length, 0);
      expect(total).toBeGreaterThan(0);
    }
  });
});
