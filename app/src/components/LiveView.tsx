import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLang, useT } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import { useActivePlan } from '../state/AppState';
import { activeRigResult } from '../lib/plan';
import {
  activeLegIndex as computeActiveLegIndex,
  distanceToNextManeuverNm,
  headingToSteerDeg,
  projectedEtaMs,
} from '../lib/live';
import { formatDriftMin, formatHeading, formatKn, formatNm, formatTime } from '../lib/format';
import { safeGetItem, safeSetItem } from '../lib/storage';
import { watchPosition as realWatchPosition, type GpsFix } from '../services/geolocation';
import BoatMarker from './BoatMarker';
import type { ManeuverKind } from '../types';

export interface LiveViewProps {
  watchPosition?: typeof realWatchPosition;
  // #31: when set (wide layout), the textual readout renders into this
  // panel-column slot via a portal instead of rendering inline in MapView's
  // subtree (the base bottom-sheet-region card). BoatMarker and its map-anchored
  // accuracy circle always stay in MapView's subtree — React context flows
  // through a portal by tree position, not DOM position, so useMapInstance()
  // keeps resolving the map wherever the readout lands. Null/undefined = render
  // inline (narrow, unchanged).
  panelSlot?: HTMLElement | null;
}

// Marks the GPS-denied/unavailable hint as shown, forever (spec §4: "hint
// shown once"). Set the moment the hint is displayed, not on dismiss, so a
// remount before the user dismisses it doesn't show it again.
const GPS_HINT_STORAGE_KEY = 'sc-gps-hint-shown';

const MANEUVER_LABEL_KEY: Record<ManeuverKind, MsgKey> = {
  tack: 'route.maneuver.tack',
  gybe: 'route.maneuver.gybe',
};

// GPS fix/error state is intentionally local to this component (not
// AppState) — see AppState.tsx's docstring: 1 Hz position updates must not
// re-render the whole app. Only the much-lower-frequency derived
// activeLegIndex is pushed up, for RouteLayer's highlight.
export default function LiveView({
  watchPosition = realWatchPosition,
  panelSlot,
}: LiveViewProps = {}) {
  const t = useT();
  const [lang] = useLang();
  const { plan, rig, setActiveLegIndex } = useActivePlan();
  const [active, setActive] = useState(false);
  const [fix, setFix] = useState<GpsFix | null>(null);
  // Snapshot of Date.now() taken when `fix` arrived (in the event handler
  // below), not read fresh at render time: projectedEtaMs's drift must
  // reflect the fix's own arrival time, not whatever moment an unrelated
  // re-render (e.g. a language toggle) happens to execute — and reading
  // Date.now() during render is impure besides.
  const [fixAtMs, setFixAtMs] = useState<number | null>(null);
  const [hintVisible, setHintVisible] = useState(false);

  const result = plan && rig ? activeRigResult(plan, rig) : null;
  const legs = result?.legs ?? [];

  // Both 'denied' and 'unavailable' get the identical treatment (spec §4:
  // "App fully usable, no boat marker; hint shown once") — a zero-arg
  // handler passed directly as watchPosition's onError, rather than a
  // callback with an unused error-kind parameter. Shown once, ever, marked
  // the moment it's displayed (not on dismiss), so a remount before the user
  // dismisses it doesn't show it again.
  const markGpsHintShownOnce = () => {
    if (safeGetItem(GPS_HINT_STORAGE_KEY) !== '1') {
      safeSetItem(GPS_HINT_STORAGE_KEY, '1');
      setHintVisible(true);
    }
  };

  useEffect(() => {
    if (!active || legs.length === 0) return;
    return watchPosition((f) => {
      setFix(f);
      setFixAtMs(Date.now());
    }, markGpsHintShownOnce);
  }, [active, legs.length, watchPosition]);

  const legIdx = fix && legs.length > 0 ? computeActiveLegIndex(legs, fix.point) : null;

  useEffect(() => {
    setActiveLegIndex(legIdx);
  }, [legIdx, setActiveLegIndex]);

  useEffect(() => {
    return () => setActiveLegIndex(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only reset, not on every setActiveLegIndex identity change
  }, []);

  if (!result || legs.length === 0) {
    const noPlan = <p className="live-view-no-plan">{t('live.noPlan')}</p>;
    return panelSlot ? createPortal(noPlan, panelSlot) : noPlan;
  }

  const hts = fix && legIdx !== null ? headingToSteerDeg(legs, legIdx, fix.point) : null;
  const nextEvent =
    fix && legIdx !== null ? distanceToNextManeuverNm(legs, legIdx, fix.point) : null;
  const etaMs =
    fix && legIdx !== null && fixAtMs !== null
      ? projectedEtaMs(legs, legIdx, fix.point, fixAtMs)
      : null;
  const driftMs = etaMs !== null ? etaMs - legs[legs.length - 1].endTimeMs : null;

  // One gate shared by the readout data block and the BoatMarker sibling below:
  // both render exactly when there is a fix with a computable heading-to-steer,
  // so they must never drift apart (a marker without a readout, or vice versa).
  // Bundling the narrowed non-null values keeps that single check type-safe for
  // both consumers.
  const steerable = fix !== null && hts !== null ? { fix, hts } : null;

  const toggleActive = () => {
    const next = !active;
    setActive(next);
    // A stale fix from a previous tracking session must not linger once
    // it's switched off.
    if (!next) {
      setFix(null);
      setFixAtMs(null);
    }
  };

  const readout = (
    <div className="live-view">
      <button type="button" aria-pressed={active} onClick={toggleActive}>
        {t('live.toggle')}
      </button>

      {hintVisible && (
        <div role="status" className="live-view-gps-hint">
          <p>{t('live.gpsHint')}</p>
          <button type="button" onClick={() => setHintVisible(false)}>
            {t('live.gpsHint.dismiss')}
          </button>
        </div>
      )}

      {steerable && (
        <div className="live-view-data">
          <div className="live-view-hts">
            <span className="live-view-label">{t('live.hts.label')}</span>
            <span className="live-view-hts-value">{formatHeading(steerable.hts)}</span>
          </div>

          <dl className="live-view-cogsog">
            <dt>{t('live.cog.label')}</dt>
            <dd>{steerable.fix.cogDeg !== null ? formatHeading(steerable.fix.cogDeg) : '—'}</dd>
            <dt>{t('live.sog.label')}</dt>
            <dd>{steerable.fix.sogKn !== null ? formatKn(steerable.fix.sogKn) : '—'}</dd>
          </dl>

          <p className="live-view-next-event">
            {nextEvent
              ? `${t('live.nextEvent.label', { distance: formatNm(nextEvent.distNm) })} ${t(
                  nextEvent.kind === 'motor-start'
                    ? 'live.nextEvent.motorStart'
                    : MANEUVER_LABEL_KEY[nextEvent.kind],
                )}`
              : t('live.nextEvent.none')}
          </p>

          <p className="live-view-eta">
            {t('live.eta.label')}: {etaMs !== null ? formatTime(etaMs, lang) : '—'}
            {driftMs !== null && ` (${formatDriftMin(driftMs)})`}
          </p>
        </div>
      )}
    </div>
  );

  // The readout is portaled into the panel column on wide (#31); BoatMarker is
  // rendered as a sibling — always inline in MapView's subtree, never portaled
  // — so a narrow<->wide switch never remounts the imperative map marker.
  //
  // The readout DOM, by contrast, is intentionally NOT remount-stable across
  // that switch: the fragment's first child alternates between a portal node
  // and a plain element (different node types to the reconciler), so crossing
  // the 1024px breakpoint while Live is active unmounts and recreates the
  // readout. Component state survives (it lives in this component, above the
  // return); transient DOM state does not — keyboard focus on the toggle falls
  // back to <body>, and any scroll position resets. Accepted: a breakpoint
  // crossing is a deliberate, rare window/orientation change, not a mid-
  // interaction event, and the readout holds no text entry or long scroll worth
  // preserving. Restoring focus in a panelSlot-keyed effect was considered and
  // rejected as focus-stealing for no real benefit here.
  return (
    <>
      {panelSlot ? createPortal(readout, panelSlot) : readout}
      {steerable && (
        <BoatMarker
          point={steerable.fix.point}
          cogDeg={steerable.fix.cogDeg}
          headingToSteerDeg={steerable.hts}
          accuracyM={steerable.fix.accuracyM}
        />
      )}
    </>
  );
}
