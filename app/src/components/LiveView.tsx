import { useEffect, useState } from 'react';
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
import { watchPosition as realWatchPosition, type GpsFix } from '../services/geolocation';
import BoatMarker from './BoatMarker';
import type { ManeuverKind } from '../types';

export interface LiveViewDeps {
  watchPosition?: typeof realWatchPosition;
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
export default function LiveView({ watchPosition = realWatchPosition }: LiveViewDeps = {}) {
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
    if (localStorage.getItem(GPS_HINT_STORAGE_KEY) !== '1') {
      localStorage.setItem(GPS_HINT_STORAGE_KEY, '1');
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
    return <p className="live-view-no-plan">{t('live.noPlan')}</p>;
  }

  const hts = fix && legIdx !== null ? headingToSteerDeg(legs, legIdx, fix.point) : null;
  const nextEvent = fix && legIdx !== null ? distanceToNextManeuverNm(legs, legIdx, fix.point) : null;
  const etaMs =
    fix && legIdx !== null && fixAtMs !== null ? projectedEtaMs(legs, legIdx, fix.point, fixAtMs) : null;
  const driftMs = etaMs !== null ? etaMs - legs[legs.length - 1].endTimeMs : null;

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

  return (
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

      {fix && hts !== null && (
        <div className="live-view-data">
          <div className="live-view-hts">
            <span className="live-view-label">{t('live.hts.label')}</span>
            <span className="live-view-hts-value">{formatHeading(hts)}</span>
          </div>

          <dl className="live-view-cogsog">
            <dt>{t('live.cog.label')}</dt>
            <dd>{fix.cogDeg !== null ? formatHeading(fix.cogDeg) : '—'}</dd>
            <dt>{t('live.sog.label')}</dt>
            <dd>{fix.sogKn !== null ? formatKn(fix.sogKn) : '—'}</dd>
          </dl>

          <p className="live-view-next-event">
            {nextEvent
              ? `${t('live.nextEvent.label', { distance: formatNm(nextEvent.distNm) })} ${t(
                  nextEvent.kind === 'motor-start' ? 'live.nextEvent.motorStart' : MANEUVER_LABEL_KEY[nextEvent.kind],
                )}`
              : t('live.nextEvent.none')}
          </p>

          <p className="live-view-eta">
            {t('live.eta.label')}: {etaMs !== null ? formatTime(etaMs, lang) : '—'}
            {driftMs !== null && ` (${formatDriftMin(driftMs)})`}
          </p>

          <BoatMarker point={fix.point} cogDeg={fix.cogDeg} headingToSteerDeg={hts} accuracyM={fix.accuracyM} />
        </div>
      )}
    </div>
  );
}
