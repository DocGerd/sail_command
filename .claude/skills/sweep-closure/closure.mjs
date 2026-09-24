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
 *    retire: it cannot see (a) vitest's real entry points — the
 *    `app/sweep/arm-*.test.ts` files (current set in `app/sweep/armNames.ts`,
 *    never restated here — the arm count went stale twice, see CLAUDE.md),
 *    reached only via `vitest.config.ts`'s
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
 *    ships an unverified routing change). Two carve-outs from that default,
 *    each proven from the diff and the tree rather than assumed:
 *    `app/src/data/boats.ts`'s `draftProvenance` field (see
 *    `classifyBoatsTs`), and #944's purely additive, unreferenced exports on
 *    an import-walk member (see `classifyAdditiveExports`).
 *
 * ## Failure direction — stated explicitly, per the issue's own request
 *
 * This tool is designed to OVER-REPORT, never under-report: every closure
 * hit is OWED by default, with TWO modelled exceptions
 * (`app/src/data/boats.ts`'s `draftProvenance`/`DraftProvenance` blocks —
 * see `classifyBoatsTs`'s own doc comment for why that specific carve-out
 * is sound — and #944's additive-export rule, which fails back to OWED on
 * anything it cannot prove). It does NOT attempt full data-flow/taint analysis of every
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
 * walk alone missed the `arm-*.test.ts` files (current set in
 * `app/sweep/armNames.ts`) and every runtime
 * data/pipeline input (Method step 2), so a diff confined to those reported
 * NOT OWED, exit 0. `PATH_PREFIXES` closes that MEASURED gap, but is itself
 * hand-maintained data (see its own header comment) rather than something
 * re-derived — so the honest claim is "over-reports against the modelled
 * universe below", not an unconditional guarantee. Extending
 * `PATH_PREFIXES`, the `draftProvenance` exception or the additive-export
 * rule needs the same structural proof, never a guess by analogy. The
 * additive rule applies to `diff` only; `reuse` fails closed and keeps the
 * `draftProvenance` exception alone.
 *
 * ## Usage
 *
 *   node closure.mjs closure                 # print the whole derived closure
 *   node closure.mjs files <path> [<path>…]  # is <path> in the closure at all?
 *   node closure.mjs diff <base> [<head>]    # real usage: does this diff owe a sweep?
 *   node closure.mjs reuse <recorded> <base> # #1337: can a recorded run's artifacts stand in as BASE?
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

import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    // #944: code here is EXECUTED during a sweep run, so the additive-export
    // rule must scan it for references. The other two prefixes are read or
    // re-run by hand, never loaded — a change there is OWED on its own.
    loadedAtSweepTime: true,
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
const FROM_RE = /(?:^|\n)[ \t]*(?:import|export)\b(?<clause>[^'"()]*?)\bfrom\s*(['"])(?<spec>[^'"]+)\2/g;
// Bare side-effect imports: `import '...'` (no `from`).
const BARE_RE = /(?:^|\n)[ \t]*import\s*(['"])(?<spec>[^'"]+)\1/g;
// Dynamic `import('...')`, wherever it appears.
const DYNAMIC_RE = /\bimport\s*\(\s*(['"])(?<spec>[^'"]+)\1\s*\)/g;

function extractSpecifiers(source) {
  const specs = new Set();
  for (const re of [FROM_RE, BARE_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) specs.add(m.groups.spec);
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
// The one modelled FIELD-level exception: app/src/data/boats.ts's
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
  return lexMask(source).masked;
}

/** `maskNonCode` plus the lexer state at the END of `source` ('code' | 'line' | 'block' | 'string'). */
function lexMask(source) {
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
  return { masked: out.join(''), state };
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
// #944: additive-export rule. A change to an import-walk closure member is
// NOT OWED when every hunk only INSERTS whole top-level `export` declarations
// (or comments) that cannot run code at load time, under names the old file
// never mentioned, and no file the sweep can load mentions those names or
// reaches the module through a namespace/dynamic import. Anything it cannot
// prove falls back to OWED — `classifyAdditiveExports` never throws.
// ---------------------------------------------------------------------------

const UNIVERSE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx'];

function isCodeFile(rel) {
  return UNIVERSE_EXTENSIONS.includes(path.extname(rel));
}

function isExtraEdgeTarget(rel) {
  return Object.values(EXTRA_EDGES).some((edges) => edges.some((e) => e.target === rel));
}

/** Import-walk members only: prefix, root and runtime-edge files are loaded by mechanisms this rule does not model. */
function additiveRuleApplies(rel, info) {
  return (
    info.kind === 'import' &&
    matchesPrefix(rel) === undefined &&
    !ROOTS.includes(rel) &&
    !isExtraEdgeTarget(rel) &&
    isCodeFile(rel)
  );
}

function matchClose(masked, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === open) depth++;
    else if (masked[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every way `source` can reach another module. Kinds: 'named' (binds only
 * listed names), 'namespace' (star import/re-export or a literal dynamic
 * import — reaches every export), 'bare', 'dynamic-basename'
 * (`import(resolve(x, 'lit'))`, target known only by basename) and
 * 'dynamic-unknown' (a load this tool cannot resolve).
 */
function moduleRefs(source) {
  const refs = [];
  let m;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(source))) {
    refs.push({ kind: m.groups.clause.includes('*') ? 'namespace' : 'named', spec: m.groups.spec });
  }
  BARE_RE.lastIndex = 0;
  while ((m = BARE_RE.exec(source))) refs.push({ kind: 'bare', spec: m.groups.spec });
  const { masked, state } = lexMask(source);
  if (state !== 'code') refs.push({ kind: 'dynamic-unknown', why: 'file ends inside a string or comment' });
  const dyn = /\bimport\s*\(/g;
  while ((m = dyn.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open, '(', ')');
    const arg = close === -1 ? null : source.slice(open + 1, close);
    const lit = arg === null ? null : /^\s*(['"])([^'"]+)\1\s*$/.exec(arg);
    const viaResolve = arg === null ? null : /^\s*resolve\(\s*[A-Za-z_$][\w$]*\s*,\s*(['"])([^'"]+)\1\s*\)\s*$/.exec(arg);
    if (lit) refs.push({ kind: 'namespace', spec: lit[2] });
    else if (viaResolve) refs.push({ kind: 'dynamic-basename', literal: viaResolve[2] });
    else refs.push({ kind: 'dynamic-unknown', why: 'import() with a non-literal argument' });
  }
  if (/\brequire\s*\(/.test(masked)) refs.push({ kind: 'dynamic-unknown', why: 'require()' });
  if (/\bimport\.meta\.glob/.test(masked)) refs.push({ kind: 'dynamic-unknown', why: 'import.meta.glob' });
  return refs;
}

/**
 * Every code file a sweep run loads from `dir`'s tree: the import walk plus
 * the tracked code under the `loadedAtSweepTime` PATH_PREFIXES (arm-*.test.ts
 * are loaded by vitest's glob, never reached by the walk). rel -> { text, refs }.
 */
function indexUniverse(dir, closure) {
  const rels = new Set();
  for (const [rel, v] of closure) if (!v.missing && isCodeFile(rel)) rels.add(rel);
  const loaded = PATH_PREFIXES.filter((p) => p.loadedAtSweepTime).map((p) => p.prefix);
  // --others: an untracked arm file in a working-tree run is still globbed by vitest.
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...loaded], {
    cwd: dir,
    encoding: 'utf8',
  });
  for (const rel of listed.split('\0')) if (rel && isCodeFile(rel)) rels.add(rel);
  const files = new Map();
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    if (!isFile(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const refs = moduleRefs(text).map((r) => {
      if (r.spec === undefined) return r;
      const resolved = resolveSpecifier(abs, r.spec);
      if (resolved) return { ...r, target: path.relative(dir, resolved) };
      if (r.kind !== 'namespace') return { ...r, target: null };
      // An unresolved namespace import: relative means a missing file; bare
      // may be a path alias, so judge it by basename like import(resolve()).
      return /^[./]/.test(r.spec)
        ? { kind: 'dynamic-unknown', why: `unresolved namespace import '${r.spec}'` }
        : { kind: 'dynamic-basename', literal: r.spec };
    });
    files.set(rel, { text, refs });
  }
  return files;
}

/** Paren/bracket/brace depth over masked code; throws if it goes negative. */
function depthOf(masked) {
  let depth = 0;
  for (const c of masked) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth < 0) throw new Error('unbalanced brackets');
    }
  }
  return depth;
}

/** Index of the first `ch` at bracket depth 0 in masked[from..], or -1. */
function findAtDepth0(masked, from, predicate) {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (depth === 0 && predicate(c, i)) return i;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

const RESERVED_NAMES = new Set([
  'enum', 'type', 'interface', 'function', 'class', 'let', 'var', 'const', 'async',
  'default', 'abstract', 'declare', 'namespace', 'module', 'await', 'yield',
]);
const EXPORT_HEAD_RE =
  /^export\s+(?:(?<kw>const|interface|type)\s+|(?<fn>(?:async\s+)?function\s*\*?\s*))(?<name>[A-Za-z_$][\w$]*)(?![\w$])/;

/**
 * A `const` initializer must be a literal: strings, non-negative numbers,
 * true/false/null/undefined, and arrays/objects of those, optionally
 * `as const`. Rejects every call, property read, operator, identifier
 * reference and template literal — the ways an initializer can run code or
 * observe other bindings at load time.
 */
function assertLiteralInitializer(maskedInit, rawInit) {
  if (rawInit.includes('`')) throw new Error('template literal in a const initializer');
  const body = maskedInit.replace(/\bas\s+const\s*$/, '');
  if (body.trim() === '') {
    const rawBody = rawInit.replace(/\bas\s+const\s*$/, '').trim();
    if (!/^(['"])[^\n]*\1$/.test(rawBody)) throw new Error('const initializer is empty');
    return;
  }
  const tokenRe = /\s+|\d+(?:\.\d+)?(?:[eE]\d+)?|[A-Za-z_$][\w$]*|[[\]{},:]|[\s\S]/gy;
  let m;
  while ((m = tokenRe.exec(body))) {
    const tok = m[0];
    if (/^\s+$/.test(tok) || /^\d/.test(tok) || /^[[\]{},:]$/.test(tok)) continue;
    if (/^[A-Za-z_$]/.test(tok)) {
      if (['true', 'false', 'null', 'undefined'].includes(tok)) continue;
      if (/^\s*:/.test(body.slice(tokenRe.lastIndex))) continue; // object key
      throw new Error(`identifier '${tok}' in a const initializer`);
    }
    throw new Error(`'${tok}' in a const initializer`);
  }
}

/**
 * Parses an inserted fragment as a sequence of top-level `export const |
 * function | interface | type` declarations (comments/blank lines allowed).
 * Returns the declared names; throws on anything else.
 */
function parseExportStatements(text) {
  const { masked, state } = lexMask(text);
  if (state !== 'code') throw new Error('inserted text ends inside a string or comment');
  const names = [];
  let pos = 0;
  for (;;) {
    while (pos < masked.length && /\s/.test(masked[pos])) pos++;
    if (pos >= masked.length) return names;
    const head = EXPORT_HEAD_RE.exec(masked.slice(pos));
    if (!head) throw new Error(`unrecognised top-level statement: ${JSON.stringify(text.slice(pos, pos + 40))}`);
    const { kw, fn, name } = head.groups;
    if (RESERVED_NAMES.has(name)) throw new Error(`unsupported declaration form 'export ${kw ?? 'function'} ${name}'`);
    const afterHead = pos + head[0].length;
    let end;
    if (kw === 'const') {
      const semi = findAtDepth0(masked, afterHead, (c) => c === ';');
      if (semi === -1) throw new Error(`export const ${name} has no terminating ';'`);
      const eq = findAtDepth0(masked, afterHead, (c, i) => c === '=' && masked[i + 1] !== '>' && i < semi);
      if (eq === -1 || eq > semi) throw new Error(`export const ${name} has no initializer`);
      assertNoDepth0Newline(masked, afterHead, eq, `export const ${name} annotation`);
      const annotation = masked.slice(afterHead, eq).trim();
      if (annotation !== '' && !annotation.startsWith(':')) throw new Error(`export const ${name}: unsupported declarator`);
      if (findAtDepth0(masked.slice(0, semi), eq + 1, (c) => c === ',') !== -1) {
        throw new Error(`export const ${name}: multiple declarators`);
      }
      assertLiteralInitializer(masked.slice(eq + 1, semi), text.slice(eq + 1, semi));
      end = semi;
    } else if (fn !== undefined) {
      const stop = findAtDepth0(masked, afterHead, (c) => c === ';' || c === '{');
      if (stop === -1 || masked[stop] !== '{') throw new Error(`export function ${name} has no body`);
      assertNoDepth0Newline(masked, afterHead, stop, `export function ${name} signature`);
      end = matchClose(masked, stop, '{', '}');
      if (end === -1) throw new Error(`export function ${name}: unbalanced body`);
    } else if (kw === 'interface') {
      const open = findAtDepth0(masked, afterHead, (c) => c === '{' || c === ';');
      if (open === -1 || masked[open] !== '{') throw new Error(`export interface ${name} has no body`);
      assertNoDepth0Newline(masked, afterHead, open, `export interface ${name} header`);
      end = matchClose(masked, open, '{', '}');
      if (end === -1) throw new Error(`export interface ${name}: unbalanced body`);
    } else {
      end = findAtDepth0(masked, afterHead, (c) => c === ';');
      if (end === -1) throw new Error(`export type ${name} has no terminating ';'`);
      assertNoDepth0Newline(masked, afterHead, end, `export type ${name}`);
    }
    names.push(name);
    pos = end + 1;
  }
}

/**
 * ASI can end a declaration at a newline and start an executable statement
 * before the `;`/`{` this parser looks for; without a full parser, a depth-0
 * newline inside a span means its boundary is unproven.
 */
function assertNoDepth0Newline(masked, from, to, what) {
  if (findAtDepth0(masked.slice(0, to), from, (c) => c === '\n') !== -1) {
    throw new Error(`${what} spans a depth-0 newline (statement boundary unproven)`);
  }
}

function tokenRegex(name) {
  return new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
}

/**
 * `universes`: one `indexUniverse` map per tree the diff touches.
 * `exemptHunk`: hunks another modelled rule already cleared (boats.ts's
 * draftProvenance spans). Never throws.
 */
function classifyAdditiveExports({ targetRel, oldContent, newContent, diffText, universes, exemptHunk = () => false }) {
  try {
    // The lexer has no regex-literal state; a quote inside a regex usually
    // leaves the file ending mid-string or unbalanced, which this rejects.
    for (const [side, content] of [['old', oldContent], ['new', newContent]]) {
      const lexed = lexMask(content);
      if (lexed.state !== 'code' || depthOf(lexed.masked) !== 0) {
        throw new Error(`the ${side} file does not lex to balanced top-level code`);
      }
    }
    const hunks = parseHunks(diffText);
    if (hunks.length === 0) throw new Error('no hunks in the diff');
    const oldStarts = buildLineStarts(oldContent);
    const newLines = newContent.split('\n');
    const names = [];
    for (const h of hunks) {
      if (exemptHunk(h)) continue;
      if (h.oldCount !== 0) throw new Error(`hunk -${h.oldStart},${h.oldCount} modifies or removes existing lines`);
      const offset = h.oldStart === 0 ? 0 : h.oldStart < oldStarts.length ? oldStarts[h.oldStart] : oldContent.length;
      const before = lexMask(oldContent.slice(0, offset));
      if (before.state !== 'code') throw new Error(`insertion after line ${h.oldStart} is inside a string or comment`);
      if (depthOf(before.masked) !== 0) throw new Error(`insertion after line ${h.oldStart} is not at module top level`);
      const prev = before.masked.trimEnd().slice(-1);
      if (prev !== '' && prev !== ';' && prev !== '}') {
        throw new Error(`insertion after line ${h.oldStart} does not follow a statement boundary`);
      }
      names.push(...parseExportStatements(newLines.slice(h.newStart - 1, h.newStart - 1 + h.newCount).join('\n')));
    }
    if (new Set(names).size !== names.length) throw new Error('duplicate new export name');
    for (const name of names) {
      if (tokenRegex(name).test(oldContent)) throw new Error(`'${name}' already appears in the old file`);
    }
    if (names.length > 0) {
      if (!Array.isArray(universes) || !universes.some((u) => u.has(targetRel))) {
        throw new Error(`no loadable-file index contains ${targetRel} itself`);
      }
      const stem = path.basename(targetRel).replace(/\.[^.]+$/, '');
      for (const universe of universes) {
        for (const [rel, { text, refs }] of universe) {
          if (rel === targetRel) continue;
          for (const name of names) {
            if (tokenRegex(name).test(text)) throw new Error(`'${name}' is referenced by ${rel}`);
          }
          for (const r of refs) {
            if (r.kind === 'namespace' && r.target === targetRel) {
              throw new Error(`${rel} reaches ${targetRel} through a namespace/star/dynamic import`);
            }
            if (r.kind === 'dynamic-unknown') throw new Error(`${rel} loads a module this tool cannot resolve (${r.why})`);
            if (r.kind === 'dynamic-basename') {
              const b = path.basename(r.literal);
              const bStem = b.replace(/\.[^.]+$/, '');
              if (/[/\\]$/.test(r.literal) || b === '.' || b === '..' || bStem === stem || bStem === 'index') {
                throw new Error(`${rel} dynamically imports '${r.literal}', which may resolve to ${targetRel}`);
              }
            }
          }
        }
      }
    }
    return {
      verdict: 'NOT_OWED',
      reason:
        names.length > 0
          ? `additive-only: new top-level export(s) ${names.join(', ')} with literal initializers, referenced by no file the sweep can load`
          : 'additive-only: inserted text is comments/blank lines at module top level',
      evidence: { names, hunks },
    };
  } catch (err) {
    return {
      verdict: 'OWED',
      reason: `additive-export rule could not prove the change inert (${err.message}) — default fail-open verdict`,
    };
  }
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

/**
 * Unions any number of closure Maps (as `computeClosure` returns), preferring
 * a NON-MISSING entry over a MISSING one wherever a key appears in more than
 * one map. `computeClosure` marks a ROOT/EXTRA_EDGES target that does not
 * exist at that commit as `{ missing: true }`, and `closureInfo` treats
 * `missing` as NOT in closure — so a plain last-write-wins spread
 * (`new Map([...a, ...b])`) lets a LATER map's missing placeholder silently
 * shadow an EARLIER map's real entry. Major, PR #1384 review (#1359): with
 * that spread, a `diff` where `head` deletes an EXTRA_EDGES target (e.g.
 * `app/src/test/setup.ts`) read NOT OWED, because `head`'s `missing` entry
 * overwrote `mergeBase`'s present one. `computeReuseVerdict` had the
 * identical bug (`new Map([...closureAtRecorded, ...closureAtBase])`,
 * #1352) — both callers now go through this one helper instead of each
 * carrying their own (correct-or-not) precedence rule.
 */
function unionClosures(...maps) {
  const merged = new Map();
  for (const m of maps) {
    for (const [k, v] of m) {
      const existing = merged.get(k);
      // Set on first sight, or replace a still-missing placeholder — but
      // NEVER replace an already-present (non-missing) entry, regardless of
      // what a later map says about the same key.
      if (existing === undefined || existing.missing) merged.set(k, v);
    }
  }
  return merged;
}

/**
 * Computes the sweep closure at the THREE trees `diff` needs — the
 * merge-base commit, `head` (or the working tree, when `head` is omitted,
 * since that IS what an omitted `head` means throughout this file), and
 * `base` itself — via disposable detached worktrees, mirroring `reuse`'s own
 * `computeReuseVerdict` (PR #1352) one command over.
 *
 * `computeClosure(root)` alone reads whatever `root` happens to have
 * CHECKED OUT right now, which is unrelated to `base`/`head` whenever the
 * caller's own tree sits on a third branch (#1359, found reviewing PR
 * #1352/#1337: `reuse` got exactly this fix, `diff` did not). A file added
 * only on `head`, or one reached only via an importer that changed on
 * `head`, then reads NOT_IN_CLOSURE regardless of what the real diff
 * contains — the same false-NOT-OWED shape #1352 closed for `reuse`, here on
 * the command actually run before every solver-heavy code change.
 *
 * UNION all three trees' closures via `unionClosures` (never a bare spread —
 * see its own header for the missing-precedence Major this fixed), same
 * reasoning as `reuse`'s union: a member present at only ONE tree (added,
 * removed, or reached via an importer that changed) must still be seen —
 * narrowing to fewer trees reopens an under-report inside this tool's own
 * modelled universe.
 *
 * The THIRD term — `base` itself, not just its merge-base with `head` — is a
 * Minor from the same review (#1359): `changedFiles` diffs
 * merge-base(base,head)..head, so an import `base` (e.g. `origin/develop`)
 * ADDED after the fork point is invisible to the merge-base/head pair alone.
 * Deliberately the SAFE direction (this tool over-reports by design) and
 * deliberately NOT a substitute for the strict-up-to-date re-sync CLAUDE.md
 * already requires before a merge — it only narrows the window where a
 * stale `diff` run would otherwise miss a base-side import.
 */
function computeClosureForDiff(root, base, head) {
  const mergeBase = mergeBaseCommit(root, base, head);
  // #944: index each tree's loadable files while its checkout still exists.
  const scan = (dir) => {
    const closure = computeClosure(dir);
    return { closure, universe: indexUniverse(dir, closure) };
  };
  const atMergeBase = withRefCheckout(root, mergeBase, scan);
  const atHead = head ? withRefCheckout(root, head, scan) : scan(root);
  const atBase = withRefCheckout(root, base, scan);
  return {
    visited: unionClosures(atMergeBase.closure, atHead.closure, atBase.closure),
    universes: [atMergeBase.universe, atHead.universe, atBase.universe],
  };
}

/**
 * The pure decision function for `diff` — mirrors `computeReuseVerdict`'s
 * split from `cmdReuse`, so `selftest` can exercise the SAME
 * closure-computation code path `cmdDiff` prints from, rather than a
 * stand-in for it (#1359).
 */
function computeDiffVerdict(root, base, head) {
  const { visited, universes } = computeClosureForDiff(root, base, head);
  const changed = changedFiles(root, base, head);
  const hits = changed.map((f) => ({ f, info: closureInfo(visited, f) })).filter((x) => x.info !== null);

  const results = hits.map(({ f, info }) => {
    let verdict;
    if (additiveRuleApplies(f, info)) {
      try {
        const oldRef = mergeBaseCommit(root, base, head);
        const oldContent = gitShow(root, oldRef, f);
        const newContent = head ? gitShow(root, head, f) : readFileSync(path.join(root, f), 'utf8');
        const diffText = gitDiffU0(root, base, head, f);
        verdict = { verdict: 'OWED' };
        let exemptHunk = () => false;
        if (f === BOATS_TS_PATH) {
          verdict = classifyBoatsTs({ oldContent, newContent, diffText });
          const oldBlocks = findSafeBlocks(oldContent);
          const newBlocks = findSafeBlocks(newContent);
          exemptHunk = (h) => hunkIsSafe(h, oldBlocks, newBlocks);
        }
        if (verdict.verdict === 'OWED') {
          verdict = classifyAdditiveExports({ targetRel: f, oldContent, newContent, diffText, universes, exemptHunk });
        }
      } catch (err) {
        verdict = { verdict: 'OWED', reason: `could not read this file's change (${err.message}) — default fail-open verdict` };
      }
    } else {
      verdict = {
        verdict: 'OWED',
        reason:
          info.kind === 'import'
            ? 'in the sweep import closure; no field-level exception modelled for this file (default fail-open)'
            : `in the sweep closure via path-prefix ${info.prefix}/ (${info.note})`,
      };
    }
    return { f, info, verdict };
  });

  return {
    changedCount: changed.length,
    closureSize: visited.size,
    results,
    anyOwed: results.some((r) => r.verdict.verdict === 'OWED'),
  };
}

function cmdDiff(root, base, head) {
  if (!base) {
    console.error('usage: closure.mjs diff <base> [<head>]');
    process.exit(2);
  }
  const { changedCount, closureSize, results, anyOwed } = computeDiffVerdict(root, base, head);

  console.log(`# app/sweep #282 closure check`);
  console.log(`base=${base} head=${head ?? '(working tree)'}`);
  console.log(`changed files examined: ${changedCount}; closure (import walk) size: ${closureSize}`);
  console.log('');

  if (results.length === 0) {
    console.log('VERDICT: NOT OWED — no changed file is in the #282 sweep closure (import walk or path prefixes)');
    return;
  }

  for (const { f, info, verdict } of results) {
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
// reuse — #1337: can a RECORDED run's stored sweep artifacts stand in for a
// fresh BASE arm-set, instead of re-running it, because the closure is
// provably untouched between the recorded SHA and the current base?
//
// This is a NUDGE-class tool exactly like `diff` above, but its failure
// direction is the OPPOSITE one: `diff` over-reports OWED (a false "owed"
// only costs unnecessary solver time), while a false REUSE here would let a
// stale artifact stand in for a base that has actually moved — silently
// certifying a comparison that was never run. So `reuse` fails CLOSED,
// never open: any ambiguity, any lookup miss, any tool error all resolve to
// `RUN_BASE`, and `REUSE` is returned ONLY when every check below has
// POSITIVELY confirmed the closure is untouched. `computeReuseVerdict`
// therefore wraps its entire body in one try/catch that turns ANY thrown
// error into `RUN_BASE` — a git failure, a malformed ledger, an
// unresolvable ref all fall through to the same safe default rather than
// crashing the caller or silently reporting REUSE on a fluke.
// ---------------------------------------------------------------------------

const LEDGER_REL_PATH = '.claude/skills/sweep-closure/recorded-runs.json';

function ledgerPath(root) {
  return path.join(root, LEDGER_REL_PATH);
}

/**
 * Reads and validates the ledger file at `absPath`. Throws on anything that
 * isn't `{ "runs": [...] }` — the caller (`computeReuseVerdict`) converts
 * that throw into a `RUN_BASE` verdict, never lets it propagate further.
 */
function loadLedgerFile(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.runs)) {
    throw new Error('ledger must be a JSON object with a "runs" array');
  }
  return parsed;
}

/**
 * Finds the ledger entry whose `sha` matches `key` exactly or as a prefix
 * (case-insensitive). Never throws. Returns one of:
 *   { status: 'short' }               — key shorter than 7 characters, refused outright
 *   { status: 'none' }                — zero entries match
 *   { status: 'ambiguous', count }     — more than one entry matches
 *   { status: 'ok', entry }            — exactly one match
 * A malformed INDIVIDUAL ledger entry is skipped rather than aborting the
 * whole lookup, so one bad row can't mask another. #1361 (issue item 3):
 * `ambiguous` and `none` used to collapse to the same `null` return and the
 * same "unknown recorded run" RUN_BASE reason — unlike `git rev-parse`,
 * which errors on an ambiguous short hash, a first-match lookup here would
 * silently pick whichever entry sorts first in the ledger array, certifying
 * a DIFFERENT run's artifacts than the one the caller meant, so the two
 * cases are now reported with DIFFERENT reason strings. Both still resolve
 * to RUN_BASE either way — this changes labelling only, never the verdict.
 */
function findLedgerEntry(ledger, key) {
  if (typeof key !== 'string' || key.length < 7) return { status: 'short' };
  const lower = key.toLowerCase();
  const matches = ledger.runs.filter(
    (e) => e && typeof e === 'object' && typeof e.sha === 'string' && e.sha.toLowerCase().startsWith(lower),
  );
  if (matches.length === 0) return { status: 'none' };
  if (matches.length > 1) return { status: 'ambiguous', count: matches.length };
  return { status: 'ok', entry: matches[0] };
}

/**
 * Registered once, lazily, the first time a temp worktree is created.
 * #1361 (issue item 1): with NO listener, Node's default SIGINT/SIGTERM
 * disposition terminates the process immediately and skips every pending
 * `finally` — so a Ctrl-C mid-`withRefCheckout` orphaned the just-created
 * temp worktree (~86 MB, registered with git, sometimes left locked;
 * reproduced 5 of 5 times). Registering ANY listener suppresses that
 * default termination, which is this handler's entire job — the body does
 * nothing further, on purpose: `withRefCheckout`'s `finally` block (or its
 * new add-failure `catch`, below) is what actually removes the worktree,
 * and it only gets a chance to run once the interrupted synchronous call
 * (`execFileSync`, or the fs reads inside `fn`) throws or returns and
 * control unwinds normally. Setting `process.exitCode` here (never calling
 * `process.exit()`, which would skip that unwind) is what avoids that.
 */
let interruptHandlersInstalled = false;
function installInterruptHandlers() {
  if (interruptHandlersInstalled) return;
  interruptHandlersInstalled = true;
  process.on('SIGINT', () => {
    process.exitCode = 130;
  });
  process.on('SIGTERM', () => {
    process.exitCode = 143;
  });
}

/**
 * Checks out `ref` into a fresh, detached temp worktree via `git worktree
 * add --detach`, runs `fn(tempDir)`, and tears the worktree down again —
 * ALWAYS, even if `fn` throws. This is what lets `computeClosure` (which
 * reads from a directory on disk, unmodified — see its own header) compute
 * the closure AT a specific commit instead of at whatever the CALLER
 * happens to have checked out (Blocker, PR #1352 review).
 */
function withRefCheckout(root, ref, fn) {
  installInterruptHandlers();
  const tmp = mkdtempSync(path.join(tmpdir(), 'sweep-closure-ref-'));
  try {
    execFileSync('git', ['worktree', 'add', '--detach', '--quiet', tmp, ref], { cwd: root });
  } catch (err) {
    // #1361 (issue item 2): `git worktree add` never registered `tmp` with
    // git on a failure (interrupted, bad ref, …), so there is nothing for
    // `git worktree remove` to clean up — only the empty directory
    // `mkdtempSync` already created above.
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  try {
    return fn(tmp);
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', tmp], { cwd: root });
    } catch {
      // best effort; still remove the directory below even if git's own
      // worktree bookkeeping failed to detach cleanly.
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The pure decision function — no I/O side effects beyond reading the
 * ledger file and invoking `git`/the closure walk, and it NEVER throws:
 * every failure mode collapses to `{ verdict: 'RUN_BASE', reason }`. This is
 * what `cmdReuse` calls for the CLI, and what `selftest` calls directly
 * (against a synthetic repo + a synthetic ledger object) so the fail-closed
 * behaviour is exercised without needing a real GitHub SHA on record.
 */
function computeReuseVerdict(root, recordedArg, baseArg) {
  try {
    if (!recordedArg || !baseArg) {
      return { verdict: 'RUN_BASE', reason: 'usage: reuse <recorded> <base>' };
    }

    let ledger;
    try {
      ledger = loadLedgerFile(ledgerPath(root));
    } catch (err) {
      return { verdict: 'RUN_BASE', reason: `malformed ledger (${LEDGER_REL_PATH}): ${err.message}` };
    }

    const found = findLedgerEntry(ledger, recordedArg);
    if (found.status === 'short') {
      return { verdict: 'RUN_BASE', reason: `recorded ref too short to disambiguate: ${recordedArg} (need >= 7 characters)` };
    }
    if (found.status === 'ambiguous') {
      return {
        verdict: 'RUN_BASE',
        reason: `ambiguous recorded run: ${recordedArg} matches ${found.count} entries in ${LEDGER_REL_PATH}`,
      };
    }
    if (found.status === 'none') {
      return { verdict: 'RUN_BASE', reason: `unknown recorded run: ${recordedArg} (no matching entry in ${LEDGER_REL_PATH})` };
    }
    const entry = found.entry;
    if (typeof entry.sha !== 'string' || entry.sha.length === 0) {
      return { verdict: 'RUN_BASE', reason: `ledger entry for ${recordedArg} has no "sha" field` };
    }
    if (!entry.arms || typeof entry.arms !== 'object' || Array.isArray(entry.arms) || Object.keys(entry.arms).length === 0) {
      return {
        verdict: 'RUN_BASE',
        reason: `ledger entry ${entry.sha} has no recorded artifact hashes ("arms" missing/empty)`,
      };
    }

    // Resolve both refs to full SHAs up front — a `git rev-parse` failure
    // (recorded SHA no longer reachable, base ref unknown) is a git
    // failure, caught by the outer try/catch below like any other.
    const recordedSha = execFileSync('git', ['rev-parse', entry.sha], { cwd: root, encoding: 'utf8' }).trim();
    const baseSha = execFileSync('git', ['rev-parse', baseArg], { cwd: root, encoding: 'utf8' }).trim();

    // Blocker (PR #1352 review): `git diff --merge-base` diffs
    // merge-base(recorded, base) -> base, so it is BLIND to any change that
    // lives only on `recorded`'s own side — a recorded run on a side branch
    // (or, symmetrically, a `recorded` that is actually a DESCENDANT of
    // `base`, where merge-base(recorded, base) == base and the diff
    // collapses to base-vs-base, i.e. empty) can certify a base it never
    // measured. `--merge-base` does NOT "only widen" the diff in general —
    // that claim from an earlier revision of this comment was refuted by
    // both a side-branch and a descendant reproduction. Require `recorded`
    // to be an ancestor of (or equal to) `base` BEFORE diffing at all.
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', recordedSha, baseSha], { cwd: root });
    } catch {
      return { verdict: 'RUN_BASE', reason: `recorded ${recordedSha} is not an ancestor of base ${baseSha}` };
    }

    // Blocker (PR #1352 review): compute the closure from the RECORDED and
    // BASE trees themselves via disposable detached worktrees, never from
    // whatever this process's OWN working tree happens to have checked
    // out — `computeClosure(root)` reads `root`'s checked-out files, so a
    // caller running `reuse` from a THIRD tree (the normal case: the branch
    // under test, distinct from both `recorded` and `base`) got a verdict
    // that depended on which branch was checked out when `reuse` ran, not
    // on `recorded`/`base` themselves. Union the two trees' closures so an
    // EXTRA_EDGES/ROOT target missing at one commit but present at the
    // other (e.g. `app/src/test/setup.ts` added or removed between
    // `recorded` and `base`) is still seen as present — `unionClosures`
    // prefers a non-missing entry over a missing one regardless of which
    // side supplies it (#1361: `closureAtRecorded` ALONE already passes
    // every selftest row below except the M9-pin row below, which needs
    // `closureAtBase`; the mirror-M9 row needs `closureAtRecorded`
    // specifically, so BOTH halves are load-bearing, not just one).
    const closureAtRecorded = withRefCheckout(root, recordedSha, (dir) => computeClosure(dir));
    const closureAtBase = withRefCheckout(root, baseSha, (dir) => computeClosure(dir));
    const visited = unionClosures(closureAtRecorded, closureAtBase);
    const changed = changedFiles(root, recordedSha, baseSha);
    const hits = changed.map((f) => ({ f, info: closureInfo(visited, f) })).filter((x) => x.info !== null);

    const owed = [];
    for (const { f, info } of hits) {
      let isOwed = true;
      if (f === BOATS_TS_PATH) {
        const oldRef = mergeBaseCommit(root, recordedSha, baseSha);
        const oldContent = gitShow(root, oldRef, f);
        const newContent = gitShow(root, baseSha, f);
        const diffText = gitDiffU0(root, recordedSha, baseSha, f);
        isOwed = classifyBoatsTs({ oldContent, newContent, diffText }).verdict === 'OWED';
      }
      if (isOwed) owed.push({ f, info });
    }

    if (owed.length > 0) {
      return {
        verdict: 'RUN_BASE',
        reason: `${owed.length} closure file(s) changed between ${recordedSha} and ${baseSha}`,
        recordedSha,
        baseSha,
        owed,
      };
    }

    return {
      verdict: 'REUSE',
      reason: `no closure member changed between ${recordedSha} and ${baseSha}`,
      recordedSha,
      baseSha,
      entry,
    };
  } catch (err) {
    return { verdict: 'RUN_BASE', reason: `closure-tool error: ${err.message}` };
  }
}

function cmdReuse(root, recordedArg, baseArg) {
  console.log(`# app/sweep #282 reuse check`);
  console.log(`recorded=${recordedArg ?? '(missing)'} base=${baseArg ?? '(missing)'}`);
  console.log('');

  const result = computeReuseVerdict(root, recordedArg, baseArg);
  const label = result.verdict === 'REUSE' ? 'REUSE' : 'RUN BASE';
  console.log(`VERDICT: ${label} — ${result.reason}`);
  if (result.owed) {
    for (const { f } of result.owed) console.log(`  ${f}`);
  }
  process.exitCode = result.verdict === 'REUSE' ? 0 : 1; // non-zero means "run base", mirrors `diff`'s OWED convention
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

  // #1337: `reuse` selftest — a real, disposable three-commit git repo (a
  // base plus two divergent children) so `computeReuseVerdict` exercises
  // its actual `git rev-parse`/`changedFiles` calls rather than a stand-in.
  // The repo's own `.claude/skills/sweep-closure/recorded-runs.json` is
  // written to DISK (never committed) so `loadLedgerFile` reads a real file
  // at the real relative path, exactly as `cmdReuse` would from the repo
  // root. Nothing here touches THIS repo's own ledger or git state.
  const reuseRepo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-reuse-'));
  try {
    const git = (args) => execFileSync('git', args, { cwd: reuseRepo, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'selftest@example.invalid']);
    git(['config', 'user.name', 'sweep-closure selftest']);
    mkdirSync(path.join(reuseRepo, 'app', 'sweep'), { recursive: true });
    writeFileSync(path.join(reuseRepo, 'app', 'sweep', 'sweepArms.ts'), 'export const ARMS = 1;\n');
    writeFileSync(path.join(reuseRepo, 'app', 'sweep', 'vitest.config.ts'), 'export default {};\n');
    writeFileSync(path.join(reuseRepo, 'README.md'), 'v1\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'recorded']);
    const recordedSha = git(['rev-parse', 'HEAD']).trim();

    // untouched-base: only a file OUTSIDE the closure changes.
    writeFileSync(path.join(reuseRepo, 'README.md'), 'v2\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'untouched base']);
    const untouchedBaseSha = git(['rev-parse', 'HEAD']).trim();

    // touched-base: branch back from the recorded commit and edit a real
    // closure member (`sweepArms.ts` is a ROOT — always in closure via the
    // import walk, independent of PATH_PREFIXES).
    git(['checkout', '-q', recordedSha]);
    writeFileSync(path.join(reuseRepo, 'app', 'sweep', 'sweepArms.ts'), 'export const ARMS = 2;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'touched base']);
    const touchedBaseSha = git(['rev-parse', 'HEAD']).trim();

    const ledgerDir = path.join(reuseRepo, '.claude', 'skills', 'sweep-closure');
    mkdirSync(ledgerDir, { recursive: true });
    const ledgerFile = path.join(ledgerDir, 'recorded-runs.json');
    const writeLedger = (obj) => writeFileSync(ledgerFile, JSON.stringify(obj));

    // Happy path: closure untouched -> REUSE.
    writeLedger({ runs: [{ sha: recordedSha, arms: { base1: 'deadbeef' } }] });
    const rUntouched = computeReuseVerdict(reuseRepo, recordedSha, untouchedBaseSha);
    results.push(
      check('reuse: closure untouched between recorded and base -> REUSE', rUntouched.verdict === 'REUSE', rUntouched),
    );

    // Closure member changed -> RUN_BASE, never REUSE (same ledger, same
    // recorded SHA — only the BASE argument differs from the row above).
    const rTouched = computeReuseVerdict(reuseRepo, recordedSha, touchedBaseSha);
    results.push(
      check(
        'reuse: a closure member (sweepArms.ts) changed between recorded and base -> RUN_BASE',
        rTouched.verdict === 'RUN_BASE',
        rTouched,
      ),
    );

    // Malformed ledger (not even an object with a "runs" array) -> RUN_BASE,
    // never a thrown exception reaching the caller.
    writeFileSync(ledgerFile, '{ "not-runs": true }');
    const rMalformed = computeReuseVerdict(reuseRepo, recordedSha, untouchedBaseSha);
    results.push(
      check(
        'reuse: malformed ledger (no "runs" array) -> RUN_BASE',
        rMalformed.verdict === 'RUN_BASE' && /malformed ledger/.test(rMalformed.reason),
        rMalformed,
      ),
    );

    // Unknown recorded run: a syntactically valid, well-shaped ledger that
    // simply has no entry matching the SHA asked for -> RUN_BASE.
    writeLedger({ runs: [{ sha: touchedBaseSha, arms: { base1: 'deadbeef' } }] });
    const rUnknown = computeReuseVerdict(reuseRepo, recordedSha, untouchedBaseSha);
    results.push(
      check(
        'reuse: recorded SHA has no matching ledger entry -> RUN_BASE',
        rUnknown.verdict === 'RUN_BASE' && /unknown recorded run/.test(rUnknown.reason),
        rUnknown,
      ),
    );

    // Ledger entry present and SHA matches, but no artifact hashes recorded
    // ("arms" missing/empty) -> RUN_BASE, not REUSE-by-omission.
    writeLedger({ runs: [{ sha: recordedSha, arms: {} }] });
    const rNoArms = computeReuseVerdict(reuseRepo, recordedSha, untouchedBaseSha);
    results.push(
      check(
        'reuse: ledger entry has no recorded artifact hashes -> RUN_BASE',
        rNoArms.verdict === 'RUN_BASE' && /artifact hashes/.test(rNoArms.reason),
        rNoArms,
      ),
    );

    // Blocker (PR #1352 review), side branch: `recorded`=touchedBaseSha and
    // `base`=untouchedBaseSha are SIBLING children of `recordedSha` — neither
    // is an ancestor of the other — so a plain `--merge-base` diff would
    // diff their shared ancestor against base, missing `recorded`'s OWN
    // closure edit (sweepArms.ts) entirely. Must fail closed on the ancestor
    // check before ever reaching that diff.
    writeLedger({ runs: [{ sha: touchedBaseSha, arms: { base1: 'deadbeef' } }] });
    const rSideBranch = computeReuseVerdict(reuseRepo, touchedBaseSha, untouchedBaseSha);
    results.push(
      check(
        'reuse: recorded sits on a divergent side branch (not an ancestor of base) -> RUN_BASE',
        rSideBranch.verdict === 'RUN_BASE' && /not an ancestor/.test(rSideBranch.reason),
        rSideBranch,
      ),
    );

    // Blocker (PR #1352 review), descendant: `recorded`=touchedBaseSha is a
    // DESCENDANT of `base`=recordedSha (a misordered call, or a ledger SHA
    // newer than the base being checked) — merge-base(recorded, base)
    // collapses to `base` itself, so the diff is EMPTY regardless of real
    // changes between them. Same ledger entry as the row above.
    const rDescendant = computeReuseVerdict(reuseRepo, touchedBaseSha, recordedSha);
    results.push(
      check(
        'reuse: recorded is a DESCENDANT of base (misordered call) -> RUN_BASE',
        rDescendant.verdict === 'RUN_BASE' && /not an ancestor/.test(rDescendant.reason),
        rDescendant,
      ),
    );

    // Major (PR #1352 review): an AMBIGUOUS SHA prefix matching MORE THAN
    // ONE ledger entry must never silently resolve to whichever sorts
    // first — unlike `git rev-parse`'s own ambiguity error, a first-match
    // lookup here would certify a DIFFERENT run's artifacts than intended.
    // Synthetic (non-git) SHA strings are fine: the ambiguity check returns
    // before any `git rev-parse` call is made. #1361 (issue item 3): the
    // reason string now says "ambiguous", distinct from a genuine no-match.
    writeLedger({
      runs: [
        { sha: 'aaaaaaaa1111111111111111111111111111aaaa', arms: { base1: 'deadbeef' } },
        { sha: 'aaaaaaaa2222222222222222222222222222bbbb', arms: { base1: 'deadbeef' } },
      ],
    });
    const rAmbiguous = computeReuseVerdict(reuseRepo, 'aaaaaaaa', untouchedBaseSha);
    results.push(
      check(
        'reuse: an ambiguous SHA prefix (matches 2 ledger entries) -> RUN_BASE, reason says "ambiguous" not "unknown"',
        rAmbiguous.verdict === 'RUN_BASE' &&
          /ambiguous recorded run/.test(rAmbiguous.reason) &&
          !/unknown recorded run/.test(rAmbiguous.reason),
        rAmbiguous,
      ),
    );

    // Major (PR #1352 review): a prefix shorter than 7 characters is
    // refused outright, even where it happens to match exactly one entry
    // today — a shorter prefix risks colliding with a future ledger entry.
    // #1361: its own reason string ("too short"), distinct from both
    // "unknown" and "ambiguous".
    writeLedger({ runs: [{ sha: recordedSha, arms: { base1: 'deadbeef' } }] });
    const rShortPrefix = computeReuseVerdict(reuseRepo, recordedSha.slice(0, 6), untouchedBaseSha);
    results.push(
      check(
        'reuse: a SHA prefix shorter than 7 characters is refused -> RUN_BASE, reason says "too short"',
        rShortPrefix.verdict === 'RUN_BASE' && /too short to disambiguate/.test(rShortPrefix.reason),
        rShortPrefix,
      ),
    );
  } finally {
    rmSync(reuseRepo, { recursive: true, force: true });
  }

  // Blocker (PR #1352 review): the closure verdict must come from the
  // RECORDED and BASE trees, never from whatever this process's OWN
  // working tree happens to have checked out. `lib/extra.ts` sits OUTSIDE
  // every PATH_PREFIXES directory (app/sweep, app/public/data, pipeline),
  // so its closure membership is genuinely CONTENT-dependent on the import
  // walk — a directory-prefix match could otherwise mask this bug
  // regardless of what the import walk itself saw.
  const blocker2Repo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-blocker2-'));
  try {
    const git2 = (args) => execFileSync('git', args, { cwd: blocker2Repo, encoding: 'utf8' });
    git2(['init', '-q']);
    git2(['config', 'user.email', 'selftest@example.invalid']);
    git2(['config', 'user.name', 'sweep-closure selftest']);
    mkdirSync(path.join(blocker2Repo, 'app', 'sweep'), { recursive: true });
    mkdirSync(path.join(blocker2Repo, 'lib'), { recursive: true });
    writeFileSync(path.join(blocker2Repo, 'lib', 'extra.ts'), 'export const EXTRA = 1;\n');
    writeFileSync(
      path.join(blocker2Repo, 'app', 'sweep', 'sweepArms.ts'),
      "import '../../lib/extra.ts';\nexport const ARMS = 1;\n",
    );
    writeFileSync(path.join(blocker2Repo, 'app', 'sweep', 'vitest.config.ts'), 'export default {};\n');
    git2(['add', '-A']);
    git2(['commit', '-q', '-m', 'recorded']);
    const recorded3Sha = git2(['rev-parse', 'HEAD']).trim();

    // base3: child of recorded3, changes ONLY lib/extra.ts — a genuine
    // closure-member edit that base3's OWN (unchanged) sweepArms.ts still
    // imports.
    writeFileSync(path.join(blocker2Repo, 'lib', 'extra.ts'), 'export const EXTRA = 2;\n');
    git2(['add', '-A']);
    git2(['commit', '-q', '-m', 'base changes extra.ts']);
    const base3Sha = git2(['rev-parse', 'HEAD']).trim();

    // feature3: a SEPARATE child of recorded3 that drops the import —
    // checked out as this repo's OWN HEAD below, so a working-tree-based
    // closure walk (the pre-fix behaviour) would see a sweepArms.ts that
    // does NOT import lib/extra.ts at all.
    git2(['checkout', '-q', recorded3Sha]);
    writeFileSync(path.join(blocker2Repo, 'app', 'sweep', 'sweepArms.ts'), 'export const ARMS = 1;\n');
    git2(['add', '-A']);
    git2(['commit', '-q', '-m', 'feature drops the import']);
    // Stays checked out on `feature3` — computeReuseVerdict must still
    // return the correct verdict for recorded3/base3 despite this.

    const ledgerDir2 = path.join(blocker2Repo, '.claude', 'skills', 'sweep-closure');
    mkdirSync(ledgerDir2, { recursive: true });
    writeFileSync(
      path.join(ledgerDir2, 'recorded-runs.json'),
      JSON.stringify({ runs: [{ sha: recorded3Sha, arms: { base1: 'deadbeef' } }] }),
    );

    const rCheckoutIndependent = computeReuseVerdict(blocker2Repo, recorded3Sha, base3Sha);
    results.push(
      check(
        "reuse: verdict is independent of the caller's own checked-out tree (a closure member changed off-tree) -> RUN_BASE",
        rCheckoutIndependent.verdict === 'RUN_BASE',
        rCheckoutIndependent,
      ),
    );
  } finally {
    rmSync(blocker2Repo, { recursive: true, force: true });
  }

  // #1359 PR #1384 review round 3 (M9 pin): `computeReuseVerdict`'s own
  // `unionClosures` call is unpinned by every existing row above.
  // Reverting `computeReuseVerdict`'s union back to a naive last-write-wins
  // spread leaves ALL prior rows green. Unfixed shape: `recorded` has an
  // EXTRA_EDGES target (setup.ts) present; `base` (a direct child of
  // `recorded`) deletes it. `unionClosures` must keep the present
  // `recorded`-side entry -> RUN_BASE; a naive spread lets `base`'s missing
  // entry win -> a false REUSE that certifies a base it never measured.
  const reuseMissingRepo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-reuse-missing-'));
  try {
    const git = (args) => execFileSync('git', args, { cwd: reuseMissingRepo, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'selftest@example.invalid']);
    git(['config', 'user.name', 'sweep-closure selftest']);
    mkdirSync(path.join(reuseMissingRepo, 'app', 'sweep'), { recursive: true });
    mkdirSync(path.join(reuseMissingRepo, 'app', 'src', 'test'), { recursive: true });
    writeFileSync(path.join(reuseMissingRepo, 'app', 'sweep', 'sweepArms.ts'), 'export const ARMS = 1;\n');
    writeFileSync(path.join(reuseMissingRepo, 'app', 'sweep', 'vitest.config.ts'), 'export default {};\n');
    writeFileSync(path.join(reuseMissingRepo, 'app', 'src', 'test', 'setup.ts'), 'export const SETUP = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'recorded, setup.ts present']);
    const recordedSha = git(['rev-parse', 'HEAD']).trim();

    git(['rm', '-q', 'app/src/test/setup.ts']);
    git(['commit', '-q', '-m', 'base deletes setup.ts']);
    const baseSha = git(['rev-parse', 'HEAD']).trim();

    const ledgerDir3 = path.join(reuseMissingRepo, '.claude', 'skills', 'sweep-closure');
    mkdirSync(ledgerDir3, { recursive: true });
    writeFileSync(
      path.join(ledgerDir3, 'recorded-runs.json'),
      JSON.stringify({ runs: [{ sha: recordedSha, arms: { base1: 'deadbeef' } }] }),
    );

    const rMissingPrecedence = computeReuseVerdict(reuseMissingRepo, recordedSha, baseSha);
    results.push(
      check(
        'reuse M9 pin: base deletes an EXTRA_EDGES target (setup.ts) present at recorded -> RUN_BASE, never a false REUSE via missing-precedence',
        rMissingPrecedence.verdict === 'RUN_BASE',
        rMissingPrecedence,
      ),
    );
  } finally {
    rmSync(reuseMissingRepo, { recursive: true, force: true });
  }

  // #1361: the MIRROR of the M9 pin above. `closureAtRecorded` ALONE passes
  // every prior reuse row including M9 (confirmed empirically), so M9 pins
  // only the `closureAtBase` half of the union. This row pins the
  // `closureAtRecorded` half: `recorded` lacks the EXTRA_EDGES target
  // (setup.ts), `base` (a child of `recorded`) ADDS it. `changedFiles`
  // lists the addition; `closureAtBase` sees it present, but
  // `closureAtRecorded` alone marks it `{missing: true}` and a
  // recorded-only walk would miss it entirely -> a false REUSE.
  const reuseAddedRepo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-reuse-added-'));
  try {
    const git = (args) => execFileSync('git', args, { cwd: reuseAddedRepo, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'selftest@example.invalid']);
    git(['config', 'user.name', 'sweep-closure selftest']);
    mkdirSync(path.join(reuseAddedRepo, 'app', 'sweep'), { recursive: true });
    writeFileSync(path.join(reuseAddedRepo, 'app', 'sweep', 'sweepArms.ts'), 'export const ARMS = 1;\n');
    writeFileSync(path.join(reuseAddedRepo, 'app', 'sweep', 'vitest.config.ts'), 'export default {};\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'recorded, setup.ts absent']);
    const recordedSha = git(['rev-parse', 'HEAD']).trim();

    mkdirSync(path.join(reuseAddedRepo, 'app', 'src', 'test'), { recursive: true });
    writeFileSync(path.join(reuseAddedRepo, 'app', 'src', 'test', 'setup.ts'), 'export const SETUP = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base adds setup.ts']);
    const baseSha = git(['rev-parse', 'HEAD']).trim();

    const ledgerDir4 = path.join(reuseAddedRepo, '.claude', 'skills', 'sweep-closure');
    mkdirSync(ledgerDir4, { recursive: true });
    writeFileSync(
      path.join(ledgerDir4, 'recorded-runs.json'),
      JSON.stringify({ runs: [{ sha: recordedSha, arms: { base1: 'deadbeef' } }] }),
    );

    const rAddedPrecedence = computeReuseVerdict(reuseAddedRepo, recordedSha, baseSha);
    results.push(
      check(
        'reuse #1361 pin: base ADDS an EXTRA_EDGES target (setup.ts) absent at recorded -> RUN_BASE, never a false REUSE via a recorded-only walk',
        rAddedPrecedence.verdict === 'RUN_BASE',
        rAddedPrecedence,
      ),
    );
  } finally {
    rmSync(reuseAddedRepo, { recursive: true, force: true });
  }

  // #1361 (issue item 2): a FAILED `git worktree add` must not leave an
  // empty temp dir behind. `withRefCheckout` calls `mkdtempSync` before
  // `git worktree add`, so a bad ref (git refuses before ever registering
  // the worktree) exercises the add-failure `catch` specifically, not the
  // steady-state `finally`. Diffing `readdirSync(tmpdir())` before/after
  // (a SET difference, not a count — other processes may share tmpdir())
  // catches a leaked `sweep-closure-ref-*` directory either way.
  const wtFailRepo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-wtfail-'));
  try {
    const git = (args) => execFileSync('git', args, { cwd: wtFailRepo, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'selftest@example.invalid']);
    git(['config', 'user.name', 'sweep-closure selftest']);
    writeFileSync(path.join(wtFailRepo, 'README.md'), 'v1\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);

    const before = new Set(readdirSync(tmpdir()));
    let threw = false;
    try {
      withRefCheckout(wtFailRepo, 'refs/heads/no-such-branch', (dir) => computeClosure(dir));
    } catch {
      threw = true;
    }
    const after = readdirSync(tmpdir());
    const leaked = after.filter((name) => !before.has(name) && name.startsWith('sweep-closure-ref-'));
    results.push(
      check(
        'withRefCheckout #1361 pin: a FAILED git worktree add leaves no leaked sweep-closure-ref-* temp dir',
        threw && leaked.length === 0,
        { threw, leaked },
      ),
    );
  } finally {
    rmSync(wtFailRepo, { recursive: true, force: true });
  }

  // #1359: `diff`'s own closure walk must be independent of the caller's
  // checked-out tree, exactly the property blocker2Repo above proves for
  // `reuse`. Same shape, one command over: `sweepArms.ts` imports
  // `lib/extra.ts` at `baseCommit`; `headCommit` (a child of `baseCommit`)
  // changes ONLY `lib/extra.ts` — a genuine closure-member edit `diff
  // baseCommit headCommit` must report OWED. `featureCommit` is a SEPARATE
  // child of `baseCommit` that drops the import, and is left CHECKED OUT as
  // this repo's own HEAD — so a closure walk over the checked-out tree (the
  // pre-#1359 `computeClosure(root)` call inside `cmdDiff`) sees a
  // `sweepArms.ts` that does NOT import `lib/extra.ts` at all, and would
  // report `lib/extra.ts` NOT_IN_CLOSURE regardless of the real
  // `baseCommit..headCommit` diff.
  const diffRepo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-diff-'));
  try {
    const git3 = (args) => execFileSync('git', args, { cwd: diffRepo, encoding: 'utf8' });
    git3(['init', '-q']);
    git3(['config', 'user.email', 'selftest@example.invalid']);
    git3(['config', 'user.name', 'sweep-closure selftest']);
    mkdirSync(path.join(diffRepo, 'app', 'sweep'), { recursive: true });
    mkdirSync(path.join(diffRepo, 'lib'), { recursive: true });
    writeFileSync(path.join(diffRepo, 'lib', 'extra.ts'), 'export const EXTRA = 1;\n');
    writeFileSync(
      path.join(diffRepo, 'app', 'sweep', 'sweepArms.ts'),
      "import '../../lib/extra.ts';\nexport const ARMS = 1;\n",
    );
    writeFileSync(path.join(diffRepo, 'app', 'sweep', 'vitest.config.ts'), 'export default {};\n');
    git3(['add', '-A']);
    git3(['commit', '-q', '-m', 'base']);
    const diffBaseSha = git3(['rev-parse', 'HEAD']).trim();

    // headCommit: child of baseCommit, changes ONLY lib/extra.ts.
    writeFileSync(path.join(diffRepo, 'lib', 'extra.ts'), 'export const EXTRA = 2;\n');
    git3(['add', '-A']);
    git3(['commit', '-q', '-m', 'head changes extra.ts']);
    const diffHeadSha = git3(['rev-parse', 'HEAD']).trim();

    // featureCommit: a SEPARATE child of baseCommit that drops the import —
    // checked out as this repo's OWN HEAD below.
    git3(['checkout', '-q', diffBaseSha]);
    writeFileSync(path.join(diffRepo, 'app', 'sweep', 'sweepArms.ts'), 'export const ARMS = 1;\n');
    git3(['add', '-A']);
    git3(['commit', '-q', '-m', 'feature drops the import']);
    // Stays checked out on `feature` — computeDiffVerdict must still return
    // the correct verdict for diffBaseSha/diffHeadSha despite this.

    const dResult = computeDiffVerdict(diffRepo, diffBaseSha, diffHeadSha);
    const extraHit = dResult.results.find((r) => r.f === 'lib/extra.ts');
    results.push(
      check(
        "diff: closure computed at base/head, not the checked-out tree — lib/extra.ts changed only reachable via base/head's own import graph -> OWED (#1359)",
        extraHit !== undefined && extraHit.verdict.verdict === 'OWED',
        { results: dResult.results },
      ),
    );
  } finally {
    rmSync(diffRepo, { recursive: true, force: true });
  }

  /**
   * Inits a disposable git repo with `app/sweep/sweepArms.ts` (importing
   * `../../lib/extra.ts`, so it lands in `lib/`, outside every
   * PATH_PREFIXES directory — membership is genuinely import-walk-dependent,
   * same reasoning as `lib/extra.ts` above and `lib/extra.ts` in
   * blocker2Repo) plus `app/sweep/vitest.config.ts`, and commits it. Shared
   * by the five #1359 mutation-check fixtures below to cut the
   * init-a-repo boilerplate five ways; the git-plumbing PATTERN (branch
   * back, commit a sibling) still matches diffRepo/blocker2Repo above.
   */
  function initClosureRepo(dir, sweepArmsBody) {
    const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'selftest@example.invalid']);
    git(['config', 'user.name', 'sweep-closure selftest']);
    mkdirSync(path.join(dir, 'app', 'sweep'), { recursive: true });
    mkdirSync(path.join(dir, 'lib'), { recursive: true });
    writeFileSync(path.join(dir, 'app', 'sweep', 'sweepArms.ts'), sweepArmsBody);
    writeFileSync(path.join(dir, 'app', 'sweep', 'vitest.config.ts'), 'export default {};\n');
    return git;
  }

  // #1359 PR #1384 review, Major (fix #1 pin): head DELETES an EXTRA_EDGES
  // target (app/src/test/setup.ts) — the exact repro from the review
  // comment. Before `unionClosures`, head's `{missing:true}` placeholder
  // silently overwrote mergeBase's real entry (last-write-wins spread), so
  // this read NOT OWED; it must read OWED, because deleting a closure
  // member is itself a closure-affecting change.
  //
  // `base` ALSO deletes setup.ts (independently, as a sibling of `head` off
  // the same true merge-base) — deliberately, not merely `base == mergeBase`.
  // With `base` unioned as a THIRD term (fix #3) and `base == mergeBase`
  // this row would pass even under a NAIVE last-write-wins spread, because
  // `base`'s own (present) entry is spread LAST and accidentally
  // "re-wins" over head's missing one — an ordering accident that would
  // mask exactly the bug this row exists to catch. Making `base` a sibling
  // that ALSO lacks the file removes that accidental rescue: only the
  // mergeBase term is present, and it must win on PRECEDENCE (via
  // `unionClosures`), never on argument order.
  const fix1Repo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-fix1-'));
  try {
    const git = initClosureRepo(fix1Repo, 'export const ARMS = 1;\n');
    mkdirSync(path.join(fix1Repo, 'app', 'src', 'test'), { recursive: true });
    writeFileSync(path.join(fix1Repo, 'app', 'src', 'test', 'setup.ts'), 'export const SETUP = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'true merge-base, setup.ts present']);
    const mergeBaseSha = git(['rev-parse', 'HEAD']).trim();

    // `base` arg: sibling that deletes setup.ts.
    git(['rm', '-q', 'app/src/test/setup.ts']);
    git(['commit', '-q', '-m', 'base deletes setup.ts']);
    const baseArgSha = git(['rev-parse', 'HEAD']).trim();

    // `head` arg: a SEPARATE sibling off the same merge-base that also
    // (independently) deletes setup.ts.
    git(['checkout', '-q', mergeBaseSha]);
    git(['rm', '-q', 'app/src/test/setup.ts']);
    git(['commit', '-q', '-m', 'head independently deletes setup.ts']);
    const headArgSha = git(['rev-parse', 'HEAD']).trim();

    const result = computeDiffVerdict(fix1Repo, baseArgSha, headArgSha);
    const hit = result.results.find((r) => r.f === 'app/src/test/setup.ts');
    results.push(
      check(
        'diff fix #1 pin: head deletes an EXTRA_EDGES target (setup.ts), base independently deletes it too -> OWED via mergeBase precedence, never via argument order',
        hit !== undefined && hit.verdict.verdict === 'OWED',
        { results: result.results },
      ),
    );
  } finally {
    rmSync(fix1Repo, { recursive: true, force: true });
  }

  // #1359 PR #1384 review, Major (M2 pin): head-ONLY closure member — head
  // newly imports AND creates lib/newhead.ts; base/mergeBase have neither
  // the import nor the file. Dropping the HEAD half of the union (M2) loses
  // this row: mergeBase's and base's closures both lack lib/newhead.ts, so
  // only the head term can see it.
  const m2Repo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-m2-'));
  try {
    const git = initClosureRepo(m2Repo, 'export const ARMS = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base, no import']);
    const baseSha = git(['rev-parse', 'HEAD']).trim();

    writeFileSync(path.join(m2Repo, 'lib', 'newhead.ts'), 'export const NEWHEAD = 1;\n');
    writeFileSync(
      path.join(m2Repo, 'app', 'sweep', 'sweepArms.ts'),
      "import '../../lib/newhead.ts';\nexport const ARMS = 1;\n",
    );
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'head adds and imports newhead.ts']);
    const headSha = git(['rev-parse', 'HEAD']).trim();

    const result = computeDiffVerdict(m2Repo, baseSha, headSha);
    const hit = result.results.find((r) => r.f === 'lib/newhead.ts');
    results.push(
      check(
        'diff M2 pin: head-only closure member (newly imported AND created on head) -> OWED; dropping the head half of the union loses it',
        hit !== undefined && hit.verdict.verdict === 'OWED',
        { results: result.results },
      ),
    );
  } finally {
    rmSync(m2Repo, { recursive: true, force: true });
  }

  // #1359 PR #1384 review, Major (M3+M4 pin, ONE fixture discriminates
  // both): the TRUE merge-base (c0) imports lib/oldbase.ts; BOTH `base` and
  // `head` are children of c0 that independently drop the import (base does
  // not touch lib/oldbase.ts; head also edits its content). So the file is
  // visible ONLY via the mergeBase term computed from the real
  // git-merge-base commit.
  //   M3 (drop the merge-base half of the union entirely) loses it: the
  //   remaining head/base terms both lack the import.
  //   M4 (compute the "merge-base" term from `base` itself instead of the
  //   true merge-base) ALSO loses it here, because `base`'s own closure
  //   lacks the import too (by construction) — a mutant that skips the real
  //   `git merge-base` call produces the same observable failure as one that
  //   drops the term outright, so ONE fixture pins both; `base` here is a
  //   SIBLING of `head` (neither an ancestor of the other), satisfying M4's
  //   "base is not an ancestor of head" precondition too.
  const m3m4Repo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-m3m4-'));
  try {
    const git = initClosureRepo(
      m3m4Repo,
      "import '../../lib/oldbase.ts';\nexport const ARMS = 1;\n",
    );
    writeFileSync(path.join(m3m4Repo, 'lib', 'oldbase.ts'), 'export const OLDBASE = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'true merge-base, imports oldbase.ts']);
    const mergeBaseSha = git(['rev-parse', 'HEAD']).trim();

    // `base` arg: drops the import, does not touch lib/oldbase.ts.
    writeFileSync(path.join(m3m4Repo, 'app', 'sweep', 'sweepArms.ts'), 'export const ARMS = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base drops the import']);
    const baseArgSha = git(['rev-parse', 'HEAD']).trim();

    // `head` arg: sibling of `base` off the true merge-base — also drops
    // the import (independently) AND edits lib/oldbase.ts.
    git(['checkout', '-q', mergeBaseSha]);
    writeFileSync(path.join(m3m4Repo, 'app', 'sweep', 'sweepArms.ts'), 'export const ARMS = 1;\n');
    writeFileSync(path.join(m3m4Repo, 'lib', 'oldbase.ts'), 'export const OLDBASE = 2;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'head drops the import and edits oldbase.ts']);
    const headArgSha = git(['rev-parse', 'HEAD']).trim();

    const result = computeDiffVerdict(m3m4Repo, baseArgSha, headArgSha);
    const hit = result.results.find((r) => r.f === 'lib/oldbase.ts');
    results.push(
      check(
        'diff M3+M4 pin: merge-base-only closure member (base and head both independently drop the import) -> OWED; dropping the merge-base term, or computing it from `base` instead of the real merge-base, both lose it',
        hit !== undefined && hit.verdict.verdict === 'OWED',
        { results: result.results },
      ),
    );
  } finally {
    rmSync(m3m4Repo, { recursive: true, force: true });
  }

  // #1359 PR #1384 review, Minor (fix #3 pin): `base` ADDS an import AFTER
  // the fork point; `head` (a sibling forked from the SAME true merge-base,
  // before the import existed) only edits that file's content. Neither the
  // mergeBase term nor the head term can see the import — ONLY unioning
  // `base`'s own closure (fix #3) surfaces it. Deleting that third union
  // term reds this row specifically.
  const fix3Repo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-fix3-'));
  try {
    const git = initClosureRepo(fix3Repo, 'export const ARMS = 1;\n');
    writeFileSync(path.join(fix3Repo, 'lib', 'x.ts'), 'export const X = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'true merge-base, no import yet']);
    const mergeBaseSha = git(['rev-parse', 'HEAD']).trim();

    // `base` arg: adds the import after the fork.
    writeFileSync(
      path.join(fix3Repo, 'app', 'sweep', 'sweepArms.ts'),
      "import '../../lib/x.ts';\nexport const ARMS = 1;\n",
    );
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base adds the import']);
    const baseArgSha = git(['rev-parse', 'HEAD']).trim();

    // `head` arg: sibling forked from the SAME merge-base, before the
    // import existed — only edits lib/x.ts.
    git(['checkout', '-q', mergeBaseSha]);
    writeFileSync(path.join(fix3Repo, 'lib', 'x.ts'), 'export const X = 2;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'head edits x.ts, forked before the import']);
    const headArgSha = git(['rev-parse', 'HEAD']).trim();

    const result = computeDiffVerdict(fix3Repo, baseArgSha, headArgSha);
    const hit = result.results.find((r) => r.f === 'lib/x.ts');
    results.push(
      check(
        "diff fix #3 pin: base adds an import after the fork; head (forked earlier) edits that file -> OWED via base's own unioned closure",
        hit !== undefined && hit.verdict.verdict === 'OWED',
        { results: result.results },
      ),
    );
  } finally {
    rmSync(fix3Repo, { recursive: true, force: true });
  }

  // #1359 PR #1384 review, M5 (omitted-head pin): with `head` omitted,
  // `computeClosureForDiff` must read the WORKING TREE (`computeClosure(root)`),
  // not the committed HEAD ref. An UNCOMMITTED (staged) edit adds an import
  // and a new file; `base` is the current HEAD commit itself (so
  // mergeBase(base,HEAD) === base, isolating the head TERM as the only one
  // that can see the staged edit). M5 (checkout HEAD instead of reading the
  // live tree) loses this row, since the staged changes are invisible to a
  // fresh `git worktree add` of the committed HEAD.
  const m5Repo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-m5-'));
  try {
    const git = initClosureRepo(m5Repo, 'export const ARMS = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base == HEAD, no import']);
    const baseSha = git(['rev-parse', 'HEAD']).trim();

    // Uncommitted (staged, never committed) working-tree edit.
    writeFileSync(path.join(m5Repo, 'lib', 'z.ts'), 'export const Z = 1;\n');
    writeFileSync(
      path.join(m5Repo, 'app', 'sweep', 'sweepArms.ts'),
      "import '../../lib/z.ts';\nexport const ARMS = 1;\n",
    );
    git(['add', '-A']); // staged, not committed — `head` argument stays omitted (working tree)

    const result = computeDiffVerdict(m5Repo, baseSha, undefined);
    const hit = result.results.find((r) => r.f === 'lib/z.ts');
    results.push(
      check(
        'diff M5 pin: head omitted uses the WORKING TREE, not the committed HEAD ref -> uncommitted lib/z.ts import reads OWED',
        hit !== undefined && hit.verdict.verdict === 'OWED',
        { results: result.results },
      ),
    );
  } finally {
    rmSync(m5Repo, { recursive: true, force: true });
  }

  // #944: additive-export rule. Pure rows run classifyAdditiveExports on real
  // `git diff --no-index` output against a hand-built loadable-file index;
  // the two real-git rows below go through computeDiffVerdict end to end.
  const ADD_TARGET = 'app/src/lib/extra.ts';
  const ADD_BASE = `import type { SailId } from './types';

export const LIMIT = 3;

export const BOATS = [
  { id: 'a', draftM: 2.1 },
];

export function boatById(id: string) {
  return BOATS.find((b) => b.id === id);
}
`;
  const importer = (text) => [
    'app/src/routing/planRoute.ts',
    { text, refs: moduleRefs(text).map((r) => (r.spec !== undefined ? { ...r, target: ADD_TARGET } : r)) },
  ];
  const addUniverse = (importerText = "import { boatById } from '../lib/extra';\n") => [
    new Map([[ADD_TARGET, { text: ADD_BASE, refs: [] }], importer(importerText)]),
  ];
  const addTmp = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-additive-'));
  try {
    const addOld = path.join(addTmp, 'old.ts');
    writeFileSync(addOld, ADD_BASE);
    let n = 0;
    const additive = (newContent, universes = addUniverse()) => {
      const f = path.join(addTmp, `new${n++}.ts`);
      writeFileSync(f, newContent);
      return classifyAdditiveExports({
        targetRel: ADD_TARGET,
        oldContent: ADD_BASE,
        newContent,
        diffText: gitDiffNoIndex(addOld, f),
        universes,
      });
    };
    const GENOA = ADD_BASE + "\n// The genoa sail id.\nexport const GENOA_SAIL_ID: SailId = 'genoa';\n";

    const a1 = additive(GENOA);
    results.push(
      check(
        '#944 additive: an appended, unreferenced export const with a literal initializer -> NOT_OWED',
        a1.verdict === 'NOT_OWED' && a1.evidence.names.join() === 'GENOA_SAIL_ID',
        a1,
      ),
    );

    const a2 = additive(
      ADD_BASE +
        '\nexport function double(x: number): number {\n  return x * 2;\n}\n\nexport interface Extra {\n  readonly a: number;\n}\n\nexport type Pair = { a: 1; b: 2 };\n',
    );
    results.push(
      check(
        '#944 additive: appended export function / interface / type, unreferenced -> NOT_OWED',
        a2.verdict === 'NOT_OWED' && a2.evidence.names.join() === 'double,Extra,Pair',
        a2,
      ),
    );

    const a3 = additive(withReplacement(ADD_BASE, 'export const LIMIT = 3;', 'export const LIMIT = 4;'));
    results.push(
      check(
        '#944 additive: a CHANGED existing export -> OWED',
        a3.verdict === 'OWED' && /modifies or removes existing lines/.test(a3.reason),
        a3,
      ),
    );

    const a4 = additive(GENOA, addUniverse("import { boatById, GENOA_SAIL_ID } from '../lib/extra';\n"));
    results.push(
      check(
        '#944 additive: a loadable file imports the new export by name -> OWED',
        a4.verdict === 'OWED' && /is referenced by app\/src\/routing\/planRoute\.ts/.test(a4.reason),
        a4,
      ),
    );

    const a5 = additive(GENOA, addUniverse("import * as extra from '../lib/extra';\n"));
    results.push(
      check(
        '#944 additive: a loadable file namespace-imports the module (never names the export) -> OWED',
        a5.verdict === 'OWED' && /namespace\/star\/dynamic import/.test(a5.reason),
        a5,
      ),
    );

    const a6 = additive(GENOA, addUniverse('const m = await import(somePath);\n'));
    results.push(
      check(
        '#944 additive: a loadable file has an unresolvable dynamic import -> OWED',
        a6.verdict === 'OWED' && /cannot resolve/.test(a6.reason),
        a6,
      ),
    );

    const a7 = additive(ADD_BASE + '\nexport let COUNTER = 0;\n');
    results.push(
      check(
        '#944 additive: inserted text the parser does not accept (export let) -> OWED',
        a7.verdict === 'OWED' && /unrecognised top-level statement/.test(a7.reason),
        a7,
      ),
    );

    const a7b = additive(ADD_BASE + '\nexport const BROKEN = { a: 1;\n');
    results.push(
      check(
        '#944 additive: inserted text that leaves the file unbalanced -> OWED',
        a7b.verdict === 'OWED' && /does not lex to balanced top-level code/.test(a7b.reason),
        a7b,
      ),
    );

    const a8 = additive(withReplacement(ADD_BASE, "  { id: 'a', draftM: 2.1 },\n", "  { id: 'a', draftM: 2.1 },\n  { id: 'b', draftM: 1.9 },\n"));
    results.push(
      check(
        '#944 additive: an element appended to the BOATS array (a pure insertion) -> OWED',
        a8.verdict === 'OWED',
        a8,
      ),
    );

    // Parses as a valid export on its own; only the top-level check sees it
    // lands inside the BOATS array.
    const a12 = additive(withReplacement(ADD_BASE, "  { id: 'a', draftM: 2.1 },\n", "  { id: 'a', draftM: 2.1 },\nexport const NESTED = 1;\n"));
    results.push(
      check(
        '#944 additive: an export-shaped line inserted INSIDE the BOATS array -> OWED',
        a12.verdict === 'OWED' && /not at module top level/.test(a12.reason),
        a12,
      ),
    );

    // PR #1450 review: ASI ends the declaration at the newline, so the
    // next line runs as its own statement.
    const aTypeAsi = additive(ADD_BASE + '\nexport type ZzqT = number\nBOATS.pop()\n;\n');
    results.push(
      check(
        '#944 additive: an export type whose span hides an ASI-separated statement (BOATS.pop()) -> OWED',
        aTypeAsi.verdict === 'OWED' && /depth-0 newline/.test(aTypeAsi.reason),
        aTypeAsi,
      ),
    );
    const aFnAsi = additive(ADD_BASE + '\nexport function zzqF(): void\nBOATS.pop();\n');
    results.push(
      check(
        '#944 additive: a bodyless export function followed by BOATS.pop(); -> OWED',
        aFnAsi.verdict === 'OWED' && /has no body/.test(aFnAsi.reason),
        aFnAsi,
      ),
    );

    const a9 = additive(ADD_BASE + "\nexport const EXTRA_COUNT = BOATS.push({ id: 'c', draftM: 1.8 });\n");
    results.push(
      check(
        '#944 additive: a new export whose initializer runs code (BOATS.push) -> OWED',
        a9.verdict === 'OWED' && /identifier 'BOATS'/.test(a9.reason),
        a9,
      ),
    );

    const a10 = additive(ADD_BASE + '\nexport function find(): void {}\n');
    results.push(
      check(
        '#944 additive: a new name the old file already mentions (possible shadowing) -> OWED',
        a10.verdict === 'OWED' && /already appears in the old file/.test(a10.reason),
        a10,
      ),
    );

    // The inserted line parses as an export, but lands inside a multi-line
    // template literal, so it changes that string's value.
    const TPL_OLD = 'export const MSG = `first\nsecond\n`;\n';
    const tplOldFile = path.join(addTmp, 'tpl-old.ts');
    writeFileSync(tplOldFile, TPL_OLD);
    const tplNew = 'export const MSG = `first\nexport const X = 1;\nsecond\n`;\n';
    const tplNewFile = path.join(addTmp, 'tpl-new.ts');
    writeFileSync(tplNewFile, tplNew);
    const a11 = classifyAdditiveExports({
      targetRel: ADD_TARGET,
      oldContent: TPL_OLD,
      newContent: tplNew,
      diffText: gitDiffNoIndex(tplOldFile, tplNewFile),
      universes: [new Map([[ADD_TARGET, { text: TPL_OLD, refs: [] }]])],
    });
    results.push(
      check(
        '#944 additive: an export-shaped line inserted inside a multi-line template literal -> OWED',
        a11.verdict === 'OWED' && /inside a string or comment/.test(a11.reason),
        a11,
      ),
    );
  } finally {
    rmSync(addTmp, { recursive: true, force: true });
  }

  const addRepo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-additive-git-'));
  try {
    const git = initClosureRepo(addRepo, "import { A } from '../../lib/extra.ts';\nexport const ARMS = A;\n");
    writeFileSync(path.join(addRepo, 'lib', 'extra.ts'), 'export const A = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    const baseSha = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(addRepo, 'lib', 'extra.ts'), 'export const A = 1;\n\nexport const B = 2;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'head appends B']);
    const headSha = git(['rev-parse', 'HEAD']).trim();

    const dNotOwed = computeDiffVerdict(addRepo, baseSha, headSha);
    const hitNotOwed = dNotOwed.results.find((r) => r.f === 'lib/extra.ts');
    results.push(
      check(
        '#944 diff: real-git additive export on an import-walk member, unreferenced -> NOT OWED end to end',
        hitNotOwed !== undefined && hitNotOwed.verdict.verdict === 'NOT_OWED' && !dNotOwed.anyOwed,
        { results: dNotOwed.results },
      ),
    );

    // An arm file (loaded by vitest's glob, never reached by the walk) that
    // namespace-imports the module, present on both sides of the diff.
    git(['checkout', '-q', baseSha]);
    writeFileSync(
      path.join(addRepo, 'app', 'sweep', 'arm-x.test.ts'),
      "import * as extra from '../../lib/extra.ts';\nexport const N = Object.keys(extra).length;\n",
    );
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base with arm file']);
    const armBaseSha = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(addRepo, 'lib', 'extra.ts'), 'export const A = 1;\n\nexport const B = 2;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'head appends B']);
    const armHeadSha = git(['rev-parse', 'HEAD']).trim();

    const dArm = computeDiffVerdict(addRepo, armBaseSha, armHeadSha);
    const hitArm = dArm.results.find((r) => r.f === 'lib/extra.ts');
    results.push(
      check(
        '#944 diff: an app/sweep arm file (outside the import walk) namespace-imports the module -> OWED',
        hitArm !== undefined && hitArm.verdict.verdict === 'OWED' && /arm-x\.test\.ts/.test(hitArm.verdict.reason),
        { results: dArm.results },
      ),
    );
  } finally {
    rmSync(addRepo, { recursive: true, force: true });
  }

  // Namespace imports indexUniverse cannot resolve: a missing relative file,
  // and a bare specifier that may be a path alias for the target.
  const unresolvedRepo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-additive-unresolved-'));
  try {
    initClosureRepo(unresolvedRepo, 'export const ARMS = 1;\n');
    const arm = path.join(unresolvedRepo, 'app', 'sweep', 'arm-z.test.ts');
    const EXTRA_OLD = 'export const A = 1;\n';
    const EXTRA_NEW = 'export const A = 1;\n\nexport const B = 2;\n';
    const oldF = path.join(unresolvedRepo, 'old.ts');
    const newF = path.join(unresolvedRepo, 'new.ts');
    writeFileSync(oldF, EXTRA_OLD);
    writeFileSync(newF, EXTRA_NEW);
    const diffText = gitDiffNoIndex(oldF, newF);
    const verdictWith = (armText) => {
      writeFileSync(arm, armText);
      const universe = indexUniverse(unresolvedRepo, computeClosure(unresolvedRepo));
      universe.set('lib/extra.ts', { text: EXTRA_OLD, refs: [] });
      return classifyAdditiveExports({
        targetRel: 'lib/extra.ts',
        oldContent: EXTRA_OLD,
        newContent: EXTRA_NEW,
        diffText,
        universes: [universe],
      });
    };
    const uRel = verdictWith("import * as x from '../../lib/missing';\n");
    const uAlias = verdictWith("import * as x from '@/lib/extra';\n");
    const uControl = verdictWith("import * as p from 'node:path';\n");
    results.push(
      check(
        '#944 additive: an unresolved relative namespace import, or a bare one whose basename matches the target -> OWED (a bare unrelated one stays NOT_OWED)',
        uRel.verdict === 'OWED' &&
          /unresolved namespace import/.test(uRel.reason) &&
          uAlias.verdict === 'OWED' &&
          /may resolve to lib\/extra\.ts/.test(uAlias.reason) &&
          uControl.verdict === 'NOT_OWED',
        { uRel, uAlias, uControl },
      ),
    );
  } finally {
    rmSync(unresolvedRepo, { recursive: true, force: true });
  }

  // Working-tree mode: an UNTRACKED arm file names the new export. It is not
  // in the diff, but vitest's glob would still load it.
  const untrackedRepo = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-additive-untracked-'));
  try {
    const git = initClosureRepo(untrackedRepo, "import { A } from '../../lib/extra.ts';\nexport const ARMS = A;\n");
    writeFileSync(path.join(untrackedRepo, 'lib', 'extra.ts'), 'export const A = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    const baseSha = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(untrackedRepo, 'lib', 'extra.ts'), 'export const A = 1;\n\nexport const B = 2;\n');
    git(['add', 'lib/extra.ts']);
    writeFileSync(
      path.join(untrackedRepo, 'app', 'sweep', 'arm-u.test.ts'),
      "import { B } from '../../lib/extra.ts';\nexport const U = B;\n",
    );

    const dUntracked = computeDiffVerdict(untrackedRepo, baseSha, undefined);
    const hitUntracked = dUntracked.results.find((r) => r.f === 'lib/extra.ts');
    results.push(
      check(
        '#944 diff: head omitted, an UNTRACKED app/sweep arm file names the new export -> OWED',
        hitUntracked !== undefined &&
          hitUntracked.verdict.verdict === 'OWED' &&
          /arm-u\.test\.ts/.test(hitUntracked.verdict.reason),
        { results: dUntracked.results },
      ),
    );
  } finally {
    rmSync(untrackedRepo, { recursive: true, force: true });
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
    case 'reuse':
      cmdReuse(root, rest[0], rest[1]);
      break;
    case 'selftest':
      runSelftest(root);
      break;
    default:
      console.error('usage: closure.mjs <closure|files <path…>|diff <base> [<head>]|reuse <recorded> <base>|selftest>');
      process.exit(2);
  }
}

main();
