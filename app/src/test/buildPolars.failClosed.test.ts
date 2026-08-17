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
// needs THREE conditions together: the sail-id guard removed, the two-pass
// restructure reverted to inline writes, AND the escaping sail written before
// a LATER boat fails validation.
//
//   exit code 1                                  <- build DID fail
//   readdir(polars/) -> []                       <- directory-scoped PASSES
//   whole tree -> app/public/data/ESCAPED.json   <- tree walk REDS
//
// Drop any one of the three and it is unreachable. With the two-pass
// restructure in place nothing is written before the throw; with inline writes
// but no later failure the build exits 0 and `polars/` holds the legitimate
// files, so the directory-scoped assertion fails rather than passes. Earlier
// retellings of this named only the first two conditions and do not reproduce.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(REPO, 'pipeline', 'build_polars.mjs');
const SOURCE = join(REPO, 'pipeline', 'polars-source.json');
const SHIPPED = join(REPO, 'app', 'public', 'data', 'polars');

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
      anchors?: { label: string; twa: number; tws: number; minKn: number; maxKn: number }[];
    };
    tws: number[];
    twa: number[];
    beat: unknown;
    gybe: unknown;
    sails: Record<string, { provenance?: { tier?: string; note?: string }; speeds: number[][] }>;
  }[];
} {
  return JSON.parse(readFileSync(SOURCE, 'utf8'));
}

function writtenFiles(outDir: string): string[] {
  return existsSync(outDir) ? readdirSync(outDir).sort() : [];
}

/**
 * Every file the run produced ANYWHERE under the scratch root, minus the two
 * inputs the harness itself planted. A directory-scoped listing cannot see a
 * write that escaped that directory, which is exactly how an unvalidated id
 * gets past a "wrote nothing" assertion.
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
    .filter(
      (f) =>
        f !== join('pipeline', 'build_polars.mjs') && f !== join('pipeline', 'polars-source.json'),
    )
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
    expect(r.output).toContain('salona-45');
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
});
