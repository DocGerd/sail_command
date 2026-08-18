import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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
// grep would pass on the broken bare-modifier form too. jsdom parses neither
// `color-mix()` nor `var()`, so `getComputedStyle(el).backgroundColor` reads
// `rgba(0, 0, 0, 0)` in BOTH the broken and the fixed state and cannot
// discriminate (CLAUDE.md's documented jsdom caveat for this exact cascade);
// only the `background` SHORTHAND carries the winning declaration's raw text
// through jsdom's cascade resolution.
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

function withAppCss(): void {
  const style = document.createElement('style');
  style.textContent = readFileSync(APP_CSS_PATH, 'utf8');
  document.head.appendChild(style);
}

describe('#54 polar-provenance tier chips resolve their own fill', () => {
  it('the estimated tier renders the caution fill, not .chip’s neutral one', () => {
    withAppCss();
    const neutral = renderChip('chip');
    const estimated = renderChip('chip chip-polar-tier chip-polar-tier-estimated');

    const neutralBackground = getComputedStyle(neutral).background;
    const estimatedBackground = getComputedStyle(estimated).background;

    expect(
      estimatedBackground,
      `#54 guard: .chip.chip-polar-tier-estimated's resolved "background" was ` +
        `"${estimatedBackground}", identical to plain .chip's "${neutralBackground}" — ` +
        `the tier-C caution fill is being overridden by .chip's own neutral ` +
        `color-mix fill (the #506/#493 cascade).`,
    ).not.toBe(neutralBackground);
    expect(estimatedBackground).toContain('--sc-depth-warning-bg');
  });

  it('the certificate tier renders the accent fill', () => {
    withAppCss();
    const neutral = renderChip('chip');
    const certificate = renderChip('chip chip-polar-tier chip-polar-tier-certificate');
    expect(getComputedStyle(certificate).background).not.toBe(getComputedStyle(neutral).background);
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
    expect(getComputedStyle(modelled).background).toBe(getComputedStyle(neutral).background);
  });
});
