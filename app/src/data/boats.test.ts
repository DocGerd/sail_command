import { describe, it, expect } from 'vitest';
import { BOATS, boatById, DEFAULT_BOAT_ID, type BoatDef } from './boats';

describe('boat catalogue', () => {
  it('release 1 ships exactly the Salona 45', () => {
    expect(BOATS.map((b) => b.id)).toEqual(['salona-45']);
  });

  it('states the Salona 45 draft as its own literal', () => {
    expect(boatById('salona-45').draftM).toBe(2.1);
  });

  it('carries per-boat motor and maneuver defaults matching today', () => {
    const b = boatById('salona-45');
    expect(b.motorSpeedKn).toBe(6.5);
    expect(b.maneuverPenaltyS).toBe(45);
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

  it('ships no estimated-tier sail in release 1 (OQ-7)', () => {
    const tiers = BOATS.flatMap((b) => b.sails.map((s) => s.polarProvenance.tier));
    expect(tiers).not.toContain('estimated');
  });

  it('defaults to the Salona 45', () => {
    expect(DEFAULT_BOAT_ID).toBe('salona-45');
  });
});
