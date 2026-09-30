import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BOATS } from '../data/boats';
import type { PolarTable } from '../types';

// #54 Task 12. The polar provenance note exists in THREE artifacts that no
// compiler spans: pipeline/polars-source.json (the input), each shipped
// app/public/data/polars/*.json asset's `source` field (the pipeline output),
// and app/src/data/boats.ts's polarProvenance.note (what the catalogue
// declares and snapshots into each plan). Task 12 RELOCATED the pipeline copy
// from build_polars.mjs's SOURCE_NOTES into polars-source.json — the count is
// unchanged at three, and this is what keeps them from drifting apart.
//
// It also pins SailDef.polarAsset, a bare string nothing type-checks against
// the filesystem. Specifically the DIRECTORY half: assets.test.ts's mock
// matches on the filename substring, so a wrong filename reds there, while a
// wrong directory still contains that substring and passes straight through —
// and a wrong directory 404s in production with nothing else to catch it.
//
// Needle and haystack are deliberately different artifacts on every assertion
// (the #388 tautology): the catalogue is compared against the pipeline input
// and against the built output, never against itself.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_DIR = join(REPO, 'app', 'public');

interface SourceSail {
  readonly provenance: { readonly tier: string; readonly note: string };
  readonly speeds: number[][];
}
// #567: a sister ship declares `polarsFrom: <donor id>` and carries no sails;
// its polar tables, note and shipped `boat` name are the donor's.
interface SourceBoat {
  readonly id: string;
  readonly name: string;
  readonly polarsFrom?: string;
  readonly sails?: Record<string, SourceSail>;
}

const source = JSON.parse(readFileSync(join(REPO, 'pipeline', 'polars-source.json'), 'utf8')) as {
  boats: SourceBoat[];
};

function donorOf(boatId: string): SourceBoat {
  const srcBoat = source.boats.find((b) => b.id === boatId);
  expect(srcBoat, `no boat ${boatId} in polars-source.json`).toBeDefined();
  if (srcBoat!.polarsFrom === undefined) return srcBoat!;
  const donor = source.boats.find((b) => b.id === srcBoat!.polarsFrom);
  expect(donor, `${boatId} borrows from unknown ${srcBoat!.polarsFrom}`).toBeDefined();
  expect(donor!.polarsFrom, `${boatId}: borrower chain`).toBeUndefined();
  return donor!;
}

describe('polar provenance is consistent across catalogue, pipeline source and shipped asset', () => {
  it('reads a pipeline source with at least one boat (fail closed)', () => {
    // Guards the two loops below against passing vacuously if the source file
    // is ever restructured out from under this regex-free parse.
    expect(Array.isArray(source.boats)).toBe(true);
    expect(source.boats.length).toBeGreaterThan(0);
    expect(BOATS.length).toBeGreaterThan(0);
  });

  for (const boat of BOATS) {
    for (const sail of boat.sails) {
      describe(`${boat.id}/${sail.id}`, () => {
        it('has a matching entry in pipeline/polars-source.json', () => {
          const srcBoat = source.boats.find((b) => b.id === boat.id);
          expect(srcBoat, `no boat ${boat.id} in polars-source.json`).toBeDefined();
          expect(srcBoat!.name).toBe(boat.name);
          expect(Object.keys(donorOf(boat.id).sails!)).toContain(sail.id);
        });

        it('carries the same provenance tier and note as the pipeline source', () => {
          const srcSail = donorOf(boat.id).sails![sail.id]!;
          expect(srcSail.provenance.tier).toBe(sail.polarProvenance.tier);
          expect(srcSail.provenance.note).toBe(sail.polarProvenance.note);
        });

        it('points polarAsset at a file that actually shipped', () => {
          // The 404-at-startup guard: assets.ts fetches exactly this string.
          expect(sail.polarAsset.startsWith('data/')).toBe(true);
          expect(existsSync(join(PUBLIC_DIR, sail.polarAsset)), sail.polarAsset).toBe(true);
        });

        // The sharing invariant: a boat's asset is its own file unless the
        // source declares it a borrower, and then it is exactly the donor's.
        it('points polarAsset at its own file, or exactly at its declared donor’s', () => {
          expect(sail.polarAsset).toBe(`data/polars/${donorOf(boat.id).id}-${sail.id}.json`);
        });

        it('shipped asset identifies this boat and sail and repeats the note', () => {
          const table = JSON.parse(
            readFileSync(join(PUBLIC_DIR, sail.polarAsset), 'utf8'),
          ) as PolarTable;
          // `rig` is the on-disk key naming the sail (types.ts) — lib/polar.ts
          // reads it at runtime, so a table filed under the wrong sail id
          // would mislabel every route this app recommends.
          expect(table.rig).toBe(sail.id);
          // The shipped `boat` field names the boat the table was built for,
          // which for a borrower is the donor.
          expect(table.boat).toBe(donorOf(boat.id).name);
          expect(table.source).toBe(sail.polarProvenance.note);
        });
      });
    }
  }

  it('every sail the pipeline declares is claimed by a catalogue polarAsset', () => {
    const claimed = new Set(BOATS.flatMap((b) => b.sails.map((s) => s.polarAsset)));
    const declared = source.boats.flatMap((b) =>
      Object.keys(b.sails ?? {}).map((sailId) => `data/polars/${b.id}-${sailId}.json`),
    );
    // Every table the pipeline builds must be reachable from the catalogue —
    // an unclaimed one is a table the app can never load.
    for (const asset of declared) expect([...claimed]).toContain(asset);
  });

  it('a borrower carries no tables of its own and shares its donor’s sail set', () => {
    const borrowers = source.boats.filter((b) => b.polarsFrom !== undefined);
    for (const b of borrowers) {
      expect(b.sails, `${b.id} declares sails beside polarsFrom`).toBeUndefined();
      const own = BOATS.find((x) => x.id === b.id)!.sails.map((x) => x.id);
      const donor = BOATS.find((x) => x.id === b.polarsFrom)!.sails.map((x) => x.id);
      expect(own).toEqual(donor);
    }
  });
});
