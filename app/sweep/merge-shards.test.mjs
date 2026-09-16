// #1262: tests for merge-shards.mjs, run under plain Node
// (`node --test sweep/canonicalize.test.mjs sweep/merge-shards.test.mjs`,
// wired as `test:sweep-unit` — CI's `app` job runs it) — this directory is
// not collected by `npm --prefix app run test`, see README.md.
//
// These fixtures fake ONLY the merge mechanics (part-file discovery,
// ordering, fail-closed checks) against tiny synthetic `PlanResult`-shaped
// objects and the REAL `harbors.json`/`armNames.ts` — no solver call, so
// this file stays in CI's sub-second budget (the same reasoning
// `canonicalize.test.mjs` states for itself). The empirical proof that a
// merged SOLVER run is byte-identical to an unsharded one is a manual
// `SC_SWEEP_LIMIT` + `cmp` pass (README.md's "Sharding" section), not
// something this suite can cheaply reproduce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARM_NAMES } from './armNames.ts';
import { serialize } from './serialize.ts';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'merge-shards.mjs');
const harborsPath = resolve(here, '../public/data/harbors.json');
const harbors = JSON.parse(readFileSync(harborsPath, 'utf8'));
// Four real harbour ids, in harbors.json's own order — enough to exercise a
// 2-way shard split without hand-authoring a fake harbors.json.
const ids = harbors.slice(0, 4).map((h) => h.id);
assert.equal(ids.length, 4, 'fixture assumes harbors.json has at least 4 entries');

function fakePlan(id, tag) {
  // Distinct per (harbour, tag) so a content mix-up between shards or arms
  // is visible in the merged bytes, not just in row PRESENCE.
  return { status: 'error', reason: `fixture-${tag}-${id}` };
}

/** Writes a complete two-shard part-file set for every arm in ARM_NAMES. */
function writeShardPair(
  dir1,
  dir2,
  {
    corruptArm = null,
    dropShard2For = null,
    dupeHarbour = null,
    staleHarbourFor = null,
    dropMiddleRowFor = null,
  } = {},
) {
  mkdirSync(dir1, { recursive: true });
  mkdirSync(dir2, { recursive: true });
  const shard1Ids = ids.filter((_, i) => i % 2 === 0); // ids[0], ids[2]
  const shard2Ids = ids.filter((_, i) => i % 2 === 1); // ids[1], ids[3]
  for (const label of ARM_NAMES) {
    if (label === corruptArm) continue; // simulates an arm entirely missing
    const rows1 = Object.fromEntries(shard1Ids.map((id) => [id, fakePlan(id, label)]));
    let rows2 = Object.fromEntries(shard2Ids.map((id) => [id, fakePlan(id, label)]));
    if (dupeHarbour && label === ARM_NAMES[0]) {
      // Double-count shard1's first id inside shard2 too.
      rows2 = { ...rows2, [shard1Ids[0]]: fakePlan(shard1Ids[0], label) };
    }
    if (staleHarbourFor && label === staleHarbourFor) {
      // A harbour id `harbors.json` does not carry — a stale shard against a
      // moved harbour list.
      rows2 = { ...rows2, 'not-a-real-harbour-id-1262': fakePlan('not-a-real-harbour-id-1262', label) };
    }
    if (dropMiddleRowFor && label === dropMiddleRowFor) {
      // Deletes ids[1] (shard2Ids[0]) — a gap in the MIDDLE of
      // harbourOrder's first four entries, not at either edge, and not a
      // whole missing shard file either (shard2of2 still exists here, just
      // short one row).
      delete rows2[shard2Ids[0]];
    }
    writeFileSync(join(dir1, `${label}.shard1of2.json`), serialize(rows1));
    writeFileSync(join(dir1, `${label}.shard1of2.timings.json`), serialize({}));
    if (label === dropShard2For) continue; // simulates a missing shard index
    writeFileSync(join(dir2, `${label}.shard2of2.json`), serialize(rows2));
    writeFileSync(join(dir2, `${label}.shard2of2.timings.json`), serialize({}));
  }
}

/**
 * Writes a shard-count MISMATCH: dir1's parts all say "of2", dir2's all say
 * "of3" — a shape `writeShardPair` cannot express (its filenames are fixed
 * at `shard1of2`/`shard2of2`).
 */
function writeMismatchedShardCountPair(dir1, dir2) {
  mkdirSync(dir1, { recursive: true });
  mkdirSync(dir2, { recursive: true });
  for (const label of ARM_NAMES) {
    const rows1 = { [ids[0]]: fakePlan(ids[0], label) };
    const rows2 = { [ids[1]]: fakePlan(ids[1], label) };
    writeFileSync(join(dir1, `${label}.shard1of2.json`), serialize(rows1));
    writeFileSync(join(dir1, `${label}.shard1of2.timings.json`), serialize({}));
    writeFileSync(join(dir2, `${label}.shard2of3.json`), serialize(rows2));
    writeFileSync(join(dir2, `${label}.shard2of3.timings.json`), serialize({}));
  }
}

function run(args) {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('merges two shards into harbors.json order, byte-identical to a hand-assembled unsharded object', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-shards-'));
  try {
    const dir1 = join(root, 's1');
    const dir2 = join(root, 's2');
    const outDir = join(root, 'merged');
    writeShardPair(dir1, dir2);

    const result = run([outDir, dir1, dir2]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);

    for (const label of ARM_NAMES) {
      const merged = readFileSync(join(outDir, `${label}.json`), 'utf8');
      // Independently reconstruct the expected bytes from `ids` in
      // harbors.json's own order (NOT from the shard-emission order, which
      // for a 2-way interleave differs) and the SAME `serialize()` the
      // script uses — this is the byte-identity claim itself, not a
      // tautology: swapping the expected order below (e.g. shard-emission
      // order) makes this assertion RED against the script's real output.
      const expected = serialize(Object.fromEntries(ids.map((id) => [id, fakePlan(id, label)])));
      assert.equal(merged, expected, `arm ${label} merged bytes`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('changing a shard file changes the merged output (merge is not vacuous)', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-shards-'));
  try {
    const dir1 = join(root, 's1');
    const dir2 = join(root, 's2');
    writeShardPair(dir1, dir2);
    const out1 = join(root, 'merged1');
    assert.equal(run([out1, dir1, dir2]).status, 0);
    const before = readFileSync(join(out1, `${ARM_NAMES[0]}.json`), 'utf8');

    // Perturb ONE row of ONE shard file for one arm — a change the harness
    // can actually produce (a different solve result for that harbour).
    const target = join(dir1, `${ARM_NAMES[0]}.shard1of2.json`);
    const rows = JSON.parse(readFileSync(target, 'utf8'));
    const firstId = Object.keys(rows)[0];
    rows[firstId] = { status: 'error', reason: 'mutated' };
    writeFileSync(target, serialize(rows));

    const out2 = join(root, 'merged2');
    assert.equal(run([out2, dir1, dir2]).status, 0);
    const after = readFileSync(join(out2, `${ARM_NAMES[0]}.json`), 'utf8');

    assert.notEqual(before, after, 'perturbing a shard row must change the merged bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed on a missing shard index for one arm', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-shards-'));
  try {
    const dir1 = join(root, 's1');
    const dir2 = join(root, 's2');
    const outDir = join(root, 'merged');
    writeShardPair(dir1, dir2, { dropShard2For: ARM_NAMES[0] });

    const result = run([outDir, dir1, dir2]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing shard/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed on a harbour double-counted across shards', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-shards-'));
  try {
    const dir1 = join(root, 's1');
    const dir2 = join(root, 's2');
    const outDir = join(root, 'merged');
    writeShardPair(dir1, dir2, { dupeHarbour: true });

    const result = run([outDir, dir1, dir2]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /present in both shard/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed on an incomplete arm set', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-shards-'));
  try {
    const dir1 = join(root, 's1');
    const dir2 = join(root, 's2');
    const outDir = join(root, 'merged');
    writeShardPair(dir1, dir2, { corruptArm: ARM_NAMES[0] });

    const result = run([outDir, dir1, dir2]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /arm set INCOMPLETE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed on a shard-count mismatch between directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-shards-'));
  try {
    const dir1 = join(root, 's1');
    const dir2 = join(root, 's2');
    const outDir = join(root, 'merged');
    writeMismatchedShardCountPair(dir1, dir2);

    const result = run([outDir, dir1, dir2]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shard-count mismatch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed on a harbour id not in the current harbors.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-shards-'));
  try {
    const dir1 = join(root, 's1');
    const dir2 = join(root, 's2');
    const outDir = join(root, 'merged');
    writeShardPair(dir1, dir2, { staleHarbourFor: ARM_NAMES[0] });

    const result = run([outDir, dir1, dir2]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not in the current harbors\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed on a row missing from the MIDDLE of the merged set (#1262 review Minor 2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-shards-'));
  try {
    const dir1 = join(root, 's1');
    const dir2 = join(root, 's2');
    const outDir = join(root, 'merged');
    writeShardPair(dir1, dir2, { dropMiddleRowFor: ARM_NAMES[0] });

    const result = run([outDir, dir1, dir2]);
    assert.notEqual(result.status, 0, 'a middle-of-the-set gap must not exit 0');
    assert.match(result.stderr, /merged harbour ids are not harbors\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when one arm merges a different total row count than another (#1262 review Minor 2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-shards-'));
  try {
    const dir1 = join(root, 's1');
    const dir2 = join(root, 's2');
    const outDir = join(root, 'merged');
    writeShardPair(dir1, dir2);
    // Drop the LAST id (ids[3]) from ARM_NAMES[0]'s shard2 file only, so
    // its surviving 3-row set {ids[0], ids[1], ids[2]} is STILL a clean
    // harbourOrder PREFIX (passes check 1) and only the cross-arm count
    // comparison (check 2) can catch it — every other arm still merges 4.
    const shard2Ids = ids.filter((_, i) => i % 2 === 1); // ids[1], ids[3]
    const rowsShort = { [shard2Ids[0]]: fakePlan(shard2Ids[0], ARM_NAMES[0]) }; // drops ids[3]
    writeFileSync(join(dir2, `${ARM_NAMES[0]}.shard2of2.json`), serialize(rowsShort));

    const result = run([outDir, dir1, dir2]);
    assert.notEqual(result.status, 0, 'arms disagreeing on total row count must not exit 0');
    assert.match(result.stderr, /merged \d+ rows but arm .* merged \d+/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects with usage on missing arguments', () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
});
