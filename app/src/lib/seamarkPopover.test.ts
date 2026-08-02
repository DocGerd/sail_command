import { describe, expect, it } from 'vitest';
import { seamarkPopoverRows } from './seamarkPopover';

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
