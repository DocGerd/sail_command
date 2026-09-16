#!/usr/bin/env node
/**
 * #1262: reassemble #282 sweep output sharded via `SC_SWEEP_SHARD` back into
 * the one-file-per-arm shape `compare.mjs` and the rest of this harness
 * already expect — unmodified. See README.md's "Sharding" section for the
 * full run + merge workflow.
 *
 *   node app/sweep/merge-shards.mjs <mergedOutDir> <shardDir1> [<shardDir2> ...]
 *
 * Each `<shardDirK>` is one `SC_SWEEP_SHARD` invocation's `SC_SWEEP_OUT` —
 * it holds, for every arm, a `<label>.shard<i>of<n>.json` (+
 * `.timings.json`) pair for THAT invocation's shard index `i` of `n`
 * (`sweepArms.ts`'s `armFileBase`). This script unions the `n` part files
 * per arm, reassembles the rows in `harbors.json`'s own order — the SAME
 * order an unsharded `runArm()` inserts them in, since it iterates
 * `harbors` in file order and the shard filter preserves each destination's
 * relative position — and re-serializes with the IDENTICAL `serialize()`
 * `sweepArms.ts` uses (imported from `serialize.ts`, not reimplemented), so
 * `<mergedOutDir>/<label>.json` is BYTE-IDENTICAL to what one unsharded run
 * at the same commit would have written. `compare.mjs` needs no changes —
 * point it at `<mergedOutDir>` like any other sweep output directory; never
 * at a shard directory directly (its own arm-name check correctly rejects
 * `<label>.shard<i>of<n>` as an arm name not in `armNames.ts`).
 *
 * Fails CLOSED on: a missing shard index for some arm, two shard files
 * disagreeing on the total shard count `n`, the same harbour id appearing
 * in more than one shard for one arm (double-counted), an arm present in
 * some shard directories but absent from others, an arm not in
 * `armNames.ts`, or a harbour id in the shard output that the CURRENT
 * `harbors.json` no longer lists (a stale shard run against a moved
 * harbour list — silently dropping it would understate the merged arm).
 *
 * Requires Node >= 22.18, same floor as `compare.mjs` and for the same
 * reason (`armNames.ts`'s own doc comment: unflagged `.ts` type-stripping
 * under plain Node, no bundler-style resolution of a further import chain —
 * which is why `serialize.ts`, like `armNames.ts`, imports nothing else).
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ARM_NAMES } from './armNames.ts';
import { serialize } from './serialize.ts';

const here = dirname(fileURLToPath(import.meta.url));

const [outDir, ...shardDirs] = process.argv.slice(2);
if (!outDir || shardDirs.length === 0) {
  console.error('usage: node merge-shards.mjs <mergedOutDir> <shardDir1> [<shardDir2> ...]');
  process.exit(2);
}

const SHARD_FILE_RE = /^(.+)\.shard(\d+)of(\d+)\.json$/;

// arm label -> shard index -> { rows, timings }
const byArm = new Map();
let expectedShardCount = null;

for (const dir of shardDirs) {
  for (const f of readdirSync(dir)) {
    const m = SHARD_FILE_RE.exec(f);
    if (!m) continue; // ignores *.timings.json siblings and anything else
    const [, label, idxStr, countStr] = m;
    const idx = Number(idxStr);
    const count = Number(countStr);
    if (expectedShardCount === null) {
      expectedShardCount = count;
    } else if (count !== expectedShardCount) {
      console.error(
        `FAIL: shard-count mismatch — ${dir}/${f} says ${count} but an earlier file said ${expectedShardCount}`,
      );
      process.exit(1);
    }
    if (!byArm.has(label)) byArm.set(label, new Map());
    const shardsForArm = byArm.get(label);
    if (shardsForArm.has(idx)) {
      console.error(`FAIL: shard ${idx} for arm "${label}" found twice (${dir}/${f} duplicates an earlier file)`);
      process.exit(1);
    }
    const rows = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
    const timingsPath = resolve(dir, f.replace(/\.json$/, '.timings.json'));
    let timings = {};
    try {
      timings = JSON.parse(readFileSync(timingsPath, 'utf8'));
    } catch {
      // Timings are diagnostic only — compare.mjs never reads *.timings.json
      // as an arm — so a missing timings file is not fatal to the merge.
    }
    shardsForArm.set(idx, { rows, timings });
  }
}

if (byArm.size === 0) {
  console.error(
    'FAIL: no `<label>.shard<i>of<n>.json` files found in any given directory — wrong path, or an unsharded run?',
  );
  process.exit(1);
}

const EXPECTED = [...ARM_NAMES].sort();
const found = [...byArm.keys()].sort();
if (found.join() !== EXPECTED.join()) {
  const missing = EXPECTED.filter((x) => !found.includes(x));
  const unexpected = found.filter((x) => !EXPECTED.includes(x));
  console.error(`FAIL: arm set INCOMPLETE — expected ${EXPECTED.length} arms, found ${found.length}`);
  if (missing.length) console.error(`  MISSING: ${missing.join(', ')}`);
  if (unexpected.length) console.error(`  UNEXPECTED (not in armNames.ts): ${unexpected.join(', ')}`);
  process.exit(1);
}

const dataDir = resolve(here, '../public/data');
const harbors = JSON.parse(readFileSync(resolve(dataDir, 'harbors.json'), 'utf8'));
const harbourOrder = harbors.map((h) => h.id);

mkdirSync(outDir, { recursive: true });

// #1262 review Minor 2: an honest sweep run always takes destinations as a
// PREFIX of `harbors.json` (`sweepArms.ts`'s `limited = harbors.slice(0,
// SC_SWEEP_LIMIT || harbors.length)`, then the shard filter over `limited`
// preserving relative order) — so every arm's row set is always exactly
// `harbourOrder.slice(0, totalRows)`, and every arm shares the SAME
// `totalRows` (they all sweep the same destination list). Tracked across
// the loop below and checked per arm, so a row silently dropped from the
// MIDDLE of one shard (a bad copy, an `SC_SWEEP_LIMIT` mismatch across
// shard invocations, a broken `idx % count` filter) reds the merge instead
// of writing a short arm file at exit 0.
let referenceTotalRows = null;
let referenceArmLabel = null;

for (const label of EXPECTED) {
  const shardsForArm = byArm.get(label);
  const n = expectedShardCount;
  const missingIdx = [];
  for (let i = 1; i <= n; i++) if (!shardsForArm.has(i)) missingIdx.push(i);
  if (missingIdx.length) {
    console.error(`FAIL: arm "${label}" is missing shard(s) ${missingIdx.join(', ')} of ${n}`);
    process.exit(1);
  }

  const owner = new Map(); // harbour id -> shard index, to catch double-counting
  let totalRows = 0;
  const mergedTimings = {};
  for (let i = 1; i <= n; i++) {
    const { rows, timings } = shardsForArm.get(i);
    for (const id of Object.keys(rows)) {
      if (owner.has(id)) {
        console.error(
          `FAIL: arm "${label}": harbour "${id}" present in both shard ${owner.get(id)} and shard ${i}`,
        );
        process.exit(1);
      }
      owner.set(id, i);
      totalRows++;
    }
    Object.assign(mergedTimings, timings);
  }

  // Insert in harbors.json's own order — the SAME order an unsharded
  // `runArm()` inserts rows in — so JSON.stringify's key-insertion-order
  // output is byte-identical to an unsharded run's. Anything in the shard
  // output but absent from harbours.json's CURRENT ids falls through to the
  // unaccounted-for check below instead of being silently dropped.
  const mergedRows = {};
  for (const id of harbourOrder) {
    if (owner.has(id)) mergedRows[id] = shardsForArm.get(owner.get(id)).rows[id];
  }
  if (Object.keys(mergedRows).length !== totalRows) {
    const unaccounted = [...owner.keys()].filter((id) => !(id in mergedRows));
    console.error(
      `FAIL: arm "${label}": ${unaccounted.length} harbour id(s) in the shard output are not in the ` +
        `current harbors.json (stale shards against a moved harbour list?): ${unaccounted.join(', ')}`,
    );
    process.exit(1);
  }

  // #1262 review Minor 2, check 1: the merged ids must be EXACTLY
  // `harbourOrder`'s first `totalRows` entries, in order — catches a GAP
  // in the middle (e.g. row 3 of 6 missing from every shard) that the
  // stale-harbour check above cannot see, since that check only looks for
  // EXTRA ids, never missing ones.
  const mergedIds = Object.keys(mergedRows);
  const expectedIds = harbourOrder.slice(0, totalRows);
  if (mergedIds.length !== expectedIds.length || !mergedIds.every((id, i) => id === expectedIds[i])) {
    console.error(
      `FAIL: arm "${label}": merged harbour ids are not harbors.json's first ${totalRows} entries — ` +
        `a gap in the middle of the shard output? got [${mergedIds.slice(0, 3).join(', ')}...], ` +
        `expected [${expectedIds.slice(0, 3).join(', ')}...]`,
    );
    process.exit(1);
  }
  // #1262 review Minor 2, check 2: every arm sweeps the SAME destination
  // list, so `totalRows` must agree across all of them — a per-arm gap that
  // happens to still land on a harbors.json prefix (e.g. one shard
  // invocation run under a different SC_SWEEP_LIMIT) would pass check 1
  // alone and only shows up as a cross-arm count mismatch.
  if (referenceTotalRows === null) {
    referenceTotalRows = totalRows;
    referenceArmLabel = label;
  } else if (totalRows !== referenceTotalRows) {
    console.error(
      `FAIL: arm "${label}" merged ${totalRows} rows but arm "${referenceArmLabel}" merged ` +
        `${referenceTotalRows} — every arm must sweep the same destination count`,
    );
    process.exit(1);
  }

  writeFileSync(resolve(outDir, `${label}.json`), serialize(mergedRows));
  writeFileSync(resolve(outDir, `${label}.timings.json`), serialize(mergedTimings));
  console.log(`arm ${label.padEnd(20)} merged ${totalRows} rows from ${n} shards`);
}

console.log(`\nMerged ${EXPECTED.length} arms into ${outDir}`);
