import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// `node:fs`, not a `?raw` static import: Vitest's default CSS handling mocks
// any `.css`-matching module id to an empty string regardless of a `?raw`
// suffix (measured — `.ts?raw`, as routing/planRoute.reasonDecoupling.test.ts
// uses, is unaffected; `.css?raw` is not). Same reason and same pattern as
// useBannerHeight.test.ts/panelWidth.test.ts/maskTolerance.test.ts, all of
// which read app.css via `node:fs` and are registered in
// tsconfig.test.json's include (and tsconfig.app.json's exclude) for it.
const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../app.css');

// #506: `.chip-shallow`'s amber hazard fill never rendered. `.chip-shallow`
// was a single-class modifier declared BEFORE `.chip`'s own base rule later
// in app.css; two single-class selectors tie on specificity, so source
// order alone handed `background` to `.chip`'s neutral
// `color-mix(in srgb, var(--sc-fg) 8%, transparent)` fill instead of
// `.chip-shallow`'s own `var(--sc-depth-warning-bg)` — the identical
// cascade #493/PR #504 hit and fixed on `.chip-shallow-cautious` by raising
// it to the compound selector `.chip.chip-shallow-cautious`.
//
// This test asserts the RESOLVED style against the REAL app.css, not the
// CSS text — a selector-only check would pass on the broken bare-modifier
// form too. jsdom parses neither `color-mix()` nor `var()`, so
// `getComputedStyle(el).backgroundColor` reads `rgba(0, 0, 0, 0)` in BOTH
// the broken and the fixed state and cannot discriminate (CLAUDE.md's own
// documented jsdom caveat for this exact cascade). Only the `background`
// SHORTHAND carries the winning declaration's raw text through jsdom's CSS
// cascade resolution — MEASURED here: the neutral `.chip` shorthand reads
// `"color-mix(in srgb, var(--sc-fg) 8%, transparent)"` and, once fixed, the
// shallow chip's reads `"var(--sc-depth-warning-bg)"`, its own declared
// value rather than the base rule's.

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

describe('#506: .chip-shallow amber hazard fill actually renders', () => {
  it("resolves its OWN background, not .chip's neutral color-mix fill", () => {
    const css = readFileSync(APP_CSS_PATH, 'utf8');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const neutral = renderChip('chip');
    const shallow = renderChip('chip chip-shallow');

    const neutralBackground = getComputedStyle(neutral).background;
    const shallowBackground = getComputedStyle(shallow).background;

    expect(
      shallowBackground,
      `#506 guard: .chip.chip-shallow's resolved "background" shorthand was ` +
        `"${shallowBackground}", identical to plain .chip's ` +
        `"${neutralBackground}" — the amber hazard fill is being overridden ` +
        `by .chip's own neutral color-mix fill again (the cascade #506 fixed).`,
    ).not.toBe(neutralBackground);

    expect(shallowBackground).toContain('--sc-depth-warning-bg');
  });
});

// Structural sibling of the resolved-style test above: rather than pinning
// THIS one instance, scan app.css for the whole SHAPE of the bug — any bare
// single-class `.chip-<modifier>` selector declared before `.chip`'s own
// base rule loses the cascade tie the same way `.chip-shallow` did, whether
// or not anyone has noticed the visual symptom yet. `.chip.chip-shallow`
// (fixed above) and `.chip.chip-shallow-cautious` (#493/PR #504) are
// compound selectors and win regardless of order; `.chip-faster-rig`
// already sits below `.chip` and is unaffected either way.
interface RuleHeader {
  selectors: string[];
  index: number;
}

function parseRuleHeaders(css: string): RuleHeader[] {
  const headers: RuleHeader[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutComments)) !== null) {
    const selectors = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    headers.push({ selectors, index: match.index });
  }
  return headers;
}

describe('#506 structural guard: no future .chip-* modifier repeats the bare-single-class cascade bug', () => {
  it('every bare `.chip-<modifier>` selector is declared after .chip, or raised to a compound selector', () => {
    const css = readFileSync(APP_CSS_PATH, 'utf8');
    const headers = parseRuleHeaders(css);

    const baseChipIndices = headers
      .filter((h) => h.selectors.includes('.chip'))
      .map((h) => h.index);

    expect(
      baseChipIndices.length,
      "#506 guard: could not find app.css's `.chip { ... }` base rule at all — has it been renamed " +
        'or restructured? This guard can no longer verify the cascade it exists to protect.',
    ).toBeGreaterThan(0);

    const lastBaseChipIndex = Math.max(...baseChipIndices);

    const brokenModifiers = headers
      .flatMap((h) => h.selectors.map((selector) => ({ selector, index: h.index })))
      .filter(({ selector }) => /^\.chip-[A-Za-z0-9_-]+$/.test(selector))
      .filter(({ index }) => index < lastBaseChipIndex)
      .map(({ selector }) => selector);

    expect(
      brokenModifiers,
      "#506 guard: found bare single-class .chip-* modifier selector(s) declared before app.css's " +
        `.chip base rule: ${brokenModifiers.join(', ')}. Two single-class selectors tie on ` +
        "specificity, so .chip (declared later) silently wins and the modifier's own styles never " +
        `render (the #506/#493 cascade). Raise it to a compound selector (e.g. ".chip${brokenModifiers[0] ?? ''}") ` +
        "or move its declaration below .chip's own.",
    ).toEqual([]);
  });
});
