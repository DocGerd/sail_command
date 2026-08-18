// #54/Task 8: tests for canonicalize.mjs, run under plain Node
// (`node --test app/sweep/canonicalize.test.mjs`) — this directory is not
// collected by `npm --prefix app run test`, see README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizePlan, canonicalizeArmFile } from './canonicalize.mjs';
import { ARM_NAMES } from './armNames.ts';

// Fixture pair is asymmetric in EVERY way Task 9's rename actually is: the
// OUTER container (named genoa/fock fields vs a sails list), the NESTED key
// (RigResult.rig vs sailId), AND comparisonComplete (absent on legacy,
// present on renamed). A symmetric pair would pass against a canonicaliser
// that ignores the nested key or the new field.
const legacyShapePlan = {
  status: 'ok',
  genoa: { rig: 'genoa', etaMs: 111, legs: [] },
  fock: null,
  genoaReason: null,
  fockReason: 'unreachable',
  recommended: 'genoa',
};
const renamedShapePlan = {
  status: 'ok',
  comparisonComplete: true,
  recommended: 'genoa',
  sails: [
    { sailId: 'genoa', result: { sailId: 'genoa', etaMs: 111, legs: [] }, reason: null },
    { sailId: 'fock', result: null, reason: 'unreachable' },
  ],
};

test('a pre-rename and a post-rename plan carrying the SAME routes canonicalize equal', () => {
  assert.deepStrictEqual(canonicalizePlan(legacyShapePlan), canonicalizePlan(renamedShapePlan));
});

// The assertion that actually matters: a canonicaliser that flattens
// everything (routes included) would make every comparison pass, which is
// the exact failure mode this file exists to avoid.
const planA = {
  status: 'ok',
  genoa: {
    rig: 'genoa',
    etaMs: 111,
    legs: [{ kind: 'sail', board: 'port', twaDeg: 45, distanceNm: 1.2 }],
  },
  fock: null,
  genoaReason: null,
  fockReason: 'unreachable',
  recommended: 'genoa',
};
const planBWithOneLegMoved = {
  status: 'ok',
  genoa: {
    rig: 'genoa',
    etaMs: 111,
    legs: [{ kind: 'sail', board: 'port', twaDeg: 45, distanceNm: 2.4 }],
  },
  fock: null,
  genoaReason: null,
  fockReason: 'unreachable',
  recommended: 'genoa',
};

test('two plans whose ROUTES differ do NOT canonicalize equal', () => {
  assert.notDeepStrictEqual(canonicalizePlan(planA), canonicalizePlan(planBWithOneLegMoved));
});

test('PlanResultError passes through unchanged — the rename never touches it', () => {
  const err = { status: 'error', reason: 'unreachable' };
  assert.deepStrictEqual(canonicalizePlan(err), err);
});

test('comparisonComplete: an EXPLICIT false is preserved, not defaulted away', () => {
  const plan = {
    status: 'ok',
    comparisonComplete: false,
    recommended: 'genoa',
    sails: [
      { sailId: 'genoa', result: { sailId: 'genoa', etaMs: 111, legs: [] }, reason: null },
      { sailId: 'fock', result: null, reason: 'unreachable' },
    ],
  };
  assert.equal(canonicalizePlan(plan).comparisonComplete, false);
});

test('does not mutate its input — a frozen sails array must not throw', () => {
  const plan = {
    status: 'ok',
    comparisonComplete: true,
    recommended: 'genoa',
    sails: Object.freeze([
      { sailId: 'fock', result: null, reason: 'unreachable' },
      { sailId: 'genoa', result: { sailId: 'genoa', etaMs: 5, legs: [] }, reason: null },
    ]),
  };
  // Array.prototype.sort() on a frozen array throws (strict-mode "Cannot
  // assign to read only property") — this only passes if canonicalizePlan
  // sorts a freshly-mapped copy, never `plan.sails` itself.
  assert.doesNotThrow(() => canonicalizePlan(plan));
});

test('does not mutate its input — the original plan object is untouched', () => {
  const frozenLegacy = Object.freeze({ ...legacyShapePlan, genoa: Object.freeze({ ...legacyShapePlan.genoa }) });
  const before = JSON.stringify(frozenLegacy);
  canonicalizePlan(frozenLegacy);
  assert.equal(JSON.stringify(frozenLegacy), before);
});

// #54 fix round 1 (CRITICAL): compare.mjs's --canonical whole-file digest
// hashes canonicalizeArmFile's OUTPUT, and the per-plan compare it sits
// alongside iterates a SHARED SORTED key list — so a canonicalizeArmFile
// that itself builds from a sorted (or otherwise shared) key order would
// make the digest blind to a harbour reordering, which is exactly the class
// of change the digest exists to catch (a per-plan compare can never see it
// either way, by construction). This pins that canonicalizeArmFile
// preserves EACH INPUT's OWN key order rather than normalising it.
const planX = {
  status: 'ok',
  genoa: { rig: 'genoa', etaMs: 1, legs: [] },
  fock: null,
  genoaReason: null,
  fockReason: 'unreachable',
  recommended: 'genoa',
};
const planY = {
  status: 'ok',
  genoa: { rig: 'genoa', etaMs: 2, legs: [] },
  fock: null,
  genoaReason: null,
  fockReason: 'unreachable',
  recommended: 'genoa',
};

test('canonicalizeArmFile preserves each input\'s OWN harbour-key order — a reorder must change the serialised output', () => {
  const forward = { alpha: planX, beta: planY };
  const reversed = { beta: planY, alpha: planX }; // same per-harbour CONTENT, different KEY ORDER
  // Per-harbour content is identical, so an order-independent (per-plan)
  // compare would call these equal — this is specifically testing that the
  // WHOLE-FILE serialisation (what the digest hashes) is NOT order-independent.
  assert.notEqual(
    JSON.stringify(canonicalizeArmFile(forward)),
    JSON.stringify(canonicalizeArmFile(reversed)),
  );
});

test('canonicalizeArmFile: same key order canonicalizes to the same serialisation (sanity twin of the row above)', () => {
  const forward = { alpha: planX, beta: planY };
  const forwardAgain = { alpha: planX, beta: planY };
  assert.equal(
    JSON.stringify(canonicalizeArmFile(forward)),
    JSON.stringify(canonicalizeArmFile(forwardAgain)),
  );
});

// #54 fix round 2 (CRITICAL, controller override): the row above pins
// canonicalizeArmFile in ISOLATION — it proves the helper itself preserves
// order, but the ACTUAL round-1 defect was never inside the helper, it was
// at compare.mjs's CALL SITE (both sides were built from one shared sorted
// key list before ever reaching canonicalizeArmFile). A unit test that
// calls canonicalizeArmFile directly cannot see a regression that
// reintroduces that call-site bug while leaving the helper itself correct
// — reviewer-demonstrated: pre-sorting `ja`/`jb` before the
// `canonicalizeArmFile(ja)` call reproduces the CRITICAL end to end while
// this file's earlier rows all stayed green.
//
// So this runs `compare.mjs` as a real CHILD PROCESS, exactly the way a
// human invokes it (`node app/sweep/compare.mjs --canonical <a> <b>`) —
// not by importing an internal function, which would just relocate the
// same blind spot one layer up.
const here = dirname(fileURLToPath(import.meta.url));
const compareMjs = resolve(here, 'compare.mjs');

// Trivial per-harbour content — two harbours are enough to prove ORDER
// matters; the values only need to be valid enough for compare.mjs's
// per-plan loop to read `.status`/`.shallow`/`.reason` without throwing.
const harbourAlpha = {
  status: 'ok',
  genoa: { rig: 'genoa', etaMs: 1, legs: [] },
  fock: null,
  genoaReason: null,
  fockReason: 'unreachable',
  recommended: 'genoa',
};
const harbourBeta = {
  status: 'ok',
  genoa: { rig: 'genoa', etaMs: 2, legs: [] },
  fock: null,
  genoaReason: null,
  fockReason: 'unreachable',
  recommended: 'genoa',
};

/**
 * Writes a full, --canonical-compare.mjs-VALID output directory: one file
 * per `ARM_NAMES` entry (compare.mjs fails closed on anything less — see
 * its own header comment), every arm carrying the SAME per-harbour content,
 * keyed in `harbourOrder`'s order. Two calls with `harbourOrder` reversed
 * produce two directories identical in every per-plan value and differing
 * ONLY in on-disk key order — exactly the reviewer's construction ("parse a
 * real arm file, reverse Object.keys(), re-serialise; values byte-identical
 * per harbour"), reproduced synthetically so this test owns its own fixture
 * rather than depending on a manually-generated `/tmp/sweep/*` directory
 * being present.
 */
function writeFixtureDir(harbourOrder) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-t8-'));
  const rows = {};
  for (const id of harbourOrder) rows[id] = id === 'alpha' ? harbourAlpha : harbourBeta;
  const body = JSON.stringify(rows, null, 1);
  for (const arm of ARM_NAMES) writeFileSync(join(dir, `${arm}.json`), body);
  return dir;
}

test('#54 fix round 2 (CRITICAL): compare.mjs --canonical, run END TO END as a real child process, reports DIFFERS for a harbour-order regression — not just canonicalizeArmFile in isolation', () => {
  const forward = writeFixtureDir(['alpha', 'beta']);
  const reversed = writeFixtureDir(['beta', 'alpha']);
  try {
    const out = execFileSync('node', [compareMjs, '--canonical', forward, reversed], { encoding: 'utf8' });
    // Content is identical per harbour on both sides, so this is testing
    // ONLY the whole-file digest (the per-plan compare is, correctly,
    // order-independent and would report every plan equal either way).
    assert.match(out, /\*\*\* DIFFERS \*\*\* \(canonical\)/);
  } finally {
    rmSync(forward, { recursive: true, force: true });
    rmSync(reversed, { recursive: true, force: true });
  }
});

test('#54 fix round 2: companion — SAME harbour order on both sides reports IDENTICAL end to end, so the row above cannot pass by always seeing a difference', () => {
  const totalPlans = ARM_NAMES.length * 2;
  const dirA = writeFixtureDir(['alpha', 'beta']);
  const dirB = writeFixtureDir(['alpha', 'beta']);
  try {
    const out = execFileSync('node', [compareMjs, '--canonical', dirA, dirB], { encoding: 'utf8' });
    assert.doesNotMatch(out, /DIFFERS/);
    assert.match(out, new RegExp(`${totalPlans}/${totalPlans} plans canonically-identical`));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
