import { describe, expect, it } from 'vitest';
import { stripCommentsAndStrings } from './sourceStrip';

// #1320: `FloodResult` and `floodHasCell` are exported from
// harborReachability.ts marked "test only" by comment, with nothing
// enforcing it. This structural guard scans every non-test source file
// (excluding harborReachability.ts itself, which defines them) for a
// reference to either identifier — modelled on
// cameraAnimationCallSites.test.ts's import.meta.glob + sourceStrip pattern.

const DEFINING_FILE = '../lib/harborReachability.ts';

const sourceFiles = import.meta.glob<string>(
  ['../**/*.{ts,tsx}', '!../test/**', '!../**/*.test.{ts,tsx}'],
  { query: '?raw', import: 'default', eager: true },
);

const TEST_ONLY_IDENTIFIERS = ['FloodResult', 'floodHasCell'];
const IDENTIFIER_PATTERN = new RegExp(`\\b(${TEST_ONLY_IDENTIFIERS.join('|')})\\b`, 'g');

function findLeaks(): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const [path, source] of Object.entries(sourceFiles)) {
    if (path === DEFINING_FILE) continue;
    const stripped = stripCommentsAndStrings(source);
    const matches = [...stripped.matchAll(IDENTIFIER_PATTERN)].map((m) => m[1]!);
    if (matches.length > 0) hits.set(path, matches);
  }
  return hits;
}

describe('#1320 structural guard: harborReachability test-only exports stay test-only', () => {
  it('non-vacuity: the defining file itself references both identifiers', () => {
    const definingSource = sourceFiles[DEFINING_FILE];
    expect(definingSource).toBeTypeOf('string');
    const stripped = stripCommentsAndStrings(definingSource!);
    for (const id of TEST_ONLY_IDENTIFIERS) {
      expect(stripped.includes(id)).toBe(true);
    }
  });

  // #1320 review (Major): the non-vacuity check above only proves the
  // DEFINING file was globbed — a glob narrowed to e.g. `../lib/*` still
  // passes it. This asserts the glob still reaches known cross-directory
  // needles, independent of the defining file, so a narrowing that drops a
  // whole consumer directory reds here.
  it('breadth: the glob still reaches components/, routing/, state/ and lib/', () => {
    const paths = Object.keys(sourceFiles);
    for (const dir of ['../components/', '../routing/', '../state/', '../lib/']) {
      expect(
        paths.some((p) => p.startsWith(dir)),
        `expected at least one captured file under ${dir}`,
      ).toBe(true);
    }
  });

  it('never lets FloodResult/floodHasCell leak into a non-test consumer', () => {
    const leaks = findLeaks();
    if (leaks.size > 0) {
      const detail = [...leaks.entries()]
        .map(([file, ids]) => `${file}: ${ids.join(', ')}`)
        .join('\n  ');
      throw new Error(
        `harborReachability.ts's test-only exports (FloodResult, floodHasCell) leaked ` +
          `into non-test source:\n  ${detail}\n\n` +
          `These are exported "for test use only" (#1320) — a real consumer should use ` +
          `the frozen API instead: HarborAccessState, computeHarborAccess, ` +
          `LowerSettingHintOutcome, findLowerSettingHint. If a new consumer genuinely ` +
          `needs FloodResult/floodHasCell, widen the frozen API deliberately and update ` +
          `this guard's comment rather than let the leak stand silently.`,
      );
    }
  });
});
