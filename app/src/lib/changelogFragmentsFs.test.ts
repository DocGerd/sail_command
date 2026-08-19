// #189 review (round 2, security pass): unit coverage for the real-fs half
// of the changelog fragment reader — specifically the two failure modes a
// pure DI-based test (changelogFragments.test.ts's `buildFragments` suite)
// structurally cannot see, because `buildFragments` takes a plain filename
// list with no concept of an entry's TYPE: a symlink (must never have its
// target content inlined into the shipped bundle) and a directory entry
// (must never crash `readFileSync` with EISDIR). Both are constructed
// against a REAL temp directory — not mocked — so the coverage exercises the
// actual `readdirSync(..., { withFileTypes: true })` + `entry.isFile()`
// logic, not a stand-in for it.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFragmentsFromDir } from './changelogFragmentsFs';

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function makeTempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'changelog-fragments-fs-test-'));
  return dir;
}

describe('readFragmentsFromDir', () => {
  it('returns [] for a missing directory, without throwing', () => {
    // A freshly mkdtemp'd directory has no attacker-controlled contents
    // (js/insecure-temporary-file, alert #16): a subpath inside it is
    // guaranteed absent without needing a predictable, fixed-name path.
    const base = makeTempDir();
    const missing = join(base, 'does-not-exist');
    expect(readFragmentsFromDir(missing)).toEqual([]);
  });

  it('reads well-formed fragments and skips README.md, matching buildFragments', () => {
    const d = makeTempDir();
    writeFileSync(join(d, 'README.md'), 'not a fragment');
    writeFileSync(join(d, '1.added.md'), 'A new thing (#1).\n');
    writeFileSync(join(d, '2.fixed.md'), 'A bug fix (#2).\n');

    const result = readFragmentsFromDir(d);
    expect(result).toEqual([
      { category: 'Added', text: 'A new thing (#1).' },
      { category: 'Fixed', text: 'A bug fix (#2).' },
    ]);
  });

  it('rejects a directory entry shaped like a fragment name — no EISDIR crash, and its content never leaks', () => {
    const d = makeTempDir();
    // A plausible contributor mistake: `mkdir` instead of creating a file.
    mkdirSync(join(d, '300.fixed.md'));
    writeFileSync(join(d, join('300.fixed.md', 'inner.txt')), 'should never be read');
    writeFileSync(join(d, '1.added.md'), 'kept');

    const warn = vi.fn();
    const result = readFragmentsFromDir(d, warn);
    expect(result).toEqual([{ category: 'Added', text: 'kept' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('300.fixed.md');
    expect(warn.mock.calls[0][0]).toContain('not a regular file');
  });

  it('rejects a symlink shaped like a fragment name — the TARGET content never ends up in the fragment list', () => {
    const d = makeTempDir();
    // The canary lives in its OWN mkdtemp'd directory, deliberately OUTSIDE
    // `d` — that separation is the point of the test (the symlink target
    // must be unreachable via `d` alone). A fixed shared-/tmp path here was
    // js/insecure-temporary-file (alert #16): a pre-planted symlink at a
    // predictable name could redirect this write and the write-target's
    // rmSync in `finally` would then delete the wrong thing. The directory
    // name doesn't need to be predictable, only the "outside `d`" property.
    const canaryDir = mkdtempSync(join(tmpdir(), 'changelog-fragments-fs-canary-'));
    const canary = join(canaryDir, 'canary.txt');
    writeFileSync(canary, 'SECRET CANARY CONTENT — must never appear in a fragment');
    symlinkSync(canary, join(d, '400.fixed.md'));
    writeFileSync(join(d, '1.added.md'), 'kept');

    try {
      const warn = vi.fn();
      const result = readFragmentsFromDir(d, warn);
      expect(result).toEqual([{ category: 'Added', text: 'kept' }]);
      expect(result.some((f) => f.text.includes('SECRET CANARY CONTENT'))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('400.fixed.md');
      expect(warn.mock.calls[0][0]).toContain('not a regular file');
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
    }
  });

  it('rejects a dangling symlink shaped like a fragment name via entry.isFile(), never reaching the readFileSync try/catch', () => {
    const d = makeTempDir();
    symlinkSync(
      join(tmpdir(), 'changelog-fragments-fs-nonexistent-target.txt'),
      join(d, '401.fixed.md'),
    );
    writeFileSync(join(d, '1.added.md'), 'kept');

    const warn = vi.fn();
    const result = readFragmentsFromDir(d, warn);
    expect(result).toEqual([{ category: 'Added', text: 'kept' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('401.fixed.md');
    // The discriminating assertion (review round 3, New-1): without this,
    // the test also passes when entry.isFile() is REMOVED, because a
    // dangling symlink then falls through to readFileSync, which throws
    // ENOENT into the OTHER catch block — same call count, same filename
    // substring, different message. Asserting the exact "not a regular
    // file" text is what proves THIS entry never reached that second catch,
    // matching the comment's claim instead of merely asserting near it.
    expect(warn.mock.calls[0][0]).toContain('not a regular file');
  });

  it('warns and skips a regular file that passes isFile() but fails to read (permissions), instead of crashing the build', () => {
    const d = makeTempDir();
    const target = join(d, '500.fixed.md');
    writeFileSync(target, 'unreadable');
    chmodSync(target, 0o000);
    writeFileSync(join(d, '1.added.md'), 'kept');

    try {
      const warn = vi.fn();
      const result = readFragmentsFromDir(d, warn);
      expect(result).toEqual([{ category: 'Added', text: 'kept' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('500.fixed.md');
    } finally {
      // Restore permissions so afterEach's rmSync can delete the temp dir.
      chmodSync(target, 0o644);
    }
  });

  it('does not warn about a README.md that is not a regular file (the entry.name guard at the isFile() branch)', () => {
    // Deliberately NOT a regular-file README.md — that shape is already
    // covered above ("reads well-formed fragments and skips README.md"),
    // where the skip happens one layer down, silently, inside
    // buildFragments' `if (filename === 'README.md') continue`. THIS test's
    // job is the `entry.name !== 'README.md'` check immediately below the
    // isFile() rejection: a README.md that is itself a directory or a
    // symlink still hits that rejection, and the check exists so it does so
    // WITHOUT a warning. Review round 3 (New-1): the previous version of
    // this test wrote a regular file, so it passed via buildFragments'
    // unrelated skip and kept passing even with this guard replaced by
    // `if (true)` — mutation-checked below to confirm this version doesn't.
    const d = makeTempDir();
    mkdirSync(join(d, 'README.md'));
    const warn = vi.fn();
    expect(readFragmentsFromDir(d, warn)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('defaults to a no-op warn callback when none is passed', () => {
    const d = makeTempDir();
    mkdirSync(join(d, '300.fixed.md'));
    expect(() => readFragmentsFromDir(d)).not.toThrow();
  });
});
