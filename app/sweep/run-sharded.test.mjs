// #1338/#1363: tests for run-sharded.mjs — both the PURE logic (argument
// parsing, output path layout, the N*maxWorkers cap, the exact shard spawn
// spec) and, since #1363 Major 4, `main()`'s VERDICT logic itself, run as a
// real child process against a FAKE `npm` on PATH (never a real solver
// call). No child process is spawned by the pure-logic section: `main()`
// only runs when this module is invoked directly (see its own header), so
// importing it for its exports is side-effect free, matching
// merge-shards.test.mjs's own no-solver-call convention. The integration
// section below DOES spawn real processes (this file's own driver, and the
// real, unmodified `merge-shards.mjs`), the same "real child process, fake
// data" shape `canonicalize.test.mjs` uses for `compare.mjs`.
//
// This file cannot prove a real sharded run reproduces an unsharded run's
// hashes — that is a manual, real-solver pass per README.md's "Sharding"
// section (same caveat merge-shards.test.mjs states for itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgError, MAX_TOTAL_WORKERS, parseArgs, planLayout, shardCommand } from './run-sharded.mjs';
import { ARM_NAMES } from './armNames.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ABS_OUT = '/tmp/sc-sweep-1338';

test('parses a minimal valid invocation', () => {
  const parsed = parseArgs(['--shards', '2', '--max-workers', '3', '--out', ABS_OUT]);
  assert.deepEqual(parsed, { shards: 2, maxWorkers: 3, out: ABS_OUT, limit: 0 });
});

test('accepts an optional --limit', () => {
  const parsed = parseArgs(['--shards', '2', '--max-workers', '3', '--out', ABS_OUT, '--limit', '5']);
  assert.equal(parsed.limit, 5);
});

test('--shards is required', () => {
  assert.throws(() => parseArgs(['--max-workers', '3', '--out', ABS_OUT]), /--shards is required/);
});

test('--max-workers is required', () => {
  assert.throws(() => parseArgs(['--shards', '2', '--out', ABS_OUT]), /--max-workers is required/);
});

test('--out is required', () => {
  assert.throws(() => parseArgs(['--shards', '2', '--max-workers', '3']), /--out is required/);
});

test('--out must be absolute', () => {
  assert.throws(
    () => parseArgs(['--shards', '2', '--max-workers', '3', '--out', 'relative/path']),
    /--out must be an absolute path/,
  );
});

test('--shards rejects a non-integer', () => {
  assert.throws(
    () => parseArgs(['--shards', 'two', '--max-workers', '3', '--out', ABS_OUT]),
    /--shards must be a non-negative integer/,
  );
});

test('--shards rejects zero', () => {
  assert.throws(
    () => parseArgs(['--shards', '0', '--max-workers', '3', '--out', ABS_OUT]),
    /--shards must be >= 1/,
  );
});

test('--shards rejects a negative value (fails the integer-shape check first)', () => {
  assert.throws(
    () => parseArgs(['--shards', '-1', '--max-workers', '3', '--out', ABS_OUT]),
    /--shards must be a non-negative integer/,
  );
});

test('--max-workers rejects zero', () => {
  assert.throws(
    () => parseArgs(['--shards', '2', '--max-workers', '0', '--out', ABS_OUT]),
    /--max-workers must be >= 1/,
  );
});

test('--limit rejects a negative value', () => {
  assert.throws(
    () => parseArgs(['--shards', '2', '--max-workers', '3', '--out', ABS_OUT, '--limit', '-1']),
    /--limit must be a non-negative integer/,
  );
});

test('an unrecognised argument is rejected, not silently ignored', () => {
  assert.throws(
    () => parseArgs(['--shards', '2', '--max-workers', '3', '--out', ABS_OUT, '--bogus']),
    /unrecognised argument: --bogus/,
  );
});

test('a flag missing its value is rejected, not read as the next flag', () => {
  assert.throws(
    () => parseArgs(['--shards', '--max-workers', '3', '--out', ABS_OUT]),
    /--shards must be a non-negative integer/,
  );
});

test('every thrown validation error is an ArgError', () => {
  try {
    parseArgs([]);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    assert.ok(err instanceof ArgError);
  }
});

// #1363 Minor 6: `--out` with NO value at all (not merely a value-shaped
// like a flag) must still fail closed as an ArgError/exit 2, not a bare
// TypeError from indexing past argv's end.
test('--out at the very end of argv with no value throws ArgError, not a bare TypeError', () => {
  try {
    parseArgs(['--shards', '2', '--max-workers', '3', '--out']);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    assert.ok(err instanceof ArgError, `expected an ArgError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.match(err.message, /--out requires a value/);
  }
});

// --- N*maxWorkers cap -------------------------------------------------

test('exactly at the documented cap is accepted', () => {
  // Find a shards/maxWorkers pair whose product is exactly the cap.
  const shards = 4;
  const maxWorkers = MAX_TOTAL_WORKERS / shards;
  assert.equal(Number.isInteger(maxWorkers), true, 'fixture assumes the cap divides evenly by 4');
  const parsed = parseArgs(['--shards', String(shards), '--max-workers', String(maxWorkers), '--out', ABS_OUT]);
  assert.equal(parsed.shards * parsed.maxWorkers, MAX_TOTAL_WORKERS);
});

test('one over the documented cap is refused', () => {
  const shards = 4;
  const maxWorkers = MAX_TOTAL_WORKERS / shards + 1;
  assert.throws(
    () => parseArgs(['--shards', String(shards), '--max-workers', String(maxWorkers), '--out', ABS_OUT]),
    new RegExp(`exceeds the documented cap of ${MAX_TOTAL_WORKERS}`),
  );
});

test('the cap message names the offending product, not just the limit', () => {
  assert.throws(
    () => parseArgs(['--shards', '100', '--max-workers', '100', '--out', ABS_OUT]),
    /--shards\(100\) \* --max-workers\(100\) = 10000 exceeds/,
  );
});

// #1363 Minor 6: the cap's DATA is unpinned unless a row asserts the LITERAL
// value against a hand-written expectation — every row above derives its
// inputs FROM `MAX_TOTAL_WORKERS`, so mutating that constant (e.g. 24 -> 1000)
// leaves them all green (the #388 SOLVER_LABELS class: a guard's data needs a
// twin, not just its detection logic). This is the twin: it fails if the
// constant ever drifts from the value README.md's "Sharding" section states.
test('MAX_TOTAL_WORKERS is 24, matching README.md\'s stated 20-24 host guidance', () => {
  assert.equal(MAX_TOTAL_WORKERS, 24);
});

// --- output path layout -------------------------------------------------

test('planLayout names one shard dir per shard, in order, under --out', () => {
  const layout = planLayout({ shards: 3, out: ABS_OUT, maxWorkers: 2, limit: 0 });
  assert.equal(layout.shardDirs.length, 3);
  assert.deepEqual(
    layout.shardDirs.map((sd) => sd.dir),
    [`${ABS_OUT}/shard-1of3`, `${ABS_OUT}/shard-2of3`, `${ABS_OUT}/shard-3of3`],
  );
  assert.deepEqual(
    layout.shardDirs.map((sd) => [sd.index, sd.count]),
    [
      [1, 3],
      [2, 3],
      [3, 3],
    ],
  );
});

test('planLayout places the merged dir and manifest under --out, not inside a shard dir', () => {
  const layout = planLayout({ shards: 2, out: ABS_OUT, maxWorkers: 2, limit: 0 });
  assert.equal(layout.mergedDir, `${ABS_OUT}/merged`);
  assert.equal(layout.manifestPath, `${ABS_OUT}/manifest.json`);
  for (const sd of layout.shardDirs) {
    assert.notEqual(sd.dir, layout.mergedDir);
  }
});

test('planLayout with a single shard still produces the <i>of<count> naming', () => {
  const layout = planLayout({ shards: 1, out: ABS_OUT, maxWorkers: 4, limit: 0 });
  assert.deepEqual(
    layout.shardDirs.map((sd) => sd.dir),
    [`${ABS_OUT}/shard-1of1`],
  );
});

// --- shard spawn spec -----------------------------------------------------

test('shardCommand never uses `npm exec` and always loads sweep/vitest.config.ts', () => {
  const spec = shardCommand({ index: 2, count: 4, dir: `${ABS_OUT}/shard-2of4` }, 3, 0);
  assert.equal(spec.cmd, 'npm');
  assert.deepEqual(spec.args, [
    '--prefix',
    'app',
    'run',
    'test',
    '--',
    '--config',
    'sweep/vitest.config.ts',
    '--maxWorkers=3',
  ]);
  assert.ok(!spec.args.includes('exec'), 'must never be `npm exec vitest` (wrong cwd, no config loaded)');
});

test('shardCommand sets SC_SWEEP_SHARD and SC_SWEEP_OUT for its own slice', () => {
  const spec = shardCommand({ index: 2, count: 4, dir: `${ABS_OUT}/shard-2of4` }, 3, 0);
  assert.equal(spec.env.SC_SWEEP_SHARD, '2/4');
  assert.equal(spec.env.SC_SWEEP_OUT, `${ABS_OUT}/shard-2of4`);
});

// #1363 Major 2: SC_SWEEP_LIMIT must ALWAYS be present in a shard's env,
// even at 0 — omitting the key when unset let an INHERITED SC_SWEEP_LIMIT
// from the caller's own environment silently override --limit (measured:
// SC_SWEEP_LIMIT=5 in the parent env, no --limit flag, produced a run that
// merged 5 rows per arm while the manifest recorded "limit": 0).
test('shardCommand ALWAYS sets SC_SWEEP_LIMIT, even at 0, so an inherited value cannot leak through', () => {
  const spec = shardCommand({ index: 1, count: 1, dir: ABS_OUT }, 2, 0);
  assert.equal('SC_SWEEP_LIMIT' in spec.env, true);
  assert.equal(spec.env.SC_SWEEP_LIMIT, '0');
});

test('shardCommand carries SC_SWEEP_LIMIT through when set', () => {
  const spec = shardCommand({ index: 1, count: 2, dir: ABS_OUT }, 2, 7);
  assert.equal(spec.env.SC_SWEEP_LIMIT, '7');
});

// ===========================================================================
// #1363 Major 4: integration coverage of main()'s VERDICT logic itself.
//
// A fake `npm` (a tiny Node script, written to a throwaway PATH directory
// per test) stands in for the real `npm --prefix app run test -- --config
// sweep/vitest.config.ts` — it reads SC_SWEEP_SHARD/SC_SWEEP_OUT/
// SC_SWEEP_LIMIT exactly as sweepArms.ts does, and writes real
// `<arm>.shard<i>of<n>.limit<l>.json` part files (or dies without writing,
// per FAKE_NPM_DIE_SHARD) over a real PREFIX of the shipped harbors.json.
// The driver itself and merge-shards.mjs run FOR REAL and unmodified — only
// the solver call is faked, the same "real child process, fake data" shape
// `canonicalize.test.mjs` uses for compare.mjs. No solver work happens.
const harborsPath = resolve(here, '../public/data/harbors.json');
const HARBOUR_IDS = JSON.parse(readFileSync(harborsPath, 'utf8')).map((h) => h.id);
assert.ok(HARBOUR_IDS.length >= 4, 'fixture assumes harbors.json has at least 4 entries');

const RUN_SHARDED_PATH = resolve(here, 'run-sharded.mjs');
const REPO_ROOT = resolve(here, '../..');

const FAKE_NPM_SOURCE = `#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const shardSpec = process.env.SC_SWEEP_SHARD || '';
const outDir = process.env.SC_SWEEP_OUT;
const limitRaw = process.env.SC_SWEEP_LIMIT;
const behavior = process.env.FAKE_NPM_BEHAVIOR || 'ok';
const dieShard = process.env.FAKE_NPM_DIE_SHARD;
const truncateShard = process.env.FAKE_NPM_TRUNCATE_SHARD || '1';
const armNamesFile = process.env.FAKE_NPM_ARM_NAMES_FILE;
const harbourIdsFile = process.env.FAKE_NPM_HARBOUR_IDS_FILE;
const logFile = process.env.FAKE_NPM_LOG_FILE;

const [idxStr, countStr] = shardSpec.split('/');
const idx = Number(idxStr);
const count = Number(countStr);
const limit = Number(limitRaw ?? '0');

if (logFile) {
  appendFileSync(logFile, JSON.stringify({ idx, count, limitRaw }) + '\\n');
}

if (dieShard && idxStr === dieShard) {
  process.exit(1);
}

const armNames = JSON.parse(readFileSync(armNamesFile, 'utf8'));
const harbourIds = JSON.parse(readFileSync(harbourIdsFile, 'utf8'));
// Mirrors sweepArms.ts's own split EXACTLY: LIMIT first, then
// \`idx % count === SHARD.index - 1\` (1-indexed), preserving relative order.
const limited = limit > 0 ? harbourIds.slice(0, limit) : harbourIds;
const mine = limited.filter((_, i) => i % count === idx - 1);

mkdirSync(outDir, { recursive: true });

let names = armNames;
if (behavior === 'truncated' && idxStr === truncateShard) {
  names = armNames.slice(0, -1);
}

for (const name of names) {
  const rows = {};
  for (const id of mine) rows[id] = { status: 'error', reason: \`fake-\${name}-\${id}\` };
  const base = \`\${name}.shard\${idx}of\${count}.limit\${limit}\`;
  writeFileSync(resolve(outDir, \`\${base}.json\`), JSON.stringify(rows));
  writeFileSync(resolve(outDir, \`\${base}.timings.json\`), JSON.stringify({}));
}
process.exit(0);
`;

/** Writes the fake npm + its arm-name/harbour-id fixture files into a fresh
 * temp dir, returns { fakeNpmDir, armNamesFile, harbourIdsFile }. */
function setupFakeNpm() {
  const dir = mkdtempSync(join(tmpdir(), 'sc-run-sharded-fake-npm-'));
  const npmPath = join(dir, 'npm');
  writeFileSync(npmPath, FAKE_NPM_SOURCE);
  chmodSync(npmPath, 0o755);
  const armNamesFile = join(dir, 'arm-names.json');
  writeFileSync(armNamesFile, JSON.stringify(ARM_NAMES));
  const harbourIdsFile = join(dir, 'harbour-ids.json');
  writeFileSync(harbourIdsFile, JSON.stringify(HARBOUR_IDS));
  return { fakeNpmDir: dir, armNamesFile, harbourIdsFile };
}

/** Runs run-sharded.mjs as a real child process with the fake npm shimmed
 * onto PATH ahead of the real one. Returns { status, stdout, stderr }. */
function runDriver(args, { fakeNpmDir, armNamesFile, harbourIdsFile, extraEnv = {} }) {
  const result = spawnSync(process.execPath, [RUN_SHARDED_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeNpmDir}:${process.env.PATH}`,
      FAKE_NPM_ARM_NAMES_FILE: armNamesFile,
      FAKE_NPM_HARBOUR_IDS_FILE: harbourIdsFile,
      ...extraEnv,
    },
  });
  return result;
}

test('integration: every shard writing successfully -> exit 0 with a complete manifest', () => {
  const { fakeNpmDir, armNamesFile, harbourIdsFile } = setupFakeNpm();
  const outDir = mkdtempSync(join(tmpdir(), 'sc-run-sharded-out-'));
  const result = runDriver(['--shards', '2', '--max-workers', '1', '--limit', '4', '--out', outDir], {
    fakeNpmDir,
    armNamesFile,
    harbourIdsFile,
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr:\n${result.stderr}`);
  const manifestPath = join(outDir, 'manifest.json');
  assert.ok(existsSync(manifestPath), 'expected a manifest.json to be written');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest.arms).sort(), [...ARM_NAMES].sort());
});

test('integration: a shard that dies without writing anything -> exit non-zero, no manifest', () => {
  const { fakeNpmDir, armNamesFile, harbourIdsFile } = setupFakeNpm();
  const outDir = mkdtempSync(join(tmpdir(), 'sc-run-sharded-out-'));
  const result = runDriver(['--shards', '2', '--max-workers', '1', '--limit', '4', '--out', outDir], {
    fakeNpmDir,
    armNamesFile,
    harbourIdsFile,
    extraEnv: { FAKE_NPM_DIE_SHARD: '2' },
  });
  assert.notEqual(result.status, 0, 'expected a non-zero exit when a shard dies');
  assert.equal(existsSync(join(outDir, 'manifest.json')), false, 'a dead shard must never produce a manifest');
});

test('integration: one shard drops an arm (truncated part) -> exit non-zero, no manifest', () => {
  const { fakeNpmDir, armNamesFile, harbourIdsFile } = setupFakeNpm();
  const outDir = mkdtempSync(join(tmpdir(), 'sc-run-sharded-out-'));
  const result = runDriver(['--shards', '2', '--max-workers', '1', '--limit', '4', '--out', outDir], {
    fakeNpmDir,
    armNamesFile,
    harbourIdsFile,
    extraEnv: { FAKE_NPM_BEHAVIOR: 'truncated', FAKE_NPM_TRUNCATE_SHARD: '1' },
  });
  assert.notEqual(result.status, 0, 'expected a non-zero exit when one shard drops an arm');
  assert.equal(existsSync(join(outDir, 'manifest.json')), false, 'an incomplete arm set must never produce a manifest');
});

test('integration: a non-empty --out is refused BEFORE anything is spawned (exit 2)', () => {
  const { fakeNpmDir, armNamesFile, harbourIdsFile } = setupFakeNpm();
  const outDir = mkdtempSync(join(tmpdir(), 'sc-run-sharded-out-'));
  const markerPath = join(outDir, 'stale-from-a-prior-run.json');
  writeFileSync(markerPath, '{"stale":true}');
  const result = runDriver(['--shards', '1', '--max-workers', '1', '--limit', '4', '--out', outDir], {
    fakeNpmDir,
    armNamesFile,
    harbourIdsFile,
  });
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\nstderr:\n${result.stderr}`);
  assert.equal(readFileSync(markerPath, 'utf8'), '{"stale":true}', 'the pre-existing file must be left untouched');
  assert.equal(existsSync(join(outDir, 'shard-1of1')), false, 'no shard dir may be created');
  assert.equal(existsSync(join(outDir, 'merged')), false, 'no merge may be attempted');
});

test('integration: an INHERITED SC_SWEEP_LIMIT does not leak into a run with no --limit flag', () => {
  const { fakeNpmDir, armNamesFile, harbourIdsFile } = setupFakeNpm();
  const outDir = mkdtempSync(join(tmpdir(), 'sc-run-sharded-out-'));
  const logDir = mkdtempSync(join(tmpdir(), 'sc-run-sharded-log-'));
  const logFile = join(logDir, 'fake-npm.log');
  // No --limit on the driver's own argv — only an env var a CALLER might
  // have exported, exactly the shape that leaked before #1363 Major 2.
  const result = runDriver(['--shards', '1', '--max-workers', '1', '--out', outDir], {
    fakeNpmDir,
    armNamesFile,
    harbourIdsFile,
    extraEnv: { SC_SWEEP_LIMIT: '999', FAKE_NPM_LOG_FILE: logFile },
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr:\n${result.stderr}`);
  const logLines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(logLines.length >= 1, 'expected the fake npm to have logged at least once');
  for (const line of logLines) {
    assert.equal(line.limitRaw, '0', `the shard child must see SC_SWEEP_LIMIT="0", not the inherited "999" (${JSON.stringify(line)})`);
  }
});

// #1363 Major 3 follow-up (round-2 review): the run-directly guard's own
// regression row. `file://${process.argv[1]}` is not URL-encoded, so a path
// containing a space never matched `import.meta.url` and the whole driver
// silently no-opped at exit 0 (measured against a dir named `sp ace`,
// `--shards 99 --max-workers 99` — should be exit 2, cap exceeded). This
// file has only builtin imports before `parseArgs` runs, so a bare copy of
// it runs standalone with no sibling files.
test('integration (#1363 Major 3): a space in the driver\'s own path still triggers the run-directly guard', () => {
  const spaceDir = mkdtempSync(join(tmpdir(), 'sc run sharded sp ace-'));
  const copyPath = join(spaceDir, 'run-sharded.mjs');
  copyFileSync(RUN_SHARDED_PATH, copyPath);
  const result = spawnSync(
    process.execPath,
    [copyPath, '--shards', '99', '--max-workers', '99', '--out', '/tmp/sc-run-sharded-major3-unused'],
    { encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    2,
    `expected exit 2 (cap exceeded), got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stderr, /exceeds the documented cap/);
});
