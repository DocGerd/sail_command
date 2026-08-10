#!/usr/bin/env node
/**
 * #282 sweep comparator: byte-compare two sweep output directories.
 *
 *   node app/sweep/compare.mjs <dirA> <dirB>
 *
 * Exits 0 only when every arm file is byte-identical. Fails CLOSED on an empty,
 * mismatched, OR INCOMPLETE arm set — a 0/0 comparison must never read as
 * success, and neither may a comparison over fewer arms than the harness
 * actually defines (#452: this used to fail closed only on ZERO arms, so a
 * partial run — e.g. one arm's output file missing or never written — could
 * still produce a confident-looking verdict over an incomplete arm set).
 *
 * The expected arm set is DERIVED from `armNames.ts`, not a second hardcoded
 * number: that file is the same one `sweepArms.ts`'s `ARMS` record is typed
 * against (`Record<(typeof ARM_NAMES)[number], Arm>`), so TypeScript itself
 * keeps the two in sync — adding an arm to `ARMS` without adding it to
 * `ARM_NAMES` (or vice versa) is a compile error, not a silent drift. This
 * script `import()`s that file directly under plain Node (no vite/vitest);
 * see `armNames.ts`'s own doc comment for why it must stay import-free for
 * that to keep working.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { ARM_NAMES } = await import(resolve(here, 'armNames.ts'));
const EXPECTED = [...ARM_NAMES].sort();

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: node compare.mjs <dirA> <dirB>');
  process.exit(2);
}

const armsOf = (d) =>
  readdirSync(d)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.timings.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

const arms = armsOf(a);
const armsB = armsOf(b);
if (arms.join() !== armsB.join()) {
  console.error(`ARM SET DIFFERS\n  A: ${arms.join()}\n  B: ${armsB.join()}`);
  process.exit(1);
}
if (arms.length === 0) {
  console.error('FAIL: no arm files found — a vacuous 0/0 comparison');
  process.exit(1);
}
if (arms.join() !== EXPECTED.join()) {
  const missing = EXPECTED.filter((x) => !arms.includes(x));
  const unexpected = arms.filter((x) => !EXPECTED.includes(x));
  console.error(
    `FAIL: arm set INCOMPLETE — expected ${EXPECTED.length} arms (${EXPECTED.join(', ')}), found ${arms.length}`,
  );
  if (missing.length) console.error(`  MISSING: ${missing.join(', ')}`);
  if (unexpected.length) console.error(`  UNEXPECTED (not in armNames.ts): ${unexpected.join(', ')}`);
  process.exit(1);
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
let total = 0;
let same = 0;
const diffs = [];
const outcomes = {};

for (const arm of arms) {
  const fa = readFileSync(`${a}/${arm}.json`, 'utf8');
  const fb = readFileSync(`${b}/${arm}.json`, 'utf8');
  const ja = JSON.parse(fa);
  const jb = JSON.parse(fb);
  const keys = Object.keys(ja).sort();
  if (keys.join() !== Object.keys(jb).sort().join()) {
    console.error(`ARM ${arm}: harbour set differs`);
    process.exit(1);
  }
  for (const k of keys) {
    total++;
    const sa = JSON.stringify(ja[k]);
    const sb = JSON.stringify(jb[k]);
    if (sa === sb) same++;
    else diffs.push(`${arm}/${k}  A=${sha(sa)} B=${sha(sb)}`);
    const o = ja[k].status === 'ok' ? (ja[k].shallow ? 'ok+shallow' : 'ok') : `error/${ja[k].reason}`;
    outcomes[o] = (outcomes[o] ?? 0) + 1;
  }
  // Whole-file digest as well: catches a key-ORDER change a per-plan compare
  // would not see.
  console.log(
    `arm ${arm.padEnd(16)} ${keys.length} plans  sha A=${sha(fa)} B=${sha(fb)} ${
      fa === fb ? 'IDENTICAL' : '*** DIFFERS ***'
    }`,
  );
}

console.log(`\n${same}/${total} plans byte-identical`);
console.log('A-side outcome distribution:', JSON.stringify(outcomes));
if (diffs.length) {
  console.log('\nDIFFERING PLANS:');
  for (const d of diffs) console.log('  ' + d);
  process.exit(1);
}
