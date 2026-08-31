import { describe, it, expect } from 'vitest';
import { BOATS, boatById, DEFAULT_BOAT_ID, DEFAULT_SAIL_IDS, type BoatDef } from './boats';

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

  // #548: `BOATS[0].sails` itself is ALREADY pinned — sweepSailIds.test.ts's
  // TWIN row asserts boatById(DEFAULT_BOAT_ID).sails.map((s) => s.id) against
  // the same hand-written literal and reds on a reversal (MEASURED at
  // a1beed3: 1 failed | 1 passed). What nothing pinned is DEFAULT_SAIL_IDS's
  // own DERIVATION. MEASURED: replacing it with
  // `[...sailIdsOf(boatById(DEFAULT_BOAT_ID))].reverse()` leaves boats.test +
  // sweepSailIds 19/19 and replan + reroute 84/84 GREEN at a1beed3 (the
  // backfill guards compare request.sailIds AGAINST DEFAULT_SAIL_IDS, so both
  // sides move together and neither can falsify the other), and reds this
  // row, and only this row, at HEAD. Hand-typed, never re-derived from BOATS.
  it('#548: DEFAULT_SAIL_IDS is genoa-then-fock', () => {
    expect(DEFAULT_SAIL_IDS).toEqual(['genoa', 'fock']);
  });

  // PR #563/#565 cross-branch BLOCKER. The picker's spec N.2 keel disclosure
  // renders off `draftProvenance`. It previously rendered off an OPTIONAL
  // `keelAssumption` that this catalogue never wrote — no type error, and the
  // paragraph was simply never emitted, for exactly the two fleet hulls the
  // spec requires it for. Neither branch's own tests could see it: the fleet
  // branch asserted the catalogue field existed, the picker branch rendered a
  // fixture that carried its own invented field.
  //
  // These two rows are the keeper. This one asserts the CATALOGUE's shape (a
  // component test against a fixture cannot); the `@ts-expect-error` row below
  // asserts the field is REQUIRED, which is what makes a future fleet entry
  // without it a build failure rather than a silent blank.
  it('records draft provenance on every catalogue boat', () => {
    for (const b of BOATS) {
      expect(typeof b.draftProvenance.keel, `${b.id} keel`).toBe('string');
      expect(b.draftProvenance.keel.length, `${b.id} keel non-empty`).toBeGreaterThan(0);
      expect(typeof b.draftProvenance.hullVerified, `${b.id} hullVerified`).toBe('boolean');
      expect(b.draftProvenance.note.length, `${b.id} note non-empty`).toBeGreaterThan(0);
    }
    // Non-vacuity twin (#411): a catalogue stubbed to [] leaves the loop green
    // over zero rows.
    expect(BOATS.length).toBeGreaterThan(0);
  });

  it('makes draftProvenance REQUIRED, so a boat cannot ship without it', () => {
    // A COMPILE-TIME assertion, checked by `tsc -b`, not by this run: the
    // `@ts-expect-error` itself fails the build if the object below ever
    // becomes assignable — i.e. if anyone relaxes the field to optional. That
    // is the exact regression that produced the Blocker, and no runtime
    // assertion can catch it.
    // @ts-expect-error draftProvenance is required on BoatDef
    const missing: BoatDef = {
      id: 'no-provenance',
      name: 'No Provenance',
      draftM: 2.0,
      motorSpeedKn: 6.5,
      maneuverPenaltyS: 45,
      sails: [],
    };
    expect(missing.id).toBe('no-provenance');
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

// #595. `draftProvenance.note` and every sail's `polarProvenance.note` render
// UNCONDITIONALLY and VERBATIM (BoatPicker.tsx ~:126 / ~:150) — the deliberate,
// spec-sanctioned exception to the i18n rule that lets a source citation stay
// exact per language. That exemption is also the hazard: nothing else stands
// between an author's internal shorthand ("spec J OQ-4 carve-out", "#455") and
// the rendered page. #595 found exactly that leak in the Salona 45's own
// draftProvenance.note; the reviewer additionally found two catalogue-id leaks
// in the polar notes (S44_GENOA_NOTE, ELAN_GENOA_NOTE). This guard exists so a
// THIRD leak reds a test instead of shipping silently, the way this one did.
describe('#595: rendered notes carry no internal register', () => {
  // Reads every note through BOATS itself — never by importing the module's
  // private *_NOTE constants (S44_GENOA_NOTE et al. are not exported) — so the
  // scan sees EXACTLY the strings BoatPicker renders, and a new boat or sail
  // is covered with zero maintenance here.
  function collectRenderedNotes(): Array<{ id: string; note: string }> {
    const notes: Array<{ id: string; note: string }> = [];
    for (const b of BOATS) {
      notes.push({ id: `${b.id}/draftProvenance.note`, note: b.draftProvenance.note });
      for (const s of b.sails) {
        notes.push({ id: `${b.id}/${s.id}/polarProvenance.note`, note: s.polarProvenance.note });
      }
    }
    return notes;
  }

  // Catalogue ids are derived from BOATS itself, not hand-listed, so a future
  // fourth boat's id is covered automatically (review "Additional scope" item
  // 2). Escaped even though today's ids need no escaping — an id containing a
  // regex metacharacter must not silently widen or narrow what this matches.
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const CATALOGUE_ID_PATTERNS = BOATS.map((b) => new RegExp(escapeRegExp(b.id)));
  const INTERNAL_TOKEN_PATTERNS: readonly RegExp[] = [
    /#\d+/, // an issue number, e.g. "#455"
    /spec [A-Z]/, // a spec section reference, e.g. "spec J"
    /OQ-\d/, // an internal hull code, e.g. "OQ-4"
    ...CATALOGUE_ID_PATTERNS, // a raw catalogue id leaking instead of a display name
  ];

  // FAIL CLOSED (this repo's useBannerHeight.test.ts pattern): assert the scan
  // actually found notes BEFORE trusting any content check below. Reviewer's
  // mutation check #2 stubs collectRenderedNotes() to return [] and confirms
  // THIS assertion trips first, ahead of the (vacuously green) content check.
  it('collects at least one note per boat and per sail (fail CLOSED)', () => {
    const notes = collectRenderedNotes();
    const expectedCount = BOATS.length + BOATS.reduce((n, b) => n + b.sails.length, 0);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBe(expectedCount);
    for (const b of BOATS) {
      expect(
        notes.some((n) => n.id === `${b.id}/draftProvenance.note`),
        `${b.id} draftProvenance.note missing from the scan`,
      ).toBe(true);
      for (const s of b.sails) {
        expect(
          notes.some((n) => n.id === `${b.id}/${s.id}/polarProvenance.note`),
          `${b.id}/${s.id} polarProvenance.note missing from the scan`,
        ).toBe(true);
      }
    }
  });

  // APERTURE (#524's pattern). The two rows above BOTH enumerate the same two
  // hand-written field paths, so they move together: a THIRD note-bearing
  // field added to BoatDef is invisible to the collector AND absent from
  // `expectedCount`, and the guard stays green over a note it never read.
  // MEASURED: a `hullProvenance: { note: 'Per spec J OQ-4, see the
  // elan-444-piranja rig note (#999).' }` on one boat — every rejected pattern
  // at once — left this file 15/15 GREEN before this row existed.
  //
  // So cross-check the aperture with a deliberately PERMISSIVE scan that knows
  // nothing about the field paths: walk BOATS for every property literally
  // named `note`, and require the collector to have seen exactly those.
  it('collects EVERY note reachable in BOATS (aperture cross-check)', () => {
    const permissive: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const el of v) walk(el);
        return;
      }
      if (typeof v !== 'object' || v === null) return;
      for (const [k, val] of Object.entries(v)) {
        if (k === 'note' && typeof val === 'string') permissive.push(val);
        else walk(val);
      }
    };
    walk(BOATS);
    const collected = collectRenderedNotes().map((n) => n.note);
    expect(permissive.length).toBeGreaterThan(0);
    expect([...permissive].sort()).toEqual([...collected].sort());
  });

  // The catalogue-id patterns above cover BOAT ids only. A SAIL id is the same
  // leak: `fock` is an internal id for a sail every label calls "Jib", and it
  // shipped inside two polar notes. Derived, not hand-listed: a sail id is
  // allowed in a note only when it is ALSO how the catalogue spells that sail
  // to the reader, i.e. it appears in some sail label. That admits `genoa`
  // (labels "Genoa 135 %", "Genoa") and rejects `fock` (no label contains it).
  it('rejects sail ids that no sail label spells out', () => {
    const labels = BOATS.flatMap((b) => b.sails.map((s) => s.label.toLowerCase()));
    const sailIds = [...new Set(BOATS.flatMap((b) => b.sails.map((s) => s.id)))];
    const internalOnly = sailIds.filter((id) => !labels.some((l) => l.includes(id.toLowerCase())));
    // Non-vacuity is asserted on the NOTES, not on `internalOnly`: an empty
    // `internalOnly` is a legitimate all-clear (every sail id is also how a
    // label spells it), so asserting on it would red this row on a strictly
    // BETTER catalogue — MEASURED: renaming the `fock` id to `jib` empties it.
    // The notes are what must never be empty, or the loop below scans nothing.
    const notes = collectRenderedNotes();
    expect(notes.length).toBeGreaterThan(0);
    for (const { id, note } of notes) {
      for (const sailId of internalOnly) {
        expect(
          note.toLowerCase(),
          `${id} names the internal sail id "${sailId}"; use the label instead`,
        ).not.toContain(sailId.toLowerCase());
      }
    }
  });

  it('rejects internal-register tokens in every rendered note', () => {
    const notes = collectRenderedNotes();
    // Re-asserted (not just relied on via the row above): this row alone must
    // still fail closed if it is ever split out or reordered ahead of the
    // dedicated non-vacuity row.
    expect(notes.length).toBeGreaterThan(0);
    for (const { id, note } of notes) {
      for (const pattern of INTERNAL_TOKEN_PATTERNS) {
        expect(note, `${id} matched ${pattern} in rendered note: "${note}"`).not.toMatch(pattern);
      }
    }
  });
});
