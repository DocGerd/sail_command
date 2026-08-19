import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';

// #54 Task 12 / spec H: pipeline/build_polars.mjs must FAIL CLOSED. A boat
// added without its own sanity anchors or plausibility bound, or a sail
// without a provenance tier or note, has to abort the build and name itself —
// never inherit the Salona 45's values, because an anchor that silently
// validates the wrong hull is worse than no anchor.
//
// The defect this closes was invisible by construction: the sail set used to
// be enumerated twice (the loop, and a hardcoded SOURCE_NOTES object) with no
// derivation between them, so a sail in the loop but not in SOURCE_NOTES got
// `source: undefined` — and JSON.stringify DROPS an undefined value rather
// than emitting it, shipping an asset with no `source` key at all. No throw,
// no warning, nothing wrong-looking in the output.
//
// The FIRST case is the control and runs against the UNMUTATED source; it is
// what licenses the abort rows and must not be deleted as an outlier. Every
// case after it runs the REAL script against a MUTATED copy of the real
// pipeline/polars-source.json, in a scratch tree. The script resolves its
// output directory relative to its own file (`../app/public/data/polars`), so
// a copy at <tmp>/pipeline/ writes to <tmp>/app/public/data/polars and can
// never touch the committed assets.
//
// Fix round 1: the "wrote nothing" assertions used to `readdir` the `polars/`
// directory alone, so a write that escaped that directory landed outside what
// the assertion looked at. They now walk the whole scratch tree.
//
// No row below DISCRIMINATES the tree walk from a directory-scoped listing.
// The two-pass restructure means every abort row throws before anything is
// written, so `polars/` does not exist and both helpers return []. Within this
// suite the tree walk is therefore defensive breadth, not something a row
// measures — keep it anyway: it is the only assertion that would see a write
// landing outside the output directory.
//
// The state it defends against WAS reached, out-of-band in a scratch tree, and
// needs FOUR conditions together (#552 — re-derived and reproduced against a
// hand-mutated scratch copy of the real script; an earlier revision of this
// comment said THREE and was wrong, see below): the sail-id guard removed,
// the two-pass restructure reverted to inline writes, the escaping sail
// written before a LATER boat fails validation, AND no legitimate sail
// landing in `polars/` at any point before that failure — which needs BOTH
// that the escaping boat contributes no legitimate sibling of its own (in
// practice: it is that boat's ONLY sail) AND that no EARLIER boat in the
// source has already written its own legitimate sails there first.
//
//   exit code 1                                  <- build DID fail
//   readdir(polars/) -> []                       <- directory-scoped PASSES
//   whole tree -> app/public/data/ESCAPED.json   <- tree walk REDS
//
// Drop any one of the four and it is unreachable. With the two-pass
// restructure in place nothing is written before the throw; with inline writes
// but no later failure the build exits 0 and `polars/` holds the legitimate
// files, so the directory-scoped assertion fails rather than passes.
// MEASURED (#552): reordering the source so one legitimate boat is processed
// BEFORE the escaping one — otherwise identical, escaping sail still its own
// boat's only sail, later boat still fails — makes `readdir(polars/)` return
// that legitimate boat's two real files instead of `[]`, so the
// directory-scoped assertion no longer passes either: the fourth condition is
// independently load-bearing, not implied by the other three. Earlier
// retellings of this named only the first two conditions and do not
// reproduce; a later retelling named three and reproduces only when the
// escaping boat also happens to be first in the source.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(REPO, 'pipeline', 'build_polars.mjs');
// #54 spec N.6: build_polars.mjs imports the estimator so E5 and E7 run the
// SAME code the tables were generated with rather than a second implementation
// of it. The scratch tree therefore needs both files or every run dies on an
// unresolved import — which would make every "it aborts" row below pass for
// entirely the wrong reason.
const ESTIMATOR = join(REPO, 'pipeline', 'estimate_polars.mjs');
const SOURCE = join(REPO, 'pipeline', 'polars-source.json');
const SHIPPED = join(REPO, 'app', 'public', 'data', 'polars');

/** A boat id that is estimated (tier C) in the committed source. */
const TIER_C = 'salona-44-speedy-go';
/** The OTHER tier-C boat, for rows that need a second one. */
const TIER_C2 = 'elan-444-piranja';

/**
 * What the harness itself writes into the scratch tree, so `allWrittenFiles`
 * can subtract it. A SET rather than an inline predicate because it grew from
 * two entries to three when the estimator had to be copied alongside the
 * script, and a missed entry here reads as "the build wrote a stray file" on
 * every abort row at once.
 */
const PLANTED = new Set([
  join('pipeline', 'build_polars.mjs'),
  join('pipeline', 'estimate_polars.mjs'),
  join('pipeline', 'polars-source.json'),
]);

const scratchRoots: string[] = [];
afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  readonly ok: boolean;
  readonly output: string;
  readonly outDir: string;
  /** The mkdtemp root, carried explicitly — see allWrittenFiles. */
  readonly root: string;
}

/** Run the real generator against `source` in a throwaway tree. */
function run(source: unknown): RunResult {
  const root = mkdtempSync(join(tmpdir(), 'sc-polars-'));
  scratchRoots.push(root);
  mkdirSync(join(root, 'pipeline'), { recursive: true });
  cpSync(SCRIPT, join(root, 'pipeline', 'build_polars.mjs'));
  cpSync(ESTIMATOR, join(root, 'pipeline', 'estimate_polars.mjs'));
  writeFileSync(join(root, 'pipeline', 'polars-source.json'), JSON.stringify(source));
  const outDir = join(root, 'app', 'public', 'data', 'polars');
  try {
    const stdout = execFileSync('node', [join(root, 'pipeline', 'build_polars.mjs')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: stdout, outDir, root };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}`, outDir, root };
  }
}

function freshSource(): {
  boats: {
    id?: string;
    name?: string;
    validation?: {
      maxSpeedKn?: number;
      /** #54 spec N.3 step 5 — optional HERE only so a row can delete it. */
      maxSpeedKnSource?: string;
      anchors?: {
        label: string;
        twa: number;
        tws: number;
        minKn: number;
        maxKn: number;
        /** #54 spec N.6 E3 — optional HERE only so a row can delete it. */
        source?: string;
      }[];
    };
    tws: number[];
    twa: number[];
    beat: unknown;
    gybe: unknown;
    sails: Record<
      string,
      {
        provenance?: { tier?: string; note?: string };
        /**
         * #54 spec N.6. Present on every tier-C sail in the committed source;
         * declared optional and loosely here so a row can delete the block, or
         * any one field of it, without a cast at every site.
         */
        estimator?: {
          method?: string;
          baseBoatId?: string;
          baseSailId?: string;
          scalar?: number;
          corpusFree?: boolean;
          uncertaintyPct?: number;
          ramp?: { boatId?: string; fromSailId?: string; toSailId?: string };
          inputs?: Record<string, { value?: number; source?: string } | undefined>;
        };
        speeds: number[][];
      }
    >;
  }[];
} {
  return JSON.parse(readFileSync(SOURCE, 'utf8'));
}

function writtenFiles(outDir: string): string[] {
  return existsSync(outDir) ? readdirSync(outDir).sort() : [];
}

/**
 * Every file the run produced ANYWHERE under the scratch root, minus the
 * inputs the harness itself planted (see PLANTED). A directory-scoped listing cannot see a
 * write that escaped that directory. That alone is not enough to slip past a
 * "wrote nothing" assertion — the full set of conditions is in this file's
 * header comment, and no row here reaches them.
 *
 * The root is the `mkdtemp` directory the run reports, NOT a fixed number of
 * levels up from `outDir` — deriving it by counting `..` hardcodes the output
 * path's depth, and if that path ever gets shallower the walk lands in
 * `tmpdir()` itself and enumerates every other test's scratch tree.
 */
function allWrittenFiles(r: RunResult): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [relative(r.root, join(dir, e.name))],
    );
  return walk(r.root)
    .filter((f) => !PLANTED.has(f))
    .sort();
}

describe('#54 Task 12: build_polars.mjs fails closed', () => {
  // CONTROL. Every "it aborts" row below is an absence assertion, and an
  // absence carries no information until the evidence-generating process is
  // established to run at all. This row is what licenses them: the unmutated
  // source builds, and its bytes are the bytes committed under
  // app/public/data/polars/ — so the harness runs the real generator on the
  // real data and the committed assets are reproducible from it.
  it('builds the committed assets byte-for-byte from the unmutated source', () => {
    const r = run(freshSource());
    expect(r.ok, r.output).toBe(true);
    const files = writtenFiles(r.outDir);
    expect(files).toEqual(readdirSync(SHIPPED).sort());
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(readFileSync(join(r.outDir, f)), f).toEqual(readFileSync(join(SHIPPED, f)));
    }
  });

  // The headline case: a sail the old two-list design would have shipped with
  // its provenance note silently missing. Asserted by SHAPE — the build fails
  // and names the offender — not by matching a sentence.
  it('aborts, writing NOTHING, when a sail carries no provenance', () => {
    const src = freshSource();
    const boat = src.boats[0];
    boat.sails['staysail'] = { speeds: boat.sails['genoa'].speeds };
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('staysail');
    // Fail CLOSED: a partially-built asset set is exactly the state a later
    // regeneration would leave alongside the good files without noticing.
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('aborts when a sail declares a provenance tier outside the three-tier model', () => {
    const src = freshSource();
    src.boats[0].sails['genoa'].provenance = { tier: 'measured', note: 'x' };
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('genoa');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('aborts when a sail carries a tier but no source note', () => {
    const src = freshSource();
    delete src.boats[0].sails['fock'].provenance!.note;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('fock');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // Spec H: a boat added without its own anchors must fail the build rather
  // than inherit the Salona's. A second boat is added here so the row cannot
  // pass merely because the ONLY boat vanished.
  it('aborts when a second boat carries no sanity anchors of its own', () => {
    const src = freshSource();
    const clone = JSON.parse(JSON.stringify(src.boats[0]));
    clone.id = 'other-boat';
    delete clone.validation.anchors;
    src.boats.push(clone);
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('other-boat');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('aborts when a second boat carries no plausibility bound of its own', () => {
    const src = freshSource();
    const clone = JSON.parse(JSON.stringify(src.boats[0]));
    clone.id = 'other-boat';
    delete clone.validation.maxSpeedKn;
    src.boats.push(clone);
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('other-boat');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // The boat id is what keeps two boats' assets apart, so a missing or
  // path-unsafe one must never reach a filename.
  it.each(['../escape', 'Salona 45', '-rf'])('aborts on boat id %o', (id) => {
    const src = freshSource();
    src.boats[0].id = id;
    const r = run(src);
    expect(r.ok).toBe(false);
    // Name the offender, like every sibling row — otherwise a future refactor
    // that aborts for an unrelated reason keeps this green.
    expect(r.output).toContain(id);
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // Split out of the it.each above: with the id absent there is no offender
  // VALUE to name, and `toContain(String(undefined))` is satisfied by the
  // substring 'undefined' anywhere in a stack trace. Naming the FIELD is the
  // strongest assertion available here, at the cost of pinning two words.
  it('aborts, naming the field, when a boat carries no id at all', () => {
    const src = freshSource();
    delete src.boats[0].id;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('boat id');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // The SAIL id is the other half of the same `${id}-${sailId}.json` string,
  // and validating only the boat half left it able to escape the output
  // directory: `../../../ESCAPED` built with exit 0 and wrote
  // app/public/data/ESCAPED.json, beside harbors.json and mask.bin.
  it.each(['../../../ESCAPED', '../escape', 'Genoa 135 %'])('aborts on sail id %o', (sailId) => {
    const src = freshSource();
    const boat = src.boats[0];
    boat.sails[sailId] = boat.sails['genoa'];
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain(sailId);
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // §F.1's overwrite hazard on the BOAT axis. Two boats sharing an id logged
  // the same filename twice and shipped the second boat's speed table and
  // provenance note under the first boat's identity — wrong polar numbers
  // under a boat's name, which is the routing-safety consequence class.
  it('aborts when two boats declare the same id', () => {
    const src = freshSource();
    const clone = JSON.parse(JSON.stringify(src.boats[0]));
    clone.name = 'Some Other Boat';
    src.boats.push(clone);
    const r = run(src);
    expect(r.ok).toBe(false);
    // #552: `toContain('salona-45')` alone does not discriminate THIS failure
    // from any of the other 8 assertions in this file that also match
    // 'salona-45' in unrelated messages — tighten to the literal
    // `requireField` message (build_polars.mjs's `duplicate boat id: ${id}`).
    expect(r.output).toContain('duplicate boat id');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // `-` is BOTH the filename separator and a legal id character, so the id is
  // not the unique thing — the FILENAME is. These two boats have distinct,
  // legal, non-duplicate ids and still both resolve to `a-b-c.json`: exit 0,
  // the same name logged twice, one table silently replacing the other. The
  // boat-id check cannot see this; only the output-file check can.
  it('aborts when two DISTINCT boat ids collide on one output filename', () => {
    const src = freshSource();
    const a = JSON.parse(JSON.stringify(src.boats[0]));
    const b = JSON.parse(JSON.stringify(src.boats[0]));
    a.id = 'a-b';
    a.name = 'Boat A-B';
    a.sails = { c: a.sails.genoa };
    b.id = 'a';
    b.name = 'Boat A';
    b.sails = { 'b-c': b.sails.fock };
    src.boats = [a, b];
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('a-b-c.json');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // The converse, and the reason the two checks are not one: these boats share
  // an id but their sail sets are DISJOINT, so no filename collides at all. A
  // filename-keyed check alone passes this (exit 0, measured) while the two
  // records silently merge into a single boat's polar set.
  it('aborts on a duplicate boat id even when no output filename collides', () => {
    const src = freshSource();
    const a = JSON.parse(JSON.stringify(src.boats[0]));
    const b = JSON.parse(JSON.stringify(src.boats[0]));
    a.name = 'Boat One';
    a.sails = { genoa: a.sails.genoa };
    b.name = 'Boat Two';
    b.sails = { fock: b.sails.fock };
    src.boats = [a, b];
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('salona-45');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // `>` and `<` coerce, so a decimal STRING satisfies the plausibility bound
  // and ships; lib/polar.ts then interpolates over strings, where `+`
  // concatenates. beat/gybe were only null-checked, so `{}` built cleanly.
  it('aborts when speeds are numeric STRINGS rather than numbers', () => {
    const src = freshSource();
    const boat = src.boats[0];
    boat.sails['genoa'].speeds = boat.sails['genoa'].speeds.map((row) =>
      row.map((v) => String(v) as unknown as number),
    );
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('salona-45/genoa');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it.each(['beat', 'gybe'] as const)('aborts when %s is an empty object', (field) => {
    const src = freshSource();
    src.boats[0][field] = {};
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain(field);
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('aborts when an anchor names a TWA/TWS the boat’s grid does not contain', () => {
    const src = freshSource();
    src.boats[0].validation!.anchors![0].twa = 999;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('999');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // The anchors must still BITE on the real table, not merely be present —
  // otherwise every row above passes while the check validates nothing.
  it('aborts when the table drifts outside an anchor’s band', () => {
    const src = freshSource();
    const a = src.boats[0].validation!.anchors![0];
    a.maxKn = a.minKn; // 8.86 sits inside [8.26, 9.46]; collapse the band onto its floor
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain(a.label);
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('aborts when a speed exceeds the boat’s own plausibility bound', () => {
    const src = freshSource();
    src.boats[0].validation!.maxSpeedKn = 5;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('salona-45/genoa');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // AXIS ORDERING. `requireNumbers` proves an axis is finite, never that it
  // ASCENDS — and app/src/lib/polar.ts walks every axis assuming it does,
  // dividing by the gap between consecutive entries. Each row below mutates a
  // DIFFERENT axis, and each mutation is chosen so no OTHER guard can serve
  // it: the two sanity anchors name twa 90/52 and tws 16/12, so all four
  // mutations leave every anchor's `indexOf` unchanged, and none touches the
  // speed grid the plausibility and TWS-monotonicity checks read.
  // Mutation-checked one call site at a time (see this task's report):
  // deleting the `requireAscending` for one axis reds that axis's row alone.
  it('aborts when the TWS axis does not ascend', () => {
    const src = freshSource();
    const tws = src.boats[0].tws;
    [tws[0], tws[1]] = [tws[1], tws[0]]; // 4,6,… -> 6,4,…
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('salona-45: tws');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // A REPEATED value is the worse half: polar.ts divides by `tws[j] -
  // tws[j-1]`, so a duplicated axis entry is a 0/0 that yields NaN boat speed
  // for every heading, and NaN flows into the isochrone cost unchecked.
  it('aborts when the TWS axis repeats a value', () => {
    const src = freshSource();
    const tws = src.boats[0].tws;
    tws[tws.length - 1] = tws[tws.length - 2]; // …,20,25 -> …,20,20
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('salona-45: tws');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('aborts when the TWA axis does not ascend', () => {
    const src = freshSource();
    const twa = src.boats[0].twa;
    [twa[0], twa[1]] = [twa[1], twa[0]]; // 35,40,… -> 40,35,…
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('salona-45: twa');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // beat/gybe carry their OWN tws axis, walked by interp1 the same way, and
  // no other guard in this file reads them at all — this is the axis a
  // boat-axis-only check would leave open.
  // LENGTH 1 — the hole requireAscending's own loop cannot see (it starts at
  // i = 1) and requireNumbers does not close (it demands only length > 0).
  // Each row supplies a SELF-CONSISTENT single-point table — the speeds grid
  // is truncated to match and the anchors are re-pointed at a cell that
  // exists, with a band wide enough to pass — so nothing but the length floor
  // can abort the build. MEASURED: with `requireInterpolable` removed, both
  // rows red because the build exits 0 (see this task's report).
  it('aborts when the TWS axis has a single point', () => {
    const src = freshSource();
    const boat = src.boats[0];
    boat.tws = [10];
    for (const sail of Object.values(boat.sails)) sail.speeds = sail.speeds.map((row) => [row[0]]);
    boat.validation!.anchors = [
      { label: 'single-column', twa: boat.twa[0], tws: 10, minKn: 0.01, maxKn: 99 },
    ];
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('salona-45: tws');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('aborts when the TWA axis has a single point', () => {
    const src = freshSource();
    const boat = src.boats[0];
    boat.twa = [90];
    for (const sail of Object.values(boat.sails)) sail.speeds = [sail.speeds[0]];
    boat.validation!.anchors = [
      { label: 'single-row', twa: 90, tws: boat.tws[0], minKn: 0.01, maxKn: 99 },
    ];
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('salona-45: twa');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it.each(['beat', 'gybe'] as const)('aborts when the %s TWS axis does not ascend', (field) => {
    const src = freshSource();
    const axis = (src.boats[0][field] as { tws: number[] }).tws;
    [axis[0], axis[1]] = [axis[1], axis[0]];
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain(`salona-45: ${field}.tws`);
    expect(allWrittenFiles(r)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #54 spec N.6: the tier-C (estimated polar) fail-closed rules E1-E8.
//
// Tier C is the app making a speed claim about a boat nobody measured. Every
// rule below exists so that claim is DECLARED, complete, sourced and
// re-derivable — and so the build stops rather than shipping quietly when any
// of that is missing.
//
// EACH ROW MUST BE INDIVIDUALLY LOAD-BEARING, and two hazards specific to this
// block made that non-obvious, so both are handled explicitly:
//
//   1. RULES CAN SHADOW EACH OTHER. E7 (reproducibility) reds on almost any
//      perturbation of an estimated boat, because almost anything changes the
//      recomputed table. A mutation aimed at E5 that also moves the table
//      therefore proves nothing about E5. The E5 row below constructs a state
//      where the inputs, the declared scalar and every committed cell agree
//      PERFECTLY and only the ratio is out of band — so E5 is the only rule
//      that can fire. That construction is the row's whole point.
//
//   2. A MUTATION MUST REACH THE PATH. Every rule here is gated on a sail
//      being tier C, so mutating a tier-A boat exercises nothing (#455's
//      "a mutation that cannot REACH the code path under test is ZERO
//      evidence"). Rows therefore mutate `TIER_C`, a boat that is genuinely
//      estimated in the committed source, and the E1-converse row deliberately
//      goes the other way to cover the tier-A direction.
// ---------------------------------------------------------------------------
describe('#54 spec N.6: tier-C estimated polars fail closed (E1-E8)', () => {
  /** The committed source is genuinely tier C — otherwise every row is vacuous. */
  it('the committed source really does contain an estimated sail (reachability control)', () => {
    const src = freshSource();
    const boat = src.boats.find((b) => b.id === TIER_C);
    expect(boat, `${TIER_C} missing from polars-source.json`).toBeDefined();
    const tiers = Object.values(boat!.sails).map((s) => s.provenance!.tier);
    expect(tiers).toContain('estimated');
    // And every estimated sail carries the block E1 demands, so the rows below
    // are removing something that is actually there.
    for (const [sailId, sail] of Object.entries(boat!.sails))
      if (sail.provenance!.tier === 'estimated')
        expect(sail.estimator, `${TIER_C}/${sailId} has no estimator block`).toBeDefined();
  });

  // E1, forward. Tier C is declared, never fallen into.
  it('E1: aborts when a tier-C sail carries no estimator block at all', () => {
    const src = freshSource();
    delete src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain(`${TIER_C}/fock`);
    expect(r.output).toContain('estimated');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it.each(['method', 'baseBoatId', 'baseSailId', 'scalar', 'corpusFree', 'uncertaintyPct'])(
    'E1: aborts when a tier-C estimator block is missing %s',
    (field) => {
      const src = freshSource();
      const est = src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!;
      delete (est as Record<string, unknown>)[field];
      const r = run(src);
      expect(r.ok).toBe(false);
      expect(r.output).toContain(`${TIER_C}/fock`);
      // Naming the FIELD is what makes each per-field check individually
      // load-bearing. Asserting only the sail name left `baseBoatId` and
      // `baseSailId` DEAD (measured): with their check deleted, a missing id
      // falls through to MAJOR 4's `baseSail != null`, which aborts and names
      // the same sail. MAJOR 4's message reads "estimator base <a>/<b>" with a
      // space, so it cannot satisfy "estimator.baseBoatId".
      expect(r.output).toContain(`estimator.${field}`);
      expect(allWrittenFiles(r)).toEqual([]);
    },
  );

  // E1, CONVERSE. Not a symmetry exercise: this is the "tier quietly
  // downgraded while the derivation stayed" shape, which would present scaled
  // numbers to the user as certificate-grade. It is also the only row in this
  // block that mutates the tier FIELD rather than the block.
  it('E1: aborts when a NON-estimated sail carries an estimator block', () => {
    const src = freshSource();
    const boat = src.boats.find((b) => b.id === TIER_C)!;
    boat.sails['fock']!.provenance!.tier = 'certificate';
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain(`${TIER_C}/fock`);
    expect(r.output).toContain('estimator block');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E2. A ratio built from a MIXED measurement basis is wrong by a few percent
  // through every cell and undetectable afterwards, so each figure must say
  // where it came from.
  it('E2: aborts when an estimator input carries no source', () => {
    const src = freshSource();
    const est = src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!;
    delete est.inputs!['sailAreaUpwindM2']!.source;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('sailAreaUpwindM2');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E2's VACUITY twin. "Every input has a source" is vacuously true of an
  // empty object, so without the emptiness check the rule above passes on a
  // block declaring no inputs whatsoever — provenance nobody can check.
  it('E2: aborts when the estimator declares an EMPTY inputs object', () => {
    const src = freshSource();
    const est = src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!;
    est.inputs = {};
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('inputs is empty');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E3, applied to EVERY boat. An anchor with no named source is an
  // unfalsifiable band: nobody can tell later whether it measured this hull or
  // was chosen to make the build pass.
  it.each(['salona-45', TIER_C])('E3: aborts when %s has an anchor with no source', (boatId) => {
    const src = freshSource();
    const anchors = src.boats.find((b) => b.id === boatId)!.validation!.anchors! as {
      source?: string;
    }[];
    delete anchors[0].source;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('has no source');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E4. Spec L's "reuse the Salona 45's polar sanity anchors for other hulls"
  // made mechanical. Reaching it needs the tier-C boat to carry an anchor at a
  // cell the DONOR also anchors, which the committed data deliberately avoids
  // — so the mutation has to build that collision, and building it is what
  // proves the rule is reachable rather than dead.
  it('E4: aborts when a tier-C boat copies the donor hull’s anchor wholesale', () => {
    const src = freshSource();
    const donorAnchor = src.boats.find((b) => b.id === 'salona-45')!.validation!.anchors![0];
    src.boats
      .find((b) => b.id === TIER_C)!
      .validation!.anchors!.push({
        ...donorAnchor,
      } as typeof donorAnchor);
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('same band');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E4 is CONJUNCTIVE, and this row is what proves it. Same cell and same
  // source but a genuinely different band is a legitimate anchor — two hulls
  // may well be cited by the same publication at the same conditions — and
  // must NOT abort. Without this row an over-eager E4 (matching on cell alone,
  // or on cell+source) would look correct.
  it('E4: does NOT abort when the band differs, even at the donor’s own cell', () => {
    const src = freshSource();
    const donorAnchor = src.boats.find((b) => b.id === 'salona-45')!.validation!.anchors![0];
    src.boats
      .find((b) => b.id === TIER_C)!
      .validation!.anchors!.push({
        ...donorAnchor,
        minKn: 0.5,
        maxKn: 11.5,
      } as typeof donorAnchor);
    const r = run(src);
    expect(r.ok, r.output).toBe(true);
  });

  // The OTHER half of the conjunction, and it needs its own row: with only the
  // row above, deleting `a.source === twin.source` from E4 reds NOTHING
  // (MEASURED) — that row's band already differs, so the band terms alone
  // still decline to fire and it stays green. Two hulls can legitimately be
  // cited at the same conditions with the same band by DIFFERENT sources; that
  // is independent corroboration, not a copied anchor, and must not abort.
  // Deleting the source term makes E4 fire here, which is what gives that term
  // a keeper. Per-TERM, not per-guard (#518).
  it('E4: does NOT abort when the band matches but the source is genuinely independent', () => {
    const src = freshSource();
    const donorAnchor = src.boats.find((b) => b.id === 'salona-45')!.validation!.anchors![0];
    src.boats
      .find((b) => b.id === TIER_C)!
      .validation!.anchors!.push({
        ...donorAnchor,
        source: 'A separate published test of THIS hull that happens to agree on the band.',
      } as typeof donorAnchor);
    const r = run(src);
    expect(r.ok, r.output).toBe(true);
  });

  // E5. THE SHADOWING PROBLEM, handled by construction. Simply editing the
  // declared `scalar` out of band reds E7 instead (the declaration would no
  // longer match the inputs), which would prove nothing about E5. So this
  // mutation moves the INPUT far enough to push the ratio past 1.25, then
  // regenerates the declared scalar AND both committed tables to match — a
  // state in which the block is perfectly self-consistent and E7 has nothing
  // to say. E5 is then the only rule that can fire.
  it('E5: aborts on a hull scalar outside [0.80, 1.25], with everything else consistent', () => {
    const src = freshSource();
    const donor = src.boats.find((b) => b.id === 'salona-45')!;
    const boat = src.boats.find((b) => b.id === TIER_C)!;

    // Doubling the target's sail area doubles SA/D and multiplies k by sqrt(2)
    // ~ 1.414 — comfortably outside [0.80, 1.25] and nowhere near the
    // boundary, so this row cannot pass or fail on a rounding hair.
    const DOUBLED_SA = 185.62;
    // Only the SCALAR sail carries inputs — MAJOR 2 removed them from the ramp
    // sail, which derives from this one.
    boat.sails['fock']!.estimator!.inputs!['sailAreaUpwindM2']!.value = DOUBLED_SA;

    // Now re-derive EVERYTHING downstream of that input, so the block stays
    // perfectly self-consistent and E7 has nothing to say. The two arithmetic
    // steps are re-implemented here rather than imported from
    // pipeline/estimate_polars.mjs on purpose — that module is untyped JS
    // outside the TS program, and needle and haystack coming from different
    // artifacts is the property #388 asks for anyway. It is self-checking: if
    // this ever drifts from production's arithmetic the row still reds, but
    // with 'do not reproduce' (E7) instead of the E5 message asserted below,
    // which is an unmistakable signal rather than a silent pass.
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const sad = (saM2: number, dispKg: number) => saM2 / Math.pow(dispKg / 1025, 2 / 3);
    const est = boat.sails['fock']!.estimator!;
    const k = Math.sqrt(
      sad(DOUBLED_SA, est.inputs!['displacementKg']!.value!) /
        sad(est.inputs!['baseSailAreaUpwindM2']!.value!, est.inputs!['baseDisplacementKg']!.value!),
    );
    const base = donor.sails['fock']!.speeds.map((row) => row.map((v) => r2(v * k)));
    boat.sails['fock']!.speeds = base;
    boat.sails['genoa']!.speeds = base.map((row, i) =>
      row.map((v, j) =>
        r2(v * (donor.sails['genoa']!.speeds[i][j] / donor.sails['fock']!.speeds[i][j])),
      ),
    );
    for (const sailId of Object.keys(boat.sails))
      boat.sails[sailId]!.estimator!.scalar = Math.round(k * 1000) / 1000;
    // The doubled table now exceeds the boat's own plausibility bound, which
    // would abort FIRST and shadow E5 — so raise it. This is the row admitting
    // what it had to neutralise to isolate one rule.
    boat.validation!.maxSpeedKn = 99;
    boat.validation!.anchors = [
      {
        label: 'e5-probe',
        twa: boat.twa[0],
        tws: boat.tws[0],
        minKn: 0.01,
        maxKn: 98,
        source: 'e5 probe',
      },
    ];

    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('outside [0.8, 1.25]');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E6, the "which base sail / which ramp" half. The second table's derivation
  // must be explicit, or a reader cannot tell an overlay from a measurement.
  // Asserts the `spec N.6 E6` MARKER, not merely the word "ramp". MEASURED:
  // with a bare toContain('ramp') this row reds ZERO times when the build-side
  // check is deleted, because estimate_polars.mjs independently refuses a ramp
  // method with no ramp block and its message also contains "ramp". The row
  // looked like it covered E6 and covered only "the build aborts somehow" —
  // the #518 "a row served by a different term" class. Only the marker
  // discriminates which layer refused.
  it('E6: aborts, naming the rule, when the second sail’s ramp block is missing', () => {
    const src = freshSource();
    delete src.boats.find((b) => b.id === TIER_C)!.sails['genoa']!.estimator!.ramp;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('spec N.6 E6');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // A ramp block PRESENT but incomplete is a distinct shape: the estimator
  // would fail later and less clearly (an undefined boat id reaches boatOf as
  // a lookup miss), so the per-field check is what names the actual omission.
  it.each(['boatId', 'fromSailId', 'toSailId'])(
    'E6: aborts, naming the field, when estimator.ramp.%s is missing',
    (field) => {
      const src = freshSource();
      const ramp = src.boats.find((b) => b.id === TIER_C)!.sails['genoa']!.estimator!.ramp!;
      delete (ramp as Record<string, unknown>)[field];
      const r = run(src);
      expect(r.ok).toBe(false);
      expect(r.output).toContain(`estimator.ramp.${field}`);
      expect(allWrittenFiles(r)).toEqual([]);
    },
  );

  // E6. A ramp pointing at ANOTHER boat's sail would silently reintroduce the
  // donor's hull into the second table while the block still looked complete.
  it('E6: aborts when the second sail derives from another boat’s base table', () => {
    const src = freshSource();
    src.boats.find((b) => b.id === TIER_C)!.sails['genoa']!.estimator!.baseBoatId = TIER_C2;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('its OWN base table');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E6. Two independent scaled base tables on one boat would be two different
  // derivations presented as one boat's inventory.
  it('E6: aborts when a boat declares two scaled base tables', () => {
    const src = freshSource();
    const boat = src.boats.find((b) => b.id === TIER_C)!;
    const genoa = boat.sails['genoa']!.estimator!;
    // Make the second block a WELL-FORMED scalar derivation, not merely a
    // relabelled ramp: point it at the donor's certificate table (or MAJOR 4
    // fires on the tier), give it the inputs a scalar sail must carry (or
    // MAJOR 2's ramp rule and E2 fire), and drop the now-meaningless ramp.
    // Only then is "two sails declare SCALAR_METHOD" the sole violation left,
    // which is what makes this row a test of E6 rather than of its neighbours.
    genoa.method = 'salona45-uniform-scalar-v1';
    genoa.baseBoatId = 'salona-45';
    genoa.baseSailId = 'fock';
    genoa.inputs = JSON.parse(JSON.stringify(boat.sails['fock']!.estimator!.inputs));
    delete genoa.ramp;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('expected exactly 1');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E7. The rule that makes the 85.7-vs-77.76 m2 sail-area trap a red build
  // rather than a 5% error through every cell that nothing downstream can see.
  it('E7: aborts when an estimator INPUT moves without the table being regenerated', () => {
    const src = freshSource();
    src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!.inputs![
      'sailAreaUpwindM2'
    ]!.value = 85.7;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('do not reproduce');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E7 must cover the SECOND table too, or the ramp step is unguarded: the
  // base table would be checked and the overlay could be anything at all.
  it('E7: aborts when the second sail’s committed table is hand-edited', () => {
    const src = freshSource();
    const speeds = src.boats.find((b) => b.id === TIER_C)!.sails['genoa'].speeds;
    speeds[0][0] = speeds[0][0] + 0.01;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('do not reproduce');
    expect(r.output).toContain('genoa');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E7 also pins the DECLARED scalar against the inputs. Without this a block
  // could advertise a scalar it was not built with — the number a reviewer
  // reads first and is least likely to recompute.
  it('E7: aborts when the declared scalar disagrees with the committed inputs', () => {
    const src = freshSource();
    src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!.scalar = 1.111;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('declared scalar 1.111');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // E8: "every existing structural check is retained unchanged". That is a
  // rule about ABSENCE of a bypass, so the honest test is to fire the OLD
  // guards at a NEW tier-C boat and confirm they still bite there. Without
  // this, E1-E7 could all pass while a tier-C boat skipped the axis,
  // plausibility and anchor-band guards entirely.
  it('E8: the pre-existing plausibility bound still bites on a tier-C boat', () => {
    const src = freshSource();
    src.boats.find((b) => b.id === TIER_C)!.validation!.maxSpeedKn = 5;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain(`${TIER_C}/`);
    expect(r.output).toContain('implausible');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('E8: the pre-existing anchor band still bites on a tier-C boat', () => {
    const src = freshSource();
    const a = src.boats.find((b) => b.id === TIER_C)!.validation!.anchors![0];
    a.maxKn = a.minKn; // collapse the band onto its floor
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain(a.label);
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // PRE-EXISTING dead condition, closed here rather than left named: nothing
  // in this file exercised the TWS-monotonicity guard at all, so it reddened
  // zero rows. Mutated on the SALONA 45 deliberately — it is not estimated, so
  // E7 has no opinion on its table and cannot shadow this. TWA 35 carries no
  // anchor (they sit at 90 and 52) and 3.0 kn clears the plausibility bound,
  // so the monotonicity check is the only thing that can fire.
  it('E8: the pre-existing TWS monotonicity guard still bites', () => {
    const src = freshSource();
    const row = src.boats.find((b) => b.id === 'salona-45')!.sails['genoa']!.speeds[0];
    row[2] = row[1] - 0.84; // 4.97 -> 3.0, below the 3.84 beside it
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('non-monotone TWS');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('E8: the pre-existing TWS axis guard still bites on a tier-C boat', () => {
    const src = freshSource();
    const tws = src.boats.find((b) => b.id === TIER_C)!.tws;
    [tws[0], tws[1]] = [tws[1], tws[0]];
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain(`${TIER_C}: tws`);
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // ---- MINOR 6: three conditions that once reddened ZERO rows ----
  //
  // Two are the message-shadowing class E6 was already repaired for:
  // build_polars.mjs and estimate_polars.mjs emitted byte-identical bodies for
  // a malformed input entry, differing only in the `polars-source.json:` vs
  // `estimate_polars:` prefix their throw sites prepend — so a row asserting
  // the body would pass with the build-side check deleted. The build-side
  // messages now carry a `spec N.6 E1`/`E2` marker; these rows assert THAT.
  // The `scalar` one shadowed differently: with the check gone a missing
  // scalar reached E7's Object.is comparison, which reds with E7's message.

  it('E1: aborts, naming the rule, when estimator.scalar is missing', () => {
    const src = freshSource();
    delete src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!.scalar;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('spec N.6 E1');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('E2: aborts, naming the SHAPE, when an inputs entry is not an object', () => {
    const src = freshSource();
    const est = src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!;
    est.inputs!['sailAreaUpwindM2'] = 92.81 as unknown as { value: number; source: string };
    const r = run(src);
    expect(r.ok).toBe(false);
    // The E2 marker alone left this DEAD (measured): a bare number has no
    // `.value` either, so deleting the shape check merely handed the abort to
    // the value check one line below, which carries the same marker. Only the
    // shape wording discriminates which of the two siblings refused.
    expect(r.output).toContain('is not a { value, source } object');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('E2: aborts, naming the rule, when an inputs entry value is not a number', () => {
    const src = freshSource();
    const est = src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!;
    est.inputs!['sailAreaUpwindM2']!.value = '92.81' as unknown as number;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('spec N.6 E2');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // ---- MAJOR 2: a RAMP sail must carry no inputs at all ----
  //
  // Before this rule, the four sourced figures on a ramp sail were dead data:
  // estimatedSpeedsFor's RAMP branch recurses into the BASE sail and never
  // reads them. MEASURED then: editing the ramp sail's sailAreaUpwindM2 from
  // 77.76 to 85.7 built cleanly with all six assets byte-identical, while the
  // same edit on the scalar sail reddened correctly. The ramp block also held
  // the FIRST occurrence of 77.76 in the file, so it was the copy a
  // contributor would most likely edit.
  it('MAJOR 2: aborts when a ramp sail declares estimator.inputs', () => {
    const src = freshSource();
    const boat = src.boats.find((b) => b.id === TIER_C)!;
    boat.sails['genoa']!.estimator!.inputs = {
      sailAreaUpwindM2: { value: 92.81, source: 'a copy nothing reads' },
    };
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('must not declare estimator.inputs');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // ---- MAJOR 4: what the base IS, not merely that it is named ----

  // Spec N.3 step 3: the certificate-anchored table is the base, NEVER the
  // modelled genoa overlay. E7 reproduces happily from either, and the shipped
  // note would still read "certificate-anchored" because that note is prose.
  it('MAJOR 4: aborts when the scaled base is the donor’s MODELLED genoa', () => {
    const src = freshSource();
    src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!.baseSailId = 'genoa';
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("not 'certificate'");
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // Scaling one estimate from another puts §G.2's "estimate of an estimate"
  // into the ETA itself, rather than into the comparison §N.4 suppresses.
  it('MAJOR 4: aborts when the scaled base is another ESTIMATED table', () => {
    const src = freshSource();
    const est = src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!;
    est.baseBoatId = TIER_C2;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("not 'certificate'");
    expect(allWrittenFiles(r)).toEqual([]);
  });

  it('MAJOR 4: aborts when the scaled base names a boat/sail that does not exist', () => {
    const src = freshSource();
    src.boats.find((b) => b.id === TIER_C)!.sails['fock']!.estimator!.baseBoatId = 'no-such-boat';
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('is not a boat/sail in this file');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // A ramp from a sail onto ITSELF is a ratio of exactly 1.0 — two
  // byte-identical tables shipped as two different sails.
  it('MAJOR 4: aborts when the ramp maps a sail onto itself', () => {
    const src = freshSource();
    src.boats.find((b) => b.id === TIER_C)!.sails['genoa']!.estimator!.ramp!.toSailId = 'fock';
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('that ramp is the identity');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // The ramp must come from the DONOR hull. Any other boat's ramp is not the
  // documented overlay §N.4 authorises, and §N.4's argument for suppressing
  // the comparison depends on knowing which ramp it is.
  it('MAJOR 4: aborts when the ramp comes from a boat other than the donor', () => {
    const src = freshSource();
    src.boats.find((b) => b.id === TIER_C)!.sails['genoa']!.estimator!.ramp!.boatId = TIER_C2;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('ramp comes from');
    expect(allWrittenFiles(r)).toEqual([]);
  });

  // ---- MINOR 10: the plausibility ceiling is held to E3's standard ----
  //
  // Spec N.3 step 5 treats maxSpeedKn and the anchors ALIKE. Applied to every
  // boat, so the reference boat is held to it too — the same reasoning that
  // made E3 universal.
  it.each(['salona-45', TIER_C])(
    'MINOR 10: aborts when %s declares a plausibility ceiling with no source',
    (boatId) => {
      const src = freshSource();
      delete src.boats.find((b) => b.id === boatId)!.validation!.maxSpeedKnSource;
      const r = run(src);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('maxSpeedKnSource missing');
      expect(allWrittenFiles(r)).toEqual([]);
    },
  );
});
