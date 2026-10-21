import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { formatDepthM } from '../lib/depthDisclosure';
import {
  formatDriftMin,
  formatHeading,
  formatKn,
  formatLatLon,
  formatNm,
  formatTime,
} from '../lib/format';
import { harborHandoverLines } from '../lib/harborHandover';
import { safeGetItem, safeSetItem } from '../lib/storage';
import { usePersistedToggle } from '../lib/usePersistedToggle';
import type { GpsSource } from '../state/useGpsSource';
import { useWakeLock } from '../state/useWakeLock';
import { isLiveSimRequested } from '../dev/liveSimulator';
import LiveSimulatorControls from '../dev/LiveSimulatorControls';
import { liveSimDict } from '../dev/LiveSimulatorControls.dict';
import Button from './Button';
import Chip from './Chip';
import type { LatLon, Leg, ManeuverKind } from '../types';

// #143: dev/UAT-only Live-view simulator gate — mirrors App.tsx's
// `__SC_UAT__ ?` pattern (see its comment for why `&&` alone leaves a
// residue in a JSX child slot). `simActive` must be the LEADING term of any
// `||`/ternary it joins, and REPLACES an existing render value rather than
// joining a new children-array sibling. Unlike an earlier version of this
// gate, the literal `import.meta.env.DEV || __SC_UAT__` expression is
// deliberately NOT hoisted into a shared module-level const: once a shared
// const is read from enough distinct call sites the minifier keeps it as a
// real `var` instead of inlining the literal at every site (measured on the
// PR that added this comment). Each of `simActive`'s two computation sites
// below (this component, and the route-feed effect) therefore re-states the
// literal expression itself, so each one folds to `false` independently in
// production and neither call site depends on a shared identifier's use
// count elsewhere in the file.

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
  // #1800: the GPS source App.tsx shares with the boat marker. Live no longer
  // owns a watch; it reports whether tracking is active via onTrackingChange.
  gps: GpsSource;
  onTrackingChange?: (active: boolean) => void;
  // #31: when set (wide layout), the textual readout renders into this
  // panel-column slot via a portal instead of rendering inline in MapView's
  // subtree (the base bottom-sheet-region card). Null/undefined = render
  // inline (narrow, unchanged).
  panelSlot?: HTMLElement | null;
  // #115: absent (tests/contexts without the plan-flow wiring) = no reroute
  // action rendered.
  reroute?: LiveRerouteControls | null;
}

// Set when the user starts tracking, cleared only by an explicit Stop, so a
// reload, crash, app kill or tab switch leaves the resume prompt behind.
const WAS_TRACKING_KEY = 'sc-live-was-tracking';
const WAKE_LOCK_KEY = 'sc-live-wake-lock';

const MANEUVER_LABEL_KEY: Record<ManeuverKind, MsgKey> = {
  tack: 'route.maneuver.tack',
  gybe: 'route.maneuver.gybe',
};

// #251, spec §3.4: the depth caution is carried by text + icon + colour, so
// colour is never the sole signal (WCAG 1.4.1). Purely decorative — the note's
// own text states the hazard — hence aria-hidden, and NOT an aria-live/alert
// region (see the §3.4 note on 1 Hz re-announcement). Inline SVG rather than a
// "⚠" glyph on purpose: many platforms substitute a colour emoji for that
// codepoint, which ignores `color` and would break the colour signal in dark
// mode; `fill: currentColor` inherits --sc-depth-warning-text in both themes.
function WarningIcon() {
  return (
    <svg
      className="live-view-hts-note-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      {/* evenodd so the bar and dot subpaths punch OUT of the triangle
          instead of being filled in the same colour (nonzero would render a
          solid triangle with no readable mark). */}
      <path
        fillRule="evenodd"
        d="M8 1.5 15 14H1L8 1.5ZM7.25 6h1.5v4h-1.5V6Zm-.1 5.3h1.7V13h-1.7v-1.7Z"
      />
    </svg>
  );
}

// GPS fixes stay out of AppState (see its docstring: 1 Hz updates must not
// re-render the whole app); they arrive via the `gps` prop. Only the
// much-lower-frequency derived activeLegIndex is pushed up, for RouteLayer's
// highlight.
export default function LiveView({ gps, onTrackingChange, panelSlot, reroute }: LiveViewProps) {
  const t = useT();
  const [lang] = useLang();
  const { plan, rig, setActiveLegIndex } = useActivePlan();
  const [active, setActive] = useState(false);
  const [wasTracking, setWasTracking] = useState(() => safeGetItem(WAS_TRACKING_KEY) === '1');
  const [wakeLockOn, setWakeLockOn] = usePersistedToggle(WAKE_LOCK_KEY, true);
  const wakeLock = useWakeLock(active && wakeLockOn);
  // Readouts show only while tracking is on and the fix is usable: a fix
  // cached from the ownship watch, or a lost/denied one, must not read as live.
  const usable = active && (gps.state === 'fresh' || gps.state === 'stale');
  const stale = active && gps.state === 'stale';
  const fix = usable ? gps.fix : null;
  // Receipt time of `fix` (not render time): projectedEtaMs's drift must
  // reflect when the fix arrived.
  const fixAtMs = usable ? gps.fixAtMs : null;

  useEffect(() => {
    onTrackingChange?.(active);
    return () => onTrackingChange?.(false);
  }, [active, onTrackingChange]);

  const result = plan && rig ? activeRigResult(plan, rig) : null;
  const legs = result?.legs ?? [];

  // #143: whether the simulator is actually driving THIS session's fix, not
  // merely whether the gate is open. Read once per render, not memoised —
  // the query string is static for a page's lifetime here.
  const simActive = (import.meta.env.DEV || __SC_UAT__) && isLiveSimRequested();

  // #1486 review: `legs` feeds the simulator's route-following (see
  // LiveSimulatorControls.tsx) so 'track'/'drift' move along the ACTIVE
  // plan rather than a synthetic loop — wired as a PROP into
  // `<LiveSimulatorControls>` at this component's single `simActive`
  // ternary site (below), never via a standalone effect here: an effect
  // declared in THIS component would be an unconditional hook call present
  // in every build, where `<LiveSimulatorControls>` itself is a whole
  // subtree that dead-code-eliminates out of the prod bundle when
  // `simActive` folds to `false` (see the module comment above).

  // #251: heading-to-steer depth check. useNavMask is a hook and must run on
  // every render, so it (and the rest of this block) lives here — BEFORE the
  // early "no plan" return below — rather than after it (a call site a
  // conditional return can skip breaks the Rules of Hooks: mounting with no
  // plan, then getting one, would render a different number of hooks across
  // renders).
  const mask = useNavMask();
  // #632: migratePlan.ts's migrateRequest never validates the stored
  // plan's `settings` field (`grep -c settings
  // app/src/services/migratePlan.ts` -> 0), so a record saved before that
  // field existed migrates with `settings` missing rather than rejected —
  // and reading its safety depth unguarded threw `TypeError: Cannot read
  // properties of undefined` the instant the Live tab mounted such a
  // plan. With no error boundary anywhere in app/src, that blanked the
  // whole app.
  //
  // Unlike the sibling presentation-only sites (App.tsx, RouteSummary.tsx)
  // that fall back to a fixed default safety depth when this field is
  // missing, this value feeds foldProbe's own
  // `idx !== null && safetyNow !== null` gate (~:209) -> checkHeadingDepth,
  // the on-water hazard path: fabricating a plausible-looking depth here
  // would render a confident caution verdict against a value the user
  // never actually chose — a wrong number is worse than an absent one on
  // this surface. Per the maintainer's own triage ruling this fails to
  // `null` instead, which already flows through that gate to the honest
  // 'unavailable' -> "Depth not checked" state. Do NOT gate whether the
  // caution note RENDERS on `safetyDepthM !== null` — see the `!plan`
  // comment below: a guard that can suppress the note is the same false
  // all-clear. (Gating the interpolated NUMBER is a different thing and is
  // fine; see the `safety:` interpolation in the caution note, ~:409.)
  //
  // `typeof … === 'number' && Number.isFinite(…) && … > 0` — plain
  // `Number.isFinite` ALONE is not enough: it admits `0`, `-0` and
  // NEGATIVE numbers, and `checkHeadingDepth` treats a non-positive
  // threshold as "nothing is shallower than this" — measured against the
  // real NavMask/checkHeadingDepth with an all-LAND grid: threshold 3
  // correctly reports `caution/land`, but 0, -0 and -5 ALL report
  // `{state: 'clear'}`. `'clear'` renders NO NOTE AT ALL, which is a
  // NOTE-LESS FALSE ALL-CLEAR — strictly worse than the NaN crash this
  // guard already caught, because a crash is loud and a silent all-clear on
  // the on-water path is not (see the `depthCheck` comment below on why a
  // note-less heading must never be mistaken for "checked, and clear").
  //
  // The leading `typeof … === 'number'` term is there for TYPE NARROWING,
  // not for an extra value class: `Number.isFinite` coerces nothing and is
  // already `false` for every non-number (measured: '3.0', null, undefined,
  // true, {}, [], [3], new Number(3) — all false). What `typeof` buys is
  // narrowing `number | undefined` for every later term in this chain, so
  // `> 0` typechecks and no `as number` cast is needed.
  const req = plan?.request;
  const rawSafetyDepthM = req?.settings?.safetyDepthM;
  const safetyDepthM =
    typeof rawSafetyDepthM === 'number' && Number.isFinite(rawSafetyDepthM) && rawSafetyDepthM > 0
      ? rawSafetyDepthM
      : null;
  const holdKey = `${plan?.id ?? ''}:${rig ?? ''}`;

  // Asymmetric hysteresis: engages instantly, drops only after a sustained
  // clear run. Folded by the gated effect below.
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

  // Ref mirror of the latest mask/legs/safetyDepthM/holdKey, written only in
  // an effect (post-commit), never during render.
  const latestRef = useRef({ mask, legs, safetyDepthM, holdKey });
  useEffect(() => {
    latestRef.current = { mask, legs, safetyDepthM, holdKey };
  });

  // What the displayed hold was last folded against. A null mask is a real
  // value (a fold that ran with no mask); the "nothing folded yet" sentinel is
  // the null KEY, which no holdKey can equal.
  const probedRef = useRef<{ fix: unknown; mask: NavMask | null; key: string | null }>({
    fix: null,
    mask: null,
    key: null,
  });

  // Folds once per distinct (fix, mask, holdKey): a new fix, the mask arriving
  // after the last fix, or a plan/rig change (which resets the hysteresis by
  // design, spec §3.2) must each re-probe from the fix already held, else
  // "Depth not checked" would stay stale while fixes have stopped. The
  // setState is reachable only past the guarded early returns and the ref
  // gate, which keeps it clear of react-hooks/set-state-in-effect. The ref is
  // written here, never during render; legs/safetyDepthM come from the
  // latestRef mirror whose effect is declared above this one.
  useEffect(() => {
    if (fix === null) return;
    const probed = probedRef.current;
    if (probed.fix === fix && probed.mask === mask && probed.key === holdKey) return;
    probedRef.current = { fix, mask, key: holdKey };
    const cur = latestRef.current;
    foldProbe(mask, cur.legs, cur.safetyDepthM, holdKey, fix.point);
  }, [mask, fix, holdKey]);

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

  // Narrow layout: the card is docked in the map area while the bottom sheet
  // (tab strip plus whatever panel content sits under it, e.g. the AIS list)
  // is a sibling of unknown height. Dock above the sheet's measured top so the
  // sheet never covers the card.
  // The CSS fallback clears the tab strip plus a typical collapsed AIS row if this never runs.
  const cardRef = useRef<HTMLDivElement>(null);
  const cardMounted = Boolean(plan && result && legs.length > 0);
  useLayoutEffect(() => {
    const card = cardRef.current;
    const sheet = document.querySelector<HTMLElement>('.app-bottom-sheet');
    if (!card || !sheet || panelSlot || typeof ResizeObserver === 'undefined') return;
    const sync = () => card.style.setProperty('--live-sheet-h', `${sheet.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(sheet);
    return () => {
      observer.disconnect();
      card.style.removeProperty('--live-sheet-h');
    };
  }, [panelSlot, cardMounted]);

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
  // which renders in ANY map context, Live View included. The shared `gps`
  // source feeds both that marker and the readout data here (HTS/COG/SOG,
  // next maneuver, ETA); this component renders no marker, so a
  // toggle-on-while-Live-active session never shows two.
  const steerable = fix !== null && hts !== null ? { fix, hts } : null;

  const startTracking = () => {
    safeSetItem(WAS_TRACKING_KEY, '1');
    setWasTracking(true);
    setActive(true);
  };
  const stopTracking = () => {
    safeSetItem(WAS_TRACKING_KEY, '0');
    setWasTracking(false);
    setActive(false);
  };
  const toggleActive = active ? stopTracking : startTracking;

  const handover = harborHandoverLines(plan).length > 0;

  const rr = gps.reroute;
  const rerouteReason = (): string => {
    if (simActive) return liveSimDict[lang]['liveSim.reroute.disabled'];
    if (!active) return t('live.reroute.needFix');
    switch (rr.reason) {
      case 'waiting':
        return t('live.reroute.reason.waiting');
      case 'lost':
        return t('live.reroute.reason.lost');
      case 'denied':
        return t('live.reroute.reason.denied');
      case 'accuracy':
        return t('live.reroute.reason.accuracy', {
          accuracy: rr.accuracyM !== null ? String(Math.round(rr.accuracyM)) : '—',
          threshold: String(rr.thresholdM),
        });
      case null:
        return t('live.reroute.hint');
    }
  };

  const readout = (
    <div className="live-view" ref={cardRef}>
      {/* #700: the sighted equivalent of aria-pressed — routed through the
          Button primitive so the pressed/on state reuses the SAME accent
          fill `.app-tabs button[aria-selected='true']`/`.rig-tabs` already
          use, rather than a new `[aria-pressed]` CSS rule. */}
      <Button
        variant={active ? 'primary' : 'secondary'}
        aria-pressed={active}
        onClick={toggleActive}
      >
        {active ? t('live.toggle.stop') : t('live.toggle')}
      </Button>

      {!active && wasTracking && (
        <div role="status" className="live-view-resume">
          <p>{t('live.resume.message')}</p>
          <Button variant="primary" onClick={startTracking}>
            {t('live.resume.action')}
          </Button>
        </div>
      )}

      {handover && <p className="live-view-handover">{t('live.handover')}</p>}

      {active && gps.state === 'waiting' && (
        <p role="status" className="live-view-gps live-view-gps--waiting">
          {t('live.gps.waiting')}
        </p>
      )}
      {stale && (
        <Chip role="status" className="live-view-gps-stale">
          <span aria-hidden="true">{t('live.gps.stale', { age: gps.ageS ?? 0 })}</span>
          <span className="sr-only">{t('live.gps.stale.announce')}</span>
        </Chip>
      )}
      {active && gps.state === 'lost' && (
        <div role="status" className="live-view-gps live-view-gps--lost">
          <p className="live-view-gps-title">{t('live.gps.lost')}</p>
          {gps.fix !== null && gps.fixAtMs !== null && (
            <p>
              {t('live.gps.lost.last', {
                time: formatTime(gps.fixAtMs, lang),
                position: formatLatLon(gps.fix.point),
              })}
            </p>
          )}
        </div>
      )}
      {active && gps.state === 'denied' && (
        <div role="status" className="live-view-gps live-view-gps--denied">
          <p className="live-view-gps-title">{t('live.gps.denied')}</p>
          <p>{t('live.gps.denied.hint')}</p>
        </div>
      )}

      {!wakeLock.supported ? (
        <p className="live-view-wake">{t('live.wake.unsupported')}</p>
      ) : (
        <div className="live-view-wake">
          <label>
            <input
              type="checkbox"
              checked={wakeLockOn}
              onChange={(e) => setWakeLockOn(e.target.checked)}
            />
            {t('live.wake.toggle')}
          </label>
          {active && (
            <p role="status" className="live-view-wake-status">
              {!wakeLockOn
                ? t('live.wake.off')
                : wakeLock.held
                  ? t('live.wake.held')
                  : t('live.wake.notHeld')}
            </p>
          )}
        </div>
      )}

      {/* Stays mounted through lost and denied once a fix has arrived: RouteLayer's
          auto-fit latch reads its presence as "Live is active". */}
      {(steerable !== null || (active && gps.fix !== null)) && (
        <div className={stale ? 'live-view-data live-view-data--stale' : 'live-view-data'}>
          {steerable && (
            <>
              <div
                className={
                  depthCheck.state === 'caution'
                    ? 'live-view-hts live-view-hts--caution'
                    : 'live-view-hts'
                }
              >
                <span className="live-view-label">
                  {t('live.hts.label')}
                  {/* #713: German's label is already the full word 'Steuerkurs'
                  — only the bare English abbreviation needs an expansion, so
                  this is gated on lang rather than rendered unconditionally
                  with an unused German value. */}
                  {lang === 'en' && <span className="sr-only"> {t('live.hts.expansion')}</span>}
                </span>
                <span className="live-view-hts-value tabular-nums">
                  {formatHeading(steerable.hts)}
                </span>
              </div>
              {depthCheck.state === 'caution' && (
                <p className="live-view-hts-note live-view-hts-note--caution">
                  <WarningIcon />
                  {depthCheck.hazard === 'land'
                    ? t('live.hts.landCaution')
                    : t('live.hts.depthCaution', {
                        // #596: through formatDepthM, not a bare `toFixed(1)` —
                        // same locale-aware one-decimal form the sibling
                        // route-level shallow banner uses for both of its depths
                        // (RouteSummary.tsx), so the two depth warnings never
                        // render the same number differently, IN EITHER
                        // language (a bare `toFixed(1)` here would have left
                        // this sentence point-formatted after RouteSummary's own
                        // switched to comma-formatted German).
                        depth: formatDepthM(depthCheck.shallowestM, lang),
                        // #632: consumes the SAME guarded `safetyDepthM` local
                        // computed above, never a fresh unguarded read.
                        // Invariant: `depthCheck.state` can only reach
                        // 'caution' through foldProbe's
                        // `idx !== null && safetyNow !== null` gate (~:209),
                        // and `safetyDepthM` is a stable function of the same
                        // `plan` for the life of this `holdKey` — so the em-dash
                        // branch below is provably unreachable. Narrowed this
                        // way (not `!`, which would be the first production
                        // non-null assertion in app/src/components/) purely to
                        // satisfy TypeScript. Uses the same em-dash placeholder
                        // as the COG/SOG fields below (`'—'`, not `''`) for
                        // consistency with this file's existing missing-value
                        // convention — an unreachable empty string would still
                        // render as "…your safety depth ( m)", a malformed
                        // sentence, if this invariant were ever violated.
                        safety: safetyDepthM !== null ? formatDepthM(safetyDepthM, lang) : '—',
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
                <dd className="tabular-nums">
                  {steerable.fix.cogDeg !== null ? formatHeading(steerable.fix.cogDeg) : '—'}
                </dd>
                <dt>{t('live.sog.label')}</dt>
                <dd className="tabular-nums">
                  {steerable.fix.sogKn !== null ? formatKn(steerable.fix.sogKn, lang) : '—'}
                </dd>
              </dl>

              <p className="live-view-next-event">
                {nextEvent
                  ? `${t('live.nextEvent.label', { distance: formatNm(nextEvent.distNm, lang) })} ${t(
                      nextEvent.kind === 'motor-start'
                        ? 'live.nextEvent.motorStart'
                        : MANEUVER_LABEL_KEY[nextEvent.kind],
                    )}`
                  : t('live.nextEvent.none')}
              </p>

              <p className="live-view-eta tabular-nums">
                {t('live.eta.label')}: {etaMs !== null ? formatTime(etaMs, lang) : '—'}
                {driftMs !== null && ` (${formatDriftMin(driftMs)})`}
              </p>
            </>
          )}
        </div>
      )}

      {/* #115 manual "reroute from here" — an explicit user action producing
          a NEW routed plan (App.tsx wires it to useLiveReroute); only
          meaningful with a current GPS fix, so it is disabled (with an i18n
          hint) until tracking is on and a fix has arrived. It never starts
          GPS itself.

          #143: ALSO disabled while the simulator is driving this session's
          fix — spike docs/spikes/749-live-view-demo-mode.md §7.2
          precondition 2, shape 1: a synthetic fix must never reach
          savePlan, and disabling the action here (rather than substituting
          a no-op/throwing writer, §2.1's rejected shape 3) keeps the UI
          HONEST at the point of the action instead of lying at the point of
          the result. */}
      {reroute && (
        <div className="live-view-reroute">
          <Button
            variant="secondary"
            disabled={simActive || fix === null || !rr.allowed || reroute.busy}
            aria-busy={reroute.rerouting}
            aria-describedby="live-reroute-reason"
            onClick={() => {
              if (fix) reroute.onReroute(fix.point);
            }}
          >
            {reroute.rerouting ? t('live.reroute.busy') : t('live.reroute.action')}
          </Button>
          <p id="live-reroute-reason" className="live-view-reroute-hint">
            {rerouteReason()}
          </p>
        </div>
      )}
    </div>
  );

  // #143: REPLACES the value below (readout -> withSim), never adds a new
  // sibling into `readout`'s own children array — measured: appending
  // `{simActive ? <LiveSimulatorControls /> : null}` as one more array
  // element there left a small residue in the prod entry chunk even fully
  // folded (a `null` placeholder still occupies that array slot); wrapping
  // at this single return-value site, the same shape App.tsx's h1 title
  // slot uses, folds to `readout` with zero diff (see the module comment
  // above `simActive`'s declaration).
  const withSim = simActive ? (
    <>
      {readout}
      <LiveSimulatorControls legs={legs} />
    </>
  ) : (
    readout
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
  return panelSlot ? createPortal(withSim, panelSlot) : withSim;
}
