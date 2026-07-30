import { useEffect, useRef, useState } from 'react';
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
import {
  advanceHold,
  checkHeadingDepth,
  initialHold,
  type HeadingDepthCheck,
  type HeadingDepthHold,
} from '../lib/headingDepth';
import type { NavMask } from '../lib/mask';
import { useNavMask } from '../state/useNavMask';
import { formatDriftMin, formatHeading, formatKn, formatNm, formatTime } from '../lib/format';
import { claimGpsHintOnce } from '../lib/gpsHint';
import { watchPosition as realWatchPosition, type GpsFix } from '../services/geolocation';
import Button from './Button';
import type { LatLon, Leg, ManeuverKind } from '../types';

// #115 manual "reroute from here": wiring provided by App.tsx (which owns the
// useLiveReroute hook — it needs usePlanFlow's ensureClient). `busy` disables
// the action while ANY solver run is in flight (shared client, no overlapping
// runs regardless of which surface starts one); `rerouting` is true only for
// this action's own in-flight solve (drives the busy label). The action stays
// an explicit user decision — lib/live.ts's projection math never re-routes
// (spec §2).
export interface LiveRerouteControls {
  busy: boolean;
  rerouting: boolean;
  onReroute: (fixPoint: LatLon) => void;
}

export interface LiveViewProps {
  watchPosition?: typeof realWatchPosition;
  // #31: when set (wide layout), the textual readout renders into this
  // panel-column slot via a portal instead of rendering inline in MapView's
  // subtree (the base bottom-sheet-region card). Null/undefined = render
  // inline (narrow, unchanged).
  panelSlot?: HTMLElement | null;
  // #115: absent (tests/contexts without the plan-flow wiring) = no reroute
  // action rendered.
  reroute?: LiveRerouteControls | null;
}

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
  reroute,
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
    if (claimGpsHintOnce()) setHintVisible(true);
  };

  // #251: heading-to-steer depth check. useNavMask is a hook and must run on
  // every render, so it (and the rest of this block) lives here — BEFORE the
  // early "no plan" return below — rather than after it (a call site a
  // conditional return can skip breaks the Rules of Hooks: mounting with no
  // plan, then getting one, would render a different number of hooks across
  // renders).
  const mask = useNavMask();
  const safetyDepthM = plan?.request.settings.safetyDepthM ?? null;
  const holdKey = `${plan?.id ?? ''}:${rig ?? ''}`;

  // Asymmetric hysteresis: engages instantly, drops only after a sustained
  // clear run. Folded on each REAL GPS fix, inside the watchPosition
  // callback below, NOT via an effect reacting to every derived-state change
  // — this project's lint config (eslint-plugin-react-hooks's React Compiler
  // rules) rejects both mutating a ref during render and calling a useState
  // setter UNCONDITIONALLY in a plain effect body ("can trigger cascading
  // renders"). Folding inside the same imperative callback that already
  // sets fix/fixAtMs sidesteps both restrictions — it is an event handler,
  // not a render-phase or bare-effect write. (The one exception is the
  // mask-arrival re-probe below, which is guarded to fire at most once per
  // mask identity and passes the rule on that basis — verified against the
  // installed eslint-plugin-react-hooks@7, not assumed.)
  const [hold, setHold] = useState<{ hold: HeadingDepthHold; key: string }>({
    hold: initialHold(),
    key: holdKey,
  });

  // Folding one probe observation into the hysteresis, shared by the fix
  // callback and the mask-arrival re-probe below. `nowMs` is
  // performance.now(), NOT Date.now(): the clear-timer must not be able to
  // bank a forward wall-clock jump, which would drop a caution early (see
  // HEADING_DEPTH_CLEAR_MS). Date.now() is still what `fixAtMs` records —
  // the ETA projection genuinely wants wall-clock time.
  const foldProbe = (
    maskNow: NavMask | null,
    legsNow: Leg[],
    safetyNow: number | null,
    keyNow: string,
    point: LatLon,
  ) => {
    const idx = legsNow.length > 0 ? computeActiveLegIndex(legsNow, point) : null;
    const raw =
      idx !== null && safetyNow !== null
        ? checkHeadingDepth(maskNow, legsNow, idx, point, safetyNow)
        : null;
    const nowMs = performance.now();
    setHold((prev) => {
      const base = prev.key === keyNow ? prev.hold : initialHold();
      return { hold: raw ? advanceHold(base, raw, nowMs) : base, key: keyNow };
    });
  };

  // Keeps a ref mirror of everything the fix callback needs, so that
  // long-lived callback (recreated only when [active, legs.length,
  // watchPosition] change, not on every render) always reads the LATEST
  // mask/legs/safetyDepthM/holdKey rather than a stale closure. Written only
  // inside an effect (post-commit) — never assigned during render.
  const latestRef = useRef({ mask, legs, safetyDepthM, holdKey });
  useEffect(() => {
    latestRef.current = { mask, legs, safetyDepthM, holdKey };
  });

  // Which mask identity the displayed hold was last folded against. Written
  // from the fix callback and the re-probe effect below (both post-render), so
  // the effect can tell "already probed with this mask" from "the mask only
  // just arrived". null is a real value here — it records a fold that ran with
  // no mask at all.
  const probedMaskRef = useRef<NavMask | null>(null);

  useEffect(() => {
    if (!active || legs.length === 0) return;
    return watchPosition((f) => {
      setFix(f);
      setFixAtMs(Date.now());

      const cur = latestRef.current;
      probedMaskRef.current = cur.mask;
      foldProbe(cur.mask, cur.legs, cur.safetyDepthM, cur.holdKey, f.point);
    }, markGpsHintShownOnce);
  }, [active, legs.length, watchPosition]);

  // The probe otherwise runs only inside the fix callback above, so a mask
  // that resolves AFTER the last fix — a slow first load, or simply GPS having
  // gone quiet — would pin the readout at "Depth not checked" indefinitely
  // even though the bearing is now checkable. Re-fold once per mask identity
  // whenever a fix is already held.
  //
  // Shape matters: the setState is reachable only past two guarded early
  // returns and the once-per-mask ref gate, which is what keeps it clear of
  // react-hooks/set-state-in-effect (an UNCONDITIONAL setState in an effect
  // body is what that rule rejects; verified against the installed plugin).
  // The ref is written here in the effect, never during render.
  useEffect(() => {
    if (mask === null || fix === null) return;
    if (probedMaskRef.current === mask) return;
    probedMaskRef.current = mask;
    // Same latestRef mirror the fix callback reads, for the same reason and
    // with the same guarantee: the effect that writes it is declared above
    // this one, so it has already committed this render's values.
    const cur = latestRef.current;
    foldProbe(cur.mask, cur.legs, cur.safetyDepthM, cur.holdKey, fix.point);
  }, [mask, fix]);

  const legIdx = fix && legs.length > 0 ? computeActiveLegIndex(legs, fix.point) : null;

  useEffect(() => {
    setActiveLegIndex(legIdx);
  }, [legIdx, setActiveLegIndex]);

  useEffect(() => {
    return () => setActiveLegIndex(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only reset, not on every setActiveLegIndex identity change
  }, []);

  // Gated on hold.key matching the CURRENT holdKey: between a plan/rig change
  // and the next real GPS fix folding a fresh observation, the stale caution
  // from the superseded route must not be shown (#158 convention — a caution
  // must not survive a reroute).
  //
  // The reset lands on an explicit 'unavailable', NEVER on "render no note":
  // a note-less heading is DOM-identical to a checked-and-clear one, so an
  // absent note reads as "checked, and clear" — the exact false all-clear this
  // feature exists to prevent, and permanent if fixes have stopped. Spec §4:
  // every degraded path lands on a RENDERED state.
  const depthCheck: HeadingDepthCheck =
    hold.key === holdKey ? hold.hold.shown : { state: 'unavailable' };

  // `!plan` is redundant with `!result` (result is derived from plan) — it is
  // here purely so TypeScript narrows `plan` for the caution note below, which
  // must render its safety depth WITHOUT a `safetyDepthM !== null` guard: a
  // guard that can suppress the note is the same false all-clear as above.
  if (!plan || !result || legs.length === 0) {
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

  // Gates the readout data block: renders exactly when there is a fix with a
  // computable heading-to-steer. Bundling the narrowed non-null values keeps
  // that check type-safe for its one remaining consumer below.
  //
  // #25 addendum: the boat marker itself no longer renders here — it moved to
  // the standalone, settings-gated OwnshipMarker (App.tsx/useOwnshipGps.ts),
  // which renders in ANY map context, Live View included. This component's
  // own GPS watch (above) still exists for the readout data (HTS/COG/SOG,
  // next maneuver, ETA) and the shared active-leg index, which stay
  // plan-gated and unchanged; only the marker rendering was decoupled, and
  // decoupling it here (rather than leaving a second copy) is what keeps a
  // toggle-on-while-Live-active session from ever showing two markers.
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
          <div
            className={
              depthCheck.state === 'caution'
                ? 'live-view-hts live-view-hts--caution'
                : 'live-view-hts'
            }
          >
            <span className="live-view-label">{t('live.hts.label')}</span>
            <span className="live-view-hts-value">{formatHeading(steerable.hts)}</span>
          </div>
          {depthCheck.state === 'caution' && (
            <p className="live-view-hts-note">
              {depthCheck.hazard === 'land'
                ? t('live.hts.landCaution')
                : t('live.hts.depthCaution', {
                    depth: depthCheck.shallowestM.toFixed(1),
                    // Same one-decimal form the sibling route-level shallow
                    // banner uses for both of its depths (RouteSummary.tsx),
                    // so the two depth warnings never render the same number
                    // differently.
                    safety: plan.request.settings.safetyDepthM.toFixed(1),
                  })}
            </p>
          )}
          {depthCheck.state === 'unavailable' && (
            <p className="live-view-hts-note live-view-hts-note--muted">
              {t('live.hts.depthUnchecked')}
            </p>
          )}

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

      {/* #115 manual "reroute from here" — an explicit user action producing
          a NEW routed plan (App.tsx wires it to useLiveReroute); only
          meaningful with a current GPS fix, so it is disabled (with an i18n
          hint) until tracking is on and a fix has arrived. It never starts
          GPS itself. */}
      {reroute && (
        <div className="live-view-reroute">
          <Button
            variant="secondary"
            disabled={fix === null || reroute.busy}
            aria-busy={reroute.rerouting}
            onClick={() => {
              if (fix) reroute.onReroute(fix.point);
            }}
          >
            {reroute.rerouting ? t('live.reroute.busy') : t('live.reroute.action')}
          </Button>
          <p className="live-view-reroute-hint">
            {fix === null ? t('live.reroute.needFix') : t('live.reroute.hint')}
          </p>
        </div>
      )}
    </div>
  );

  // The readout is portaled into the panel column on wide (#31); on narrow it
  // renders inline in MapView's subtree (the base bottom-sheet-region card).
  //
  // The readout DOM is intentionally NOT remount-stable across that switch:
  // it alternates between a portal node and a plain element (different node
  // types to the reconciler), so crossing the 1024px breakpoint while Live is
  // active unmounts and recreates it. Component state survives (it lives in
  // this component, above the return); transient DOM state does not —
  // keyboard focus on the toggle falls back to <body>, and any scroll
  // position resets. Accepted: a breakpoint crossing is a deliberate, rare
  // window/orientation change, not a mid-interaction event, and the readout
  // holds no text entry or long scroll worth preserving. Restoring focus in a
  // panelSlot-keyed effect was considered and rejected as focus-stealing for
  // no real benefit here.
  return panelSlot ? createPortal(readout, panelSlot) : readout;
}
