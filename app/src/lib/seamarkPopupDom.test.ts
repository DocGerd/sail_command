import { describe, expect, it, vi } from 'vitest';
import { buildSeamarkPopoverContent } from './seamarkPopupDom';
import type { SeamarkPopoverTranslate } from './seamarkPopover';
import type { ViaPoint } from '../types';

// #830: the DOM half of the seamark popup, shared by the list's row
// activation. A stub `t` keeps this dict-independent: every key resolves to
// itself (plus any vars), so the assertions pin STRUCTURE and ORDER, not
// copy.
const t: SeamarkPopoverTranslate = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);
const POINT = { lat: 54.9, lon: 10.1 };

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
      POINT,
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
    // No onAddWaypoint was passed, so the disclaimer stays the last child —
    // no button rendered even though buoy_cardinal is eligible (#845).
    expect(el.lastElementChild).toBe(disclaimer);
  });

  it('renders only the type line for a bare mark', () => {
    const el = buildSeamarkPopoverContent({ seamarkType: 'light_major' }, t, POINT);
    expect(el.querySelectorAll(':scope > div')).toHaveLength(1);
    expect(el.querySelector('p.seamark-popover-disclaimer')).not.toBeNull();
  });

  // #845: the "add as waypoint" action.
  describe('add-as-waypoint action (#845)', () => {
    it('renders a button AFTER the disclaimer for an eligible mark when onAddWaypoint is given', () => {
      const onAddWaypoint = vi.fn();
      const el = buildSeamarkPopoverContent(
        { seamarkType: 'buoy_cardinal', category: 'north' },
        t,
        POINT,
        onAddWaypoint,
      );
      const button = el.querySelector('button.seamark-popover-add-waypoint');
      expect(button).not.toBeNull();
      expect(button?.className).toBe('sc-btn sc-btn-secondary seamark-popover-add-waypoint');
      expect(el.lastElementChild).toBe(button);
      expect(onAddWaypoint).not.toHaveBeenCalled();
    });

    it('clicking the button reports a flattened {lat, lon, name} — the type label, not a provenance link', () => {
      const onAddWaypoint = vi.fn();
      const el = buildSeamarkPopoverContent(
        { seamarkType: 'buoy_lateral', category: 'port' },
        t,
        POINT,
        onAddWaypoint,
      );
      const button = el.querySelector('button.seamark-popover-add-waypoint') as HTMLButtonElement;
      button.click();
      const expected: ViaPoint = {
        lat: POINT.lat,
        lon: POINT.lon,
        name: 'seamark.value.type.buoy_lateral',
      };
      expect(onAddWaypoint).toHaveBeenCalledExactlyOnceWith(expected);
    });

    it.each(['buoy_special_purpose', 'light_major', 'buoy_safe_water'])(
      'renders NO button for an ineligible seamarkType %s, even with onAddWaypoint given',
      (seamarkType) => {
        const el = buildSeamarkPopoverContent({ seamarkType }, t, POINT, vi.fn());
        expect(el.querySelector('button.seamark-popover-add-waypoint')).toBeNull();
      },
    );

    it.each([
      'buoy_cardinal',
      'beacon_cardinal',
      'buoy_lateral',
      'beacon_lateral',
      'buoy_isolated_danger',
      'beacon_isolated_danger',
    ])('renders a button for the curated-eligible seamarkType %s', (seamarkType) => {
      const el = buildSeamarkPopoverContent({ seamarkType }, t, POINT, vi.fn());
      expect(el.querySelector('button.seamark-popover-add-waypoint')).not.toBeNull();
    });
  });
});
