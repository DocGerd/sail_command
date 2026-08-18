import { describe, it, expect } from 'vitest';
import { BOATS, boatById, DEFAULT_BOAT_ID } from './boats';

describe('boat catalogue', () => {
  // RETIRED ASSERTION 1 of 3 (#54 spec N.8) — was:
  //   it('release 1 ships exactly the Salona 45', () =>
  //     expect(BOATS.map((b) => b.id)).toEqual(['salona-45']));
  //
  // RATIONALE. This encoded OQ-7's release-1 scope decision, which spec N
  // SUPERSEDES: two Flensburg fleet models now ship at tier C. The assertion
  // was correct when written and is simply about a scope that no longer holds
  // — it is not a guard that was found wanting.
  //
  // NOT deleted, REPLACED, and the distinction matters: the property worth
  // keeping was never "exactly one boat", it was "the catalogue's membership
  // is pinned against a HAND-WRITTEN list, so a boat cannot appear by
  // accident". That property is now carried by the row below and, with a
  // sharper discriminating experiment, by maskTolerance.test.ts's R1. A boat
  // is a safety-critical record — it carries the draft that derives the mask
  // gate and the #53 relaxation floor — so membership stays pinned, only the
  // expected list moves.
  const EXPECTED_BOAT_IDS = ['salona-45', 'salona-44-speedy-go', 'elan-444-piranja'];

  it('ships exactly the catalogue spec N.1 authorises, in order', () => {
    expect(BOATS.map((b) => b.id)).toEqual(EXPECTED_BOAT_IDS);
  });

  // Spec N.1 defers these two BY NAME, each because its derived gate drops
  // harbours the picker cannot yet grey out (spec N.7). They are the entries
  // most likely to be added by someone reading the spec's fleet table in §C.5
  // without reaching §N.7, so name them rather than trust the list above to
  // convey it. EASY GO! is the sharp case: it is a Salona 44 like SPEEDY GO!
  // and a DIFFERENT HULL, 0.45 m deeper.
  it('does not ship the two vessels spec N.7 defers', () => {
    const names = BOATS.map((b) => b.name).join(' | ');
    expect(names).not.toContain('EASY GO!');
    expect(names).not.toContain('Grand Soleil');
  });

  it('states the Salona 45 draft as its own literal', () => {
    expect(boatById('salona-45').draftM).toBe(2.1);
  });

  it('carries per-boat motor and maneuver defaults matching today', () => {
    const b = boatById('salona-45');
    expect(b.motorSpeedKn).toBe(6.5);
    expect(b.maneuverPenaltyS).toBe(45);
  });

  it('requires a provenance tier on every sail', () => {
    for (const b of BOATS) {
      for (const s of b.sails) {
        expect(['certificate', 'modelled', 'estimated']).toContain(s.polarProvenance.tier);
        expect(s.polarProvenance.note.length).toBeGreaterThan(0);
      }
    }
  });

  // RETIRED ASSERTION 2 of 3 (#54 spec N.8) — was:
  //   it('ships no estimated-tier sail in release 1 (OQ-7)', () => {
  //     const tiers = BOATS.flatMap((b) => b.sails.map((s) => s.polarProvenance.tier));
  //     expect(tiers).not.toContain('estimated');
  //   });
  //
  // RATIONALE. This was the code-level enforcement of OQ-7's "no tier-C boat
  // ships", and spec N overrules exactly that. Inverting it to
  // `toContain('estimated')` would be the lazy move and would assert nothing
  // useful; what the retired row was really protecting is that a sail cannot
  // reach tier C ACCIDENTALLY. That protection is now stronger and lives in
  // two places, neither of which existed when the row was written:
  //   - pipeline/build_polars.mjs's E1 makes tier C structurally impossible to
  //     fall into — an estimated sail with no complete estimator block fails
  //     the build, and (the converse direction) a NON-estimated sail carrying
  //     an estimator block fails it too.
  //   - the row below, which pins the exact tier of every sail against a
  //     hand-written table rather than merely counting tiers.
  //
  // So the invariant is not weakened, it is relocated from "none exists" to
  // "each one is declared, complete and exactly where we put it".
  it('every sail carries exactly the provenance tier the spec assigns it', () => {
    const tiers = Object.fromEntries(
      BOATS.flatMap((b) => b.sails.map((s) => [`${b.id}/${s.id}`, s.polarProvenance.tier])),
    );
    expect(tiers).toEqual({
      // Unchanged by spec N: the reference boat keeps its certificate-anchored
      // jib and its modelled genoa overlay.
      'salona-45/genoa': 'modelled',
      'salona-45/fock': 'certificate',
      // Spec N.1's two tier-C fleet models. BOTH sails of each are estimated —
      // the second is the first times the Salona 45's overlay ramp (spec N.4),
      // so it is no more measured than the first.
      'salona-44-speedy-go/genoa': 'estimated',
      'salona-44-speedy-go/fock': 'estimated',
      'elan-444-piranja/genoa': 'estimated',
      'elan-444-piranja/fock': 'estimated',
    });
  });

  // Spec N.4's consequence, stated at the catalogue level because this is the
  // INPUT the routing layer's suppression reads. `assemble` must resolve any
  // sail set containing a tier-C sail to `not-compared` (spec N.6 E6); that
  // rule is enforced in the routing layer and is NOT in this branch's scope,
  // so this row pins only the half the catalogue owns — that each tier-C boat
  // presents a set which is entirely tier C, giving the suppression rule an
  // unambiguous input rather than a mixed one it would have to reason about.
  it('a tier-C boat is tier C in EVERY sail, never a mixed set', () => {
    for (const b of BOATS) {
      const tiers = b.sails.map((s) => s.polarProvenance.tier);
      if (!tiers.includes('estimated')) continue;
      expect(tiers, `${b.id} mixes estimated and non-estimated sails`).toEqual(
        tiers.map(() => 'estimated'),
      );
    }
  });

  // Spec N.2's required disclosure. The picker renders this, so the DATA has
  // to carry it — a wrong keel is invisible in every artifact the app draws.
  it('every fleet entry discloses the keel its draft assumes', () => {
    for (const b of BOATS) {
      expect(b.draftProvenance.keel.length, `${b.id}`).toBeGreaterThan(0);
      expect(b.draftProvenance.note.length, `${b.id}`).toBeGreaterThan(0);
    }
    // The two fleet vessels are explicitly NOT hull-verified: their drafts are
    // the operator's published per-vessel tech sheets, which spec N.2 accepts
    // as a cost rather than treating as satisfied (spec M.1 still asks for the
    // hull's own papers). Asserted per boat, not as a count, so a future entry
    // silently flipping to `true` without evidence reds here.
    expect(Object.fromEntries(BOATS.map((b) => [b.id, b.draftProvenance.hullVerified]))).toEqual({
      'salona-45': true,
      'salona-44-speedy-go': false,
      'elan-444-piranja': false,
    });
    // BLOCKER 1's keeper on THIS side of the boundary. `draftProvenance` is a
    // REQUIRED BoatDef field, so a fleet entry that omits it is a type error —
    // that is what makes the disclosure impossible to lose silently, and it is
    // why this record won over #563's optional `keelAssumption?`, where an
    // absent field simply rendered nothing for exactly the two boats spec N.2
    // requires it for. A row asserting the picker actually EMITS the sentence
    // belongs with the picker; this one guarantees the data it reads exists.
    for (const b of BOATS) {
      if (b.draftProvenance.hullVerified) continue;
      expect(b.draftProvenance.keel.trim().length, `${b.id} keel`).toBeGreaterThan(0);
    }
  });

  // Spec L's "Reuse BOAT_DRAFT_M for the Salona 44" row, made checkable. The
  // two drafts COINCIDE numerically and must remain independent literals: a
  // shared reference would mean a later change to one silently moves the
  // other. Reading equal here is expected; what would be wrong is one of them
  // being derived from the other, which this cannot see — hence the source
  // comment on the entry. This row's job is to notice if either MOVES alone.
  it('the Salona 44 states its own 2.10 m draft, coinciding with the Salona 45', () => {
    expect(boatById('salona-44-speedy-go').draftM).toBe(2.1);
    expect(boatById('salona-45').draftM).toBe(2.1);
  });

  it('the Elan Impression 444 states its 1.90 m standard-keel draft', () => {
    expect(boatById('elan-444-piranja').draftM).toBe(1.9);
  });

  it('defaults to the Salona 45', () => {
    expect(DEFAULT_BOAT_ID).toBe('salona-45');
  });
});
