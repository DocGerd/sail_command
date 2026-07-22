import { describe, expect, it } from 'vitest';
import { seamarkPopoverRows } from './seamarkPopover';

describe('seamarkPopoverRows', () => {
  it('always shows the humanized type, even with nothing else tagged', () => {
    expect(seamarkPopoverRows({ seamarkType: 'buoy_lateral' })).toEqual([
      { labelKey: 'seamark.popover.type', value: 'buoy lateral' },
    ]);
  });

  it('adds category and colour rows when present, humanizing underscores/semicolons to spaces', () => {
    const rows = seamarkPopoverRows({
      seamarkType: 'buoy_cardinal',
      category: 'north',
      colour: 'black;yellow;black',
    });
    expect(rows).toEqual([
      { labelKey: 'seamark.popover.type', value: 'buoy cardinal' },
      { labelKey: 'seamark.popover.category', value: 'north' },
      { labelKey: 'seamark.popover.colour', value: 'black yellow black' },
    ]);
  });

  it('adds light rows only for the fields actually tagged, in character/colour/period order', () => {
    const rows = seamarkPopoverRows({
      seamarkType: 'buoy_lateral',
      lightCharacter: 'Oc',
      lightPeriod: '9',
    });
    expect(rows).toEqual([
      { labelKey: 'seamark.popover.type', value: 'buoy lateral' },
      { labelKey: 'seamark.popover.lightCharacter', value: 'Oc' },
      { labelKey: 'seamark.popover.lightPeriod', value: '9 s' },
    ]);
  });

  it('humanizes light colour but leaves light character as the raw abbreviation', () => {
    const rows = seamarkPopoverRows({
      seamarkType: 'light_minor',
      lightCharacter: 'Q+LFl',
      lightColour: 'red',
    });
    expect(rows).toContainEqual({ labelKey: 'seamark.popover.lightCharacter', value: 'Q+LFl' });
    expect(rows).toContainEqual({ labelKey: 'seamark.popover.lightColour', value: 'red' });
  });

  it('omits category/colour/light rows entirely when untagged', () => {
    const rows = seamarkPopoverRows({ seamarkType: 'light_major' });
    expect(rows).toHaveLength(1);
  });
});
