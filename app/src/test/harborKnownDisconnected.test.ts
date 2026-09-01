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
  const out = new Set<string>();
  for (const m of block![1].matchAll(/^\s*"([a-z0-9-]+)"\s*:/gm)) {
    out.add(m[1]);
  }
  // Same silent-empty hole as the block-not-found case above: a regex that
  // matches the block but stops matching individual entries (e.g. the
  // dict switched to single-quoted keys) would otherwise extract zero ids
  // and silently disarm this whole guard.
  expect(
    out.size,
    'KNOWN_DISCONNECTED matched but zero ids were extracted — the entry regex stopped matching ' +
      '(single-quoted keys?) — update it alongside the pipeline change',
  ).toBeGreaterThan(0);
  return out;
}

function readShippedKnownDisconnectedIds(): Set<string> {
  const harbors = JSON.parse(readFileSync(HARBORS_JSON_PATH, 'utf8')) as HarborFixture[];
  return new Set(harbors.filter((h) => h.knownDisconnected === true).map((h) => h.id));
}

describe("#652: harbors.json's knownDisconnected <-> verify_mask.py's KNOWN_DISCONNECTED", () => {
  it('the shipped harbors.json flags EXACTLY the ids verify_mask.py names', () => {
    const wantIds = [...readKnownDisconnectedIds()].sort();
    const gotIds = [...readShippedKnownDisconnectedIds()].sort();
    expect(gotIds).toEqual(wantIds);
  });

  // Positive control (repo lesson: an empty comparison passing silently is
  // not evidence — CLAUDE.md's "give any probe whose emptiness you intend
  // to interpret a positive control"): pins the real, currently-known five
  // so a reader stubbed to return an empty set fails HERE too, not just on
  // the equality check above (which a coincidentally-also-empty
  // harbors.json could pass vacuously).
  it('names the five #9 harbours known to be disconnected today', () => {
    expect([...readKnownDisconnectedIds()].sort()).toEqual(
      ['arnis', 'dyvig', 'graasten', 'kappeln', 'maasholm'].sort(),
    );
  });
});
