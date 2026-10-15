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
  readonly speeds?: number[][];
  readonly estimator?: unknown;
  readonly derivation?: {
    readonly method?: string;
    readonly fromSailId?: string;
    readonly donor?: { readonly refNo?: string };
  };
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

// Spec P.6/P.9 (#1660). Pure over a source-shaped value so the synthetic
// fixtures below can show each rule fires; the real source is vacuous until
// EASY GO! carries its own derivation blocks. Method ids and tiers mirror
// build_polars.mjs's DERIVATION_TIER; token matching is case-SENSITIVE, as D6.
const CERT_METHOD = 'orc-ns-cert-rows-v1';
const RAMP_METHOD = 'orc-jib-genoa-ramp-v1';
const METHOD_TIER: Record<string, string> = {
  [CERT_METHOD]: 'modelled',
  [RAMP_METHOD]: 'estimated',
};
const REFERENCE_BOAT_ID = 'salona-45';

function noteTokens(sail: SourceSail): string[] {
  const der = sail.derivation;
  if (der?.method === RAMP_METHOD) return ['ESTIMATED', 'ramp'];
  if (der?.method === CERT_METHOD) return ['sister hull', der.donor?.refNo ?? '\0missing refNo'];
  return [];
}

function missingTokens(sail: SourceSail, note: string): string[] {
  return noteTokens(sail).filter((t) => !note.includes(t));
}

function derivationProblems(boats: readonly SourceBoat[]): string[] {
  const problems: string[] = [];
  for (const boat of boats) {
    const sails = boat.sails ?? {};
    const tiers = Object.values(sails).map((s) => s.provenance.tier);
    const mixed = tiers.includes('estimated') && tiers.some((t) => t !== 'estimated');
    for (const [sailId, sail] of Object.entries(sails)) {
      const name = `${boat.id}/${sailId}`;
      const tier = sail.provenance.tier;
      const der = sail.derivation;
      const required =
        boat.id !== REFERENCE_BOAT_ID &&
        (tier === 'modelled' || (tier === 'estimated' && sail.estimator === undefined));
      if (required && der === undefined) problems.push(`${name}: no derivation block`);
      if (der !== undefined) {
        const method = der.method ?? '';
        if (!Object.hasOwn(METHOD_TIER, method)) problems.push(`${name}: unknown method ${method}`);
        else if (METHOD_TIER[method] !== tier)
          problems.push(`${name}: ${method} fixes tier ${METHOD_TIER[method]}, sail is ${tier}`);
        for (const t of missingTokens(sail, sail.provenance.note))
          problems.push(`${name}: note lacks ${JSON.stringify(t)} (D6)`);
      }
      if (mixed && tier === 'estimated') {
        const from = der?.fromSailId;
        const base = from === undefined ? undefined : sails[from];
        if (der?.method !== RAMP_METHOD || base === undefined || base.provenance.tier === 'estimated')
          problems.push(`${name}: mixed-tier boat, estimated sail does not ramp off a same-boat sail`);
      }
    }
  }
  return problems;
}

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

  describe('derivation blocks (spec P.6 D1/D6, P.9, amended mixed-tier rule)', () => {
    const goodBoats = (): SourceBoat[] => [
      {
        id: 'salona-45',
        name: 'Salona 45',
        sails: {
          fock: { provenance: { tier: 'certificate', note: 'cert' } },
          genoa: { provenance: { tier: 'modelled', note: 'overlay' } },
        },
      },
      {
        id: 'x-boat',
        name: 'X',
        sails: {
          fock: {
            provenance: { tier: 'modelled', note: 'from a sister hull, refNo 04590004MKR' },
            derivation: { method: CERT_METHOD, donor: { refNo: '04590004MKR' } },
          },
          genoa: {
            provenance: { tier: 'estimated', note: 'ESTIMATED via the genoa ramp' },
            derivation: { method: RAMP_METHOD, fromSailId: 'fock' },
          },
        },
      },
    ];
    const mutate = (fn: (b: SourceBoat[]) => void): string[] => {
      const b = goodBoats();
      fn(b);
      return derivationProblems(b);
    };
    const sailOf = (b: SourceBoat[], id: string): SourceSail => b[1]!.sails![id]!;
    // `readonly` fields are overwritten through this cast only in the fixtures.
    const put = (s: object, patch: Record<string, unknown>) => Object.assign(s, patch);

    it('control: the well-formed fixture raises no problem', () => {
      expect(derivationProblems(goodBoats())).toEqual([]);
    });

    it('the committed catalogue source raises no problem', () => {
      expect(derivationProblems(source.boats)).toEqual([]);
    });

    it('requires a derivation block on a non-Salona-45 modelled sail', () => {
      expect(mutate((b) => delete (sailOf(b, 'fock') as { derivation?: unknown }).derivation)).toEqual([
        'x-boat/fock: no derivation block',
      ]);
    });

    it('requires a derivation block on an estimated sail with no estimator block', () => {
      expect(mutate((b) => delete (sailOf(b, 'genoa') as { derivation?: unknown }).derivation)).toContain(
        'x-boat/genoa: no derivation block',
      );
    });

    it('does not require one on an estimator-derived estimated sail, nor on the Salona 45', () => {
      const b45 = goodBoats();
      const p = mutate((b) => {
        const g = sailOf(b, 'genoa');
        delete (g as { derivation?: unknown }).derivation;
        put(g, { estimator: {} });
      });
      expect(p, 'estimator-derived genoa').toEqual([
        'x-boat/genoa: mixed-tier boat, estimated sail does not ramp off a same-boat sail',
      ]);
      expect(derivationProblems([b45[0]!]), 'Salona 45 exempt').toEqual([]);
    });

    it('rejects an unknown method, including an Object.prototype name', () => {
      for (const method of ['nope', ...Object.getOwnPropertyNames(Object.prototype)]) {
        const p = mutate((b) => put(sailOf(b, 'fock').derivation!, { method }));
        expect(p, method).toContain(`x-boat/fock: unknown method ${method}`);
      }
    });

    it('rejects a method whose fixed tier disagrees with the sail', () => {
      const p = mutate((b) => put(sailOf(b, 'fock').derivation!, { method: RAMP_METHOD }));
      expect(p).toContain('x-boat/fock: orc-jib-genoa-ramp-v1 fixes tier estimated, sail is modelled');
    });

    it('D6: a certificate-method note needs `sister hull` and the refNo, case-sensitively', () => {
      for (const note of ['from a Sister Hull, refNo 04590004MKR', 'from a sister hull', 'sister hull 04590004mkr']) {
        const p = mutate((b) => put(sailOf(b, 'fock'), { provenance: { tier: 'modelled', note } }));
        expect(p.filter((x) => x.includes('(D6)')), note).toHaveLength(1);
      }
    });

    it('D6: a ramp note needs `ESTIMATED` and `ramp`, case-sensitively', () => {
      for (const note of ['estimated via the genoa ramp', 'ESTIMATED via the genoa Ramp', 'ESTIMATED only']) {
        const p = mutate((b) => put(sailOf(b, 'genoa'), { provenance: { tier: 'estimated', note } }));
        expect(p.filter((x) => x.includes('(D6)')), note).toHaveLength(1);
      }
    });

    it('mixed tiers are allowed only where the estimated sail ramps off a same-boat non-estimated sail', () => {
      const cases: Record<string, (b: SourceBoat[]) => void> = {
        'fromSailId names no sail of the boat': (b) =>
          put(sailOf(b, 'genoa').derivation!, { fromSailId: 'spinnaker' }),
        'fromSailId is the sail itself': (b) => put(sailOf(b, 'genoa').derivation!, { fromSailId: 'genoa' }),
        'fromSailId names another estimated sail': (b) => {
          b[1]!.sails!.extra = { provenance: { tier: 'estimated', note: 'e' }, estimator: {} };
          put(sailOf(b, 'genoa').derivation!, { fromSailId: 'extra' });
        },
        'the method is not the ramp': (b) => put(sailOf(b, 'genoa').derivation!, { method: 'nope' }),
        'fromSailId is absent': (b) => delete (sailOf(b, 'genoa').derivation as { fromSailId?: string }).fromSailId,
      };
      for (const [label, fn] of Object.entries(cases))
        expect(mutate(fn), label).toContain(
          'x-boat/genoa: mixed-tier boat, estimated sail does not ramp off a same-boat sail',
        );
    });

    it('the catalogue’s mixed-tier boats resolve to a same-boat ramp base in the pipeline source', () => {
      for (const boat of BOATS) {
        const tiers = boat.sails.map((s) => s.polarProvenance.tier);
        if (!(tiers.includes('estimated') && tiers.some((t) => t !== 'estimated'))) continue;
        const sails = donorOf(boat.id).sails!;
        for (const s of boat.sails.filter((x) => x.polarProvenance.tier === 'estimated')) {
          const from = sails[s.id]!.derivation?.fromSailId;
          expect(from, `${boat.id}/${s.id} derivation.fromSailId`).toBeDefined();
          expect(boat.sails.map((x) => x.id), `${boat.id}/${s.id}`).toContain(from);
        }
      }
    });

    it('the catalogue notes of derived sails carry the D6 tokens', () => {
      for (const boat of BOATS)
        for (const s of boat.sails) {
          const srcSail = donorOf(boat.id).sails![s.id]!;
          expect(missingTokens(srcSail, s.polarProvenance.note), `${boat.id}/${s.id}`).toEqual([]);
        }
    });
  });

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
    expect(borrowers.map((b) => b.id)).toEqual(['salona-44-easy-go']);
    for (const b of borrowers) {
      expect(b.sails, `${b.id} declares sails beside polarsFrom`).toBeUndefined();
      const own = BOATS.find((x) => x.id === b.id)!.sails.map((x) => x.id);
      const donor = BOATS.find((x) => x.id === b.polarsFrom)!.sails.map((x) => x.id);
      expect(own).toEqual(donor);
    }
  });
});
