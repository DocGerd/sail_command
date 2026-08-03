// #189: parses and assembles CHANGELOG.md fragments under the repo-root
// `changelog.d/` directory — the conflict-free replacement for having every
// user-visible-behavior PR edit CHANGELOG.md's shared `[Unreleased]` section
// directly (see CLAUDE.md's "Changelog ritual" and changelog.d/README.md).
// Each PR that changes user-visible behavior drops ONE file named
// `<number>.<category>.md` here and never touches CHANGELOG.md itself; two
// PRs adding two different files can never conflict.
//
// `app/vite.config.ts`'s `changelogFragmentsPlugin` reads this directory
// Node-side via `fs` at build time (bypassing the `server.fs.allow` `?raw`
// trap documented in CLAUDE.md/#131 entirely — a plugin's own
// `fs.readFileSync` never goes through the dev-server transform middleware
// that allowlist gates) and exposes the parsed `{ category, text }` pairs
// through the `virtual:changelog-fragments` module. `AboutDialog.tsx` folds
// them into a synthetic 'Unreleased' preview so the About dialog's "What's
// new" view keeps showing pending work on UAT — this module never writes to
// CHANGELOG.md; that happens by hand at the release cut (release runbook
// §2b), which also deletes the fragment files.

import type { ChangelogCategory, ChangelogRelease } from './changelog.ts';

/** Keep a Changelog 1.1 category names, in the file's canonical order. */
const CATEGORY_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'] as const;

type Category = (typeof CATEGORY_ORDER)[number];

const CATEGORY_LABELS: Record<string, Category> = {
  added: 'Added',
  changed: 'Changed',
  deprecated: 'Deprecated',
  removed: 'Removed',
  fixed: 'Fixed',
  security: 'Security',
};

// `<number>.<category>.md`, optionally `<number>-<n>.<category>.md` to
// disambiguate a second fragment about the same issue/PR.
const FRAGMENT_FILENAME_RE = /^(\d+)(?:-\d+)?\.([a-z]+)\.md$/;

/** One fragment file's parsed IDENTITY (filename only) — never carries entry text. */
export interface ParsedFragmentFilename {
  number: string;
  category: Category;
}

/**
 * Parses a `changelog.d/` filename, e.g. `165.fixed.md` or `165-2.fixed.md`.
 * Returns null for anything else — `README.md`, an unrecognized category, a
 * missing number — so the caller can skip it without failing the build (a
 * NUDGE, not a blocking guard: CLAUDE.md's guard-asymmetry rule — a
 * misnamed fragment should cost a missing preview line, never a red build).
 */
export function parseFragmentFilename(filename: string): ParsedFragmentFilename | null {
  const match = FRAGMENT_FILENAME_RE.exec(filename);
  if (match === null) return null;
  const category = CATEGORY_LABELS[match[2]];
  if (category === undefined) return null;
  return { number: match[1], category };
}

/**
 * Collapses a fragment file's raw content into the single-line entry text
 * ChangelogView renders as one list item: blank lines are dropped, the
 * remaining lines are trimmed and joined with a single space (so a
 * fragment's source can wrap for readability without wrapping in the UI —
 * the same join CHANGELOG.md's own parser (`changelog.ts`) applies to a
 * wrapped bullet continuation), and a leading '- ' is stripped if a
 * contributor copied the CHANGELOG.md bullet convention by habit (a
 * fragment's content IS the entry text; the dash is presentation added by
 * the renderer/the release-cut fold, never stored here).
 */
export function normalizeFragmentText(raw: string): string {
  const joined = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
  return joined.startsWith('- ') ? joined.slice(2).trim() : joined;
}

/** One parsed fragment, ready to assemble — category already resolved to its label. */
export interface RawFragment {
  category: Category;
  text: string;
}

/**
 * The whole of `vite.config.ts`'s `readFragments()` behavior, with the
 * actual `fs` calls factored out so it's unit-testable without a real
 * `changelog.d/` directory: given a raw filename listing and a way to read
 * each file's content, returns the fragments ready for `assembleFragments`.
 * `README.md`, a misnamed file, and a whitespace-only file are all skipped
 * (via `warn`, never a thrown error — a NUDGE, not a blocking guard, per
 * CLAUDE.md's guard-asymmetry rule: a bad fragment should cost a missing
 * preview line, never a red build). Filenames are sorted first for a
 * deterministic entry order independent of the OS's directory listing order.
 */
export function buildFragments(
  filenames: string[],
  readFile: (filename: string) => string,
  warn: (message: string) => void = () => {},
): RawFragment[] {
  const fragments: RawFragment[] = [];
  for (const filename of [...filenames].sort()) {
    if (filename === 'README.md') continue;
    const parsed = parseFragmentFilename(filename);
    if (parsed === null) {
      warn(
        `[changelog.d] skipping "${filename}": expected "<number>.<category>.md" ` +
          '(added|changed|deprecated|removed|fixed|security)',
      );
      continue;
    }
    const text = normalizeFragmentText(readFile(filename));
    if (text === '') {
      warn(`[changelog.d] skipping "${filename}": file is empty`);
      continue;
    }
    fragments.push({ category: parsed.category, text });
  }
  return fragments;
}

/**
 * Groups fragments by category, in Keep a Changelog's canonical order
 * (CATEGORY_ORDER above), not file/discovery order, into a synthetic
 * 'Unreleased' release. Entries within a category keep the input order.
 * An empty input yields an empty-categories release, which ChangelogView
 * already renders as nothing (its existing empty-section filter, #131) —
 * so a repo with no pending fragments shows no change at all.
 */
export function assembleFragments(fragments: RawFragment[]): ChangelogRelease {
  const byCategory = new Map<Category, string[]>();
  for (const f of fragments) {
    const entries = byCategory.get(f.category) ?? [];
    entries.push(f.text);
    byCategory.set(f.category, entries);
  }
  const categories: ChangelogCategory[] = CATEGORY_ORDER.filter((name) => byCategory.has(name)).map(
    (name) => ({ name, entries: byCategory.get(name) as string[] }),
  );
  return { version: 'Unreleased', date: null, categories };
}

// Rank used to sort a merged category list back into Keep a Changelog's
// canonical order (see `assembleFragments`'s CATEGORY_ORDER.filter above,
// which this mirrors). A category name outside the canonical six — only
// reachable via `existing`, which comes from the free-form CHANGELOG.md
// parser and could carry anything a human typed under a `### Heading` —
// sorts AFTER all six canonical ones, in first-seen order among themselves
// (Array.prototype.sort is stable, so ties keep their Map insertion order).
function categoryRank(name: string): number {
  const index = CATEGORY_ORDER.indexOf(name as Category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

/**
 * Folds a pending-fragments 'Unreleased' preview into a parsed CHANGELOG.md
 * release list. Merges into the real `## [Unreleased]` section if one is
 * present (defensive: nothing should hand-edit it anymore under the
 * fragment ritual, but a stray manual entry must not be silently dropped),
 * or prepends a synthetic one if the section is somehow absent. A pure
 * no-op — returns the SAME array reference — when there are no pending
 * fragments, so a fragment-free build never re-renders anything differently.
 * The merged category list is re-sorted into CATEGORY_ORDER (never left in
 * Map insertion order) so a manually-added CHANGELOG.md category doesn't
 * silently shuffle the canonical ordering `assembleFragments` guarantees.
 */
export function withPendingFragments(
  releases: ChangelogRelease[],
  pending: ChangelogRelease,
): ChangelogRelease[] {
  if (pending.categories.length === 0) return releases;
  const index = releases.findIndex((r) => r.version === 'Unreleased');
  if (index === -1) return [pending, ...releases];
  const existing = releases[index];
  const byName = new Map<string, string[]>();
  for (const c of [...existing.categories, ...pending.categories]) {
    const entries = byName.get(c.name) ?? [];
    entries.push(...c.entries);
    byName.set(c.name, entries);
  }
  const mergedCategories: ChangelogCategory[] = [...byName.entries()]
    .map(([name, entries]) => ({ name, entries }))
    .sort((a, b) => categoryRank(a.name) - categoryRank(b.name));
  const merged: ChangelogRelease = { ...existing, categories: mergedCategories };
  return [...releases.slice(0, index), merged, ...releases.slice(index + 1)];
}
