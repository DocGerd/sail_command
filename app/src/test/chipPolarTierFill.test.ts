import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withBackgroundSentinels } from './cssBackgroundSentinels';

// `node:fs`, not a `?raw` static import: Vitest's default CSS handling mocks
// any `.css`-matching module id to an empty string regardless of a `?raw`
// suffix. Same reason and same pattern as chipShallowFill.test.ts /
// useBannerHeight.test.ts / panelWidth.test.ts / maskTolerance.test.ts.
const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../app.css');

// #54: the boat picker's polar-provenance tier chip. `.chip-shallow` (#506)
// and `.chip-shallow-cautious` (#493) each silently lost their fill to
// `.chip`'s neutral `color-mix(...)` because two single-class selectors tie
// on specificity and `.chip`'s base rule is declared LATER in app.css — so
// the tier chips are written as compound `.chip.chip-polar-tier-*` selectors.
//
// This asserts the RESOLVED style against the REAL app.css. A selector-only
// grep would pass on the broken bare-modifier form too. jsdom does not
// resolve `var()`, so the stylesheet goes through `withBackgroundSentinels`
// first (see its header).
//
// The ESTIMATED tier is the one that must not fail silently: it is the
// caution label spec N.5 requires at the picker, and a tier-C polar rendering
// as an ordinary neutral pill is exactly the honesty failure that section
// exists to prevent.

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

function renderChip(className: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  document.body.appendChild(el);
  return el;
}

function withAppCss(): (name: string) => string {
  const { css, sentinel } = withBackgroundSentinels(readFileSync(APP_CSS_PATH, 'utf8'));
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  return sentinel;
}

const bg = (el: Element): string => getComputedStyle(el).backgroundColor;

describe('#54 polar-provenance tier chips resolve their own fill', () => {
  it('the estimated tier renders the caution fill, not .chip’s neutral one', () => {
    const sentinel = withAppCss();
    const neutral = renderChip('chip');
    const estimated = renderChip('chip chip-polar-tier chip-polar-tier-estimated');

    expect(
      bg(estimated),
      `#54 guard: .chip.chip-polar-tier-estimated resolved backgroundColor ` +
        `"${bg(estimated)}" (plain .chip: "${bg(neutral)}") instead of ` +
        `--sc-depth-warning-bg's sentinel — the tier-C caution fill is being ` +
        `overridden by .chip's own neutral color-mix fill (the #506/#493 cascade).`,
    ).toBe(sentinel('--sc-depth-warning-bg'));
  });

  it('the certificate tier renders the accent fill', () => {
    withAppCss();
    const neutral = renderChip('chip');
    const certificate = renderChip('chip chip-polar-tier chip-polar-tier-certificate');
    // Both are color-mix() over a token, so neither has a sentinel of its own;
    // a different mix is what distinguishes the accent fill.
    expect(bg(certificate)).not.toBe(bg(neutral));
  });

  it('the modelled tier DELIBERATELY inherits .chip’s neutral fill', () => {
    // Not an omission — the honest middle of three tiers gets no colour of
    // its own. Pinned so that adding a `.chip.chip-polar-tier-modelled` rule
    // later is a deliberate act rather than an accident, and so the two rows
    // above are known to be measuring a real difference rather than three
    // chips that happen to look alike.
    withAppCss();
    const neutral = renderChip('chip');
    const modelled = renderChip('chip chip-polar-tier chip-polar-tier-modelled');
    expect(bg(modelled)).toBe(bg(neutral));
  });
});
