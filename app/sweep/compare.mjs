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
 *
 * #54/Task 8: pass `--canonical` (in either argument position) to compare
 * through `canonicalize.mjs`'s `canonicalizePlan` instead of raw parsed
 * JSON. Default (no flag) byte mode is UNCHANGED — every code path below
 * that doesn't mention `canonical` behaves exactly as before, so a prior
 * byte-mode result stays comparable. See README.md for when each mode is
 * valid: byte for a no-change claim, canonical for a deliberate shape
 * change (Task 9's PlanResultOk rename) that a byte compare cannot see past.
 *
 * The whole-file digest below is ALSO computed over the canonicalised form
 * under `--canonical`, not suppressed and not left on raw bytes: raw bytes
 * would print "*** DIFFERS ***" beside a correct canonically-identical
 * verdict (the rename changes field names, which changes every byte), while
 * suppressing it would silently drop the one thing a per-plan compare
 * cannot see — a key-order change. `JSON.stringify` preserves insertion
 * order, and `canonicalizePlan` does NOT normalise every key's order (only
 * the fields the rename itself touches — the sails list and the
 * genoa/fock-vs-sailId key inside each RigResult); every other top-level key
 * keeps the input plan's own order. So a stray key-order regression in a
 * field the rename never touches is still caught in canonical mode.
 *
 * NAMED RESIDUAL (PR #488 review): this only checks that BOTH SIDES agree on
 * which arms exist and which harbours each arm covers — it has no idea that
 * a real run always covers all 33 harbours, so it cannot distinguish a
 * genuine full comparison from two `SC_SWEEP_LIMIT`-truncated runs compared
 * against each other (README.md's own "never for a real comparison" caveat
 * on that env var is not mechanically enforced here). The summary line below
 * therefore names the arm and per-arm-harbour counts explicitly rather than
 * a bare fraction, so a truncated run is visible in the output even though
 * it is not rejected.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { canonicalizePlan } from './canonicalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { ARM_NAMES } = await import(resolve(here, 'armNames.ts'));
const EXPECTED = [...ARM_NAMES].sort();

const rawArgs = process.argv.slice(2);
const canonical = rawArgs.includes('--canonical');
const [a, b] = rawArgs.filter((x) => x !== '--canonical');
if (!a || !b) {
  console.error('usage: node compare.mjs [--canonical] <dirA> <dirB>');
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
  // Under --canonical, built up alongside the per-plan loop for the
  // whole-file digest below — never read when canonical is false.
  const canonA = {};
  const canonB = {};
  for (const k of keys) {
    total++;
    const va = canonical ? canonicalizePlan(ja[k]) : ja[k];
    const vb = canonical ? canonicalizePlan(jb[k]) : jb[k];
    if (canonical) {
      canonA[k] = va;
      canonB[k] = vb;
    }
    const sa = JSON.stringify(va);
    const sb = JSON.stringify(vb);
    if (sa === sb) same++;
    else diffs.push(`${arm}/${k}  A=${sha(sa)} B=${sha(sb)}`);
    const o = ja[k].status === 'ok' ? (ja[k].shallow ? 'ok+shallow' : 'ok') : `error/${ja[k].reason}`;
    outcomes[o] = (outcomes[o] ?? 0) + 1;
  }
  // Whole-file digest as well: catches a key-ORDER change a per-plan compare
  // would not see. In canonical mode this hashes the CANONICALISED
  // serialisation, not raw bytes — raw bytes would print "*** DIFFERS ***"
  // beside a correct canonically-identical verdict, since the rename changes
  // field names (see the header comment above for why this doesn't just
  // drop the key-order check).
  const digestA = canonical ? JSON.stringify(canonA) : fa;
  const digestB = canonical ? JSON.stringify(canonB) : fb;
  console.log(
    `arm ${arm.padEnd(16)} ${keys.length} plans  sha A=${sha(digestA)} B=${sha(digestB)} ${
      digestA === digestB ? 'IDENTICAL' : '*** DIFFERS ***'
    }${canonical ? ' (canonical)' : ''}`,
  );
}

// Named per-arm harbour count rather than a bare fraction (see the NAMED
// RESIDUAL header comment above): makes a SC_SWEEP_LIMIT-truncated run
// visible in the summary instead of reading identically to a full one.
const harboursPerArm = arms.length > 0 ? total / arms.length : 0;
console.log(
  `\n${same}/${total} plans ${canonical ? 'canonically' : 'byte'}-identical across ${arms.length} arms x ${harboursPerArm} harbours/arm`,
);
console.log('A-side outcome distribution:', JSON.stringify(outcomes));
if (diffs.length) {
  console.log('\nDIFFERING PLANS:');
  for (const d of diffs) console.log('  ' + d);
  process.exit(1);
}
