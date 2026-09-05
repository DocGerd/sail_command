import {
  resolveSeamarkPopoverValue,
  seamarkPopoverRows,
  seamarkWaypointName,
  type SeamarkPopoverTranslate,
} from './seamarkPopover';
import type { LatLon, SeamarkProperties, ViaPoint } from '../types';

// #830: the DOM half of the seamark info popup (#7) — one "label: value"
// line per seamarkPopoverRows() row, then the app disclaimer — so the
// keyboard-reachable list (components/SeamarksInView.tsx) can open the SAME
// popup at a mark that a map click opens. Lifted, byte-for-byte in output,
// from the inline DOM build inside DataLayers.tsx's seamark click handler
// (its `handleClick`, the `container`/`line`/`disclaimer` block). #845
// pointed that handler at this function, making it the single definition —
// the twin-drift risk #872 tracked is now closed structurally rather than
// merely pinned by a paired test.
//
// DOM-only, no React and no map: `t` is injected (seamarkPopover.ts's
// structural SeamarkPopoverTranslate) so this stays unit-testable with a
// stub, and the caller owns the Popup that displays it.
//
// #845: `point` is the mark's own coordinates (never the tap point a map
// click may have anchored the popup at — see seamarkPopupAnchor's own
// comment) and `onAddWaypoint`, when given, renders an "add as waypoint"
// button that hands the caller a flattened `{lat, lon, name}` record
// (design spec §2.5, amended #966: any seamark the user can see and tap is
// eligible — the earlier curated-family allowlist is superseded). Reusing
// the existing `sc-btn`/`sc-btn-secondary` primitive classes here (this is
// plain DOM, not React, so the Button component itself can't be used) keeps
// this in the app's design system without touching app.css.
export function buildSeamarkPopoverContent(
  props: SeamarkProperties,
  t: SeamarkPopoverTranslate,
  point: LatLon,
  onAddWaypoint?: (waypoint: ViaPoint) => void,
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
  if (onAddWaypoint) {
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'sc-btn sc-btn-secondary seamark-popover-add-waypoint';
    addButton.textContent = t('seamark.popover.addWaypoint');
    addButton.addEventListener('click', () => {
      onAddWaypoint({ lat: point.lat, lon: point.lon, name: seamarkWaypointName(props, t) });
    });
    container.append(addButton);
  }
  return container;
}
