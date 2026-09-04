import { describe, expect, it, vi } from 'vitest';
import type { MsgKey } from '../i18n/dict.de';
import {
  isWaypointEligibleSeamark,
  resolveSeamarkPopoverValue,
  seamarkPopoverRows,
  seamarkWaypointName,
  type SeamarkPopoverRow,
  type SeamarkPopoverTranslate,
} from './seamarkPopover';

// Stub `t`: looks a key up in a fixed table and substitutes {vars}, exactly
// like the real useT() (i18n/index.tsx) but without importing app dicts —
// lets these tests pin literal DE/EN strings independently of whatever the
// real dict currently says (#300 F4).
function stubT(entries: Partial<Record<MsgKey, string>>): SeamarkPopoverTranslate {
  return (key, vars) => {
    let msg = entries[key] ?? `MISSING:${key}`;
    for (const [k, v] of Object.entries(vars ?? {})) msg = msg.replaceAll(`{${k}}`, String(v));
    return msg;
  };
}

describe('seamarkPopoverRows', () => {
  it('translates a known type as a dict key, even with nothing else tagged', () => {
    expect(seamarkPopoverRows({ seamarkType: 'buoy_lateral' })).toEqual([
      { labelKey: 'seamark.popover.type', value: [{ key: 'seamark.value.type.buoy_lateral' }] },
    ]);
  });

  it('translates each component of compound category/colour values independently', () => {
    const rows = seamarkPopoverRows({
      seamarkType: 'buoy_cardinal',
      category: 'north',
      colour: 'black;yellow;black',
    });
    expect(rows).toEqual([
      { labelKey: 'seamark.popover.type', value: [{ key: 'seamark.value.type.buoy_cardinal' }] },
      { labelKey: 'seamark.popover.category', value: [{ key: 'seamark.value.category.north' }] },
      {
        labelKey: 'seamark.popover.colour',
        value: [
          { key: 'seamark.value.colour.black' },
          { key: 'seamark.value.colour.yellow' },
          { key: 'seamark.value.colour.black' },
        ],
      },
    ]);
  });

  it('also splits a colon-joined compound colour (both separators occur in the shipped data)', () => {
    const rows = seamarkPopoverRows({ seamarkType: 'buoy_cardinal', colour: 'black:yellow:black' });
    expect(rows).toContainEqual({
      labelKey: 'seamark.popover.colour',
      value: [
        { key: 'seamark.value.colour.black' },
        { key: 'seamark.value.colour.yellow' },
        { key: 'seamark.value.colour.black' },
      ],
    });
  });

  it('adds light rows only for the fields actually tagged, in character/colour/period order', () => {
    const rows = seamarkPopoverRows({
      seamarkType: 'buoy_lateral',
      lightCharacter: 'Oc',
      lightPeriod: '9',
    });
    expect(rows).toEqual([
      { labelKey: 'seamark.popover.type', value: [{ key: 'seamark.value.type.buoy_lateral' }] },
      { labelKey: 'seamark.popover.lightCharacter', value: [{ text: 'Oc' }] },
      {
        labelKey: 'seamark.popover.lightPeriod',
        value: [{ key: 'seamark.popover.lightPeriodUnit', vars: { value: '9' } }],
      },
    ]);
  });

  it('translates light colour but leaves light character verbatim (never a translation key, #300)', () => {
    const rows = seamarkPopoverRows({
      seamarkType: 'light_minor',
      lightCharacter: 'Q+LFl',
      lightColour: 'red',
    });
    expect(rows).toContainEqual({
      labelKey: 'seamark.popover.lightCharacter',
      value: [{ text: 'Q+LFl' }],
    });
    expect(rows).toContainEqual({
      labelKey: 'seamark.popover.lightColour',
      value: [{ key: 'seamark.value.colour.red' }],
    });
  });

  it('falls back to humanized text for a type with no translation entry, instead of a missing-key placeholder', () => {
    const rows = seamarkPopoverRows({ seamarkType: 'buoy_hypothetical_future_tag' });
    expect(rows).toEqual([
      { labelKey: 'seamark.popover.type', value: [{ text: 'buoy hypothetical future tag' }] },
    ]);
  });

  it('falls back per-component within a compound category, translating the known part and humanizing the unknown one', () => {
    const rows = seamarkPopoverRows({
      seamarkType: 'buoy_lateral',
      category: 'no_entry;totally_unknown_tag',
    });
    expect(rows).toContainEqual({
      labelKey: 'seamark.popover.category',
      value: [{ key: 'seamark.value.category.no_entry' }, { text: 'totally unknown tag' }],
    });
  });

  it('omits category/colour/light rows entirely when untagged', () => {
    const rows = seamarkPopoverRows({ seamarkType: 'light_major' });
    expect(rows).toHaveLength(1);
  });
});

// #300 F4: the DataLayers.tsx line that turns row.value tokens into the
// string a user actually reads was untested (DataLayers.test.tsx stubs
// Popup.setDOMContent as a no-op, so no test ever built the popover DOM).
// This is that exact join/translate logic, extracted into a t-injected pure
// function and exercised directly — each expectation below is a literal
// string pinned by hand, not derived from the implementation (#50).
describe('resolveSeamarkPopoverValue', () => {
  it('resolves a single-token row via the injected t (DE)', () => {
    const t = stubT({ 'seamark.value.type.buoy_lateral': 'Lateraltonne' });
    const row: SeamarkPopoverRow = {
      labelKey: 'seamark.popover.type',
      value: [{ key: 'seamark.value.type.buoy_lateral' }],
    };
    expect(resolveSeamarkPopoverValue(row, t)).toBe('Lateraltonne');
  });

  it('resolves the SAME row via the injected t (EN) — proves the join goes through t, not a hardcoded string', () => {
    const t = stubT({ 'seamark.value.type.buoy_lateral': 'Lateral buoy' });
    const row: SeamarkPopoverRow = {
      labelKey: 'seamark.popover.type',
      value: [{ key: 'seamark.value.type.buoy_lateral' }],
    };
    expect(resolveSeamarkPopoverValue(row, t)).toBe('Lateral buoy');
  });

  it('joins a compound CATEGORY row with ", " (#300 F7)', () => {
    const t = stubT({
      'seamark.value.category.no_entry': 'Sperrgebiet',
      'seamark.value.category.foul_ground': 'unreiner Grund',
    });
    const row: SeamarkPopoverRow = {
      labelKey: 'seamark.popover.category',
      value: [
        { key: 'seamark.value.category.no_entry' },
        { key: 'seamark.value.category.foul_ground' },
      ],
    };
    expect(resolveSeamarkPopoverValue(row, t)).toBe('Sperrgebiet, unreiner Grund');
  });

  it('joins a compound COLOUR row with a bare space, not a comma (#300 F7 — colours read as a sequence)', () => {
    const t = stubT({
      'seamark.value.colour.black': 'Schwarz',
      'seamark.value.colour.yellow': 'Gelb',
    });
    const row: SeamarkPopoverRow = {
      labelKey: 'seamark.popover.colour',
      value: [
        { key: 'seamark.value.colour.black' },
        { key: 'seamark.value.colour.yellow' },
        { key: 'seamark.value.colour.black' },
      ],
    };
    expect(resolveSeamarkPopoverValue(row, t)).toBe('Schwarz Gelb Schwarz');
  });

  it('renders a lightCharacter token verbatim and never calls t for it', () => {
    const t = vi.fn(stubT({}));
    const row: SeamarkPopoverRow = {
      labelKey: 'seamark.popover.lightCharacter',
      value: [{ text: 'Q+LFl' }],
    };
    expect(resolveSeamarkPopoverValue(row, t)).toBe('Q+LFl');
    expect(t).not.toHaveBeenCalled();
  });

  it('resolves a templated key with vars (lightPeriod)', () => {
    const t = stubT({ 'seamark.popover.lightPeriodUnit': '{value} s' });
    const row: SeamarkPopoverRow = {
      labelKey: 'seamark.popover.lightPeriod',
      value: [{ key: 'seamark.popover.lightPeriodUnit', vars: { value: '9' } }],
    };
    expect(resolveSeamarkPopoverValue(row, t)).toBe('9 s');
  });
});

// #845: the curated waypoint-eligible subset (design spec §2.5).
describe('isWaypointEligibleSeamark (#845)', () => {
  it.each([
    'buoy_cardinal',
    'beacon_cardinal',
    'buoy_lateral',
    'beacon_lateral',
    'buoy_isolated_danger',
    'beacon_isolated_danger',
  ])('admits %s', (seamarkType) => {
    expect(isWaypointEligibleSeamark({ seamarkType })).toBe(true);
  });

  it.each([
    'buoy_special_purpose',
    'beacon_special_purpose',
    'light_major',
    'light_minor',
    'buoy_safe_water',
  ])('excludes %s', (seamarkType) => {
    expect(isWaypointEligibleSeamark({ seamarkType })).toBe(false);
  });

  it('excludes an unrecognised seamarkType (classifySeamark falls back to "unknown")', () => {
    expect(isWaypointEligibleSeamark({ seamarkType: 'something_never_seen' })).toBe(false);
  });
});

// #845: the pre-filled waypoint name — the mark's translated TYPE label,
// never the category and never a raw tag value.
describe('seamarkWaypointName (#845)', () => {
  it('returns the resolved TYPE row text, not a coordinate or category', () => {
    const t = stubT({
      'seamark.value.type.buoy_cardinal': 'Kardinaltonne',
      'seamark.value.category.north': 'Nord',
    });
    expect(seamarkWaypointName({ seamarkType: 'buoy_cardinal', category: 'north' }, t)).toBe(
      'Kardinaltonne',
    );
  });

  it('falls back to the humanized raw type for an unrecognised seamarkType, never throwing', () => {
    const t = stubT({});
    expect(seamarkWaypointName({ seamarkType: 'buoy_unknown_thing' }, t)).toBe(
      'buoy unknown thing',
    );
  });
});
