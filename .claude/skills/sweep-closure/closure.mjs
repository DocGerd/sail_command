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
 *    ships an unverified routing change). `app/src/data/boats.ts` carries
 *    TWO carve-outs from that default, both inside `classifyBoatsTs` below,
 *    both structurally provable rather than merely assumed: the
 *    `draftProvenance` field-level exemption (`BoatSnapshot` omits the
 *    field entirely), and (#944) an ADDITIVE-EXPORT exemption — a
 *    pure-insertion hunk that adds one or more complete new top-level
 *    `const`/`type`/`interface` declarations, none of whose EXPORTED names
 *    is imported by anything in the sweep's own closure, cannot move a
 *    single byte that closure ever reads. See `splitAdditiveDeclarations`
 *    and `collectClosureImportersOf` below for the reachability proof, and
 *    "Failure direction" for what it deliberately does NOT model.
 *
 * ## Failure direction — stated explicitly, per the issue's own request
 *
 * This tool is designed to OVER-REPORT, never under-report: every closure
 * hit is OWED by default, with exactly TWO modelled exceptions, both scoped
 * to `app/src/data/boats.ts` and both inside `classifyBoatsTs`:
 * the `draftProvenance`/`DraftProvenance` field-level span (see
 * `classifyBoatsTs`'s own doc comment for why that specific carve-out is
 * sound), and the #944 additive-export reachability check. It does NOT
 * attempt full data-flow/taint analysis of every field reachable from the
 * closure — e.g. it does NOT model whether `polarProvenance.note` (also
 * present in `boats.ts`, also copied into `BoatSnapshot`) can move a
 * `PlanResult`; CLAUDE.md's own "polarProvenance and draftProvenance have
 * DIFFERENT blast radii" bullet warns explicitly against assuming one
 * field's exemption transfers to the other, so a `polarProvenance`-only
 * edit is deliberately left at the default OWED verdict rather than
 * silently generalising the exception (see `selftest`'s
 * "narrow-scope-check" case) — and the additive-export check does NOT make
 * it exempt either, since a `polarProvenance.note` EDIT is a hunk that
 * MODIFIES existing lines (`oldCount > 0`), which the additive-export path
 * never even considers (see its own guard below).
 *
 * A PRIOR REVISION of this file made the stronger claim "never
 * under-reports" unconditionally — FALSIFIED in review (#729): the import
 * walk alone missed the nine `arm-*.test.ts` files and every runtime
 * data/pipeline input (Method step 2), so a diff confined to those reported
 * NOT OWED, exit 0. `PATH_PREFIXES` closes that MEASURED gap, but is itself
 * hand-maintained data (see its own header comment) rather than something
 * re-derived — so the honest claim is "over-reports against the modelled
 * universe below", not an unconditional guarantee. Extending EITHER
 * `PATH_PREFIXES` or either `boats.ts` exception needs the same structural
 * proof `classifyBoatsTs` gives, never a guess by analogy.
 *
 * The additive-export check's OWN residuals — REVISED after a review round
 * (#944) found the FIRST version of this paragraph over-claimed two of
 * these as open gaps when they were already closed, and under-claimed one
 * real gap it never named at all. Read this list as the current state, not
 * the original design intent; the three items below are the ones still
 * genuinely unmodelled, and every one of them fails OPEN to OWED, never
 * silently to NOT_OWED:
 *
 * 1. `require(...)` (a CommonJS dynamic-ish call) is not recognised by
 *    ANY of this file's regexes — `FROM_CLAUSE_RE` matches only ES
 *    `import`/`export ... from` syntax, and the dynamic-import scan
 *    (`findDynamicImportArgs`) matches only the literal token `import(`.
 *    A closure member reaching the target via `require('../data/boats')`
 *    is therefore invisible to `collectClosureImportersOf` and could yield
 *    a false NOT_OWED. Not observed anywhere in `app/sweep`/`pipeline`
 *    today (`grep -rn '\brequire(' app/sweep pipeline`, zero hits,
 *    2026-09-09) — but that is a fact about today's tree, not a guarantee.
 * 2. A getter/accessor property on an object/array literal (no such shape
 *    exists in `boats.ts` today — its `as const satisfies BoatDef[]`
 *    literal data has none) is not checked for by `isPureInitializer`,
 *    which looks for calls/`new`/mutating operators/assignment/templates
 *    but not `get x() { ... }` syntax inside an object literal.
 * 3. A re-export chain through a file the SAME diff also ADDS (not merely
 *    edits) is scanned at whatever state it holds on the WORKING TREE /
 *    `<head>` `diff` reads — correct for that file, and for a two-hunk
 *    diff that both adds the export AND adds a new importer of it in the
 *    same commit (the importer scan sees the new import and correctly
 *    reports OWED) — but a hypothetical multi-commit sequence where a
 *    LATER, un-scanned commit adds the importer is outside any single
 *    `diff` invocation's view, same as it always was for every other part
 *    of this tool.
 *
 * TWO gaps a prior revision of this paragraph named are now CLOSED, not
 * residual — recorded here so a future reader does not re-file them:
 * a dynamic `import()` with a COMPUTED specifier is now RESOLVED where
 * provably safe (`resolve(here, 'literal')` — verified against the real
 * `app/sweep/compare.mjs`/`tripRate.mjs` shape — or a bare string literal)
 * and falls back to wildcard-unsafe only when it genuinely cannot be
 * resolved, never silently ignored (`collectClosureImportersOf`,
 * `classifyDynamicImportArg`); and a file reachable ONLY via
 * `PATH_PREFIXES` (never the import walk) is now included in the
 * reachability scan (`collectClosureScanTargets`), matching this file's
 * own Method section's definition of the closure.
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

/**
 * Resolves a specifier relative to `fromFileAbs`'s OWN DIRECTORY to an
 * absolute file path, or null if nothing on disk matches — the shared
 * filesystem-probing core of both `resolveSpecifier` (ES `import`
 * specifiers, which must start with `.`) and the `#944` dynamic-import
 * literal resolution below (`path.resolve(here, specifier)` semantics,
 * which do NOT require a leading `.` — `path.resolve`'s second argument is
 * always relative-ish, `./` or not).
 */
function resolveRelativeTo(fromFileAbs, specifier) {
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

/** Resolves a relative specifier to an absolute file path, or null (external package / unresolved). */
function resolveSpecifier(fromFileAbs, specifier) {
  if (!specifier.startsWith('.')) return null; // bare specifier: external package, not app source
  return resolveRelativeTo(fromFileAbs, specifier);
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

// ---------------------------------------------------------------------------
// #944: additive-export safe span — the SECOND `boats.ts` exception,
// alongside `draftProvenance` above. See the file header's "Method" step 4
// and "Failure direction" for the argument this implements: a PURE-INSERTION
// hunk whose added lines form one or more complete new top-level
// `const`/`type`/`interface` declarations, none of whose EXPORTED name is
// imported by anything in the sweep's own closure, cannot move a byte the
// sweep ever compares — checked at EXPORT granularity via the same import
// graph `computeClosure` already builds, not pre-declared as a named field
// span the way `draftProvenance` is.
//
// Every ambiguous step below fails toward UNSAFE (the hunk stays OWED),
// never toward silently accepting a shape that wasn't proven. This is
// intentionally NOT a real parser — like `extractSpecifiers` above, a
// pattern it cannot recognise is a pattern it refuses to certify, not one
// it guesses about.
// ---------------------------------------------------------------------------

/** Bracket/paren nesting depth of `masked` immediately BEFORE `offset`. */
function bracketDepthAt(masked, offset) {
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    const c = masked[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
  }
  return depth;
}

/**
 * The character offset in `oldContent` where a pure-insertion hunk
 * (`oldCount === 0`) lands — git's convention for such a hunk is that
 * `oldStart` names the OLD line AFTER which the new lines are inserted
 * (0 meaning "before the first line").
 */
function insertionOffsetOld(oldContent, oldLineStarts, oldStart) {
  if (oldStart <= 0) return 0;
  if (oldStart < oldLineStarts.length) return oldLineStarts[oldStart];
  return oldContent.length;
}

/** The exact substring covering `count` lines starting at 1-indexed `startLine`. */
function sliceLines(content, lineStarts, startLine, count) {
  if (count <= 0) return '';
  const fromIdx = startLine - 1;
  const from = fromIdx < lineStarts.length ? lineStarts[fromIdx] : content.length;
  const toIdx = fromIdx + count;
  const to = toIdx < lineStarts.length ? lineStarts[toIdx] : content.length;
  return content.slice(from, to);
}

/**
 * Scans `masked` from `start` for the first `;` at bracket depth 0 relative
 * to `start` — the end of a `const`/`type` initializer/RHS. Returns -1
 * (unterminated / malformed) if depth ever goes negative (a `)`/`]`/`}`
 * closing something opened before `start`) or no such `;` is found — never
 * trust a negative result as "safe", only as "cannot classify".
 */
function findTopLevelSemicolon(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth < 0) return -1;
    } else if (c === ';' && depth === 0) {
      return i;
    }
  }
  return -1;
}

// A `const` initializer counts as PROVABLY PURE data only if it contains
// none of these — every one is a way a "new unreferenced const" could still
// have a runtime side effect that moves the world the sweep depends on
// (a function call, `BOATS.push(...)`, `new X()`, a mutating operator, an
// arrow/function expression, or a tagged template). Checked on the MASKED
// text (strings/comments blanked) except the backtick check, which must run
// on the RAW text — `maskNonCode` blanks a template literal's delimiters
// too, so a masked scan can never see one.
//
// #944 Blocker 1 fix wave: the ASSIGNMENT check below is deliberately
// "reject any further '=' at all" rather than an enumeration of "unsafe"
// assignment forms — a first version tried to strip only the SAFE
// multi-character operators that legitimately contain '=' (`==`, `===`,
// `!=`, `!==`, `<=`, `>=`, `=>`) and treat anything left over as an
// assignment, but `<=` is a literal SUBSTRING of the shift-assignment
// `<<=` (its last two characters), so stripping `<=` first would eat the
// tail of `<<=` too and leave nothing behind to flag — a real false
// NOT_OWED for `export const X = BOATS[0].draftM <<= 1;`-shaped code
// (contrived here, but the exact trap the fix must not reproduce for the
// simpler `+=`/`-=`/`&&=`/etc. forms). Per this repo's guard-asymmetry
// rule ("reject any assignment operator outright, don't try to parse
// which ones are safe" — #944 review), this checks for ANY '=' at all:
// `boats.ts`'s own idiom (`as const satisfies BoatDef[]`, plain literals)
// never needs one, so this costs nothing on the shapes that file actually
// uses, and every assignment form — simple, compound, and shift — reliably
// contains a bare '=' that this alone is enough to catch.
function isPureInitializer(maskedInit, rawInit) {
  if (/[(]/.test(maskedInit)) return false; // calls, arrow-fn parens, parenthesised exprs
  if (/\+\+|--/.test(maskedInit)) return false;
  if (/\b(new|delete|await|yield|throw|function)\b/.test(maskedInit)) return false;
  if (rawInit.includes('`')) return false; // template/tagged-template literal
  if (maskedInit.includes('=')) return false; // ANY assignment (=, +=, <<=, =>, ...) — reject outright, never enumerate
  return true;
}

/**
 * Decomposes `maskedAdded` (the masked text of a pure-insertion hunk's added
 * lines) into a sequence of top-level `const`/`type`/`interface`
 * declarations, or fails closed. `rawAdded` is the SAME span unmasked, used
 * only for the backtick check inside `isPureInitializer`.
 *
 * Returns `{ ok: true, decls: [{ kind, name, exported }] }` only when the
 * ENTIRE added span decomposes into recognised declarations with nothing
 * left over — a bare mutating statement (`BOATS.push({...})`), an
 * unrecognised shape, or an unterminated declaration all return
 * `{ ok: false, reason }` instead. This is deliberately NOT "does the span
 * contain a safe declaration" — it is "does the span consist of NOTHING
 * BUT safe declarations", so a mutating statement hidden among safe ones
 * cannot slip through.
 */
function splitAdditiveDeclarations(maskedAdded, rawAdded) {
  const decls = [];
  let pos = 0;
  const n = maskedAdded.length;
  while (true) {
    while (pos < n && /\s/.test(maskedAdded[pos])) pos++;
    if (pos >= n) break;
    const rest = maskedAdded.slice(pos);

    const constHead = /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(:[^=]*?)?=/.exec(rest);
    if (constHead) {
      const exported = Boolean(constHead[1]);
      const name = constHead[2];
      const initStart = pos + constHead[0].length;
      const end = findTopLevelSemicolon(maskedAdded, initStart);
      if (end === -1) return { ok: false, reason: `unterminated const declaration for '${name}'` };
      const initMasked = maskedAdded.slice(initStart, end);
      const initRaw = rawAdded.slice(initStart, end);
      if (!isPureInitializer(initMasked, initRaw)) {
        return { ok: false, reason: `const '${name}' initializer is not provably free of calls/mutation/new/await/templates` };
      }
      decls.push({ kind: 'const', name, exported });
      pos = end + 1;
      continue;
    }

    const typeHead = /^(export\s+)?type\s+([A-Za-z_$][\w$]*)\b[^=;{]*=/.exec(rest);
    if (typeHead) {
      const exported = Boolean(typeHead[1]);
      const name = typeHead[2];
      const rhsStart = pos + typeHead[0].length;
      const end = findTopLevelSemicolon(maskedAdded, rhsStart);
      if (end === -1) return { ok: false, reason: `unterminated type declaration for '${name}'` };
      // A type alias is erased at compile time — no runtime footprint to
      // check for purity, unlike a `const` initializer.
      decls.push({ kind: 'type', name, exported });
      pos = end + 1;
      continue;
    }

    const interfaceHead = /^(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b[^{]*\{/.exec(rest);
    if (interfaceHead) {
      const exported = Boolean(interfaceHead[1]);
      const name = interfaceHead[2];
      const braceIdx = pos + interfaceHead[0].length - 1;
      const closeIdx = matchBrace(maskedAdded, braceIdx);
      if (closeIdx === -1) return { ok: false, reason: `unterminated interface declaration for '${name}'` };
      let end = closeIdx + 1;
      let j = end;
      while (j < n && /\s/.test(maskedAdded[j])) j++;
      if (maskedAdded[j] === ';') end = j + 1;
      // An interface has no runtime footprint either — same reasoning as `type`.
      decls.push({ kind: 'interface', name, exported });
      pos = end;
      continue;
    }

    return {
      ok: false,
      reason: `unrecognised top-level statement (not a const/type/interface declaration) at offset ${pos}: ${JSON.stringify(rest.slice(0, 60))}`,
    };
  }
  return { ok: true, decls };
}

// `import`/`export ... from` clauses, capturing the KEYWORD and the CLAUSE
// TEXT (everything between the keyword and `from`) separately from
// `extractSpecifiers`'s FROM_RE above, because reachability needs to know
// WHICH NAMES a clause binds, not just which file it resolves to.
const FROM_CLAUSE_RE = /(?:^|\n)[ \t]*(import|export)\b([^'"()]*?)\bfrom\s*(['"])([^'"]+)\3/g;

/**
 * Parses one import/export clause (the text between `import`/`export` and
 * `from`) into `{ wildcard, names }`. `wildcard` covers `import * as ns`,
 * `export * from` and `export * as ns from` — any of which could re-expose
 * ANY export of the target file, so it is treated as referencing every
 * name (fail open), never resolved further.
 */
function parseClauseNames(clause) {
  let c = clause.trim().replace(/^type\s+/, '');
  if (c.startsWith('*')) return { wildcard: true, names: [] };
  const braceMatch = c.match(/\{([^}]*)\}/);
  if (!braceMatch) return { wildcard: false, names: [] }; // default-only import/export: no named binding
  const names = braceMatch[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  return { wildcard: false, names };
}

// #944 Blocker 3 fix wave: the reachability scan must cover exactly what
// this file's own "Method" section (see the header doc comment) defines
// the sweep's closure to BE — the import walk UNIONED with PATH_PREFIXES —
// not merely the subset a static import walk (`visited`) can see. A file
// reachable ONLY by prefix match (a NEW `app/sweep/arm-*.test.ts`, say,
// which is never discovered by the walk per PATH_PREFIXES's own header
// comment: "an edge INTO sweepArms.ts that a walk FROM it can never
// traverse") that statically imports the additive export is otherwise
// invisible to `collectClosureImportersOf` and yields a false NOT_OWED —
// measured directly: a synthetic `app/sweep/arm-check.test.ts` importing
// `{ NEW_ID }` from `boats.ts`, reached by NEITHER `sweepArms.ts` nor
// `vitest.config.ts`, was missed before this fix and caught after it (see
// selftest scenario J below).
//
// Only .ts/.tsx/.mts/.cts/.mjs/.cjs/.js/.jsx/.py are ever READ — `pipeline`
// alone can hold an ~887 MiB gitignored download cache
// (`pipeline/data-src/`, per CLAUDE.md's own pipeline bullet) of large
// binary rasters, and extension-filtering BEFORE any `readFileSync` is what
// keeps this scan from ever opening one of those files at all, not merely
// fast on them. `.py` is included even though Python's `from x import y`
// never matches `FROM_CLAUSE_RE` (no quoted module path) — harmless to
// scan, and future-proofs against a JS-shaped import syntax appearing
// there. `node_modules` and `.git` directories are skipped outright: they
// are never part of the app's OWN source closure (external packages, per
// this file's own `extractSpecifiers` walking no further into them either).
const PATH_PREFIX_SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx', '.py']);

/** Recursively lists every scannable-extension file under `root/prefix`. */
function listScannableFilesUnder(root, prefix) {
  const results = [];
  const stack = [path.join(root, prefix)];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // prefix directory doesn't exist, or a permission error — nothing to scan there
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && PATH_PREFIX_SCAN_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(abs);
      }
    }
  }
  return results;
}

/**
 * The UNION of every file the reachability scan must examine: the import
 * walk's own closure (`visited`) plus every scannable file under each
 * `PATH_PREFIXES` directory — the same union this file's Method section
 * defines the sweep's closure to be, so the reachability scan can never be
 * narrower than the closure membership test (`closureInfo`) itself.
 * Deduplicated via a Set (a file can be reached both ways, e.g.
 * `app/sweep/sweepArms.ts` is both a ROOT and under the `app/sweep` prefix).
 */
function collectClosureScanTargets(root, visited) {
  const set = new Set();
  for (const [rel, info] of visited.entries()) {
    if (!info.missing) set.add(rel);
  }
  for (const p of PATH_PREFIXES) {
    for (const abs of listScannableFilesUnder(root, p.prefix)) {
      set.add(path.relative(root, abs));
    }
  }
  return set;
}

// #944 Blocker 2 fix wave: a dynamic `import(...)` call cannot be resolved
// by `FROM_CLAUSE_RE` at all — it only ever matches the STATIC
// `import ... from '...'` / `export ... from '...'` grammar, and a call
// expression is a different production entirely. This is not hypothetical:
// `app/sweep/compare.mjs:86` and `tripRate.mjs:108-110` already do
// `await import(resolve(here, 'sweepArms.ts'))` (`here =
// dirname(fileURLToPath(import.meta.url))`, i.e. the IMPORTING FILE'S OWN
// DIRECTORY — verified at both real call sites, and `resolve` verified
// imported from `node:path` at both, so this is `path.resolve(here, X)`
// exactly, not a project-defined function of the same name).
//
// A first version of this fix (measured directly against the real repo,
// not merely reasoned about) treated ANY file containing `import(`
// anywhere as WILDCARD-reachable to EVERY target, unconditionally — the
// bluntest possible fail-open reading of "refuse to resolve, don't
// enumerate what's safe". That is SOUND but makes the additive-export
// exception PERMANENTLY INERT against the real repo today: `compare.mjs`
// and `tripRate.mjs` are always in the closure (PATH_PREFIXES `app/sweep`),
// so `boats.ts` reported OWED for the real #941/`5e6d236` reproduction
// again under that version — the exact false positive this issue exists to
// fix, un-fixed by the safety patch meant to harden it. That regression is
// what motivates the narrower resolution below, rather than shipping the
// blanket form.
//
// The narrowing is a POSITIVE resolution, never a negative one: for each
// `import(...)` call, only a call whose ENTIRE argument is (a) a bare
// string literal, or (b) `resolve(<anything>, 'STRING LITERAL')` — the
// verified real-world shape — is resolved at all, via `resolveRelativeTo`
// (matching `path.resolve(here, specifier)`'s actual semantics, which do
// NOT require a leading `.` the way an ES import specifier does). If that
// resolves to `targetRel`, the call proves reachability (wildcard, since a
// dynamic import's destructured names aren't tracked). If it resolves to a
// DIFFERENT real file, the call is POSITIVELY PROVEN not to reach the
// target — never inferred, never guessed. Any call NOT matching one of
// these two shapes (a template literal, string concatenation, a computed
// variable, `resolve()` with the wrong argument count, or a literal that
// fails to resolve to any file at all) falls back to the ORIGINAL blanket
// rule: wildcard-unsafe, unconditionally. So this can only ever NARROW
// wildcard classification for a call it can POSITIVELY resolve away from
// the target — it never manufactures a false "not reachable" the way
// attempting to resolve a genuinely ambiguous specifier would.
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Extracts the RAW (unmasked) argument text of every `import(...)` call
 * site found via the MASKED text (so a comment/string mentioning the
 * token can't be mistaken for a real call) — paired so the returned text
 * still has real quote characters to parse. */
function findDynamicImportArgs(masked, raw) {
  const args = [];
  const re = /\bimport\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    const openIdx = m.index + m[0].length - 1;
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < masked.length; i++) {
      const c = masked[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    if (closeIdx === -1) {
      args.push({ rawArg: null }); // unterminated: caller must treat as unresolvable
    } else {
      args.push({ rawArg: raw.slice(openIdx + 1, closeIdx) });
      re.lastIndex = closeIdx + 1;
    }
  }
  return args;
}

const STRING_LITERAL_RE = /^(['"])([^'"]*)\1$/;

/** Classifies one dynamic-import call argument: `{ resolvable, specifier }`
 * for the two provably-safe shapes described above, `{ resolvable: false }`
 * for everything else. */
function classifyDynamicImportArg(rawArg) {
  if (rawArg === null) return { resolvable: false };
  const trimmed = rawArg.trim();
  const bareLit = STRING_LITERAL_RE.exec(trimmed);
  if (bareLit) return { resolvable: true, specifier: bareLit[2] };
  const call = /^resolve\s*\((.*)\)$/s.exec(trimmed);
  if (call) {
    const parts = splitTopLevelCommas(call[1]);
    if (parts.length === 2) {
      const secondLit = STRING_LITERAL_RE.exec(parts[1].trim());
      if (secondLit) return { resolvable: true, specifier: secondLit[2] };
    }
  }
  return { resolvable: false };
}

/**
 * For every file the sweep's closure reaches (`collectClosureScanTargets`
 * — the import walk UNIONED with PATH_PREFIXES, never `visited` alone),
 * scans its import/export-from clauses for ones resolving to `targetRel`,
 * PLUS every dynamic `import(...)` call (resolved where provably safe,
 * else wildcard per the comment above), returning one entry per IMPORTING
 * closure member: `{ rel, wildcard, names }`. An empty return is a
 * POSITIVE-CONTROL failure, not evidence of anything — see the caller,
 * which refuses to certify any name unreachable on an empty scan (`rel`
 * being IN the closure at all means at least one edge into it must exist).
 */
function collectClosureImportersOf(root, visited, targetRel) {
  const targetAbs = path.join(root, targetRel);
  const importers = [];
  for (const rel of collectClosureScanTargets(root, visited)) {
    if (rel === targetRel) continue;
    const abs = path.join(root, rel);
    let source;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    let wildcard = false;
    const masked = maskNonCode(source);
    for (const { rawArg } of findDynamicImportArgs(masked, source)) {
      const cls = classifyDynamicImportArg(rawArg);
      if (!cls.resolvable) {
        wildcard = true;
        break;
      }
      const resolvedAbs = resolveRelativeTo(abs, cls.specifier);
      if (resolvedAbs && resolvedAbs === targetAbs) {
        wildcard = true;
        break;
      }
      // resolves to a DIFFERENT real file, or to nothing at all: this call
      // is positively proven (or, if unresolved, structurally cannot be) to
      // reach the target via THIS call — contributes nothing, keep scanning.
    }
    const names = new Set();
    if (!wildcard) {
      FROM_CLAUSE_RE.lastIndex = 0;
      let m;
      while ((m = FROM_CLAUSE_RE.exec(source))) {
        const resolvedAbs = resolveSpecifier(abs, m[4]);
        if (!resolvedAbs || resolvedAbs !== targetAbs) continue;
        const parsed = parseClauseNames(m[2]);
        if (parsed.wildcard) wildcard = true;
        for (const n of parsed.names) names.add(n);
      }
    }
    if (wildcard || names.size > 0) importers.push({ rel, wildcard, names: [...names] });
  }
  return importers;
}

function isNameReachable(importers, name) {
  return importers.some((imp) => imp.wildcard || imp.names.includes(name));
}

/**
 * Classifies one pure-insertion hunk (`hunk.oldCount === 0`) as an
 * additive-export safe span, or returns why it is not. `oldMasked` is the
 * masked OLD content (for the insertion-point depth check); `newMasked`/
 * `newContent`/`newLineStarts` locate and slice the added text.
 * `getImporters()` is a memoised closure over `collectClosureImportersOf`
 * so the (cheap, but non-trivial) scan runs at most once per diff.
 */
function classifyAdditiveHunk(hunk, { oldContent, oldMasked, oldLineStarts, newContent, newMasked, newLineStarts, getImporters }) {
  const insertOffset = insertionOffsetOld(oldContent, oldLineStarts, hunk.oldStart);
  const insertDepth = bracketDepthAt(oldMasked, insertOffset);
  if (insertDepth !== 0) {
    return {
      safe: false,
      why: `insertion point sits at bracket depth ${insertDepth} in the OLD file — not a new top-level statement (e.g. inside an existing array/object literal such as BOATS)`,
    };
  }
  const addedMasked = sliceLines(newMasked, newLineStarts, hunk.newStart, hunk.newCount);
  const addedRaw = sliceLines(newContent, newLineStarts, hunk.newStart, hunk.newCount);
  const split = splitAdditiveDeclarations(addedMasked, addedRaw);
  if (!split.ok) {
    return { safe: false, why: `added text does not decompose into recognised const/type/interface declarations: ${split.reason}` };
  }
  const reachable = [];
  for (const decl of split.decls) {
    if (!decl.exported) continue; // module-private: nothing outside this file can ever import it
    const importers = getImporters();
    if (importers.length === 0) {
      return {
        safe: false,
        why:
          'reachability scan found ZERO closure files importing from this file, but the file is IN ' +
          'the closure (a precondition of reaching this code path) — refusing to certify any export ' +
          'as unreferenced on what must be a broken scan (positive-control failure), not a real result',
      };
    }
    if (isNameReachable(importers, decl.name)) reachable.push(decl.name);
  }
  if (reachable.length > 0) {
    return { safe: false, why: `exported name(s) referenced by the sweep's own closure: ${reachable.join(', ')}` };
  }
  return {
    safe: true,
    via: `additive export(s) [${split.decls.map((d) => `${d.kind} ${d.name}${d.exported ? '' : ' (module-private)'}`).join(', ')}] unreferenced by any closure import`,
  };
}

/**
 * `oldContent`/`newContent`: the full text of `boats.ts` on each side.
 * `diffText`: `git diff -U0 <old> <new> -- boats.ts` (or `--no-index`) output.
 * `root`/`visited`: repo root and the sweep's import closure (from
 * `computeClosure`), needed ONLY by the #944 additive-export check —
 * `targetRel` lets the synthetic selftest below point this at a fixture
 * file living at the SAME relative path (`app/src/data/boats.ts`) under a
 * throwaway root, exercising the real function rather than a stand-in.
 */
function classifyBoatsTs({ oldContent, newContent, diffText, root, visited, targetRel = BOATS_TS_PATH }) {
  const hunks = parseHunks(diffText);
  if (hunks.length === 0) {
    return { verdict: 'NOT_OWED', reason: 'no textual change in boats.ts on this diff' };
  }
  const oldBlocks = findSafeBlocks(oldContent);
  const newBlocks = findSafeBlocks(newContent);

  const oldMasked = maskNonCode(oldContent);
  const newMasked = maskNonCode(newContent);
  const oldLineStarts = buildLineStarts(oldContent);
  const newLineStarts = buildLineStarts(newContent);

  let importersCache = null;
  const getImporters = () => {
    if (importersCache === null) importersCache = collectClosureImportersOf(root, visited, targetRel);
    return importersCache;
  };

  const results = hunks.map((hunk) => {
    if (hunkIsSafe(hunk, oldBlocks, newBlocks)) {
      return { hunk, safe: true, via: 'draftProvenance/DraftProvenance span' };
    }
    if (hunk.oldCount === 0 && hunk.newCount > 0) {
      const r = classifyAdditiveHunk(hunk, { oldContent, oldMasked, oldLineStarts, newContent, newMasked, newLineStarts, getImporters });
      return { hunk, ...r };
    }
    return { hunk, safe: false, why: 'not a pure-insertion hunk (modifies or removes existing lines) — no exception modelled' };
  });

  const unsafe = results.filter((r) => !r.safe);
  if (unsafe.length === 0) {
    const kinds = [...new Set(results.map((r) => r.via))];
    return {
      verdict: 'NOT_OWED',
      reason: `every hunk is a modelled safe span — ${kinds.join('; ')}`,
      // `importersCache`, never `getImporters()` — the latter would FORCE a
      // scan (and require `root`/`visited`) even when every hunk was safe
      // via the draftProvenance span alone, which is exactly the existing
      // (root/visited-less) selftest calls below still exercise.
      evidence: { results, importers: importersCache },
    };
  }
  return {
    verdict: 'OWED',
    reason:
      `${unsafe.length} of ${hunks.length} hunk(s) fall outside every modelled safe span — ` +
      'default fail-open verdict (see file header: this tool over-reports, never under-reports)',
    evidence: { unsafe, oldBlocks, newBlocks },
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
      verdict = classifyBoatsTs({ oldContent, newContent, diffText, root, visited });
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

  // #944: additive-export safe span. Each scenario builds a THROWAWAY
  // closure repo (no git needed — `computeClosure` is pure fs) at exactly
  // the relative paths `ROOTS`/`BOATS_TS_PATH` expect, so `classifyBoatsTs`
  // exercises its REAL `collectClosureImportersOf` scan against a real
  // `visited` map, never a hand-rolled stand-in for either.
  const ADDITIVE_BASE = `export interface DraftProvenance {
  readonly keel: string;
}

export const BOATS = [
  {
    id: 'salona-45',
    draftM: 2.1,
    draftProvenance: {
      keel: 'standard',
      note: 'Original draft note.',
    },
  },
] as const;
`;
  const ADDITIVE_NEW_EXPORT = `\nexport const NEW_ID = 'genoa';\n`;

  function buildAdditiveRepo(files) {
    const tmp = mkdtempSync(path.join(tmpdir(), 'sweep-closure-selftest-additive-'));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(tmp, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    return tmp;
  }

  function additiveVerdict(files, oldContent, newContent) {
    const root = buildAdditiveRepo({ ...files, [BOATS_TS_PATH]: oldContent });
    try {
      const visited = computeClosure(root);
      const oldFile = path.join(root, '_scenario_old.ts');
      const newFile = path.join(root, '_scenario_new.ts');
      writeFileSync(oldFile, oldContent);
      writeFileSync(newFile, newContent);
      return classifyBoatsTs({
        oldContent,
        newContent,
        diffText: gitDiffNoIndex(oldFile, newFile),
        root,
        visited,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // A: a NEW top-level `export const` that nothing in the closure imports.
  const vA = additiveVerdict(
    { 'app/sweep/vitest.config.ts': 'export default {};\n', 'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\n" },
    ADDITIVE_BASE,
    ADDITIVE_BASE + ADDITIVE_NEW_EXPORT,
  );
  results.push(check('#944 A: unreferenced additive export -> NOT_OWED (the #941 false positive this issue exists to fix)', vA.verdict === 'NOT_OWED', vA));

  // B: same addition, but the closure's own root file names it directly.
  const vB = additiveVerdict(
    { 'app/sweep/vitest.config.ts': 'export default {};\n', 'app/sweep/sweepArms.ts': "import { KEEP_ME, NEW_ID } from '../src/data/boats';\n" },
    ADDITIVE_BASE,
    ADDITIVE_BASE + ADDITIVE_NEW_EXPORT,
  );
  results.push(check('#944 B: mutation-check — same export, now NAMED by a closure import -> OWED', vB.verdict === 'OWED', vB));

  // B2: reachable only through a re-export BARREL the closure imports for a
  // side effect — never named in sweepArms.ts's own import list. This is
  // the issue's explicit "re-export and barrel files" residual.
  const vB2 = additiveVerdict(
    {
      'app/sweep/vitest.config.ts': 'export default {};\n',
      'app/sweep/sweepArms.ts': "import '../src/lib/index';\nimport { KEEP_ME } from '../src/data/boats';\n",
      'app/src/lib/index.ts': "export { NEW_ID } from '../data/boats';\n",
    },
    ADDITIVE_BASE,
    ADDITIVE_BASE + ADDITIVE_NEW_EXPORT,
  );
  results.push(check('#944 B2: mutation-check — same export, reachable only via a re-export BARREL -> OWED', vB2.verdict === 'OWED', vB2));

  // C: a pure top-level ADDITION that is NOT a const/type/interface
  // declaration at all — a bare call statement. Must not be waved through
  // just because the hunk is additive-only.
  const vC = additiveVerdict(
    { 'app/sweep/vitest.config.ts': 'export default {};\n', 'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\n" },
    ADDITIVE_BASE,
    ADDITIVE_BASE + "\nregisterExtraBoat(BOATS[0]);\n",
  );
  results.push(check('#944 C: additive but non-declaration statement (bare call) -> OWED ("additive is not the same as inert")', vC.verdict === 'OWED', vC));

  // C2: a `const` declaration whose INITIALIZER itself mutates shared state
  // — `BOATS.push(...)`. Matches the head regex, so purity of the RHS is
  // the only thing standing between this and a false NOT_OWED.
  const vC2 = additiveVerdict(
    { 'app/sweep/vitest.config.ts': 'export default {};\n', 'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\n" },
    ADDITIVE_BASE,
    ADDITIVE_BASE + "\nexport const PUSHED = BOATS.push({ id: 'x-boat', draftM: 1 } as const);\n",
  );
  results.push(check("#944 C2: additive const whose initializer calls BOATS.push(...) -> OWED (impure initializer)", vC2.verdict === 'OWED', vC2));

  // D: a pure INSERTION whose landing point sits INSIDE the existing BOATS
  // array (depth > 0 in the old file) — a new array element, not a new
  // top-level statement. The issue's own example of "additive is not inert".
  const vD = additiveVerdict(
    { 'app/sweep/vitest.config.ts': 'export default {};\n', 'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\n" },
    ADDITIVE_BASE,
    withReplacement(ADDITIVE_BASE, '  },\n] as const;', "  },\n  {\n    id: 'elan-444',\n    draftM: 1.9,\n  },\n] as const;"),
  );
  results.push(check('#944 D: pure insertion landing INSIDE the BOATS array literal -> OWED (insertion depth > 0)', vD.verdict === 'OWED', vD));

  // D2: the DEPTH GUARD in isolation. Unlike D, the inserted text here IS a
  // syntactically valid, pure, unreferenced `const` declaration on its
  // own — the ONLY thing making this unsafe is that it lands INSIDE the
  // BOATS array's element object (depth 2), a sibling of `draftM`, OUTSIDE
  // both existing `findSafeBlocks` spans (`interface DraftProvenance` and
  // `draftProvenance: { … }`) so the PRE-EXISTING draftProvenance mechanism
  // cannot also classify it safe. D alone cannot mutation-check the depth
  // guard specifically, because its inserted object-literal fragment also
  // fails the SHAPE check independently (measured: disabling only
  // `bracketDepthAt` left D still OWED, via the shape check). A first
  // attempt at this scenario landed INSIDE the `DraftProvenance` interface
  // body instead and was confounded by that PRE-EXISTING safe span
  // (measured: reported NOT_OWED via "draftProvenance/DraftProvenance
  // span", never reaching the additive-export path at all) — this
  // placement avoids both confounds.
  const vD2 = additiveVerdict(
    { 'app/sweep/vitest.config.ts': 'export default {};\n', 'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\n" },
    ADDITIVE_BASE,
    withReplacement(ADDITIVE_BASE, '    draftM: 2.1,\n', "    draftM: 2.1,\n    export const SNEAKY = 'x';\n"),
  );
  results.push(
    check(
      '#944 D2: mutation-check for the DEPTH GUARD — a valid, unreferenced const inserted INSIDE the interface body -> OWED',
      vD2.verdict === 'OWED',
      vD2,
    ),
  );

  // E: a WILDCARD import (`import * as ns from`) of boats.ts anywhere in
  // the closure must treat every new export as reachable, regardless of
  // whether its name is spelled out anywhere. The SAME file also carries a
  // named import of an UNRELATED export (`KEEP_ME`) so the positive
  // control (>= 1 importer) is satisfied via that second clause too — a
  // first attempt with a wildcard-only import was NOT a clean isolation of
  // the wildcard guard: mutating wildcard detection alone made the
  // (then-sole) importer clause resolve to `{wildcard:false, names:[]}`,
  // which drops OUT of the importer list entirely, so the row stayed OWED
  // via the UNRELATED positive-control-failure path instead — same
  // verdict, wrong reason, and the wildcard mutation went undetected. This
  // construction keeps the importer list non-empty regardless, so ONLY the
  // wildcard guard stands between this and a false NOT_OWED.
  const vE = additiveVerdict(
    {
      'app/sweep/vitest.config.ts': 'export default {};\n',
      'app/sweep/sweepArms.ts': "import * as boatsNs from '../src/data/boats';\nimport { KEEP_ME } from '../src/data/boats';\n",
    },
    ADDITIVE_BASE,
    ADDITIVE_BASE + ADDITIVE_NEW_EXPORT,
  );
  results.push(check('#944 E: closure member imports boats.ts via `import * as ns` -> OWED (wildcard, name never checked)', vE.verdict === 'OWED', vE));

  // F: composition — a draftProvenance-note edit (existing exception) AND
  // an unreferenced additive export in the SAME diff both classify safe,
  // so the two mechanisms compose to NOT_OWED.
  const vF = additiveVerdict(
    { 'app/sweep/vitest.config.ts': 'export default {};\n', 'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\n" },
    ADDITIVE_BASE,
    withReplacement(ADDITIVE_BASE, 'Original draft note.', 'A revised, longer draft note.') + ADDITIVE_NEW_EXPORT,
  );
  results.push(check('#944 F: draftProvenance-note edit + unreferenced additive export, same diff -> NOT_OWED (mechanisms compose)', vF.verdict === 'NOT_OWED', vF));

  // F2: the same pairing, but the SECOND hunk is an ordinary unsafe edit
  // (draftM) — one unsafe hunk must still force OWED for the whole file,
  // proving the additive-export exception cannot be used to launder an
  // unrelated unsafe hunk riding along in the same diff.
  const vF2 = additiveVerdict(
    { 'app/sweep/vitest.config.ts': 'export default {};\n', 'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\n" },
    ADDITIVE_BASE,
    withReplacement(ADDITIVE_BASE, 'draftM: 2.1,', 'draftM: 2.2,') + ADDITIVE_NEW_EXPORT,
  );
  results.push(check('#944 F2: unreferenced additive export + an UNRELATED unsafe draftM edit, same diff -> OWED (one unsafe hunk dominates)', vF2.verdict === 'OWED', vF2));

  // G1/G2: the reachability scan's own POSITIVE CONTROL. Nothing in this
  // closure imports boats.ts at all, so `collectClosureImportersOf` must
  // return an EMPTY list — that emptiness must never be read as "therefore
  // nothing is reachable", only as "the scan cannot be trusted here". A
  // module-PRIVATE addition (G1) never calls the reachability scan at all
  // (nothing outside the file can import an unexported name) and stays
  // NOT_OWED; an EXPORTED addition (G2) must fail toward OWED specifically
  // because of that empty scan, not merely because the name happens to be
  // unreachable.
  const zeroImporterFiles = {
    'app/sweep/vitest.config.ts': 'export default {};\n',
    'app/sweep/sweepArms.ts': "import { unrelated } from '../src/lib/other';\n",
    'app/src/lib/other.ts': 'export const unrelated = 1;\n',
  };
  const vG1 = additiveVerdict(zeroImporterFiles, ADDITIVE_BASE, ADDITIVE_BASE + "\nconst privateHelper = 'x';\n");
  results.push(check('#944 G1: module-private additive const, ZERO closure importers of boats.ts -> NOT_OWED (never needs the scan)', vG1.verdict === 'NOT_OWED', vG1));
  const vG2 = additiveVerdict(zeroImporterFiles, ADDITIVE_BASE, ADDITIVE_BASE + ADDITIVE_NEW_EXPORT);
  results.push(
    check(
      '#944 G2: EXPORTED additive const, ZERO closure importers of boats.ts -> OWED (positive-control failure, not "provably unreachable")',
      vG2.verdict === 'OWED' && JSON.stringify(vG2).includes('positive-control failure'),
      vG2,
    ),
  );

  // H (Blocker 1, review round 2): an additive const whose initializer
  // MUTATES shared state via a bare ASSIGNMENT — no call, no parens at
  // all, so the `(` purity check alone cannot catch it.
  // `export const X = BOATS[0].draftM = 999;` reassigns an existing
  // element's field as a side effect of the initializer. Must be OWED.
  const vH = additiveVerdict(
    { 'app/sweep/vitest.config.ts': 'export default {};\n', 'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\n" },
    ADDITIVE_BASE,
    ADDITIVE_BASE + "\nexport const X = BOATS[0].draftM = 999;\n",
  );
  results.push(check('#944 H: additive const initializer performs a bare ASSIGNMENT (no parens) -> OWED (Blocker 1)', vH.verdict === 'OWED', vH));

  // I (Blocker 2, review round 2): a closure member reaches the target via
  // a dynamic `import(...)` whose ENTIRE argument is a bare string literal
  // resolving to the target file itself -- must be wildcard-reachable.
  const vI = additiveVerdict(
    {
      'app/sweep/vitest.config.ts': 'export default {};\n',
      'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\nawait import('../src/data/boats');\n",
    },
    ADDITIVE_BASE,
    ADDITIVE_BASE + ADDITIVE_NEW_EXPORT,
  );
  results.push(check('#944 I: closure member dynamically imports the TARGET via a bare string literal -> OWED (Blocker 2)', vI.verdict === 'OWED', vI));

  // I2 (Blocker 2, the real-world shape that MOTIVATED the narrowing): a
  // dynamic import via `resolve(here, 'literal')` -- exactly what
  // `compare.mjs`/`tripRate.mjs` do today -- whose literal resolves to a
  // DIFFERENT real file, not the target. Must NOT force wildcard: the
  // additive export stays NOT_OWED. This is the scenario the blanket
  // "any import() poisons everything" reading of Blocker 2 broke (measured
  // directly against the real repo: the #941/`5e6d236` reproduction
  // regressed to OWED under that reading, because `compare.mjs` and
  // `tripRate.mjs` are always in the closure via PATH_PREFIXES).
  const vI2 = additiveVerdict(
    {
      'app/sweep/vitest.config.ts': 'export default {};\n',
      'app/sweep/sweepArms.ts':
        "import { KEEP_ME } from '../src/data/boats';\nimport { resolve, dirname } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst here = dirname(fileURLToPath(import.meta.url));\nawait import(resolve(here, 'other.mjs'));\n",
      'app/sweep/other.mjs': 'export const unrelated = 1;\n',
    },
    ADDITIVE_BASE,
    ADDITIVE_BASE + ADDITIVE_NEW_EXPORT,
  );
  results.push(
    check(
      "#944 I2: closure member's resolve(here, 'literal') dynamic import resolves AWAY from the target -> NOT_OWED (the narrowing this fix depends on)",
      vI2.verdict === 'NOT_OWED',
      vI2,
    ),
  );

  // I3 (Blocker 2, the unresolvable-argument fallback): a dynamic import
  // whose argument is neither a bare literal nor `resolve(x, 'literal')` --
  // a plain variable -- so it cannot be positively resolved away from the
  // target either. Must fall back to wildcard-unsafe -> OWED.
  const vI3 = additiveVerdict(
    {
      'app/sweep/vitest.config.ts': 'export default {};\n',
      'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\nconst mod = pickOne();\nawait import(mod);\n",
    },
    ADDITIVE_BASE,
    ADDITIVE_BASE + ADDITIVE_NEW_EXPORT,
  );
  results.push(check('#944 I3: closure member dynamically imports a COMPUTED, unresolvable specifier -> OWED (Blocker 2 fallback)', vI3.verdict === 'OWED', vI3));

  // J (Blocker 3, review round 2): a NEW file reachable ONLY via
  // PATH_PREFIXES (`app/sweep`), never via the import walk -- named by
  // neither `sweepArms.ts` nor `vitest.config.ts` -- that statically
  // imports the additive export. Must be OWED: the reachability scan has
  // to cover the SAME union `closureInfo`/Method step 2 already define the
  // sweep's closure to be, not merely `visited`.
  const vJ = additiveVerdict(
    {
      'app/sweep/vitest.config.ts': 'export default {};\n',
      'app/sweep/sweepArms.ts': "import { KEEP_ME } from '../src/data/boats';\n",
      'app/sweep/arm-check.test.ts': "import { NEW_ID } from '../src/data/boats';\n",
    },
    ADDITIVE_BASE,
    ADDITIVE_BASE + ADDITIVE_NEW_EXPORT,
  );
  results.push(
    check(
      '#944 J: a NEW arm-*.test.ts reachable ONLY via PATH_PREFIXES statically imports the export -> OWED (Blocker 3)',
      vJ.verdict === 'OWED',
      vJ,
    ),
  );

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
