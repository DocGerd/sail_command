// #131: parser for the constrained Keep-a-Changelog-1.1 subset used by the
// repo-root CHANGELOG.md, which the About dialog bakes in at build time via a
// Vite `?raw` import. Deliberately NOT a markdown library: the file is
// repo-authored, its shape is fixed (release headings → category headings →
// dash entries), and a full markdown dependency would be bundle weight for
// nothing. Output is plain data (structured-clone-safe).
//
// Recognized, in order of precedence per line:
//   `## [version] - YYYY-MM-DD` / `## [Unreleased]`  → new release section
//   `[label]: url` (after the first release heading)  → link-reference, dropped
//   `### Name`                                        → new category
//   `- text`                                          → new entry (needs category)
//
// Everything before the first release heading (the H1 + preamble) and blank
// lines are ignored. Any OTHER non-blank line is treated as the wrapped
// continuation of the closest open entry (joined with a single space) so a
// reformatted/wrapped entry is never silently truncated; a stray line with no
// open entry to attach to (outside the subset entirely) is the only text
// dropped, which the tests pin.

export interface ChangelogCategory {
  /** Category heading as written (e.g. 'Added', 'Fixed') — English by design. */
  name: string;
  /** Entry texts as written, without the leading '- '; issue/PR refs stay plain text. */
  entries: string[];
}

export interface ChangelogRelease {
  /** Version string from inside the brackets — '0.3.0' or 'Unreleased'. */
  version: string;
  /** ISO release date from the heading; null for the Unreleased section. */
  date: string | null;
  categories: ChangelogCategory[];
}

const RELEASE_RE = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const CATEGORY_RE = /^### (.+?)\s*$/;
const ENTRY_RE = /^- (.*)$/;
const LINK_REF_RE = /^\[[^\]]+\]:\s*\S/;

export function parseChangelog(md: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let category: ChangelogCategory | null = null;

  for (const rawLine of md.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trimEnd();

    const releaseMatch = RELEASE_RE.exec(line);
    if (releaseMatch) {
      release = {
        version: releaseMatch[1],
        // Optional capture group: RegExpExecArray types it string, but a
        // dateless heading ([Unreleased]) yields undefined at runtime.
        date: (releaseMatch[2] as string | undefined) ?? null,
        categories: [],
      };
      releases.push(release);
      category = null;
      continue;
    }
    if (release === null) continue; // H1 + preamble before the first release
    if (line === '') continue;
    if (LINK_REF_RE.test(line)) continue; // trailing link-reference block

    const categoryMatch = CATEGORY_RE.exec(line);
    if (categoryMatch) {
      category = { name: categoryMatch[1], entries: [] };
      release.categories.push(category);
      continue;
    }

    const entryMatch = ENTRY_RE.exec(line);
    if (entryMatch && category !== null) {
      category.entries.push(entryMatch[1]);
      continue;
    }

    // Wrapped continuation of the previous entry (or stray prose) — append
    // rather than drop, so re-wrapped source lines survive intact.
    if (category !== null && category.entries.length > 0) {
      const last = category.entries.length - 1;
      category.entries[last] = `${category.entries[last]} ${line.trim()}`;
    }
  }

  return releases;
}
