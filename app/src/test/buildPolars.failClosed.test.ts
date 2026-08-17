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
import { dirname, join, resolve } from 'node:path';
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
// Each case below runs the REAL script against a MUTATED copy of the real
// pipeline/polars-source.json, in a scratch tree. The script resolves its
// output directory relative to its own file (`../app/public/data/polars`), so
// a copy at <tmp>/pipeline/ writes to <tmp>/app/public/data/polars and can
// never touch the committed assets.

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
    return { ok: true, output: stdout, outDir };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}`, outDir };
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
    expect(writtenFiles(r.outDir)).toEqual([]);
  });

  it('aborts when a sail declares a provenance tier outside the three-tier model', () => {
    const src = freshSource();
    src.boats[0].sails['genoa'].provenance = { tier: 'measured', note: 'x' };
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('genoa');
    expect(writtenFiles(r.outDir)).toEqual([]);
  });

  it('aborts when a sail carries a tier but no source note', () => {
    const src = freshSource();
    delete src.boats[0].sails['fock'].provenance!.note;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('fock');
    expect(writtenFiles(r.outDir)).toEqual([]);
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
    expect(writtenFiles(r.outDir)).toEqual([]);
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
    expect(writtenFiles(r.outDir)).toEqual([]);
  });

  // The boat id is what keeps two boats' assets apart, so a missing or
  // path-unsafe one must never reach a filename.
  it.each([undefined, '../escape', 'Salona 45'])('aborts on boat id %o', (id) => {
    const src = freshSource();
    if (id === undefined) delete src.boats[0].id;
    else src.boats[0].id = id;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(writtenFiles(r.outDir)).toEqual([]);
  });

  it('aborts when an anchor names a TWA/TWS the boat’s grid does not contain', () => {
    const src = freshSource();
    src.boats[0].validation!.anchors![0].twa = 999;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('999');
    expect(writtenFiles(r.outDir)).toEqual([]);
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
    expect(writtenFiles(r.outDir)).toEqual([]);
  });

  it('aborts when a speed exceeds the boat’s own plausibility bound', () => {
    const src = freshSource();
    src.boats[0].validation!.maxSpeedKn = 5;
    const r = run(src);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('salona-45/genoa');
    expect(writtenFiles(r.outDir)).toEqual([]);
  });
});
