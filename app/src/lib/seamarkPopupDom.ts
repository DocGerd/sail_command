import {
  resolveSeamarkPopoverValue,
  seamarkPopoverRows,
  type SeamarkPopoverTranslate,
} from './seamarkPopover';
import type { SeamarkProperties } from '../types';

// #830: the DOM half of the seamark info popup (#7) — one "label: value"
// line per seamarkPopoverRows() row, then the app disclaimer — so the
// keyboard-reachable list (components/SeamarksInView.tsx) can open the SAME
// popup at a mark that a map click opens. Lifted, byte-for-byte in output,
// from the inline DOM build inside DataLayers.tsx's seamark click handler
// (its `handleClick`, the `container`/`line`/`disclaimer` block). That file
// was outside #830's file allowlist, so it still builds its own copy: the
// pending follow-up is to point that handler at this function, at which
// point this becomes the single definition. Until then the twin is pinned
// here by seamarkPopupDom.test.ts and there by DataLayers.test.tsx's #232
// popup-content rows — a drift between the two reds one of them.
//
// DOM-only, no React and no map: `t` is injected (seamarkPopover.ts's
// structural SeamarkPopoverTranslate) so this stays unit-testable with a
// stub, and the caller owns the Popup that displays it.
export function buildSeamarkPopoverContent(
  props: SeamarkProperties,
  t: SeamarkPopoverTranslate,
): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'seamark-popover';
  for (const row of seamarkPopoverRows(props)) {
    const line = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = `${t(row.labelKey)}: `;
    // resolveSeamarkPopoverValue is the join/translate logic under direct
    // unit test with a stub t (#300 F4) — this call is a thin DOM wrapper.
    line.append(label, document.createTextNode(resolveSeamarkPopoverValue(row, t)));
    container.append(line);
  }
  const disclaimer = document.createElement('p');
  disclaimer.className = 'seamark-popover-disclaimer';
  disclaimer.textContent = t('app.disclaimer');
  container.append(disclaimer);
  return container;
}
