#!/usr/bin/env node
/**
 * closure.mjs — #729: mechanically derives whether a diff owes an
 * `app/sweep/` #282 acceptance sweep.
 *
 * Replaces the hand-maintained prose path list in the root CLAUDE.md, whose
 * own text says it is unsafe ("never a remembered path list"). The list form
 * of the rule was already wrong twice: too NARROW (a `DEFAULT_SETTINGS` field
 * edit in `app/src/types.ts` moves every arm without touching any of the
 * "obvious" paths) and too WIDE (an edit confined to `draftProvenance` in
 * `app/src/data/boats.ts` touches a listed file yet owes nothing, because
 * `BoatSnapshot` — and therefore the serialised `PlanResult` the sweep
 * compares byte-for-byte — never carries that field at all).
 *
 * ## Method
 *
 * 1. Walk the import graph from the sweep's two real CODE roots
 *    (`app/sweep/sweepArms.ts`, `app/sweep/vitest.config.ts`) transitively,
 *    following every relative `import`/`export ... from`/dynamic `import()`
 *    specifier. External packages (bare specifiers: 'vitest', 'node:fs', …)
 *    are not walked further — they are not part of the app SOURCE closure.
 *    This produces the closure as DERIVED DATA, not a maintained list.
 *
 * 2. UNION that walk with three declared PATH PREFIXES (`PATH_PREFIXES`
 *    below) for inputs that are structurally NOT `import` statements at
 *    all. A Blocker review (#729) measured that the import walk ALONE is a
 *    strictly NARROWER, UNSAFE replacement for the prose list it exists to
 *    retire: it cannot see (a) vitest's real entry points — the nine
 *    `app/sweep/arm-*.test.ts` files, reached only via `vitest.config.ts`'s
 *    `include: ['**\/*.test.ts']`, an edge INTO `sweepArms.ts` that a walk
 *    FROM it can never traverse — or (b) any of `sweepArms.ts`'s runtime
 *    `readFileSync` reads of shipped data (`mask.bin`, `mask.meta.json`,
 *    `harbors.json`, `polars/*.json`) or that data's pipeline generators.
 *    Several of those paths are built from a variable at runtime (e.g.
 *    `resolve(dataDir, '..', sail.polarAsset)`), so they cannot be
 *    re-derived by a static scan in general — the three prefixes name the
 *    directories those reads structurally live under instead.
 *
 * 3. Intersect the UNION with the changed files in a diff
 *    (`git diff --merge-base --name-only <base> [<head>]`).
 *
 * 4. For each hit, default to **OWED** — this is a NUDGE-class tool, and per
 *    the repo's guard-asymmetry convention a nudge must fail OPEN (a false
 *    "owed" costs ~31 minutes of unnecessary solver time; a false "not owed"
 *    ships an unverified routing change). The only carve-out from that
 *    default is `app/src/data/boats.ts`'s `draftProvenance` field, because
 *    that specific exemption is STRUCTURALLY provable from the type system
 *    on disk today (see `classifyBoatsTs` below) rather than merely assumed.
 *
 * ## Failure direction — stated explicitly, per the issue's own request
 *
 * This tool is designed to OVER-REPORT, never under-report: every closure
 * hit is OWED by default, with exactly ONE modelled exception
 * (`app/src/data/boats.ts`'s `draftProvenance`/`DraftProvenance` blocks —
 * see `classifyBoatsTs`'s own doc comment for why that specific carve-out
 * is sound). It does NOT attempt full data-flow/taint analysis of every
 * field reachable from the closure — e.g. it does NOT model whether
 * `polarProvenance.note` (also present in `boats.ts`, also copied into
 * `BoatSnapshot`) can move a `PlanResult`; CLAUDE.md's own
 * "polarProvenance and draftProvenance have DIFFERENT blast radii" bullet
 * warns explicitly against assuming one field's exemption transfers to the
 * other, so a `polarProvenance`-only edit is deliberately left at the
 * default OWED verdict rather than silently generalising the exception
 * (see `selftest`'s "narrow-scope-check" case).
 *
 * A PRIOR REVISION of this file made the stronger claim "never
 * under-reports" unconditionally — FALSIFIED in review (#729): the import
 * walk alone missed the nine `arm-*.test.ts` files and every runtime
 * data/pipeline input (Method step 2), so a diff confined to those reported
 * NOT OWED, exit 0. `PATH_PREFIXES` closes that MEASURED gap, but is itself
 * hand-maintained data (see its own header comment) rather than something
 * re-derived — so the honest claim is "over-reports against the modelled
 * universe below", not an unconditional guarantee. Extending EITHER
 * `PATH_PREFIXES` or the `draftProvenance` exception needs the same
 * structural proof `classifyBoatsTs` gives, never a guess by analogy.
 *
 * ## Usage
 *
 *   node closure.mjs closure                 # print the whole derived closure
 *   node closure.mjs files <path> [<path>…]  # is <path> in the closure at all?
 *   node closure.mjs diff <base> [<head>]    # real usage: does this diff owe a sweep?
 *   node closure.mjs selftest                # positive/negative controls, see #729
 *
 * `<base>`/`<head>` are anything `git diff --merge-base --no-renames`
 * accepts (a ref, a SHA, …). `<head>` omitted means "working tree",
 * matching plain `git diff --merge-base --no-renames <base>`. Both flags
 * are used throughout, each fixing a separate #729 Minor:
 *
 *   - `--merge-base`: a bare `git diff <base> <head>` is a direct TREE
 *     comparison that widens as `<base>` moves, so passing a moving branch
 *     name (`diff origin/develop`, the first usage line above) would
 *     otherwise pull in every file `develop` changed since this branch's
 *     own fork point. `--merge-base` diffs against the ancestor the two
 *     refs actually share, independent of how far `<base>` has since moved.
 *     `gitShow`'s "old content" read for the `boats.ts` exception resolves
 *     that SAME merge-base commit explicitly (`git merge-base`), so the
 *     hunks classified and the content read are always relative to one
 *     consistent ancestor.
 *   - `--no-renames`: git's DEFAULT rename detection makes `--name-only`
 *     print only the DESTINATION of a detected rename, silently dropping
 *     the source path — `git mv app/sweep/canonicalize.mjs
 *     tools-canonicalize.mjs` would otherwise report NOT OWED, an
 *     under-report inside this tool's own modelled universe. `--no-renames`
 *     makes such a rename appear as an add + a delete, so the in-closure
 *     source path is never lost.
 *
 * No dependency beyond Node's standard library — this must stay runnable
 * from a bare checkout with no `npm install`.
 */

import { existsSync, readFileSync, statSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Repo root
// ---------------------------------------------------------------------------

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------------------
// The two real roots, plus the edges a static import scan structurally
// cannot see because they are built at RUNTIME rather than written as a
// literal `import` statement.
// ---------------------------------------------------------------------------

const ROOTS = ['app/sweep/sweepArms.ts', 'app/sweep/vitest.config.ts'];

/** repo-relative-file -> array of repo-relative files it reaches, with WHY. */
const EXTRA_EDGES = {
  'app/sweep/vitest.config.ts': [
    {
      // `setupFiles: [resolve(here, '../src/test/setup.ts')]` — a path
      // built from `node:path`'s `resolve()` at runtime, never a literal
      // `import`/`from` string. Named explicitly in issue #729.
      target: 'app/src/test/setup.ts',
      note: 'EXTRA_EDGE: setupFiles path built via path.resolve() at runtime, not a static import',
    },
  ],
};

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx', '.json'];

// ---------------------------------------------------------------------------
// PATH PREFIXES — inputs the import walk structurally cannot see, because
// they are not `import` statements: vitest's own collection glob, and every
// runtime `readFileSync` in `sweepArms.ts` (several built from a variable,
// so no static scan can enumerate them — see the file header's Method
// step 2). Added in response to a Blocker review (#729) that measured the
// import-walk-only version reporting NOT OWED for a diff editing
// `arm-marginzero.test.ts` + `canonicalize.mjs`, and for every one of
// `mask.bin`/`mask.meta.json`/`harbors.json`/`polars/*.json`/
// `pipeline/build_mask.py`.
//
// This is HAND-MAINTAINED DATA — the one piece of knowledge in this tool
// that is declared rather than derived, same as `EXTRA_EDGES` above. Each
// entry is pinned individually in `selftest` (see the
// "path-prefix pin" checks) with a HARDCODED expected path, never derived
// from this array — CLAUDE.md's "a guard's DATA needs a twin, not just its
// detection logic" rule (the `SOLVER_LABELS` shape): deriving needle and
// haystack from the same array would let this array be emptied to `[]`
// while the guard kept reporting success.
//
// Deliberately WHOLE-DIRECTORY, not a narrower list of individual files —
// the safe direction per this tool's fail-open design: a future arm file,
// data asset or pipeline generator is covered automatically, at the cost of
// also reporting OWED for files under these directories with no real
// bearing on `PlanResult` (e.g. `app/sweep/README.md`,
// `app/public/data/basemap.pmtiles.png`, `pipeline/extract_basemap.sh`).
// Never narrow these to "just the files sweepArms.ts happens to read
// today" — that would re-create exactly the too-narrow-list defect this
// tool exists to replace, one level down.
const PATH_PREFIXES = [
  {
    prefix: 'app/sweep',
    note:
      "the harness itself — vitest.config.ts's include: ['**/*.test.ts'] " +
      'makes every arm-*.test.ts file a REAL entry point (an edge INTO ' +
      'sweepArms.ts, invisible to a walk FROM it), and canonicalize.mjs / ' +
      "compare.mjs produce and compare the bytes a sweep run certifies",
  },
  {
    prefix: 'app/public/data',
    note:
      'sweepArms.ts reads this directory at runtime via readFileSync ' +
      '(mask.meta.json ~:336, mask.bin ~:337, polars/*.json ~:348, ' +
      'harbors.json ~:370) — structurally invisible to a static import scan',
  },
  {
    prefix: 'pipeline',
    note:
      'produces every file app/public/data ships (mask.bin via ' +
      'build_mask.py, polars via build_polars.mjs/estimate_polars.mjs, ' +
      'harbors.json via build_harbors.mjs, …) — a pipeline change can move ' +
      'the sweep just as surely as editing the shipped data file directly',
  },
];

/** Returns the matching PATH_PREFIXES entry for `rel`, or undefined. */
function matchesPrefix(rel) {
  return PATH_PREFIXES.find((p) => rel === p.prefix || rel.startsWith(p.prefix + '/'));
}

// ---------------------------------------------------------------------------
// Static import extraction (regex-based — deliberately not a full TS
// parser; see the header for why that is the safe direction here).
// ---------------------------------------------------------------------------

// `import ... from '...'` / `export ... from '...'`, including multi-line
// `import type {\n  A,\n  B,\n} from '...'` blocks: `[^'"()]` matches
// newlines too (character classes do unless a literal \n is excluded), so
// the non-greedy run to the first `from` correctly spans the whole clause.
const FROM_RE = /(?:^|\n)[ \t]*(?:import|export)\b[^'"()]*?\bfrom\s*(['"])([^'"]+)\1/g;
// Bare side-effect imports: `import '...'` (no `from`).
const BARE_RE = /(?:^|\n)[ \t]*import\s*(['"])([^'"]+)\1/g;
// Dynamic `import('...')`, wherever it appears.
const DYNAMIC_RE = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

function extractSpecifiers(source) {
  const specs = new Set();
  for (const re of [FROM_RE, BARE_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) specs.add(m[2]);
  }
  return specs;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolves a relative specifier to an absolute file path, or null (external package / unresolved). */
function resolveSpecifier(fromFileAbs, specifier) {
  if (!specifier.startsWith('.')) return null; // bare specifier: external package, not app source
  const base = path.resolve(path.dirname(fromFileAbs), specifier);
  if (isFile(base)) return base;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (isFile(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexFile = path.join(base, 'index' + ext);
    if (isFile(indexFile)) return indexFile;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Closure walk (BFS — first discovery gives the shortest, most legible
// import chain for evidence output).
// ---------------------------------------------------------------------------

/**
 * Returns a Map<repoRelPath, { parent: repoRelPath|null, note: string, missing?: true }>
 * covering every file transitively reachable from ROOTS plus EXTRA_EDGES.
 */
function computeClosure(root) {
  const visited = new Map();
  const queue = ROOTS.map((rel) => ({ rel, parent: null, note: 'root' }));
  while (queue.length) {
    const { rel, parent, note } = queue.shift();
    if (visited.has(rel)) continue;
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      visited.set(rel, { parent, note, missing: true });
      continue;
    }
    visited.set(rel, { parent, note });
    const source = readFileSync(abs, 'utf8');
    for (const spec of extractSpecifiers(source)) {
      const resolvedAbs = resolveSpecifier(abs, spec);
      if (!resolvedAbs) continue; // external package — closure stops here
      const resolvedRel = path.relative(root, resolvedAbs);
      if (!visited.has(resolvedRel)) {
        queue.push({ rel: resolvedRel, parent: rel, note: `import '${spec}'` });
      }
    }
    for (const edge of EXTRA_EDGES[rel] ?? []) {
      if (!visited.has(edge.target)) {
        queue.push({ rel: edge.target, parent: rel, note: edge.note });
      }
    }
  }
  return visited;
}

function chainFor(visited, rel) {
  const chain = [];
  let cur = rel;
  while (cur) {
    const info = visited.get(cur);
    chain.unshift({ file: cur, via: info?.note });
    cur = info?.parent ?? null;
  }
  return chain;
}

/**
 * The single membership predicate every command uses: is `rel` in the
 * #282 sweep closure at all, and if so, by which mechanism (the import
 * walk, or a PATH_PREFIXES match)? Returns `null` when neither applies.
 */
function closureInfo(visited, rel) {
  const v = visited.get(rel);
  if (v && !v.missing) {
    return { kind: 'import', chain: chainFor(visited, rel) };
  }
  const p = matchesPrefix(rel);
  if (p) {
    return { kind: 'prefix', prefix: p.prefix, note: p.note };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The one modelled field-level exception: app/src/data/boats.ts's
// `draftProvenance` field / `DraftProvenance` type.
//
// WHY THIS IS SOUND (not a guess): `app/src/types.ts`'s `BoatSnapshot`
// interface — the ONLY shape a boat is denormalised into inside a stored
// `Plan` — lists `id`, `name`, `draftM` and a `sails` array whose entries
// carry `id`, `label`, `polarProvenance`. There is no `draftProvenance`
// field anywhere in it, and `boatSnapshot()` in the same file copies fields
// by name (never a spread), so a field `BoatSnapshot` doesn't declare is a
// field it structurally cannot carry. Going one step further:
// `PlanResultOk`/`PlanResultError` (also `types.ts`) carry no boat/request
// field AT ALL — the sweep's serialised `PlanResult` never contains a boat
// snapshot in the first place. So a change confined to `draftProvenance` (a
// human-readable disclosure about which keel a draft figure assumes) cannot
// move a single byte of what the sweep compares.
//
// This is intentionally narrow: it does NOT cover `polarProvenance` (also
// present on `boats.ts`, also copied into `BoatSnapshot`) — see the file
// header's "Failure direction" section for why that is deliberate rather
// than an oversight.
// ---------------------------------------------------------------------------

const BOATS_TS_PATH = 'app/src/data/boats.ts';

/**
 * Masks every character that lives inside a string/template literal or a
 * comment to a space, preserving length and line breaks exactly, so brace
 * matching and pattern search below only ever see real code structure —
 * never a brace that happens to appear inside prose (this file's
 * `draftProvenance.note` values are long hand-written strings) or inside a
 * `//`/`/* … *\/` comment.
 *
 * Template-literal interpolations (`${…}`) are treated as opaque string
 * content rather than re-entering "code" state — a real simplification, but
 * a safe one here: `boats.ts` has exactly one template literal
 * (`` `unknown boat id: ${id}` `` in `boatById`), nowhere near a
 * `draftProvenance`/`DraftProvenance` block, and masking its interpolation
 * as opaque content can only ever REMOVE braces from the count, never add a
 * spurious one — the failure direction of that simplification is "treat as
 * plain text", which cannot manufacture a false safe-block boundary.
 */
function maskNonCode(source) {
  const out = source.split('');
  const n = out.length;
  let i = 0;
  let state = 'code'; // 'code' | 'line' | 'block' | 'string'
  let quote = '';
  const mask = (idx) => {
    if (out[idx] !== '\n') out[idx] = ' ';
  };
  while (i < n) {
    const c = out[i];
    const c2 = i + 1 < n ? out[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        mask(i);
        mask(i + 1);
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block';
        mask(i);
        mask(i + 1);
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        state = 'string';
        quote = c;
        mask(i);
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        i += 1;
        continue;
      }
      mask(i);
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        mask(i);
        mask(i + 1);
        state = 'code';
        i += 2;
        continue;
      }
      mask(i);
      i += 1;
      continue;
    }
    // state === 'string'
    if (c === '\\') {
      mask(i);
      if (i + 1 < n) mask(i + 1);
      i += 2;
      continue;
    }
    if (c === quote) {
      mask(i);
      state = 'code';
      i += 1;
      continue;
    }
    mask(i);
    i += 1;
  }
  return out.join('');
}

function buildLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-indexed
}

function matchBrace(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1; // unmatched: malformed/truncated input — never trust it as a safe block
}

/**
 * Finds every `interface DraftProvenance { … }` and `draftProvenance: { … }`
 * span in `content`, returning `{ name, startLine, endLine }` (1-indexed,
 * inclusive) for each. A malformed/unmatched brace is silently DROPPED
 * (never added as a safe block) — the fail-open direction: if we can't be
 * sure a span is what it looks like, it doesn't get the exception.
 */
function findSafeBlocks(content) {
  const masked = maskNonCode(content);
  const lineStarts = buildLineStarts(content);
  const patterns = [
    { name: 'interface DraftProvenance', re: /\binterface\s+DraftProvenance\s*\{/g },
    { name: 'draftProvenance object literal', re: /\bdraftProvenance\s*:\s*\{/g },
  ];
  const blocks = [];
  for (const { name, re } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked))) {
      const braceIdx = m.index + m[0].length - 1; // last char of the match is '{'
      const closeIdx = matchBrace(masked, braceIdx);
      if (closeIdx === -1) continue;
      blocks.push({
        name,
        startLine: lineAt(lineStarts, m.index),
        endLine: lineAt(lineStarts, closeIdx),
      });
    }
  }
  return blocks;
}

function parseHunks(diffText) {
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  const hunks = [];
  let m;
  while ((m = re.exec(diffText))) {
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] !== undefined ? Number(m[2]) : 1,
      newStart: Number(m[3]),
      newCount: m[4] !== undefined ? Number(m[4]) : 1,
    });
  }
  return hunks;
}

function rangeWithinBlocks(start, count, blocks) {
  if (count <= 0) return true; // nothing on this side of the hunk to check
  const end = start + count - 1;
  return blocks.some((b) => b.startLine <= start && end <= b.endLine);
}

function hunkIsSafe(hunk, oldBlocks, newBlocks) {
  return (
    rangeWithinBlocks(hunk.oldStart, hunk.oldCount, oldBlocks) &&
    rangeWithinBlocks(hunk.newStart, hunk.newCount, newBlocks)
  );
}

/**
 * `oldContent`/`newContent`: the full text of `boats.ts` on each side.
 * `diffText`: `git diff -U0 <old> <new> -- boats.ts` (or `--no-index`) output.
 */
function classifyBoatsTs({ oldContent, newContent, diffText }) {
  const hunks = parseHunks(diffText);
  if (hunks.length === 0) {
    return { verdict: 'NOT_OWED', reason: 'no textual change in boats.ts on this diff' };
  }
  const oldBlocks = findSafeBlocks(oldContent);
  const newBlocks = findSafeBlocks(newContent);
  const unsafeHunks = hunks.filter((h) => !hunkIsSafe(h, oldBlocks, newBlocks));
  if (unsafeHunks.length === 0) {
    return {
      verdict: 'NOT_OWED',
      reason:
        'every hunk falls entirely inside a draftProvenance/DraftProvenance span — ' +
        'BoatSnapshot omits that field and PlanResult carries no boat field at all, ' +
        'so this change structurally cannot move a serialised plan',
      evidence: { oldBlocks, newBlocks, hunks },
    };
  }
  return {
    verdict: 'OWED',
    reason:
      `${unsafeHunks.length} of ${hunks.length} hunk(s) fall outside every modelled safe span — ` +
      'default fail-open verdict (see file header: this tool over-reports, never under-reports)',
    evidence: { unsafeHunks, oldBlocks, newBlocks },
  };
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

// `--merge-base` throughout (Minor, #729): a plain two-dot `git diff <base>
// <head>` is a direct TREE comparison, so it widens as `<base>` moves —
// passing a moving branch name pulls in every file the branch changed
// since this diff's own fork point, not just what this diff touched.
// `--merge-base` diffs against the ancestor the two refs actually share,
// which is safe regardless of how far `<base>` has since moved. See the
// file header's Usage section for the full mechanism.
//
// `--no-renames` throughout too (second Minor, #729): git's DEFAULT rename
// detection makes `--name-only` print ONLY the destination of a detected
// rename, dropping the source path entirely from the list — MEASURED in a
// scratch repo: `git mv app/sweep/canonicalize.mjs tools-canonicalize.mjs`
// then a plain `--name-only` diff prints just `tools-canonicalize.mjs` (the
// destination, outside every PATH_PREFIXES entry); with `--no-renames` it
// prints BOTH `app/sweep/canonicalize.mjs` (the real, in-closure source)
// AND `tools-canonicalize.mjs`. Without this flag a rename of an in-closure
// file is an UNDER-report inside the very universe this tool claims to
// model — the same failure direction as the original Blocker, one level
// down. `--no-renames` is on every `git diff` call below that feeds a
// verdict; `gitDiffNoIndex` (selftest's synthetic two-file comparisons,
// never a tree diff) has no renames to detect and needs no such flag.
function changedFiles(root, base, head) {
  const args = head
    ? ['diff', '--merge-base', '--no-renames', '--name-only', base, head]
    : ['diff', '--merge-base', '--no-renames', '--name-only', base];
  const out = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function gitShow(root, ref, relPath) {
  return execFileSync('git', ['show', `${ref}:${relPath}`], { cwd: root, encoding: 'utf8' });
}

function gitDiffU0(root, base, head, relPath) {
  const args = head
    ? ['diff', '--merge-base', '--no-renames', '-U0', '--no-color', base, head, '--', relPath]
    : ['diff', '--merge-base', '--no-renames', '-U0', '--no-color', base, '--', relPath];
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/**
 * Resolves the actual merge-base COMMIT of `base` and `head` (or HEAD when
 * `head` is omitted) — used so `gitShow`'s "old content" read is relative to
 * the SAME ancestor `changedFiles`/`gitDiffU0`'s `--merge-base` diffed
 * against, never to `base` itself (which, for a moving branch name, is a
 * different, later tree than the merge-base the hunks were computed from).
 */
function mergeBaseCommit(root, base, head) {
  return execFileSync('git', ['merge-base', base, head ?? 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

/** `git diff --no-index` exits 1 (not an error) whenever the two files differ. */
function gitDiffNoIndex(oldPath, newPath) {
  try {
    return execFileSync('git', ['diff', '--no-index', '--no-color', '-U0', oldPath, newPath], {
      encoding: 'utf8',
    });
  } catch (err) {
    if (err.status === 1 && typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdClosure(root) {
  const visited = computeClosure(root);
  const files = [...visited.keys()].filter((f) => !visited.get(f).missing).sort();
  for (const f of files) console.log(f);
  console.log(`\n${files.length} files in the #282 sweep closure via the import walk (roots: ${ROOTS.join(', ')})`);
  const missing = [...visited.entries()].filter(([, v]) => v.missing);
  if (missing.length) {
    console.log(`\n${missing.length} unresolved reference(s) (external package, or genuinely missing):`);
    for (const [rel] of missing) console.log(`  ${rel}`);
  }
  console.log(
    `\nPLUS every file under these ${PATH_PREFIXES.length} path prefixes (not enumerated here — ` +
      `some, e.g. pipeline/data-src, are large gitignored caches; membership is checked live by ` +
      `'files'/'diff' instead of expanded into a list):`,
  );
  for (const p of PATH_PREFIXES) console.log(`  ${p.prefix}/**  — ${p.note}`);
}

function cmdFiles(root, paths) {
  if (paths.length === 0) {
    console.error('usage: closure.mjs files <path> [<path>…]');
    process.exit(2);
  }
  const visited = computeClosure(root);
  for (const p of paths) {
    const rel = path.relative(root, path.resolve(root, p));
    const info = closureInfo(visited, rel);
    if (!info) {
      console.log(`NOT_IN_CLOSURE  ${rel}`);
      continue;
    }
    if (info.kind === 'import') {
      console.log(`IN_CLOSURE      ${rel}  (import walk)`);
      for (const step of info.chain) {
        console.log(`  via ${step.file}${step.via && step.via !== 'root' ? '  (' + step.via + ')' : ''}`);
      }
    } else {
      console.log(`IN_CLOSURE      ${rel}  (path-prefix: ${info.prefix}/)`);
      console.log(`  reason: ${info.note}`);
    }
  }
}

function cmdDiff(root, base, head) {
  if (!base) {
    console.error('usage: closure.mjs diff <base> [<head>]');
    process.exit(2);
  }
  const visited = computeClosure(root);
  const changed = changedFiles(root, base, head);
  const hits = changed.map((f) => ({ f, info: closureInfo(visited, f) })).filter((x) => x.info !== null);

  console.log(`# app/sweep #282 closure check`);
  console.log(`base=${base} head=${head ?? '(working tree)'}`);
  console.log(`changed files examined: ${changed.length}; closure (import walk) size: ${visited.size}`);
  console.log('');

  if (hits.length === 0) {
    console.log('VERDICT: NOT OWED — no changed file is in the #282 sweep closure (import walk or path prefixes)');
    return;
  }

  let anyOwed = false;
  for (const { f, info } of hits) {
    let verdict;
    if (f === BOATS_TS_PATH) {
      const oldRef = mergeBaseCommit(root, base, head);
      const oldContent = gitShow(root, oldRef, f);
      const newContent = head ? gitShow(root, head, f) : readFileSync(path.join(root, f), 'utf8');
      const diffText = gitDiffU0(root, base, head, f);
      verdict = classifyBoatsTs({ oldContent, newContent, diffText });
    } else {
      verdict = {
        verdict: 'OWED',
        reason:
          info.kind === 'import'
            ? 'in the sweep import closure; no field-level exception modelled for this file (default fail-open)'
            : `in the sweep closure via path-prefix ${info.prefix}/ (${info.note})`,
      };
    }
    if (verdict.verdict === 'OWED') anyOwed = true;
    console.log(`${verdict.verdict}  ${f}`);
    console.log(`  reason: ${verdict.reason}`);
    if (info.kind === 'import') {
      for (const step of info.chain) {
        console.log(`  via ${step.file}${step.via && step.via !== 'root' ? '  (' + step.via + ')' : ''}`);
      }
    }
    console.log('');
  }

  console.log(
    anyOwed
      ? 'VERDICT: SWEEP OWED — record a BASE double-run control against the merge-base of the branch it will certify (see CLAUDE.md #282/#450/#488), never as a harness background task.'
      : 'VERDICT: NOT OWED — every closure hit fell entirely inside a modelled safe exception.',
  );
  process.exitCode = anyOwed ? 1 : 0; // non-zero on OWED, so a CI/hook caller can branch on it
}

// ---------------------------------------------------------------------------
// selftest — the issue's required positive/negative controls, plus two
// non-vacuity mutation checks (an edit inside the SAME file that must still
// be OWED, and an edit to a DIFFERENT boats.ts field the exception is
// deliberately NOT generalised to).
// ---------------------------------------------------------------------------

const SYNTH_BASE = `export interface DraftProvenance {
  readonly keel: string;
  readonly hullVerified: boolean;
  readonly note: string;
}

export const BOATS = [
  {
    id: 'salona-45',
    draftM: 2.1,
    draftProvenance: {
      keel: 'standard',
      hullVerified: true,
      note: 'Original draft note.',
    },
    motorSpeedKn: 6.5,
    sails: [
      {
        id: 'genoa',
        polarAsset: 'data/polars/salona-45-genoa.json',
        polarProvenance: { tier: 'modelled', note: 'Original polar note.' },
      },
    ],
  },
];
`;

function withReplacement(source, from, to) {
  if (!source.includes(from)) throw new Error(`selftest fixture error: ${JSON.stringify(from)} not found`);
  return source.replace(from, to);
}

function check(name, pass, detail) {
  return { name, pass, detail };
}

function runSelftest(root) {
  const results = [];
  const visited = computeClosure(root);
  // Union of the import walk AND the PATH_PREFIXES match — the same
  // predicate every command uses (`closureInfo`), NOT a re-derivation of
  // either array, so these checks exercise the real membership test rather
  // than a copy of it.
  const inClosure = (rel) => closureInfo(visited, rel) !== null;

  results.push(
    check(
      'control-1: app/src/types.ts (holds DEFAULT_SETTINGS) is IN the closure -> default OWED',
      inClosure('app/src/types.ts'),
    ),
  );
  results.push(
    check('precondition: app/src/data/boats.ts is IN the closure (else the exception below is moot)', inClosure(BOATS_TS_PATH)),
  );
  results.push(
    check(
      'control-3 (negative control): app/src/components/AboutDialog.tsx is NOT in the closure',
      !inClosure('app/src/components/AboutDialog.tsx'),
    ),
  );

  // Major (#729): EXTRA_EDGES had ZERO selftest coverage — deleting it
  // dropped app/src/test/setup.ts from the closure with selftest still
  // reporting SELFTEST OK (the SOLVER_LABELS shape: a guard's data needs a
  // twin, not just its detection logic). This path is HARDCODED here, not
  // read off EXTRA_EDGES, so stubbing that array to `{}` reds this row and
  // nothing else — verified manually before push (see PR description).
  results.push(
    check(
      'EXTRA_EDGES pin: app/src/test/setup.ts is IN the closure (via the vitest.config.ts setupFiles runtime edge)',
      inClosure('app/src/test/setup.ts'),
    ),
  );

  // Blocker (#729): the import walk ALONE reported all eight of these
  // NOT_IN_CLOSURE, so `npm --prefix pipeline run mask` (which changes the
  // mask.bin/mask.meta.json rows below) and an edit to any arm-*.test.ts or
  // the harness scripts both reported NOT OWED, exit 0. Each path here is a
  // LITERAL string, not derived from PATH_PREFIXES, for the same
  // needle-vs-haystack reason as the EXTRA_EDGES pin above. None of these
  // eight is reachable via the import walk (verified: nothing in the
  // walked closure imports a .bin/.json data file or an arm-*.test.ts /
  // canonicalize.mjs / compare.mjs / .py file — those files import FROM
  // sweepArms.ts, never the reverse), so a green run here is evidence
  // specifically about PATH_PREFIXES, not a restatement of the import walk.
  const blockerInputs = [
    'app/public/data/mask.bin',
    'app/public/data/mask.meta.json',
    'app/public/data/harbors.json',
    'app/public/data/polars/salona-45-genoa.json',
    'app/sweep/arm-marginzero.test.ts',
    'app/sweep/canonicalize.mjs',
    'app/sweep/compare.mjs',
    'pipeline/build_mask.py',
  ];
  blockerInputs.forEach((rel, i) => {
    results.push(
      check(`path-prefix pin (#729 Blocker input ${i + 1}/${blockerInputs.length}): ${rel} is IN the closure`, inClosure(rel)),
    );
  });

  // Synthetic boats.ts-shaped file pairs, compared with real `git diff
  // --no-index` so the hunks fed into classifyBoatsTs are genuine git
  // output, not hand-computed line numbers. Written under the OS tmpdir —
  // never inside the repo, so nothing here can be mistaken for a tracked
  // change or interfere with the file allowlist for this task.
  const tmp = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-'));
  try {
    const oldFile = path.join(tmp, 'boats.old.ts');
    writeFileSync(oldFile, SYNTH_BASE);

    const draftProvNew = withReplacement(SYNTH_BASE, 'Original draft note.', 'A revised, longer draft note explaining the keel assumption in more detail.');
    const draftProvFile = path.join(tmp, 'boats.draftprov.ts');
    writeFileSync(draftProvFile, draftProvNew);
    const v2 = classifyBoatsTs({
      oldContent: SYNTH_BASE,
      newContent: draftProvNew,
      diffText: gitDiffNoIndex(oldFile, draftProvFile),
    });
    results.push(check('control-2: draftProvenance-note-only edit -> NOT_OWED', v2.verdict === 'NOT_OWED', v2));

    const draftMNew = withReplacement(SYNTH_BASE, 'draftM: 2.1,', 'draftM: 2.2,');
    const draftMFile = path.join(tmp, 'boats.draftm.ts');
    writeFileSync(draftMFile, draftMNew);
    const v5 = classifyBoatsTs({
      oldContent: SYNTH_BASE,
      newContent: draftMNew,
      diffText: gitDiffNoIndex(oldFile, draftMFile),
    });
    results.push(
      check('mutation-check: draftM edit in the SAME file -> OWED (exception is not "the whole file is exempt")', v5.verdict === 'OWED', v5),
    );

    const polarProvNew = withReplacement(SYNTH_BASE, 'Original polar note.', 'A revised polar note.');
    const polarProvFile = path.join(tmp, 'boats.polarprov.ts');
    writeFileSync(polarProvFile, polarProvNew);
    const v6 = classifyBoatsTs({
      oldContent: SYNTH_BASE,
      newContent: polarProvNew,
      diffText: gitDiffNoIndex(oldFile, polarProvFile),
    });
    results.push(
      check(
        'narrow-scope-check: polarProvenance.note edit -> OWED (exception deliberately NOT generalised beyond draftProvenance)',
        v6.verdict === 'OWED',
        v6,
      ),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // Second Minor (#729): a rename of an in-closure file is an UNDER-REPORT
  // inside this tool's OWN modelled universe unless `--no-renames` is set —
  // git's default rename detection makes `--name-only` print only the
  // DESTINATION of a detected rename, silently dropping the (in-closure)
  // source path. Reproduced with a REAL two-commit git repo (not a
  // hand-built diff string), so this exercises the actual `changedFiles()`
  // git invocation rather than a stand-in for it. Mutation-checked:
  // removing `--no-renames` from `changedFiles`'s args reds exactly this
  // row (verified before push, see PR description).
  const renameRepo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-rename-'));
  try {
    const git = (args) => execFileSync('git', args, { cwd: renameRepo, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'selftest@example.invalid']);
    git(['config', 'user.name', 'sweep-closure selftest']);
    mkdirSync(path.join(renameRepo, 'app', 'sweep'), { recursive: true });
    writeFileSync(
      path.join(renameRepo, 'app', 'sweep', 'canonicalize.mjs'),
      'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n',
    );
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    const renameBase = git(['rev-parse', 'HEAD']).trim();
    git(['mv', 'app/sweep/canonicalize.mjs', 'tools-canonicalize.mjs']);
    git(['commit', '-q', '-m', 'rename']);
    const renameHead = git(['rev-parse', 'HEAD']).trim();

    const changed = changedFiles(renameRepo, renameBase, renameHead);
    results.push(
      check(
        'rename-check: git mv app/sweep/canonicalize.mjs -> tools-canonicalize.mjs still lists the in-closure SOURCE path',
        changed.includes('app/sweep/canonicalize.mjs'),
        { changed },
      ),
    );
  } finally {
    rmSync(renameRepo, { recursive: true, force: true });
  }

  let failed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}`);
    if (!r.pass) {
      failed++;
      if (r.detail) console.log('  ' + JSON.stringify(r.detail));
    }
  }
  console.log('');
  if (failed > 0) {
    console.error(`${failed} of ${results.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log(`${results.length} of ${results.length} checks passed.`);
  console.log('SELFTEST OK');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = repoRoot();
  switch (cmd) {
    case 'closure':
      cmdClosure(root);
      break;
    case 'files':
      cmdFiles(root, rest);
      break;
    case 'diff':
      cmdDiff(root, rest[0], rest[1]);
      break;
    case 'selftest':
      runSelftest(root);
      break;
    default:
      console.error('usage: closure.mjs <closure|files <path…>|diff <base> [<head>]|selftest>');
      process.exit(2);
  }
}

main();
