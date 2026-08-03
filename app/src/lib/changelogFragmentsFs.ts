// #189 review (round 2, security pass): the real `fs`-touching half of the
// changelog fragment reader — deliberately split out of `changelogFragments.ts`
// so that file can stay import-free of `node:fs` (it is imported by
// `AboutDialog.tsx`, which ships to the BROWSER; a static `node:fs` import
// there would break the client bundle). This file is Node-only and must
// NEVER be imported by browser-side app code — only `vite.config.ts` (a
// build-tool module, evaluated by Node, never bundled into the client)
// imports it. Vitest runs in Node too, so it's directly unit-testable here,
// including with REAL temporary directories/symlinks — the two failure
// modes below (a non-file directory entry, an unreadable file) can only be
// exercised against a real filesystem; `changelogFragments.ts`'s
// `buildFragments` takes a plain filename list and can't see an entry's
// TYPE at all.
//
// Two defects this closes (found by security review, not by the original
// implementation):
// - A `changelog.d/` entry that ISN'T a regular file — a symlink or a
//   directory — used to be read anyway. A symlink pointing outside the repo
//   (`/etc/hostname`, `~/.ssh/id_ed25519`, `/proc/self/environ`) got its
//   TARGET's content inlined straight into the shipped bundle; a directory
//   crashed the build with `EISDIR`. `readdirSync(dir, { withFileTypes:
//   true })` reports each entry's OWN type (not the symlink target's), so
//   `entry.isFile()` rejects both before any read happens.
// - `readFileSync` was unguarded, so ANY read failure (a file deleted
//   between `readdir` and `read`, a permissions error) hard-failed the
//   build — contradicting this module's own guard-asymmetry contract (a bad
//   fragment costs a missing preview line, never a red build). Wrapped in a
//   try/catch that warns and skips instead.

import { readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { resolve } from 'node:path';
import { buildFragments, type RawFragment } from './changelogFragments.ts';

export type FragmentWarning = (message: string) => void;

/**
 * Scans `dir` for `changelog.d/`-shaped fragments and returns them ready
 * for `assembleFragments`. Never throws: a missing directory, a non-file
 * entry (symlink/directory), or an unreadable file all degrade to "skip
 * this one, warn about it, keep going" — matching `buildFragments`'
 * `parseFragmentFilename`/empty-content skips, which this delegates to for
 * everything past the raw directory scan.
 */
export function readFragmentsFromDir(dir: string, warn: FragmentWarning = () => {}): RawFragment[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory missing entirely (e.g. a stray `rm -rf`) — no fragments,
    // not a build error; README.md is the normal keeper that keeps this
    // directory present.
    return [];
  }

  const contents = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) {
      // Rejects a symlink (reach amplifier — could inline an arbitrary
      // file's content into the shipped bundle) AND a directory (crashes
      // `readFileSync` with EISDIR) before either ever reaches `readFileSync`.
      if (entry.name !== 'README.md') {
        warn(`[changelog.d] skipping "${entry.name}": not a regular file (symlink or directory)`);
      }
      continue;
    }
    try {
      contents.set(entry.name, readFileSync(resolve(dir, entry.name), 'utf8'));
    } catch (err) {
      // A dangling symlink already failed `isFile()` above and never
      // reaches here; this covers residual read failures (permissions, a
      // file removed between `readdir` and `read`) so a bad fragment still
      // costs only a missing preview line, never a red build.
      const message = err instanceof Error ? err.message : String(err);
      warn(`[changelog.d] skipping "${entry.name}": ${message}`);
    }
  }

  return buildFragments([...contents.keys()], (filename) => contents.get(filename) as string, warn);
}
