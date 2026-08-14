import { describe, expect, it } from 'vitest';
import { BOATS } from '../data/boats';

// #54 (multi-boat release-1, spec §F.3): nine non-test files enumerate the
// sail set (today `'genoa' | 'fock'`) with NO derivation between any of
// them. The compiler protects that asymmetrically: a `Record<SailId, X>`
// reds loudly the moment a sail is added or removed, while a two-way
// ternary (`rig === 'genoa' ? a : b`) keeps compiling and silently picks
// the wrong sail once a third one exists. Task 9 centralises these nine
// call sites onto BOATS-derived lookups; this guard exists so a NEW bare
// sail-id literal cannot regrow silently in the meantime, and so Task 9's
// own progress is visible as the offender list shrinking toward `[]`.
//
// Modeled on chipShallowFill.test.ts's structural-scan half (an offender
// list pinned against an expected value, with an explanatory failure
// message, rather than a bare pass/fail) for the shape of the test. The
// SCAN MECHANISM itself follows cameraAnimationCallSites.test.ts /
// timeoutGuard.test.ts instead of chipShallowFill.test.ts's `node:fs`
// `readFileSync`: those two already solve "scan every non-test file in
// app/src for a pattern" via `import.meta.glob(..., { query: '?raw', eager:
// true })`, which needs no tsconfig.test.json/tsconfig.app.json entry —
// chipShallowFill.test.ts's `node:fs` read is for a single NON-TypeScript
// asset (app.css), which is the actual reason that file needs node builtins
// (see its own tsconfig.test.json comment); nothing here reads a non-TS
// asset, so the browser-safe glob form is the closer precedent for a
// many-file source scan.
const rawSourceFiles = import.meta.glob<string>(
  ['../**/*.{ts,tsx}', '!../test/**', '!../**/*.test.{ts,tsx}'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

// import.meta.glob's keys are relative to THIS file's own directory
// (app/src/test/), e.g. `'../data/boats.ts'`. Normalise the single leading
// `../` to `src/` so file identities read the way the rest of this repo
// (and the #54 plan's own ALLOWED literal below) spells them —
// `src/data/boats.ts` — and so `ALLOWED`'s entries match by a plain
// `endsWith`, exactly as the plan's own code does.
//
// THE TRAP this closes (MEASURED, not theoretical — mutation-checked in
// this task's report): without this normalisation, a raw key like
// `'../data/boats.ts'` does NOT `endsWith('src/data/boats.ts')` — there is
// no `src/` segment in it at all. `boats.ts` would then silently fall OUT
// of the allowlist match, get scanned like any other file, and — since it
// legitimately DOES contain the bare literals `'genoa'`/`'fock'` as the
// catalogue's own ids — get reported as a FALSE offender. The guard would
// look like it was working while accusing the very catalogue it exists to
// route everything else through.
const sourceByPath = new Map(
  Object.entries(rawSourceFiles).map(([key, content]) => [key.replace(/^\.\.\//, 'src/'), content]),
);

function walkSourceFiles(): string[] {
  return [...sourceByPath.keys()];
}

function readSource(path: string): string {
  const content = sourceByPath.get(path);
  if (content === undefined) {
    throw new Error(
      `#54 guard: no source found for ${path} — the glob and the path normalisation have drifted apart`,
    );
  }
  return content;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches `'genoa'`, `"genoa"` AND `` `genoa` `` — all three quote forms.
// PR #411 measured a structural guard that matched only single-quoted
// literals and stayed 10/10 green against a backtick re-coupling (prettier
// normalises `"…"` to `'…'` but leaves a template literal alone), passing
// both lint and typecheck. The quote character must sit IMMEDIATELY before
// and after the id, which is what makes this NOT match a longer i18n key
// like `'route.rig.genoa'` — see the sanity tests below and the ALLOWED
// comment for why that distinction is load-bearing here.
function buildSailIdPattern(ids: readonly string[]): RegExp {
  return new RegExp(`['"\`](${ids.map(escapeRegExp).join('|')})['"\`]`);
}

// The allowlist is HAND-WRITTEN and pinned — per #411, a guard's DATA needs
// a twin, or stubbing this to [] silently disables the guard while it keeps
// reporting success (see the twin test below).
//
// `src/i18n/dict.de.ts` and `src/i18n/dict.en.ts` are DELIBERATELY NOT
// here, on a controller ruling (#54 fix-wave 1). MEASURED: neither dict
// contains a bare quoted sail-id literal today — both hold
// `'route.rig.genoa'` / `'route.rig.fock'`, longer i18n KEYS for the Rig
// type's labels that the pattern below does not match (no quote
// immediately before "genoa") — so an entry for either would have exempted
// a violation that has never occurred, not a known-acceptable one. Worse,
// pre-exempting them would read as "the dicts are expected to contain sail
// ids", which is backwards: the plan's Global Constraints state sail/boat
// labels are catalogue data (proper nouns), never dictionary keys, so a
// bare sail-id literal landing in a dict is exactly the violation this
// guard exists to catch, and the file class where the rule is strictest.
// See the dedicated active check below instead of an allowlist entry.
const ALLOWED = ['src/data/boats.ts'];

// SNAPSHOT of today's nine known offenders — deliberately NOT an empty
// array. Task 9 centralises every one of these onto BOATS-derived lookups;
// until then, keeping the guard red-until-fixed (via `it.fails`) or the two
// tasks' commits adjacent both leave a real window — a full task's worth of
// commits under Task 8 — where the suite carries no working structural
// signal, which is exactly when a genuinely NEW offender hides best.
// Pinning the CURRENT set instead makes this guard a real, live check from
// the moment it lands: a tenth file adding a bare sail-id literal reds it
// immediately, and Task 9 shrinking the set (correctly) ALSO reds it,
// forcing a deliberate, reviewed update to this list rather than silent
// drift in either direction. Task 9 should shrink this to `[]`.
const KNOWN_OFFENDERS = [
  'src/components/RouteLayer.tsx',
  'src/components/RouteSummary.tsx',
  'src/lib/gpx.ts',
  'src/lib/plan.ts',
  'src/lib/sessionSnapshot.ts',
  'src/routing/planRoute.ts',
  'src/routing/workerClient.ts',
  'src/state/usePlanFlow.ts',
  'src/types.ts',
];

function findOffenders(): string[] {
  const ids = BOATS.flatMap((b) => b.sails.map((s) => s.id));
  const pattern = buildSailIdPattern(ids);
  return walkSourceFiles()
    .filter((f) => !ALLOWED.some((a) => f.endsWith(a)))
    .filter((f) => pattern.test(readSource(f)))
    .sort();
}

describe('#54 sail-id pattern sanity (proves the regex construction itself, not just the scan)', () => {
  it('matches a bare quoted sail id in each supported quote form', () => {
    const ids = BOATS.flatMap((b) => b.sails.map((s) => s.id));
    const pattern = buildSailIdPattern(ids);
    for (const id of ids) {
      expect(pattern.test(`'${id}'`), `single-quote form of ${id}`).toBe(true);
      expect(pattern.test(`"${id}"`), `double-quote form of ${id}`).toBe(true);
      expect(pattern.test(`\`${id}\``), `backtick form of ${id}`).toBe(true);
    }
  });

  it('does NOT match a longer key that merely contains a sail id as a substring', () => {
    const ids = BOATS.flatMap((b) => b.sails.map((s) => s.id));
    const pattern = buildSailIdPattern(ids);
    expect(pattern.test(`'route.rig.${ids[0]}'`)).toBe(false);
  });
});

// ACTIVE guard, not documentation: the plan's Global Constraints state sail
// and boat labels are catalogue data (proper nouns) and NEVER dictionary
// keys, so a bare sail-id literal in either dict would be a real violation
// of that rule — and, unlike everywhere else this guard scans, one that
// nothing else in the codebase enforces (dict.de.ts/dict.en.ts key parity
// via `satisfies Record<MsgKey, string>` checks the KEY SET matches between
// the two dicts; it says nothing about what a key's own text may contain).
// Deliberately reads the REAL file content through the same `readSource` /
// `buildSailIdPattern` the rest of this file uses, rather than a synthetic
// string, so this is checking the actual shipped dicts, not a hypothesis
// about them. If Task 9 (or anything later) needs a bare sail literal in a
// dict, this reds and the exemption has to be added to ALLOWED
// deliberately — the point, not an accident to route around.
describe('#54 i18n dicts never carry a bare sail-id literal (plan Global Constraints)', () => {
  it('neither dict.de.ts nor dict.en.ts contains one', () => {
    const ids = BOATS.flatMap((b) => b.sails.map((s) => s.id));
    const pattern = buildSailIdPattern(ids);
    for (const path of ['src/i18n/dict.de.ts', 'src/i18n/dict.en.ts']) {
      expect(
        pattern.test(readSource(path)),
        `#54 guard: ${path} contains a bare sail-id literal. Sail/boat labels are catalogue ` +
          'data (proper nouns), never i18n dictionary keys (plan Global Constraints) — route ' +
          'the label through BOATS instead of adding it to a dict.',
      ).toBe(false);
    }
  });
});

describe('#54 structural guard: allowlist is pinned', () => {
  it('the allowlist is exactly what we expect', () => {
    expect(ALLOWED).toEqual(['src/data/boats.ts']);
  });
});

describe('#54 structural guard: no bare sail-id literal outside the allowlist beyond the known set', () => {
  it('the source scan itself is not empty (guards against a broken glob silently reporting zero offenders)', () => {
    // 114 non-test files exist in app/src today; 50 is a conservative floor
    // that still fails loudly if the glob pattern or the exclusions above
    // are ever broken in a way that empties the scan.
    expect(walkSourceFiles().length).toBeGreaterThan(50);
  });

  it('matches exactly the known offenders — no fewer (Task 9 drift), no more (a new regression)', () => {
    const offenders = findOffenders();
    expect(
      offenders,
      `#54 guard: offender list was [${offenders.join(', ')}], expected the pinned snapshot ` +
        `[${KNOWN_OFFENDERS.join(', ')}]. If a NEW file appeared, route its sail-id literal ` +
        'through the BOATS catalogue instead of adding it here. If this shrank because Task 9 ' +
        'centralised a call site, update KNOWN_OFFENDERS deliberately to match (and delete this ' +
        'guard once it reaches [] and Task 9 replaces it with a real Record<SailId, …> pattern).',
    ).toEqual(KNOWN_OFFENDERS);
  });
});
