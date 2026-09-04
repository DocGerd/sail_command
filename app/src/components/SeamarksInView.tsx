import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Popup } from 'maplibre-gl';
import Disclosure from './Disclosure';
import { useMapInstance } from './MapView';
import { useT } from '../i18n';
import { toSeamarkDisplayTier } from '../lib/seamarkGlyphs';
import { resolveSeamarkPopoverValue, seamarkPopoverRows } from '../lib/seamarkPopover';
import { buildSeamarkPopoverContent } from '../lib/seamarkPopupDom';
import { seamarksInView, type SeamarkInView } from '../lib/seamarksInView';
import { usePersistedNumber } from '../lib/usePersistedNumber';
import { usePersistedToggle } from '../lib/usePersistedToggle';
import { useMapViewport } from '../state/useMapViewport';
import { useSeamarks } from '../state/useSeamarks';
import type { ViaPoint } from '../types';

// #830: the keyboard-reachable "seamarks in view" list — WCAG 2.1.1's
// equivalent for DataLayers.tsx's pointer-only seamark click. A rendered
// symbol-layer glyph has no DOM node, so it can never be focused; this
// renders the marks inside the current viewport as a list of native
// <button>s (focusable and Enter/Space-activatable for free), each reading
// as the map popover would (the SAME seamarkPopoverRows() data, a second
// renderer of it, per the #714 spike's §4.1), and each opening that same
// popup ON THE MAP at the mark when activated — so a sighted keyboard user
// also learns WHERE the mark is.
//
// PLACEMENT — the Plan panel, NOT `.data-layer-controls` (the spike's
// recommendation). Measured 2026-09-02 against a real DOM injection: a third
// `.data-layer-controls` row costs +51.6px at 375x667 and drops the depth
// legend's reachability budget (`budgetPx`, DataLayers.tsx's own
// useLayoutEffect) from 62.556px to 10.96px, under LEGEND_COLLAPSED_HEIGHT_PX
// (44) — `hidden` on the whole `.depth-legend`, #597 safety caveat included,
// at 375x667 and 360x740 collapsed and 390x844 expanded. The panel leaves
// that budget byte-identical at all twelve viewports in both arms; its whole
// price is panel scroll depth (+46px collapsed / +153px expanded at 375x667,
// zero at desktopHd where the panel does not scroll), which is why the
// Disclosure defaults COLLAPSED. `seamarks.spec.ts`'s #830 guard pins the
// three viewports where the chrome placement fails.
//
// WHY A PORTAL: `useMapInstance()` is a context only MapView's descendants
// can read, and the panel is a sibling of MapView (App.tsx). LiveView.tsx
// already solves exactly this by mounting inside MapView and portalling its
// readout into a panel slot; this is the same shape, into the Plan tab's
// `.app-panel-seamarks` slot. `null` slot (any other tab) renders nothing.
//
// WHAT IT MIRRORS from the map, and what it does not: the seamark layer's
// visibility toggle (`sc-seamarks-visible` — off by default, #7) and the
// persisted display-tier cut (`sc-seamark-display-tier`), both through the
// SAME persisted hooks DataLayers.tsx reads, so a change made on the map
// chrome or the Boat tab reaches this list live (#681's cross-instance
// sync). It does NOT mirror z<12 collision culling — see seamarksInView.ts.
//
// The viewport is settle-gated (state/useMapViewport.ts): the list rebuilds
// once per gesture train, never per moveend.

export interface SeamarksInViewProps {
  /** The Plan panel's `.app-panel-seamarks` element, or null when that tab is
   * not showing — LiveView's `panelSlot` contract. */
  panelSlot: HTMLDivElement | null;
  // #845: "add as waypoint" from the popup this row's activation opens —
  // §3.1 of the design spec deliberately reaches this component too, since
  // a MapLibre glyph has no DOM node and this list is a keyboard user's
  // only route to the action. OPTIONAL for the same reason as
  // DataLayers.tsx's own `onAddWaypoint` — many existing
  // `<SeamarksInView panelSlot={...} />` test call sites need no change.
  onAddWaypoint?: (waypoint: ViaPoint) => void;
}

export default function SeamarksInView({ panelSlot, onAddWaypoint }: SeamarksInViewProps) {
  const map = useMapInstance();
  const t = useT();
  const seamarks = useSeamarks();
  const viewport = useMapViewport(map);
  const [seamarksVisible] = usePersistedToggle('sc-seamarks-visible', false);
  // #513 R4: UNCLAMPED, the same read DataLayers.tsx and SettingsPanel.tsx
  // make — `usePersistedNumber`'s clamp would launder a corrupt stored
  // value before toSeamarkDisplayTier could fail it toward SHOWING.
  const [seamarkDisplayTierStored] = usePersistedNumber(
    'sc-seamark-display-tier',
    -Infinity,
    Infinity,
  );
  const selectedTier = toSeamarkDisplayTier(seamarkDisplayTierStored);
  const hintId = useId();

  const result = useMemo(
    () => (seamarks && viewport ? seamarksInView(seamarks, viewport, selectedTier) : null),
    [seamarks, viewport, selectedTier],
  );

  // One popup at a time from this list (a map click may add its own; that
  // is DataLayers' popup, not tracked here), removed on unmount so a tab
  // switch does not strand a popover on the map.
  const popupRef = useRef<Popup | null>(null);
  useEffect(
    () => () => {
      popupRef.current?.remove();
      popupRef.current = null;
    },
    [],
  );

  const showOnMap = (mark: SeamarkInView) => {
    if (!map) return;
    popupRef.current?.remove();
    // Same options the map click uses (DataLayers.tsx), anchored at the
    // mark's own coordinates — there is no tap point to anchor at instead.
    popupRef.current = new Popup({
      closeButton: true,
      maxWidth: '240px',
      className: 'seamark-popup',
    })
      .setLngLat([mark.lon, mark.lat])
      .setDOMContent(
        buildSeamarkPopoverContent(mark.props, t, { lat: mark.lat, lon: mark.lon }, onAddWaypoint),
      )
      .addTo(map);
  };

  if (!panelSlot) return null;

  // The SUMMARY and every ROW are accessible names; neither may contain
  // "Seezeichen" or "Wassertiefen" — see dict.de.ts's own #830 comment on
  // the getByRole substring hazard. Body notes are plain <p>s, no role.
  const counted = seamarksVisible && result !== null;
  const summary = counted
    ? t('seamarks.inView.summary', { count: result.total })
    : t('seamarks.inView.summaryPending');

  let body: ReactNode;
  if (!seamarksVisible) {
    body = <p className="seamarks-in-view-note">{t('seamarks.inView.layerOff')}</p>;
  } else if (result === null) {
    body = <p className="seamarks-in-view-note">{t('seamarks.inView.loading')}</p>;
  } else if (result.total === 0) {
    body = <p className="seamarks-in-view-note">{t('seamarks.inView.empty')}</p>;
  } else {
    body = (
      <>
        <p id={hintId} className="seamarks-in-view-hint">
          {t('seamarks.inView.hint')}
        </p>
        <ol className="seamarks-in-view-list">
          {result.marks.map((mark) => {
            // seamarkPopoverRows always leads with the type row; the rest
            // are optional (category/colour/light fields when tagged).
            const [typeRow, ...detailRows] = seamarkPopoverRows(mark.props);
            return (
              <li key={mark.key}>
                <button
                  type="button"
                  className="seamarks-in-view-row"
                  data-seamark-key={mark.key}
                  aria-describedby={hintId}
                  onClick={() => showOnMap(mark)}
                >
                  <span className="seamarks-in-view-row-type">
                    {typeRow ? resolveSeamarkPopoverValue(typeRow, t) : ''}
                  </span>
                  {detailRows.map((row) => (
                    <span key={row.labelKey} className="seamarks-in-view-row-detail">
                      {' · '}
                      {t(row.labelKey)}: {resolveSeamarkPopoverValue(row, t)}
                    </span>
                  ))}
                </button>
              </li>
            );
          })}
        </ol>
        {result.total > result.marks.length && (
          <p className="seamarks-in-view-note">
            {t('seamarks.inView.truncated', { shown: result.marks.length, total: result.total })}
          </p>
        )}
      </>
    );
  }

  return createPortal(
    <Disclosure className="seamarks-in-view" summary={summary}>
      {body}
    </Disclosure>,
    panelSlot,
  );
}
