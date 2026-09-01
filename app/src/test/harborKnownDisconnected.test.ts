import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// #652: pipeline/verify_mask.py's KNOWN_DISCONNECTED dict is the single
// source of truth for "genuinely unreachable at the ~46 m mask resolution"
// (issue #9's five harbours). pipeline/build_harbors.mjs parses that SAME
// dict at build time and writes a `knownDisconnected: true` field into the
// shipped harbors.json for exactly those ids — never a hand-written second
// list; see build_harbors.mjs's own comment for why (a third place these
// ids could drift, on top of the Python source and the shipped JSON).
//
// This file is the DRIFT GUARD promised there: it independently re-parses
// pipeline/verify_mask.py (same regex idiom as maskTolerance.test.ts's
// readToleranceM() / verifyMaskConnectivity.test.ts's
// readKnownDisconnected() — deliberately NOT shared code, so one PR
// refactoring the parser can't silently break every reader at once) and
// asserts the SHIPPED harbors.json agrees. A KNOWN_DISCONNECTED edit whose
// `npm --prefix pipeline run harbors` re-run was skipped therefore reds the
// REQUIRED `app` check instead of silently shipping stale disclosure data —
// pipeline/verify_mask.py carries the same comparison too, but that job is
// advisory, not required (CLAUDE.md's "Python gates live OUTSIDE the app
// toolchain" bullet).
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFY_MASK_PATH = resolve(REPO, 'pipeline', 'verify_mask.py');
const HARBORS_JSON_PATH = resolve(REPO, 'app', 'public', 'data', 'harbors.json');

interface HarborFixture {
  readonly id: string;
  readonly knownDisconnected?: boolean;
}

function readKnownDisconnectedIds(): Set<string> {
  const py = readFileSync(VERIFY_MASK_PATH, 'utf8');
  const block = py.match(/^KNOWN_DISCONNECTED\s*:\s*dict\[str,\s*str\]\s*=\s*\{([\s\S]*?)^\}/m);
  // Fail CLOSED before any value comparison — same shape as
  // maskTolerance.test.ts's readToleranceM(): a regex that silently stops
  // matching (renamed, retyped, reformatted) must red loudly here, not pass
  // an empty/vacuous comparison quietly.
  expect(
    block,
    'KNOWN_DISCONNECTED literal not found in pipeline/verify_mask.py (renamed, retyped, or ' +
      "reformatted) — update this regex, build_harbors.mjs's reader, and " +
      "verifyMaskConnectivity.test.ts's readKnownDisconnected() together",
  ).not.toBeNull();
  // #652 review MINOR 1: matches ANY quoted key, not `[a-z0-9-]+` — a
  // narrower charset silently DROPS a real entry whose id contains `_` or
  // an uppercase letter (measured: adding "sonderborg_old" or "Sonderborg"
  // to KNOWN_DISCONNECTED parsed the SAME five ids either way, no throw, and
  // this file's own equality check below still PASSED, because
  // build_harbors.mjs's reader shared the identical blind spot — two guards
  // agreeing measured the shared assumption, not the fact). Reachability of
  // that gap is nil TODAY only because build_harbors.mjs's row-map check
  // (`if (!/^[a-z0-9-]+$/.test(id)) throw ...`) already enforces this same
  // narrow charset on every real harbor id — an UNDOCUMENTED PRECONDITION of
  // the narrow form, so relaxing that check alone would silently disarm both
  // parsers with nothing to say so. Widening costs nothing: over-extraction
  // still fails CLOSED via the equality assertion below (an extra id in
  // `wantIds` with nothing matching in `gotIds` is a real mismatch, not a
  // silent pass) — same conclusion build_harbors.mjs's twin comment reaches.
  const out = new Set<string>();
  for (const m of block![1].matchAll(/^\s*"([^"]+)"\s*:/gm)) {
    out.add(m[1]);
  }
  // #652 review MINOR 3: this fires on TWO distinct causes, only one of
  // which is a defect. The regex genuinely breaking (renamed/retyped/
  // reformatted entries, single-quoted keys) is the failure this guard
  // exists to catch. But KNOWN_DISCONNECTED emptying to `{}` is the OUTCOME
  // #9 exists to reach (new bathymetry, a per-feature channel carve, ...) —
  // and on that day this same regex, still working correctly, ALSO extracts
  // zero ids. Failing closed here is still the right default (a
  // legitimately-empty dict and a broken regex are indistinguishable at the
  // string level, and CLAUDE.md's guard-asymmetry rule puts a BLOCKING guard
  // on the fail-closed side) — the message just needs to name both causes so
  // the reader isn't sent hunting a parser bug that isn't there.
  expect(
    out.size,
    'KNOWN_DISCONNECTED matched but zero ids were extracted — EITHER the entry regex stopped ' +
      'matching (single-quoted keys?), update it alongside the pipeline change, OR ' +
      'KNOWN_DISCONNECTED is now legitimately empty (all five #9 harbours reconnected) — in that ' +
      'case delete this test file and its build_harbors.mjs twin, rather than widening the regex',
  ).toBeGreaterThan(0);
  return out;
}

function readShippedKnownDisconnectedIds(
  harbors: readonly HarborFixture[] = JSON.parse(
    readFileSync(HARBORS_JSON_PATH, 'utf8'),
  ) as HarborFixture[],
): Set<string> {
  return new Set(harbors.filter((h) => h.knownDisconnected === true).map((h) => h.id));
}

describe("#652: harbors.json's knownDisconnected <-> verify_mask.py's KNOWN_DISCONNECTED", () => {
  // The BLOCKING guard: a silent disagreement between the two artifacts is
  // the whole hazard this file exists to catch, so this stays fail-closed
  // and unconditional — never weakened, whatever KNOWN_DISCONNECTED's
  // CURRENT membership happens to be.
  it('the shipped harbors.json flags EXACTLY the ids verify_mask.py names', () => {
    const wantIds = [...readKnownDisconnectedIds()].sort();
    const gotIds = [...readShippedKnownDisconnectedIds()].sort();
    expect(gotIds).toEqual(wantIds);
  });

  // #652 review addendum: this test USED TO pin the literal five ids
  // (arnis/dyvig/graasten/kappeln/maasholm) as a positive control against the
  // equality check above passing vacuously on two coincidentally-empty sets.
  // That was WRONG in the same shape CLAUDE.md documents for a leak-detector
  // reddening on an IMPROVED catalogue (#595/PR #657,
  // `expect(internalOnly.length).toBeGreaterThan(0)`): KNOWN_DISCONNECTED
  // SHRINKING is the OUTCOME #9 exists to reach (new bathymetry, a
  // per-feature carve for the Dyvig channel or the Egernsund bridge, ...),
  // and a control requiring TODAY's five ids would red this REQUIRED `app`
  // check the day the dataset gets STRICTLY BETTER. Five disconnected
  // harbours is a fact about today's bathymetry, not an invariant of the
  // system.
  //
  // Replaced with a MEMBERSHIP-INDEPENDENT non-vacuity proof: a synthetic
  // fixture, unrelated to any real harbor id, that proves
  // readShippedKnownDisconnectedIds() can find a flagged entry and correctly
  // ignores an unflagged one — in BOTH directions, so stubbing the filter to
  // always-true or always-false both fail this row. This can never redden
  // because of anything that happens to the real KNOWN_DISCONNECTED dict,
  // including it going legitimately empty. (readKnownDisconnectedIds()'s own
  // internal `toBeGreaterThan(0)` check above already rules out the Python
  // side silently parsing to empty; this is the JSON-reading half, which had
  // no such check.)
  it('readShippedKnownDisconnectedIds finds a flagged id and ignores an unflagged one', () => {
    const fixture: HarborFixture[] = [
      { id: 'fixture-reachable-implicit' },
      { id: 'fixture-reachable-explicit', knownDisconnected: false },
      { id: 'fixture-disconnected', knownDisconnected: true },
    ];
    expect([...readShippedKnownDisconnectedIds(fixture)]).toEqual(['fixture-disconnected']);
  });
});
