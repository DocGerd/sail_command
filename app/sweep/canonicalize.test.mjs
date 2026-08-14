// #54/Task 8: tests for canonicalize.mjs, run under plain Node
// (`node --test app/sweep/canonicalize.test.mjs`) — this directory is not
// collected by `npm --prefix app run test`, see README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizePlan, canonicalizeArmFile } from './canonicalize.mjs';

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
