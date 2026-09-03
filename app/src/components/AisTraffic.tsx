import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { useMapInstance } from './MapView';
import { useLang, useT } from '../i18n';
import { useOnline } from '../state/AppState';
import { useAisTraffic, useSettledValue, type AisStatus } from '../state/useAisTraffic';
import { useMapViewport } from '../state/useMapViewport';
import AisLayer, { openAisPopup } from './AisLayer';
import Chip from './Chip';
import Disclosure from './Disclosure';
import { padBoundingBox, viewportEscapedBbox, type AisBoundingBox } from '../services/aisStream';
import {
  AIS_CORRIDOR_HALF_WIDTH_NM,
  mergeOverlappingBoxes,
  routeCorridorBoxes,
} from '../lib/routeCorridor';
import { aisPopupRows, aisTargetsInView, type AisPopupProps } from '../lib/aisGeoJson';
import { activeRigResult } from '../lib/plan';
import type { Plan, SailId } from '../types';
import type { MsgKey } from '../i18n/dict.de';
import type { AisTargetSnapshot } from '../lib/aisTargets';

const AIS_BBOX_PAD = 0.2; // subscribe to the viewport padded 20% each side
const AIS_RESUBSCRIBE_DEBOUNCE_MS = 2000;
// #158: how long activeLegIndex must hold one value before the corridor adopts
// it — sized to the viewport debounce above (a network resend, not a render).
const AIS_CORRIDOR_LEG_SETTLE_MS = 2000;

const STATUS_KEY: Record<Exclude<AisStatus, 'live'>, MsgKey> = {
  off: 'ais.status.off',
  connecting: 'ais.status.connecting',
  offline: 'ais.status.offline',
  keyError: 'ais.status.keyError',
};

// Pure, unit-tested: the five-state status chip. Kept separate from the
// map/hook wiring so it can be tested without a MapLibre instance. While a
// route is active (#146) the live count splits into total and along-route.
export function AisStatusChip({
  status,
  targetCount,
  routeActive,
  routeCount,
}: {
  status: AisStatus;
  targetCount: number;
  routeActive: boolean;
  routeCount: number;
}) {
  const t = useT();
  const text =
    status === 'live'
      ? routeActive
        ? t('ais.status.liveRoute', { count: targetCount, routeCount })
        : t('ais.status.live', { count: targetCount })
      : t(STATUS_KEY[status]);
  return (
    <div className="ais-status" role="status">
      <Chip className={`ais-status-chip ais-status-${status}`}>{text}</Chip>
    </div>
  );
}

// #831: AIS vessel identification is pointer-only in AisLayer.tsx — a rendered
// symbol-layer glyph has no DOM node, so a click on a vessel triangle has no
// keyboard equivalent (WCAG 2.1.1, same defect class as #830's seamarks-in-
// view list, which this mirrors per the #714 spike's own recommendation to
// reuse whatever pattern that list settles on rather than invent a second
// one). Population is the SAME `targets` array AisLayer already renders
// (never a second data source), filtered to the map's current viewport
// bounds via lib/aisGeoJson.ts's aisTargetsInView — so the list matches
// exactly what a mouse user can see and click, nearest-to-centre first,
// capped at AIS_IN_VIEW_MAX. Each row is a native <button> (focusable and
// Enter/Space-activatable for free) that opens the SAME themed popup a
// pointer click does (AisLayer.tsx's exported openAisPopup — one renderer of
// aisPopupRows(), never two), so a sighted keyboard user also learns WHERE
// the vessel is. Deliberately renders in every AIS status (off/connecting/
// offline/keyError/live) rather than hiding itself when AIS isn't
// configured — AisStatusChip above already does the same (always visible),
// and the "no vessels in view" body text is equally true whether the cause
// is "no key" or "connected but nothing nearby"; a sighted keyboard-only
// user can already read the WHY from that chip without needing focus on it.
//
// PLACEMENT: this file's own AIS status chip (`.ais-status`) is the one
// Live-tab-specific slot in the map chrome tier system (app.css's Tier-2
// list) already reserved for exactly this feature — `App.tsx` and `app.css`
// are both OUT of this task's file scope, so rather than invent a new
// floating box that would need coordinating against that documented z-index/
// collision history (CLAUDE.md's #208/#368 lineage), this renders as an
// independent absolutely-positioned sibling stacked directly below that
// chip's row, at the SAME z-index tier (2) and the SAME horizontal
// centering, using inline styles only (no new app.css rule). The vertical
// offset below the chip is a judgement call, not a measured constant (the
// same "maintainer judgement call" shape as panelWidth.ts's
// PANEL_MAP_RESERVE_PX) — a follow-up with app.css in scope may want to fold
// this into the tier system's own comment properly.
const AIS_IN_VIEW_TOP_OFFSET = 'calc(3.5rem + 2.75rem)';

function popupPropsOf(target: AisTargetSnapshot): AisPopupProps {
  return {
    mmsi: target.mmsi,
    name: target.name ?? '',
    shipType: target.shipType ?? null,
    sog: target.sogKn ?? null,
    cog: target.cogDeg ?? null,
    heading: target.headingDeg ?? null,
    lastUpdateMs: target.lastUpdateMs,
  };
}

export function AisVesselsInView({
  map,
  targets,
}: {
  map: MaplibreMap | null;
  targets: AisTargetSnapshot[];
}) {
  const t = useT();
  const [lang] = useLang();
  const viewport = useMapViewport(map);

  // One popup at a time from this list (a map click may add its own; that is
  // AisLayer's popup, not tracked here), removed on unmount so a tab switch
  // does not strand a popover on the map.
  const popupRef = useRef<ReturnType<typeof openAisPopup> | null>(null);
  useEffect(
    () => () => {
      popupRef.current?.remove();
      popupRef.current = null;
    },
    [],
  );

  const result = useMemo(
    () => (viewport ? aisTargetsInView(targets, viewport) : null),
    [targets, viewport],
  );

  const showOnMap = (target: AisTargetSnapshot) => {
    if (!map) return;
    popupRef.current?.remove();
    popupRef.current = openAisPopup(
      map,
      { lng: target.position.lon, lat: target.position.lat },
      popupPropsOf(target),
      t,
      lang,
    );
  };

  const summary = t('ais.inView.summary', { count: result?.total ?? 0 });

  let body: ReactNode;
  if (!result) {
    body = <p className="ais-in-view-note">{t('ais.inView.loading')}</p>;
  } else if (result.total === 0) {
    body = <p className="ais-in-view-note">{t('ais.inView.empty')}</p>;
  } else {
    body = (
      <>
        <p className="ais-in-view-hint">{t('ais.inView.hint')}</p>
        <ol className="ais-in-view-list">
          {result.targets.map((target) => {
            const props = popupPropsOf(target);
            // aisPopupRows always leads with the name row; the rest are
            // optional (ship type/SOG/COG when known) plus a trailing age
            // row this list DROPS (never shown as a row here) — computing a
            // live age needs Date.now(), an impure call this eslint config
            // forbids in a render body, and the age is already available in
            // full on activation: openAisPopup() computes it fresh at click
            // time. `target.lastUpdateMs` as `nowMs` is a pure placeholder
            // (ageMin would read 0) purely to keep aisPopupRows a pure call.
            const [primaryRow, ...rest] = aisPopupRows(props, target.lastUpdateMs, lang);
            const detailRows = rest.filter((row) => row.labelKey !== 'ais.popup.age');
            return (
              <li key={target.mmsi}>
                <button type="button" className="ais-in-view-row" onClick={() => showOnMap(target)}>
                  <span className="ais-in-view-row-name">{primaryRow.value}</span>
                  {detailRows.map((row) => (
                    <span key={row.labelKey} className="ais-in-view-row-detail">
                      {' · '}
                      {t(row.labelKey)}: {row.value}
                    </span>
                  ))}
                </button>
              </li>
            );
          })}
        </ol>
        {result.total > result.targets.length && (
          <p className="ais-in-view-note">
            {t('ais.inView.truncated', {
              shown: result.targets.length,
              total: result.total,
            })}
          </p>
        )}
      </>
    );
  }

  return (
    <div
      className="ais-in-view"
      style={{
        position: 'absolute',
        top: AIS_IN_VIEW_TOP_OFFSET,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2,
        pointerEvents: 'auto',
        background: 'var(--sc-bg)',
      }}
    >
      <Disclosure summary={summary}>{body}</Disclosure>
    </div>
  );
}

/**
 * #25: the Live-tab AIS overlay controller. Mounted only while tab === 'live'
 * (App), inside MapView's subtree so useMapInstance()/AisLayer see the map.
 * Owns the viewport→bbox subscription (debounced moveend, padded, re-sent only
 * when the view leaves the padded box) and the online/visibility gates, then
 * delegates the socket lifecycle to useAisTraffic. Renders the vessel layers
 * (AisLayer) plus a status-chip overlay on the map.
 */
export default function AisTraffic({
  apiKey,
  ownMmsi,
  plan,
  rig,
  activeLegIndex,
}: {
  apiKey: string | undefined;
  ownMmsi: string | undefined;
  plan: Plan | null;
  rig: SailId | null;
  activeLegIndex: number | null;
}) {
  const map = useMapInstance();
  const online = useOnline();
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [bbox, setBbox] = useState<AisBoundingBox | null>(null);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Track the viewport, debounced. Re-pad (and thus re-subscribe) only when the
  // current view escapes the padded box we last subscribed to — a small pan
  // inside the pad margin sends nothing.
  useEffect(() => {
    if (!map) return;
    const update = () => {
      const b = map.getBounds();
      const sw = { lat: b.getSouth(), lon: b.getWest() };
      const ne = { lat: b.getNorth(), lon: b.getEast() };
      setBbox((prev) =>
        prev && !viewportEscapedBbox(prev, sw, ne) ? prev : padBoundingBox(sw, ne, AIS_BBOX_PAD),
      );
    };
    update(); // initial bbox
    let timer: number | undefined;
    const onMoveEnd = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(update, AIS_RESUBSCRIBE_DEBOUNCE_MS);
    };
    map.on('moveend', onMoveEnd);
    return () => {
      window.clearTimeout(timer);
      map.off('moveend', onMoveEnd);
    };
  }, [map]);

  // #158: activeLegIndex is a hysteresis-free per-fix argmin — near a leg
  // boundary GPS noise flips it between adjacent indices at fix rate. The
  // corridor consumes it through the settle gate: a genuine leg advance is
  // adopted after 2 s; sustained boundary jitter never settles, so the memo
  // below never recomputes at fix rate. A plan/rig identity change is NEVER
  // fix jitter (#162 review): it resets the gate to the raw index in the same
  // render — setPlan batches plan + activeLegIndex→null, and holding the OLD
  // plan's index against the NEW plan's legs would slice a mis-placed
  // corridor for up to 2 s.
  const corridorEpoch = useMemo(() => [plan, rig] as const, [plan, rig]);
  const settledLegIndex = useSettledValue(
    activeLegIndex,
    AIS_CORRIDOR_LEG_SETTLE_MS,
    corridorEpoch,
  );

  // #146 route corridor: recomputes only on [plan, rig, settledLegIndex] — all
  // three are stable references / change at leg-transition cadence (#158),
  // never per GPS fix.
  const corridorBoxes = useMemo<AisBoundingBox[]>(() => {
    if (!plan || !rig) return [];
    const rr = activeRigResult(plan, rig);
    if (!rr) return [];
    return routeCorridorBoxes(rr.legs, settledLegIndex, AIS_CORRIDOR_HALF_WIDTH_NM);
  }, [plan, rig, settledLegIndex]);

  // Subscription union (corridor ∪ padded viewport), memoized so an unchanged
  // corridor + viewport keeps list identity and the hook's subscription effect
  // does not re-fire per render (a leg/plan/rig change resends on the open
  // socket, never reconnects).
  const bboxes = useMemo<AisBoundingBox[] | null>(
    () => (bbox === null ? null : mergeOverlappingBoxes([bbox, ...corridorBoxes])),
    [bbox, corridorBoxes],
  );

  // A real route exists for the active rig (#146 OQ2) — gates the chip split.
  const routeActive = plan !== null && rig !== null && activeRigResult(plan, rig) !== null;

  const { status, targets, targetCount, routeCount } = useAisTraffic({
    apiKey,
    ownMmsi,
    bboxes,
    corridorBoxes,
    online,
    visible,
  });

  return (
    <>
      <AisLayer targets={targets} />
      <AisStatusChip
        status={status}
        targetCount={targetCount}
        routeActive={routeActive}
        routeCount={routeCount}
      />
      <AisVesselsInView map={map} targets={targets} />
    </>
  );
}
