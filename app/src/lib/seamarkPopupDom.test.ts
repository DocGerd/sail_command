import { describe, expect, it } from 'vitest';
import { buildSeamarkPopoverContent } from './seamarkPopupDom';
import type { SeamarkPopoverTranslate } from './seamarkPopover';

// #830: the DOM half of the seamark popup, shared by the list's row
// activation. A stub `t` keeps this dict-independent: every key resolves to
// itself (plus any vars), so the assertions pin STRUCTURE and ORDER, not
// copy.
const t: SeamarkPopoverTranslate = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);

describe('buildSeamarkPopoverContent (#830)', () => {
  it('renders one "label: value" line per popover row inside .seamark-popover, then the disclaimer', () => {
    const el = buildSeamarkPopoverContent(
      {
        seamarkType: 'buoy_cardinal',
        category: 'north',
        colour: 'black;yellow',
        lightPeriod: '10',
      },
      t,
    );
    expect(el.className).toBe('seamark-popover');
    const lines = Array.from(el.querySelectorAll(':scope > div'));
    expect(lines.map((l) => l.textContent)).toEqual([
      'seamark.popover.type: seamark.value.type.buoy_cardinal',
      'seamark.popover.category: seamark.value.category.north',
      'seamark.popover.colour: seamark.value.colour.black seamark.value.colour.yellow',
      'seamark.popover.lightPeriod: seamark.popover.lightPeriodUnit{"value":"10"}',
    ]);
    for (const line of lines) {
      expect(line.querySelector('strong')?.textContent).toMatch(/: $/);
    }
    const disclaimer = el.querySelector(':scope > p.seamark-popover-disclaimer');
    expect(disclaimer?.textContent).toBe('app.disclaimer');
    expect(el.lastElementChild).toBe(disclaimer);
  });

  it('renders only the type line for a bare mark', () => {
    const el = buildSeamarkPopoverContent({ seamarkType: 'light_major' }, t);
    expect(el.querySelectorAll(':scope > div')).toHaveLength(1);
    expect(el.querySelector('p.seamark-popover-disclaimer')).not.toBeNull();
  });
});
