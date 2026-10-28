import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { OPENING_BRIDGES } from '../data/openingBridges';
import type { LatLon, Leg } from '../types';
import { OpeningBridgeNotice } from './OpeningBridgeNotice';

const KC = OPENING_BRIDGES[0]!;

function leg(start: LatLon, end: LatLon): Leg {
  return {
    kind: 'sail',
    board: 'starboard',
    start,
    end,
    startTimeMs: 0,
    endTimeMs: 600_000,
    headingDeg: 180,
    twaDeg: 90,
    twsKn: 8,
    speedKn: 5,
    distanceNm: 1,
    maneuverAtStart: null,
  };
}

const CROSSING: Leg[] = [
  leg({ lat: 54.9210026, lon: 9.7830141 }, { lat: 54.9010026, lon: 9.7830141 }),
];
const ELSEWHERE: Leg[] = [leg({ lat: 54.8, lon: 9.43 }, { lat: 54.85, lon: 10.52 })];

function renderNotice(legs: Leg[] | null | undefined, lang: 'de' | 'en' = 'en') {
  localStorage.setItem('sc-lang', lang);
  const ui = (l: Leg[] | null | undefined) => (
    <I18nProvider>
      <OpeningBridgeNotice legs={l} />
    </I18nProvider>
  );
  const view = render(ui(legs));
  return { ...view, rerenderLegs: (l: Leg[] | null | undefined) => view.rerender(ui(l)) };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('#1881 OpeningBridgeNotice', () => {
  it('EN: names the bridge, states the off-hours and closure caveats, links the bridge page', () => {
    const { container } = renderNotice(CROSSING);
    const p = container.querySelector('.opening-bridge-notice');
    expect(p, 'expected a .opening-bridge-notice').not.toBeNull();
    expect(p?.tagName).toBe('P');
    expect(p?.textContent).toContain("This route passes Kong Christian X's Bro, a bascule bridge");
    expect(p?.textContent).toContain('opens at listed times');
    expect(p?.textContent).toContain('an opening may be possible on request');
    expect(p?.textContent).toContain('the bridge may be closed');
    expect(p?.textContent).toContain('does not model openings or closures');
    expect(p?.textContent).not.toMatch(/\bonly\b/i);
    expect(p?.textContent).not.toMatch(/\d{4}/);
    expect(p).not.toHaveAttribute('role');
    const a = p?.querySelector('a');
    expect(a?.getAttribute('href')).toBe(KC.infoUrl);
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.textContent).toBe('Bridge opening times (Danske Havnelods)');
  });

  it('DE: same content in German', () => {
    const { container } = renderNotice(CROSSING, 'de');
    const p = container.querySelector('.opening-bridge-notice');
    expect(p?.textContent).toContain(
      "Diese Route passiert Kong Christian X's Bro, eine Klappbrücke",
    );
    expect(p?.textContent).toContain('auf Anfrage möglich');
    expect(p?.textContent).toContain('gesperrt sein');
    expect(p?.textContent).not.toMatch(/\bnur\b/i);
    expect(p?.textContent).not.toMatch(/\d{4}/);
    expect(p?.querySelector('a')?.textContent).toBe('Öffnungszeiten der Brücke (Danske Havnelods)');
  });

  it.each([
    ['null legs', null],
    ['undefined legs', undefined],
    ['empty legs', []],
    ['a route elsewhere', ELSEWHERE],
  ])('renders nothing for %s', (_label, legs) => {
    const { container } = renderNotice(legs as Leg[] | null | undefined);
    expect(container.innerHTML).toBe('');
  });

  it('follows the legs prop across a transition (recalculate-and-replace, rig switch)', () => {
    const { container, rerenderLegs } = renderNotice(ELSEWHERE);
    expect(container.querySelector('.opening-bridge-notice')).toBeNull();
    rerenderLegs(CROSSING);
    expect(container.querySelectorAll('.opening-bridge-notice')).toHaveLength(1);
    rerenderLegs(ELSEWHERE);
    expect(container.querySelector('.opening-bridge-notice')).toBeNull();
  });
});
