#!/usr/bin/env node
/**
 * #1338: drives the #282 sweep's existing `SC_SWEEP_SHARD` mechanism across
 * N concurrent shard invocations, each capped at `--max-workers` vitest
 * workers, so an arm-set's wall time (its SLOWEST arm — README.md's
 * "Sharding" section, arms are file-parallel) is divided across idle cores
 * instead of serialised. This file adds NO new sharding logic — the split
 * itself is `sweepArms.ts`'s `SC_SWEEP_SHARD` and the reassembly is
 * `merge-shards.mjs`, both unmodified. It only orchestrates: spawn N
 * `SC_SWEEP_SHARD=i/N` invocations, wait, merge, hash the merged arms.
 *
 * Usage:
 *   node app/sweep/run-sharded.mjs --shards N --max-workers K \
 *     --out <absDir> [--limit L]
 *
 * Each shard writes into `<out>/shard-<i>of<N>`; the merge lands in
 * `<out>/merged`; a manifest (per-arm sha256 prefix, the ledger's own
 * `arms` shape — see `.claude/skills/sweep-closure/SKILL.md`'s "Reusing a
 * stored BASE" section) is written to `<out>/manifest.json`.
 *
 * This driver does NOT run `npm --prefix app exec vitest` — that resolves
 * the binary but executes in the CALLER's cwd, never loading
 * `sweep/vitest.config.ts` (CLAUDE.md's `npm --prefix X run` bullet). It
 * spawns `npm --prefix app run test -- --config sweep/vitest.config.ts`,
 * the same invocation this directory's own README documents.
 *
 * A non-zero shard exit is LOGGED, never the verdict — vitest's per-arm
 * wrapper timeout can fire after an arm has already written its JSON
 * (CLAUDE.md's `app/sweep/` bullet: "the artifact hash is the verdict,
 * never the runner's exit code"). The verdict is decided by whether every
 * expected merged arm file exists and `merge-shards.mjs` itself exits 0 —
 * that script already fails closed on a missing/incomplete/mismatched
 * shard set, so this driver does not re-implement that checking.
 *
 * Verification obligation this driver does NOT discharge itself (README.md
 * "Sharding"): a merged sharded run's per-arm hashes must reproduce an
 * unsharded run's recorded prefixes before the comparison means anything.
 * Diff this run's manifest against a recorded ledger entry
 * (`.claude/skills/sweep-closure/recorded-runs.json`) or a fresh unsharded
 * run's own hashes.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..'); // app/
const REPO_ROOT = resolve(APP_DIR, '..');

/**
 * README.md's "Sharding" section's own guidance: keep `<shards> *
 * --maxWorkers` around 20-24 on a 26 GB host, never uncapped — each shard
 * invocation still runs all eleven arms in parallel within itself
 * (`fileParallelism`'s one-worker-per-arm-file shape, unchanged per
 * invocation), so N concurrent invocations multiply potential concurrency
 * to up to `11 * N` solver workers before `--maxWorkers` narrows it. A cap
 * too low costs wall time; one too high risks the host, the worse failure
 * (that section's own framing). Exported as ONE constant so the cap is
 * testable and has a single place to change if the host guidance changes.
 */
export const MAX_TOTAL_WORKERS = 24;

export class ArgError extends Error {}

function requireIntArg(argv, idx, flagName) {
  const raw = argv[idx];
  if (raw === undefined) throw new ArgError(`${flagName} requires a value`);
  if (!/^\d+$/.test(raw)) {
    throw new ArgError(`${flagName} must be a non-negative integer, got "${raw}"`);
  }
  return Number(raw);
}

/**
 * Parses argv (an array of strings, no leading node/script entries).
 * Fail-closed: every required flag is required, every value is validated,
 * and an unrecognised flag is rejected rather than silently ignored.
 */
export function parseArgs(argv) {
  const out = { shards: null, maxWorkers: null, out: null, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--shards':
        out.shards = requireIntArg(argv, ++i, '--shards');
        break;
      case '--max-workers':
        out.maxWorkers = requireIntArg(argv, ++i, '--max-workers');
        break;
      case '--out':
        out.out = argv[++i];
        if (out.out === undefined) throw new ArgError('--out requires a value');
        break;
      case '--limit':
        out.limit = requireIntArg(argv, ++i, '--limit');
        break;
      default:
        throw new ArgError(`unrecognised argument: ${a}`);
    }
  }
  if (out.shards === null) throw new ArgError('--shards is required');
  if (out.maxWorkers === null) throw new ArgError('--max-workers is required');
  if (out.out === null) throw new ArgError('--out is required (absolute path)');
  if (out.shards < 1) throw new ArgError('--shards must be >= 1');
  if (out.maxWorkers < 1) throw new ArgError('--max-workers must be >= 1');
  if (out.limit < 0) throw new ArgError('--limit must be >= 0');
  if (!isAbsolute(out.out)) throw new ArgError(`--out must be an absolute path, got "${out.out}"`);
  const total = out.shards * out.maxWorkers;
  if (total > MAX_TOTAL_WORKERS) {
    throw new ArgError(
      `--shards(${out.shards}) * --max-workers(${out.maxWorkers}) = ${total} exceeds the ` +
        `documented cap of ${MAX_TOTAL_WORKERS} concurrent solver workers (README.md "Sharding")`,
    );
  }
  return out;
}

/**
 * Pure output-path layout, derived from parsed args — every path this run
 * will use, computed BEFORE anything is spawned. Factored out so the
 * "print every output path before starting" requirement is testable
 * without spawning a single process.
 */
export function planLayout({ shards, out, maxWorkers, limit }) {
  const shardDirs = [];
  for (let i = 1; i <= shards; i++) {
    shardDirs.push({ index: i, count: shards, dir: resolve(out, `shard-${i}of${shards}`) });
  }
  return {
    shardDirs,
    mergedDir: resolve(out, 'merged'),
    manifestPath: resolve(out, 'manifest.json'),
    maxWorkers,
    limit,
  };
}

/**
 * Builds one shard child's exact spawn spec — pure, so the command a shard
 * runs is testable without spawning it. `npm --prefix app run test --
 * --config sweep/vitest.config.ts`, run from REPO_ROOT: never `npm exec
 * vitest` (wrong cwd, no config loaded) and never a bare `vitest` binary
 * (same reason) — see this file's header comment.
 */
export function shardCommand({ index, count, dir }, maxWorkers, limit) {
  const args = [
    '--prefix',
    'app',
    'run',
    'test',
    '--',
    '--config',
    'sweep/vitest.config.ts',
    `--maxWorkers=${maxWorkers}`,
  ];
  const env = {
    SC_SWEEP_SHARD: `${index}/${count}`,
    SC_SWEEP_OUT: dir,
  };
  if (limit > 0) env.SC_SWEEP_LIMIT = String(limit);
  return { cmd: 'npm', args, cwd: REPO_ROOT, env };
}

function sha256Prefix16(buf) {
  // Matches compare.mjs's own `sha(s) = createHash('sha256').update(s)
  // .digest('hex').slice(0, 16)` so a manifest entry is directly
  // comparable to README.md's recorded prefixes and the sweep-closure
  // ledger's `arms` field without a units mismatch.
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function runShard(spec) {
  return new Promise((resolvePromise) => {
    mkdirSync(spec.env.SC_SWEEP_OUT, { recursive: true });
    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => resolvePromise({ code, signal }));
    child.on('error', (err) => resolvePromise({ code: null, signal: null, spawnError: err }));
  });
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      console.error(`FAIL: ${err.message}`);
      console.error(
        'usage: node app/sweep/run-sharded.mjs --shards N --max-workers K --out <absDir> [--limit L]',
      );
      process.exit(2);
      return;
    }
    throw err;
  }

  const layout = planLayout(parsed);
  mkdirSync(parsed.out, { recursive: true });

  // Print every output path BEFORE starting anything.
  console.log(`#1338 sharded sweep — ${layout.shardDirs.length} shards x --maxWorkers=${layout.maxWorkers}`);
  for (const sd of layout.shardDirs) console.log(`  shard ${sd.index}/${sd.count}: ${sd.dir}`);
  console.log(`  merged:   ${layout.mergedDir}`);
  console.log(`  manifest: ${layout.manifestPath}`);

  const specs = layout.shardDirs.map((sd) => shardCommand(sd, layout.maxWorkers, layout.limit));
  const results = await Promise.all(specs.map(runShard));

  results.forEach((r, i) => {
    if (r.spawnError) {
      console.error(`shard ${i + 1}/${specs.length}: FAILED TO SPAWN — ${r.spawnError.message}`);
    } else if (r.code !== 0) {
      console.error(
        `shard ${i + 1}/${specs.length}: exited ${r.code}${r.signal ? ` (signal ${r.signal})` : ''} — ` +
          'logged, not the verdict; checking merged part files instead',
      );
    }
  });

  const mergeArgs = ['app/sweep/merge-shards.mjs', layout.mergedDir, ...layout.shardDirs.map((sd) => sd.dir)];
  const mergeCode = await new Promise((res) => {
    const child = spawn('node', mergeArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
    child.on('exit', (code) => res(code));
    child.on('error', () => res(1));
  });

  if (mergeCode !== 0) {
    console.error(`FAIL: merge-shards.mjs exited ${mergeCode} — see its own output above`);
    process.exit(1);
    return;
  }

  // Manifest: per-arm sha256 prefix in the ledger's own `arms` shape
  // (.claude/skills/sweep-closure/SKILL.md), so this run's result is
  // directly diffable against a recorded ledger entry or a fresh unsharded
  // run — never re-derived from a hardcoded arm list (same reason
  // merge-shards.mjs imports ARM_NAMES rather than restating it).
  const { ARM_NAMES } = await import(resolve(APP_DIR, 'sweep/armNames.ts'));
  const arms = {};
  for (const name of ARM_NAMES) {
    const p = resolve(layout.mergedDir, `${name}.json`);
    if (!existsSync(p)) {
      console.error(`FAIL: merged output missing ${p}`);
      process.exit(1);
      return;
    }
    arms[name] = sha256Prefix16(readFileSync(p));
  }

  const manifest = {
    shards: layout.shardDirs.length,
    maxWorkers: layout.maxWorkers,
    limit: layout.limit,
    mergedDir: layout.mergedDir,
    arms,
  };
  writeFileSync(layout.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nmanifest written: ${layout.manifestPath}`);
  for (const [name, hash] of Object.entries(arms)) console.log(`  ${name.padEnd(20)} ${hash}`);
}

// Only run when invoked directly — importing this module for its exports
// (run-sharded.test.mjs) must not spawn anything.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
