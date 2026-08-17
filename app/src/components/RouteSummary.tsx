import { useMemo, type Ref } from 'react';
import { useT, useLang } from '../i18n';
import { formatHeading, formatKn, formatLegDuration, formatNm, formatTime } from '../lib/format';
import { toGpx } from '../lib/gpx';
import { APPROACH_RADIUS_M } from '../lib/depthGate';
import { cautiousDepthLowerBoundM, MASK_TOLERANCE_M } from '../lib/mask';
import { activeRigResult, isStaleForecast, NO_ROUTE_MESSAGE_KEY } from '../lib/plan';
import { RIG_LABEL_KEY, resultSummary, rigRecommendationOf } from '../lib/resultSummary';
import { roundExposureNm, shallowConfinedWithinM, shallowExposureNm } from '../lib/shallowExposure';
import { useWideLayout } from '../lib/useWideLayout';
import { BOAT_DRAFT_M } from '../routing/relaxedDepth';
import { useNavMask } from '../state/useNavMask';
import { SAFETY_DEPTH_FIELD } from './OptionsPanel';
import type { MsgKey } from '../i18n/dict.de';
import type { Board, Leg, NoRouteReason, Plan, SailId, ShallowInfo } from '../types';
import Card from './Card';
import Chip from './Chip';
import Button from './Button';
import Disclosure from './Disclosure';

// #452: plan-level shallow-water warning — shared by RouteSummary (Routes
// tab, both rig tabs) and PlannerPanel's compact Ergebnis strip (the first
// surface a user sees after planning), so the copy and honesty caveats can
// never drift between the two. `shallow` is only ever present when the #53
// relaxation tier actually fired, which by construction only happens when
// usedDepthM < requestedDepthM (planRoute.ts's relaxation block only probes
// a shallower gate after the REQUESTED gate failed to connect) — so
// rendering `used` here is never redundant with `requested`.

// #452 gap 3: locator for the shared warning above — `legs` is the ACTIVE
// rig's own legs (both call sites already have `result` in hand). Returns
// null (never a "0 legs" sentence) both when no legs were passed at all
// (the active tab's own rig has no result — #452 Major 1, the plan-level
// warning still renders there) and when the relaxation fired but flagged no
// individual leg — the absent-data path must fail SAFE, i.e. silently drop
// the locator sentence rather than render a nonsensical one.
function firstShallowLeg(
  legs: Leg[] | null | undefined,
): { count: number; firstTimeMs: number } | null {
  const flagged = (legs ?? []).filter((leg) => leg.shallow);
  if (flagged.length === 0) return null;
  // Legs are chronological — the legs table below renders leg.startTimeMs
  // in plain array order with no re-sort — so the first FLAGGED array entry
  // is also the first flagged leg in time, not merely the first array entry.
  return { count: flagged.length, firstTimeMs: flagged[0].startTimeMs };
}

export function ShallowWarning({
  shallow,
  legs,
  plan,
}: {
  shallow: ShallowInfo;
  legs?: Leg[] | null;
  // #516 increment 2: only the confinement sentence needs this — snappedOrigin/
  // snappedDestination and the unsnapped request.viaPoints all live on `plan`,
  // not on `shallow` or `legs`. Both call sites already have a non-null `plan`
  // whenever `shallow` is present (RouteSummary's is a required prop;
  // PlannerPanel's guard adds an explicit `plan &&` alongside its existing
  // `shallow &&` for exactly this).
  plan: Plan;
}) {
  const t = useT();
  const [lang] = useLang();
  const locator = firstShallowLeg(legs);
  // #493/#504: the mask build's TOLERANCE_M bound (about.caveats.depthMask)
  // means the used gate's own more-cautious reading can run as low as
  // usedDepthM - MASK_TOLERANCE_M — recomputed from THIS plan's usedDepthM
  // every render, never a fixed number, so it can never go stale as
  // usedDepthM varies plan to plan.
  // #54 spec C.4(a)/C.8 R5 — BOAT-AGNOSTIC, blocked on Task 11. This compares
  // against the Salona's 2.1 m constant, not the SELECTED boat's draft. Not
  // live: BOATS holds one boat at draftM 2.1, identical to BOAT_DRAFT_M.
  // Structurally unfixable here until Task 11 puts the boat on the plan —
  // `Plan`/`PlanResult` carry none, so this component cannot reach it. Must
  // be retired before a second boat becomes user-selectable; a 2.30 m boat
  // relaxed to its correct 2.3 m gate would otherwise be judged against the
  // wrong hull. Same fix owns the rendered draft below.
  const isSevere = shallow.usedDepthM - MASK_TOLERANCE_M < BOAT_DRAFT_M;
  const containerClassName = isSevere
    ? 'shallow-warning shallow-warning--severe'
    : 'shallow-warning';
  const cautiousM = cautiousDepthLowerBoundM(shallow.usedDepthM).toFixed(1);
  // #516 increment 1: presentation-only exposure figure — how much of the
  // ACTIVE rig's own legs cross cells the mask charts below the REQUESTED
  // depth, re-walked at render time against the currently-loaded mask
  // (never the mask this plan was originally routed against — see
  // lib/shallowExposure.ts's own doc comment for that residual, shared with
  // #505's exhaustiveMinDepth). Gated on legs being present at all: an empty
  // or absent legs array (the active tab's own rig has no result, #452
  // Major 1) has nothing to walk. `mask` starts null and resolves
  // asynchronously (useNavMask), so this is null on first paint and fills
  // in once routing assets load — never a fallback number in between.
  // A MEASURED ZERO is gated out too (PR #523 review, Blocker 1): the plan's
  // `shallow` block folds over BOTH rigs' legs while this walks only the
  // ACTIVE rig's, and the walk uses the currently-loaded mask, so an
  // honest 0 is reachable — and "0.0 nm of this route crosses shallow
  // water, try lowering your safety depth" is wrong on both halves. The
  // banner then degrades to lead + detail + caveat, the same fail-safe
  // shape firstShallowLeg already uses for the locator. Resolved to the
  // FORMATTED distance so that gate has exactly one home.
  const mask = useNavMask();
  const exposureDist = useMemo(() => {
    if (!mask || !legs || legs.length === 0) return null;
    const nm = shallowExposureNm(legs, mask, shallow.requestedDepthM);
    if (nm === null || nm <= 0) return null;
    return formatNm(roundExposureNm(nm));
  }, [legs, mask, shallow.requestedDepthM]);
  // #516 increment 2 (requires #518): whether the exposure just measured
  // above is entirely inside #452's relaxation discs. Waypoints/allowances
  // per shallowConfinedWithinM's own contract: the SNAPPED origin/destination
  // (exact, allowance 0) plus the UNSNAPPED request.viaPoints (the snapped
  // vias are not stored on `Plan` at all — allowance 300 m, snapToNavigable's
  // documented default, spent so the claim can only be harder to establish).
  // MEASURED, never assumed from the router: a plan saved before #518 shipped
  // is byte-indistinguishable from one computed after, so this re-derives the
  // guarantee from the CURRENTLY loaded mask rather than trusting the plan's
  // own provenance.
  const confinedWithin = useMemo(() => {
    if (!mask || !legs || legs.length === 0) return null;
    const waypoints = [
      plan.result.snappedOrigin,
      ...plan.request.viaPoints,
      plan.result.snappedDestination,
    ];
    const allowanceM = [0, ...plan.request.viaPoints.map(() => 300), 0];
    return shallowConfinedWithinM(
      legs,
      mask,
      shallow.requestedDepthM,
      waypoints,
      allowanceM,
      APPROACH_RADIUS_M,
    );
  }, [legs, mask, shallow.requestedDepthM, plan]);
  // Gated on exposureDist too (not just confinedWithin === true): a
  // MEASURED-ZERO exposure (see exposureDist's own comment above) makes
  // shallowConfinedWithinM vacuously true — no shallow cell is ever visited
  // to fail the check — which would otherwise render a confinement claim
  // with no stated exposure for it to describe. false/null both suppress
  // silently, per shallowConfinedWithinM's own contract: an alarming "not
  // confined" line would fire on every legitimately pre-#518 saved plan.
  const showConfined = exposureDist !== null && confinedWithin === true;
  const isWide = useWideLayout();
  // The remedy sentence's ONE gate. Three conditions, one home — splitting
  // them across the JSX is how the figure and the remedy diverged before
  // (PR #523 review, Blocker 1). Each is an independent reason to say
  // nothing: this is safety copy, so a sentence that is wrong, unreadable, or
  // impossible to act on costs more than its absence.
  //
  // 1. exposureDist !== null — Blocker 1. Reuses the SAME resolved value the
  //    figure renders, so the two can never disagree about whether there is a
  //    measured, non-zero problem to advise about.
  // 2. isWide — #516 item 5, the maintainer's call. Mount-gated on
  //    lib/useWideLayout.ts's single 1024 px breakpoint, never CSS-hidden, so
  //    a narrow layout does not carry a wide-only sentence in the
  //    accessibility tree either (#355's resizer set that precedent). Reason:
  //    a real-browser pass on 2026-08-13 measured the German banner at 489 px
  //    against a 418 px panel viewport at 390x844, putting ~71 px of a safety
  //    warning below the fold — a fourth sentence costs more than it gives on
  //    the likeliest on-deck device.
  //    Consequence, accepted: because this is inside the role="alert"
  //    container, crossing the breakpoint mutates a live region in place
  //    (measured: same DOM node, remedy added/removed) and an assertive
  //    re-read is the expected result — a tablet rotation is enough.
  //    Mount-gating is still correct; display:none would leave a wide-only
  //    sentence in the accessibility tree on narrow, which is worse.
  // 3. usedDepthM > SAFETY_DEPTH_FIELD.min — Minor 5. findRelaxedGate
  //    searches [BOAT_DRAFT_M, requestedDepthM) while SAFETY_DEPTH_FIELD
  //    clamps the input to >= its own min (2.1 and 2.2 respectively today),
  //    so at a usedDepthM of either there is no lower setting to choose and
  //    "set a lower safety depth" names an unavailable action.
  const showRemedy = exposureDist !== null && isWide && shallow.usedDepthM > SAFETY_DEPTH_FIELD.min;
  // #504 wave 4: ONE role="alert" region (a <div>, not a <p>) holding three
  // children — lead/detail/caveat — so a screen reader still announces one
  // region while sighted users get a real visual hierarchy instead of one
  // dense, uniformly-bold paragraph. LEAD carries the new #493 cautious-floor
  // fact (the most severe, most actionable thing this warning says) and is
  // the only emphasised part; DETAIL is the "what happened" mechanism at
  // normal weight; CAVEAT is the chart-accuracy hedge, visually secondary but
  // never hidden behind a click — it is a safety statement about the limits
  // of this warning in an app with no chart authority of its own.
  return (
    <div className={containerClassName} role="alert">
      <p className="shallow-warning__lead">
        {/* #54 spec C.4(a)/C.8 R5 — BOAT-AGNOSTIC, blocked on Task 11: this
            renders the Salona's 2.1 m, not the SELECTED boat's draft, so with
            a second boat it would UNDERSTATE a deeper hull in the app's most
            severe safety copy. See isSevere above for why it cannot be fixed
            here yet. */}
        {t(isSevere ? 'route.shallow.leadSevere' : 'route.shallow.lead', {
          cautious: cautiousM,
          draft: BOAT_DRAFT_M.toFixed(1),
        })}
      </p>
      <p className="shallow-warning__detail">
        {exposureDist !== null && (
          <>
            {t('route.shallow.exposure', {
              dist: exposureDist,
              requested: shallow.requestedDepthM.toFixed(1),
            })}{' '}
          </>
        )}
        {/* #516 increment 2: rendered right after the exposure sentence above,
            never re-sequenced relative to it — a self-contained sentence
            (never "all of it", which would bind to the exposure sentence's
            position, the #493/#504 anaphora lesson). Stays ahead of the
            existing mechanism/locator sentences below, whose own referents
            are untouched. */}
        {showConfined && (
          <>{t('route.shallow.confined', { radius: formatNm(APPROACH_RADIUS_M / 1852) })} </>
        )}
        {t('route.shallow.detail', {
          requested: shallow.requestedDepthM.toFixed(1),
          used: shallow.usedDepthM.toFixed(1),
          minGate: shallow.minGateDepthM.toFixed(1),
        })}
        {locator && (
          <>
            {' '}
            {t(locator.count === 1 ? 'route.shallow.locator' : 'route.shallow.locator.plural', {
              count: locator.count,
              time: formatTime(locator.firstTimeMs, lang),
            })}
          </>
        )}
        {/* PR #523 review, Minor 3: the remedy renders LAST, after the
            mechanism sentence that justifies it — a reader must learn the
            router already reduced the gate on their behalf before being
            advised to reduce it themselves. Gated on showRemedy, whose three
            conditions are enumerated at its declaration. */}
        {showRemedy && <> {t('route.shallow.remedy')}</>}
      </p>
      <p className="shallow-warning__caveat">{t('route.shallow.caveat')}</p>
    </div>
  );
}

export interface RouteSummaryProps {
  plan: Plan;
  rig: SailId;
  onRigChange: (rig: SailId) => void;
  // #64 phase 3: focus target for the Plan-tab "Details ansehen" link — App
  // forwards it onto the Ergebnis card heading (tabIndex -1, focused on jump).
  resultHeadingRef?: Ref<HTMLHeadingElement>;
}

// Okabe-Ito colorblind-safe green/red, echoing the port/starboard nav-light
// convention. Mirrored in RouteLayer.tsx's line-color paint expression.
const BOARD_COLOR: Record<Board, string> = { starboard: '#009E73', port: '#D55E00' };

function pointOfSailKey(twaDeg: number): MsgKey {
  const abs = Math.abs(twaDeg);
  if (abs < 60) return 'route.pointOfSail.beat';
  if (abs <= 110) return 'route.pointOfSail.reach';
  if (abs <= 155) return 'route.pointOfSail.broadReach';
  return 'route.pointOfSail.run';
}

// #54: derived from `plan.result.sails` instead of a genoa/fock ternary —
// naturally centralises without a bare sail-id literal.
function reasonForRig(plan: Plan, rig: SailId): NoRouteReason | null {
  return plan.result.sails.find((s) => s.sailId === rig)?.reason ?? null;
}

function LegKindChip({ leg, rig }: { leg: Leg; rig: SailId }) {
  const t = useT();
  if (leg.kind === 'motor') {
    return <span className="chip chip-motor">{t('route.kind.motor')}</span>;
  }
  const boardKey = leg.board === 'port' ? 'route.board.port' : 'route.board.starboard';
  // Prefix the displayed rig's sail name so each sail leg names the sail
  // actually driving it (Genoa/Fock), making propulsion explicit per leg.
  return (
    <span className="chip chip-sail">
      <span
        className={`board-dot board-dot-${leg.board}`}
        aria-hidden="true"
        style={{ backgroundColor: BOARD_COLOR[leg.board] }}
      />
      {t(RIG_LABEL_KEY[rig])} · {t(boardKey)} {t(pointOfSailKey(leg.twaDeg))}
    </span>
  );
}

// #452 gap 3: per-leg shallow marker for the legs table — the table already
// gives every leg a time-ordered row, so this reuses that coordinate system
// instead of inventing a separate one. Text-based, not colour-only (WCAG
// 1.4.1): the chip's own VISIBLE CONTENT is the accessibility mechanism — it
// names the hazard and the depth directly, so a colour-blind or
// screen-reader user gets the same information a sighted user reading the
// depth-warning colour does. No `title` tooltip: it's unreliable for
// assistive tech and unreachable on touch, and would only duplicate text
// that's already visible (`.route-legs` scrolls horizontally rather than
// truncating, so there's nothing here for a tooltip to reveal). Shares the
// --sc-depth-warning-* family (#251) with the plan-level ShallowWarning
// banner above, so the same hazard reads consistently wherever it appears.
function ShallowLegMarker({ minDepthM }: { minDepthM: number }) {
  const t = useT();
  return (
    <>
      <Chip className="chip-shallow">
        {t('route.legs.shallowMarker', { depth: minDepthM.toFixed(1) })}
      </Chip>
      {/* #493/#504: sound lower bound on the mask's more cautious (conservative)
          reading, derived from the SAME shipped figure the chip above
          already shows — see cautiousDepthLowerBoundM's own doc comment
          (app/src/lib/mask.ts) for the derivation. Rendered alongside, never
          replacing, the shipped number: the two are meant to read
          differently, and the user must be able to tell them apart. Uses the
          Chip primitive (not a raw span) so it shares the base `.chip` pill
          styling with its sibling above instead of re-declaring it. */}
      <Chip className="chip-shallow-cautious">
        {t('route.legs.shallowCautious', {
          depth: cautiousDepthLowerBoundM(minDepthM).toFixed(1),
        })}
      </Chip>
    </>
  );
}

function downloadGpx(plan: Plan, rig: SailId): void {
  const xml = toGpx(plan, rig);
  const blob = new Blob([xml], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${plan.name}-${rig}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
}

/** A labelled statistic cell with a `tabular-nums` value. */
function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={['ergebnis-stat', className].filter(Boolean).join(' ')}>
      <span className="ergebnis-stat-label">{label}</span>
      <span className="ergebnis-stat-value tabular-nums">{value}</span>
    </div>
  );
}

export default function RouteSummary({
  plan,
  rig,
  onRigChange,
  resultHeadingRef,
}: RouteSummaryProps) {
  const t = useT();
  const [lang] = useLang();
  const result = activeRigResult(plan, rig);
  const stale = isStaleForecast(plan);
  const reason = !result ? reasonForRig(plan, rig) : null;
  const summary = result ? resultSummary(plan, result, lang) : null;
  // #259: plan-level, independent of `result`/`summary` — must still resolve
  // correctly when viewing a tab whose own rig failed to solve (star/chip
  // render unconditionally below, matching the pre-#259 architecture).
  const rigRecommendation = rigRecommendationOf(plan.result);
  // #54: the tab list is every sail THIS plan actually requested (plan is a
  // required prop, so this is always available) — replaces the old
  // module-level RIGS two-element array literal. Byte-identical today
  // (every plan solves exactly the same two sails req.sailIds always
  // carries) and correctly generalises if that ever changes.
  const sailTabs = plan.result.sails.map((s) => s.sailId);

  return (
    <Card
      title={t('planner.card.result')}
      className="route-summary route-ergebnis"
      titleRef={resultHeadingRef}
      titleTabIndex={-1}
    >
      <div role="tablist" aria-label={t('route.rigTabs')} className="rig-tabs">
        {sailTabs.map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={rig === r}
            onClick={() => {
              if (r !== rig) onRigChange(r);
            }}
          >
            {t(RIG_LABEL_KEY[r])}
            {rigRecommendation.kind === 'decided' && rigRecommendation.rig === r && (
              <span aria-label={t('route.recommended')} title={t('route.recommended')}>
                {' '}
                ★
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Additive rig-comparison chip (the ★ on the tab stays for a 'decided'
          comparison — e2e depends on it). #259: an ETA tie or an all-motor
          comparison must not silently badge one rig as recommended — say so
          honestly instead of picking a winner. */}
      <Chip className="chip-faster-rig">
        {rigRecommendation.kind === 'decided'
          ? t('route.fasterRig', { rig: t(RIG_LABEL_KEY[rigRecommendation.rig]) })
          : t(rigRecommendation.kind === 'moot' ? 'route.rigMoot' : 'route.rigTie')}
      </Chip>

      {stale && <p role="alert">{t('route.staleForecast')}</p>}

      {/* #53: plan-level shallow-water warning — both rigs solved at the same
          relaxed gate, so this renders on BOTH rig tabs (it sits outside the
          per-rig branch below). Persisted with the plan, so a reloaded plan
          renders it identically. #452: shared with PlannerPanel's compact
          Ergebnis strip via the ShallowWarning component above, so the same
          plan-level warning is visible without switching to this tab too. */}
      {plan.result.shallow && (
        <ShallowWarning shallow={plan.result.shallow} legs={result?.legs ?? null} plan={plan} />
      )}

      {!result || !summary ? (
        <p role="alert">{t(reason ? NO_ROUTE_MESSAGE_KEY[reason] : 'error.internal')}</p>
      ) : (
        <>
          <div className="ergebnis-stats">
            <Stat label={t('route.totals.eta')} value={summary.arrivalText} />
            <Stat label={t('route.totals.distance')} value={summary.distanceText} />
            <Stat label={t('route.totals.duration')} value={summary.durationText} />
            <Stat label={t('route.totals.avgSpeed')} value={summary.avgSpeedText} />
          </div>
          <p className="ergebnis-maneuvers">
            {t('route.totals.maneuvers')}:{' '}
            <span className="tabular-nums">{result.maneuverCount}</span>
          </p>

          {/* Sail/motor split bar — proportions from the shared formatter.
              Motor uses a neutral grey (NOT a map-palette token). */}
          <div className="ergebnis-split">
            <div
              className="ergebnis-split-bar"
              role="img"
              aria-label={t('route.split.aria', {
                sailPct: summary.sailPct,
                motorPct: summary.motorPct,
              })}
            >
              <span className="ergebnis-split-sail" style={{ flexGrow: summary.sailFraction }} />
              {summary.motorNm > 0 && (
                <span
                  className="ergebnis-split-motor"
                  style={{ flexGrow: summary.motorFraction }}
                />
              )}
            </div>
            <div className="ergebnis-split-legend">
              <span className="ergebnis-split-item">
                <span
                  className="ergebnis-split-swatch ergebnis-split-swatch-sail"
                  aria-hidden="true"
                />
                <span className="tabular-nums">
                  {t('route.split.sail')} · {formatNm(summary.sailNm)} · {summary.sailPct}%
                </span>
              </span>
              <span className="ergebnis-split-item">
                <span
                  className="ergebnis-split-swatch ergebnis-split-swatch-motor"
                  aria-hidden="true"
                />
                <span className="tabular-nums">
                  {t('route.split.motor')} · {formatNm(summary.motorNm)} · {summary.motorPct}%
                </span>
              </span>
            </div>
          </div>

          {/* Legs move behind a disclosure — the card leads with the glance
              stats; the full etappen table is one tap away. */}
          <Disclosure
            className="route-legs-disclosure"
            summary={t('route.legs.disclosure', { count: result.legs.length })}
          >
            <table className="route-legs">
              <thead>
                <tr>
                  <th>{t('route.legs.time')}</th>
                  {/* #379: leg-scale elapsed time (endTimeMs - startTimeMs).
                      Placed next to Time (same dimension, read together) and
                      away from Distance/Speed — those two plus this one are
                      algebraically dependent (speedKn = distanceNm / hours
                      by construction, see isochrone.ts/postprocess.ts), so
                      showing all three is a deck-readability convenience —
                      cross-reading without doing arithmetic — never
                      independent confirmation of one another. */}
                  <th>{t('route.legs.duration')}</th>
                  <th>{t('route.legs.kind')}</th>
                  {/* #379: this column shows headingDeg, which is course over
                      ground despite its field name — no leeway model exists
                      in this app, so a true heading value would be
                      fabricated. Label as COG, not "Heading". */}
                  <th>{t('route.legs.cog')}</th>
                  <th>{t('route.legs.twa')}</th>
                  <th>{t('route.legs.tws')}</th>
                  <th>{t('route.legs.speed')}</th>
                  <th>{t('route.legs.distance')}</th>
                  <th>{t('route.legs.maneuver')}</th>
                  <th>{t('route.legs.shallow')}</th>
                </tr>
              </thead>
              <tbody>
                {result.legs.map((leg, i) => (
                  <tr key={i}>
                    <td>{formatTime(leg.startTimeMs, lang)}</td>
                    {/* endTimeMs/startTimeMs live on LegCommon, so both sail
                        and motor legs render a real duration here — no
                        `kind` narrowing needed or wanted (a defensive
                        ternary would wrongly print '—' over real data). */}
                    <td>{formatLegDuration(leg.endTimeMs - leg.startTimeMs)}</td>
                    <td>
                      <LegKindChip leg={leg} rig={rig} />
                    </td>
                    <td>{formatHeading(leg.headingDeg)}</td>
                    <td>{leg.kind === 'sail' ? `${Math.round(Math.abs(leg.twaDeg))}°` : '—'}</td>
                    <td>{formatKn(leg.twsKn)}</td>
                    <td>{formatKn(leg.speedKn)}</td>
                    <td>{formatNm(leg.distanceNm)}</td>
                    <td>
                      {leg.maneuverAtStart && (
                        <span className="chip chip-maneuver">
                          {t(
                            leg.maneuverAtStart === 'tack'
                              ? 'route.maneuver.tack'
                              : 'route.maneuver.gybe',
                          )}
                        </span>
                      )}
                    </td>
                    <td>{leg.shallow && <ShallowLegMarker minDepthM={leg.shallow.minDepthM} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.legs.length > 0 && (
              <p className="route-legs-note">{t('route.legs.motorNote')}</p>
            )}
          </Disclosure>

          <Button
            variant="secondary"
            onClick={() => downloadGpx(plan, rig)}
            disabled={result.legs.length === 0}
          >
            {t('route.exportGpx')}
          </Button>
        </>
      )}
    </Card>
  );
}
