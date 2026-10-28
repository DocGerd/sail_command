import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withBackgroundSentinels } from './cssBackgroundSentinels';

// #1884: `.ais-status-chip` was a bare single-class rule declared BEFORE `.chip`'s
// base rule, so `.chip`'s `background` won the tie and the pill was unreadable in
// dark mode. chipShallowFill.test.ts / chipPolarTierFill.test.ts cover only
// `.chip-*` names; this guard covers any class applied together with `.chip`.
//
// `node:fs`, not `?raw`: vitest empties `.css` modules (see chipShallowFill.test.ts).
const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../app.css');

// The companion set is derived from `<Chip className="…">` / `<Chip className={`…`}>` and
// literal `className="chip …"` in component sources. Blind spots: a class reaching a chip
// through a variable, a ternary, another wrapper, a literal with `chip` not first, or a
// `>` (arrow handler) before `className` inside the `<Chip` tag.
const sources = import.meta.glob<string>(['../**/*.tsx', '!../**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

interface Rule {
  selectors: string[];
  props: string[];
  index: number;
}

function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    rules.push({
      selectors: match[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      props: match[2]
        .split(';')
        .map((d) => d.split(':')[0].trim().toLowerCase())
        .filter((p) => p.length > 0),
      index: match.index,
    });
  }
  return rules;
}

// Same property, a shorthand/longhand pair (background / background-color), or
// two radius properties; `gap` pairs with `row-gap`/`column-gap`.
function overlaps(a: string, b: string): boolean {
  if (a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`)) return true;
  if (a.includes('radius') && b.includes('radius')) return true;
  const gaps = ['gap', 'row-gap', 'column-gap'];
  return gaps.includes(a) && gaps.includes(b);
}

interface Companions {
  exact: Set<string>;
  prefixes: Set<string>;
}

function collectCompanions(): Companions {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  const add = (list: string): void => {
    for (const token of list.split(/\s+/)) {
      if (token === '' || token === 'chip') continue;
      const tpl = token.indexOf('${');
      if (tpl === -1) exact.add(token);
      else if (tpl > 0) prefixes.add(token.slice(0, tpl));
    }
  };
  const chipElement = /<Chip\b[^>]*?\bclassName=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  const literalChip = /className="(chip\s[^"]*)"/g;
  for (const source of Object.values(sources)) {
    let m: RegExpExecArray | null;
    while ((m = chipElement.exec(source)) !== null) add(m[1] ?? m[2] ?? '');
    while ((m = literalChip.exec(source)) !== null) add(m[1]);
  }
  return { exact, prefixes };
}

const isCompanion = (name: string, c: Companions): boolean =>
  c.exact.has(name) || [...c.prefixes].some((p) => name.startsWith(p));

describe('#1884: .chip companion classes win the cascade over .chip', () => {
  it('the AIS status chip resolves its own background, not .chip’s neutral one', () => {
    const { css, sentinel } = withBackgroundSentinels(readFileSync(APP_CSS_PATH, 'utf8'));
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const plain = document.createElement('span');
    plain.className = 'chip';
    const ais = document.createElement('span');
    ais.className = 'chip ais-status-chip ais-status-offline';
    // Reference painted inline with the intended token, so a wrong-but-different
    // background cannot satisfy the row.
    const reference = document.createElement('span');
    reference.style.background = `color-mix(in srgb, ${sentinel('--sc-bg')} 88%, transparent)`;
    document.body.append(plain, ais, reference);

    const plainBackground = getComputedStyle(plain).backgroundColor;
    const aisBackground = getComputedStyle(ais).backgroundColor;
    expect(plainBackground, 'control: plain .chip must paint a background').not.toBe('');
    expect(
      aisBackground,
      `#1884 guard: .chip.ais-status-chip resolved "${aisBackground}", identical to plain .chip — ` +
        '`.chip` is overriding its background again.',
    ).not.toBe(plainBackground);
    expect(
      aisBackground,
      `#1884 guard: .chip.ais-status-chip resolved "${aisBackground}", not the 88% --sc-bg glass fill.`,
    ).toBe(getComputedStyle(reference).backgroundColor);
  });

  it('no bare companion rule declared before .chip overlaps .chip’s properties', () => {
    const rules = parseRules(readFileSync(APP_CSS_PATH, 'utf8'));
    const baseChip = rules.filter((r) => r.selectors.includes('.chip'));
    expect(
      baseChip.length,
      '#1884 guard: app.css has no bare `.chip { … }` rule — renamed or restructured?',
    ).toBeGreaterThan(0);
    const lastBase = Math.max(...baseChip.map((r) => r.index));
    const baseProps = [...new Set(baseChip.flatMap((r) => r.props))];
    expect(baseProps, '.chip base property set').toContain('background');

    const companions = collectCompanions();
    for (const known of [
      'ais-status-chip',
      'chip-faster-rig',
      'chip-shallow',
      'live-view-gps-stale',
    ]) {
      expect(companions.exact, `companion scan lost ${known}`).toContain(known);
    }
    expect([...companions.prefixes], 'companion scan lost template prefixes').toContain(
      'ais-status-',
    );

    const offenders = rules
      .filter((r) => r.index < lastBase)
      .filter((r) => r.props.some((p) => baseProps.some((b) => overlaps(p, b))))
      .flatMap((r) =>
        r.selectors
          .filter((s) => /^\.[A-Za-z0-9_-]+$/.test(s))
          .filter((s) => isCompanion(s.slice(1), companions)),
      );
    expect(
      offenders,
      `#1884 guard: bare companion rule(s) declared before .chip with overlapping properties: ` +
        `${offenders.join(', ')}. They tie .chip on specificity and lose on source order; ` +
        'raise to `.chip.<name>` (#506, #504).',
    ).toEqual([]);
  });
});
