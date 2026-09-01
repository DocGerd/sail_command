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
 * 1. Walk the import graph from the sweep's two real roots
 *    (`app/sweep/sweepArms.ts`, `app/sweep/vitest.config.ts`) transitively,
 *    following every relative `import`/`export ... from`/dynamic `import()`
 *    specifier. External packages (bare specifiers: 'vitest', 'node:fs', …)
 *    are not walked further — they are not part of the app SOURCE closure.
 *    This produces the closure as DERIVED DATA, not a maintained list.
 *
 * 2. Intersect that closure with the changed files in a diff
 *    (`git diff --name-only <base> [<head>]`).
 *
 * 3. For each hit, default to **OWED** — this is a NUDGE-class tool, and per
 *    the repo's guard-asymmetry convention a nudge must fail OPEN (a false
 *    "owed" costs ~31 minutes of unnecessary solver time; a false "not owed"
 *    ships an unverified routing change). The only carve-out from that
 *    default is `app/src/data/boats.ts`'s `draftProvenance` field, because
 *    that specific exemption is STRUCTURALLY provable from the type system
 *    on disk today (see `classifyBoatsTs` below) rather than merely assumed.
 *
 * ## Failure direction — stated explicitly, per the issue's own request
 *
 * This tool OVER-REPORTS, never under-reports, with exactly one modelled
 * exception (`app/src/data/boats.ts`'s `draftProvenance`/`DraftProvenance`
 * blocks). It does NOT attempt full data-flow/taint analysis of every field
 * reachable from the closure — e.g. it does NOT model whether
 * `polarProvenance.note` (also present in `boats.ts`, also copied into
 * `BoatSnapshot`) can move a `PlanResult`; CLAUDE.md's own
 * "polarProvenance and draftProvenance have DIFFERENT blast radii" bullet
 * warns explicitly against assuming one field's exemption transfers to the
 * other, so a `polarProvenance`-only edit is deliberately left at the
 * default OWED verdict rather than silently generalising the exception
 * (see `selftest`'s "narrow-scope-check" case). Extending the exception list
 * to a new field needs the same structural proof `classifyBoatsTs` gives for
 * `draftProvenance` — never a guess by analogy.
 *
 * ## Usage
 *
 *   node closure.mjs closure                 # print the whole derived closure
 *   node closure.mjs files <path> [<path>…]  # is <path> in the closure at all?
 *   node closure.mjs diff <base> [<head>]    # real usage: does this diff owe a sweep?
 *   node closure.mjs selftest                # positive/negative controls, see #729
 *
 * `<base>`/`<head>` are anything `git diff` accepts (a ref, a SHA, …).
 * `<head>` omitted means "working tree", matching plain `git diff <base>`.
 *
 * No dependency beyond Node's standard library — this must stay runnable
 * from a bare checkout with no `npm install`.
 */

import { existsSync, readFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function changedFiles(root, base, head) {
  const args = head ? ['diff', '--name-only', base, head] : ['diff', '--name-only', base];
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
    ? ['diff', '-U0', '--no-color', base, head, '--', relPath]
    : ['diff', '-U0', '--no-color', base, '--', relPath];
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
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
  console.log(`\n${files.length} files in the #282 sweep closure (roots: ${ROOTS.join(', ')})`);
  const missing = [...visited.entries()].filter(([, v]) => v.missing);
  if (missing.length) {
    console.log(`\n${missing.length} unresolved reference(s) (external package, or genuinely missing):`);
    for (const [rel] of missing) console.log(`  ${rel}`);
  }
}

function cmdFiles(root, paths) {
  if (paths.length === 0) {
    console.error('usage: closure.mjs files <path> [<path>…]');
    process.exit(2);
  }
  const visited = computeClosure(root);
  let anyIn = false;
  for (const p of paths) {
    const rel = path.relative(root, path.resolve(root, p));
    const info = visited.get(rel);
    if (!info || info.missing) {
      console.log(`NOT_IN_CLOSURE  ${rel}`);
      continue;
    }
    anyIn = true;
    console.log(`IN_CLOSURE      ${rel}`);
    for (const step of chainFor(visited, rel)) {
      console.log(`  via ${step.file}${step.via && step.via !== 'root' ? '  (' + step.via + ')' : ''}`);
    }
  }
  process.exitCode = anyIn ? 0 : 0; // informational command; exit code carries no verdict
}

function cmdDiff(root, base, head) {
  if (!base) {
    console.error('usage: closure.mjs diff <base> [<head>]');
    process.exit(2);
  }
  const visited = computeClosure(root);
  const changed = changedFiles(root, base, head);
  const hits = changed.filter((f) => visited.has(f) && !visited.get(f).missing);

  console.log(`# app/sweep #282 closure check`);
  console.log(`base=${base} head=${head ?? '(working tree)'}`);
  console.log(`changed files examined: ${changed.length}; closure size: ${visited.size}`);
  console.log('');

  if (hits.length === 0) {
    console.log('VERDICT: NOT OWED — no changed file is in the #282 sweep import closure');
    return;
  }

  let anyOwed = false;
  for (const f of hits) {
    let verdict;
    if (f === BOATS_TS_PATH) {
      const oldContent = gitShow(root, base, f);
      const newContent = head ? gitShow(root, head, f) : readFileSync(path.join(root, f), 'utf8');
      const diffText = gitDiffU0(root, base, head, f);
      verdict = classifyBoatsTs({ oldContent, newContent, diffText });
    } else {
      verdict = {
        verdict: 'OWED',
        reason: 'in the sweep import closure; no field-level exception modelled for this file (default fail-open)',
      };
    }
    if (verdict.verdict === 'OWED') anyOwed = true;
    console.log(`${verdict.verdict}  ${f}`);
    console.log(`  reason: ${verdict.reason}`);
    for (const step of chainFor(visited, f)) {
      console.log(`  via ${step.file}${step.via && step.via !== 'root' ? '  (' + step.via + ')' : ''}`);
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
  const inClosure = (rel) => visited.has(rel) && !visited.get(rel).missing;

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
