// #1338: tests for run-sharded.mjs's PURE logic (argument parsing, output
// path layout, the N*maxWorkers cap, and the exact shard spawn spec) — run
// under plain Node (`node --test sweep/run-sharded.test.mjs`, wired into
// `test:sweep-unit`, CI's required `app` job). No child process is ever
// spawned here: `main()` only runs when this module is invoked directly
// (see its own header), so importing it for these exports is side-effect
// free, matching merge-shards.test.mjs's own no-solver-call convention.
//
// This file cannot prove a real sharded run reproduces an unsharded run's
// hashes — that is a manual, real-solver pass per README.md's "Sharding"
// section (same caveat merge-shards.test.mjs states for itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArgError, MAX_TOTAL_WORKERS, parseArgs, planLayout, shardCommand } from './run-sharded.mjs';

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

test('shardCommand omits SC_SWEEP_LIMIT when limit is 0 (unset, matching sweepArms.ts default)', () => {
  const spec = shardCommand({ index: 1, count: 1, dir: ABS_OUT }, 2, 0);
  assert.equal('SC_SWEEP_LIMIT' in spec.env, false);
});

test('shardCommand carries SC_SWEEP_LIMIT through when set', () => {
  const spec = shardCommand({ index: 1, count: 2, dir: ABS_OUT }, 2, 7);
  assert.equal(spec.env.SC_SWEEP_LIMIT, '7');
});
