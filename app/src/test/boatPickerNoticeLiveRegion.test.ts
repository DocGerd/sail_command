import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// `node:fs`, not a `?raw` static import: Vitest's default CSS handling mocks
// any `.css`-matching module id to an empty string regardless of a `?raw`
// suffix. Same reason and pattern as chipShallowFill.test.ts /
// chipPolarTierFill.test.ts / useBannerHeight.test.ts / panelWidth.test.ts.
const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../app.css');

// PR #563 MAJOR 1. `BoatPicker.tsx` renders the spec C.7 clamp announcement as
// a role="status" region that is ALWAYS mounted and empty until there is
// something to say, because a live region has to be in the accessibility tree
// BEFORE its text changes for assistive tech to have anything to observe the
// mutation on. An earlier revision then hid the empty one with
// `display: none` — which removes an element from that tree outright, so the
// region was absent exactly while empty and appeared as a NEWLY INSERTED node
// at the same moment its text arrived. That is the one shape AT is not
// required to announce, and it silently defeated the whole arrangement.
//
// The component-side assertion (BoatPicker.test.tsx: the region is present,
// empty, and carries this class) is a DOM check and structurally cannot see
// this — that test renders without app.css attached, so the cascade is not
// even in play there. This file is the other half: the resolved style against
// the REAL stylesheet. The two are hand-written twins — the class name is
// spelled out independently on each side rather than derived from one
// source — so a rename on either side reds one of them.

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

function withAppCss(): void {
  const style = document.createElement('style');
  style.textContent = readFileSync(APP_CSS_PATH, 'utf8');
  document.head.appendChild(style);
}

function renderNotice(text: string): HTMLParagraphElement {
  const el = document.createElement('p');
  el.className = 'boat-picker-notice';
  el.setAttribute('role', 'status');
  if (text !== '') el.textContent = text;
  document.body.appendChild(el);
  return el;
}

describe('#54 the clamp announcement stays in the accessibility tree while empty', () => {
  it('does NOT resolve to display:none when empty', () => {
    withAppCss();
    const empty = renderNotice('');
    const display = getComputedStyle(empty).display;
    expect(
      display,
      `MAJOR 1 guard: an EMPTY .boat-picker-notice resolved "display: ${display}". ` +
        `display:none removes the element from the accessibility tree, so the ` +
        `role="status" region would not be present to observe the clamp text ` +
        `landing on it and the spec C.7 announcement is lost.`,
    ).not.toBe('none');
  });

  it('costs no layout while empty — the reason the rule existed at all', () => {
    // The original `display: none` was there to stop an idle region occupying
    // a padded, coloured row. Zeroing the box has to actually achieve that, or
    // the accessibility fix would have traded one visible defect for another.
    withAppCss();
    const empty = renderNotice('');
    const cs = getComputedStyle(empty);
    expect(cs.marginTop).toBe('0px');
    expect(cs.paddingTop).toBe('0px');
    expect(cs.paddingBottom).toBe('0px');
    // NOT `toBe('none')`: MEASURED, jsdom normalises the `background: none`
    // shorthand to `rgba(0, 0, 0, 0)`, so that assertion fails against a
    // correct stylesheet. What matters here is that the base rule's warning
    // fill is OVERRIDDEN, which is what the next row's positive control
    // confirms this check can actually distinguish.
    expect(cs.background).not.toContain('--sc-banner-warning-bg');
  });

  it('still paints its warning box once it has text', () => {
    // The discriminating control for the row above: without it, a rule that
    // zeroed the box unconditionally would pass "costs no layout" and silently
    // render the real announcement as unstyled body text.
    withAppCss();
    const filled = renderNotice('Safety depth raised to 2.4 m — the minimum for Deep 46.');
    const cs = getComputedStyle(filled);
    expect(cs.display).not.toBe('none');
    expect(cs.paddingTop).not.toBe('0px');
    expect(cs.background).toContain('--sc-banner-warning-bg');
  });
});
