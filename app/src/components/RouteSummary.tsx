import { useMemo, useRef, type KeyboardEvent, type Ref } from 'react';
import { useT, useLang } from '../i18n';
import {
  formatHeading,
  formatKn,
  formatLegDuration,
  formatLegNm,
  formatNm,
  formatTime,
} from '../lib/format';
import { toGpx } from '../lib/gpx';
import { APPROACH_RADIUS_M } from '../lib/depthGate';
import { formatDepthM } from '../lib/depthDisclosure';
import { cautiousDepthLowerBoundM, MASK_TOLERANCE_M } from '../lib/mask';
import {
  activeRigResult,
  isStaleForecast,
  NO_ROUTE_MESSAGE_KEY,
  staleForecastGapHours,
} from '../lib/plan';
import { planViaPoints } from '../lib/planViaPoints';
import {
  renderRigVerdict,
  resultSummary,
  rigRecommendationOf,
  sailLabelKey,
} from '../lib/resultSummary';
import {
  isMarginalDepthM,
  legMinDepthsM,
  marginalExposureNm,
  requestedGateM,
  roundExposureNm,
  shallowConfinedWithinM,
  shallowExposureNm,
} from '../lib/shallowExposure';
import { useWideLayout } from '../lib/useWideLayout';
import { useNavMask } from '../state/useNavMask';
import { safetyDepthFieldFor } from './OptionsPanel';
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
  // #54 spec C.4(a), fixed in #539. THE PLAN'S OWN BOAT, never the module
  // constant and never the live picker selection: a plan re-opened after the
  // user switches boats must still describe the hull it was computed for
  // (`plan.request.boat` is a by-value snapshot, spec I.3, and that boat may
  // have left the catalogue entirely — so no `boatById` lookup here).
  //
  // Before #539 this compared against `BOAT_DRAFT_M` (2.1). Because no
  // catalogue boat is DEEPER than 2.1 m, the error direction was
  // conservative — `isSevere` OVER-fired for the 1.90 m Elan rather than
  // under-warning — but the draft it then RENDERED was simply the wrong
  // number in the app's most severe depth copy. Both come from this one
  // value; `draftM` below is the same read.
  const draftM = plan.request.boat.draftM;
  const isSevere = shallow.usedDepthM - MASK_TOLERANCE_M < draftM;
  const containerClassName = isSevere
    ? 'shallow-warning shallow-warning--severe'
    : 'shallow-warning';
  const cautiousM = formatDepthM(cautiousDepthLowerBoundM(shallow.usedDepthM), lang);
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
    return formatNm(roundExposureNm(nm), lang);
  }, [legs, mask, shallow.requestedDepthM, lang]);
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
    // #654: plan.request.viaPoints read through the shared accessor —
    // defends a hand-edited/corrupted stored record (see planViaPoints.ts's
    // own comment for why an empty fallback can only suppress the
    // confinement sentence, never fabricate a false "confined" claim).
    const viaPoints = planViaPoints(plan.request);
    const waypoints = [plan.result.snappedOrigin, ...viaPoints, plan.result.snappedDestination];
    const allowanceM = [0, ...viaPoints.map(() => 300), 0];
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
  // 3. usedDepthM > this boat's own field minimum — Minor 5. findRelaxedGate
  //    searches [the relaxation floor, requestedDepthM) — relaxationFloorM(boat),
  //    2.1 for the Salona today — while the safety-depth input
  //    clamps to >= its own min (2.1 and 2.2 respectively for the Salona),
  //    so at a usedDepthM of either there is no lower setting to choose and
  //    "set a lower safety depth" names an unavailable action.
  //
  //    #539: read through `safetyDepthFieldFor(...)`, which is what
  //    OptionsPanel.tsx's own comment already required of every surface —
  //    this site is the sibling that did not get the memo. The bare
  //    `SAFETY_DEPTH_FIELD.min` is the DEFAULT boat's 2.2 m; the Elan's is
  //    2.0 m, so on that boat the remedy was SUPPRESSED across usedDepthM in
  //    (2.0, 2.2] — precisely the band where it is actionable.
  const safetyDepthMinM = safetyDepthFieldFor(plan.request.boat).min;
  const showRemedy = exposureDist !== null && isWide && shallow.usedDepthM > safetyDepthMinM;
  // #54 spec C.4(a), fixed in #539: renders THE PLAN'S OWN boat's draft — see
  // the `draftM` read above for why the plan, not the picker, decides.
  // #596 (fixed here): PR #590 review (MAJOR, round 2) found that #525 made
  // `formatNm`/`formatKn` locale-aware while every depth figure in this
  // banner (draft/requested/used/minGate) stayed on a bare `toFixed(1)`,
  // mixing a comma-formatted distance (`exposureDist` below, via `formatNm`,
  // and the confinement sentence's `{radius}`) beside still-point-formatted
  // depths in ONE German sentence. That was left as a known, accepted-for-now
  // inconsistency — depthDisclosure.ts's `formatDepthM` predates #525 with
  // its own "separate, wider copy decision" scoping note, and fixing it was
  // #596's job, not this PR's. It is fixed now: every depth figure in this
  // component goes through `formatDepthM`, so a German sentence never mixes
  // the two conventions again.
  const leadText = t(isSevere ? 'route.shallow.leadSevere' : 'route.shallow.lead', {
    cautious: cautiousM,
    draft: formatDepthM(draftM, lang),
  });
  // #703/#516 increment 1's exposure figure and this plan's own usedDepthM
  // BOTH need to be visible without interaction (PR #763 review Blocker 2:
  // usedDepthM is the gate the route was ACTUALLY planned at, and the
  // exposure distance answers "how much of my route" — inseparable from
  // "how shallow"). Rendered in a SEPARATE span
  // (`shallow-warning__summary-detail`), never appended into
  // `shallow-warning__lead` itself, so the exact-text pins on the lead
  // elsewhere in this file's test suite stay meaningful.
  const usedDepthText = t('route.shallow.usedDepth', {
    used: formatDepthM(shallow.usedDepthM, lang),
  });
  // #504 wave 4 / #747: ONE role="alert" region (a <div>, not a <p>) holding
  // a headline SUMMARY, a collapsible detail body and an always-visible
  // caveat — so a screen reader still announces one region while sighted
  // users get a real visual hierarchy instead of one dense, uniformly-bold
  // paragraph (pre-#747) or, before that, a five-sentence unconditional wall
  // of prose that pushed the actual Ergebnis stats below the fold on a
  // phone (#747's own live DE example).
  //
  // #747 constraint 1 (read before touching this): content inside a closed
  // <details> drops out of the accessibility tree, so whatever is in the
  // SUMMARY is the entire safety signal a screen reader gets without an
  // explicit expand. The summary therefore carries THREE things, never just
  // the lead: `leadText` (the #493 cautious-floor figure and, in the severe
  // case, the below-draft fact), `usedDepthText` (Blocker 2 above), and the
  // exposure sentence when `exposureDist` has resolved to a real, non-zero
  // measurement. Everything else — confined/detail/locator/remedy, the
  // "what happened" MECHANISM rather than the hazard itself — stays behind
  // the Disclosure, since #747's own DoD only requires the hazard, not its
  // explanation, to survive a collapse.
  //
  // #747 constraint 2: `defaultOpen={isSevere}` — the below-draft case is
  // meant to start EXPANDED and every other case collapsed. That is true
  // ONLY on a fresh mount: Disclosure.tsx's `useState(defaultOpen)` seeds
  // once and never re-syncs on a later `defaultOpen` prop change, so a plan
  // SWAPPED into an already-mounted RouteSummary/PlannerPanel would keep
  // whichever open/closed state the PREVIOUS plan's disclosure had,
  // regardless of the new plan's own severity (PR #763 review Blocker 1,
  // MEASURED: mild plan -> new severe plan id rendered collapsed). Both call
  // sites now pass `key={`${plan.id}-${plan.createdAtMs}`}` on this component
  // specifically to force a real remount — and therefore a fresh `useState`
  // seed — on every genuine plan change; `plan.id` ALONE is insufficient,
  // because `usePlanFlow.ts`'s `id: opts.replacePlanId ?? crypto.randomUUID()`
  // keeps the id fixed across a #114 recalculate-and-replace (see round 3's
  // own comment below, and those call sites' comments). The claim above is
  // therefore accurate given that key, not despite it.
  //
  // The CAVEAT stays a SIBLING of the Disclosure, never a child of it: the
  // `.shallow-warning__caveat` CSS rule (app.css) already documents "NEVER
  // hidden behind a Disclosure or any click — it is a safety statement about
  // the limits of the warning above it" — a constraint #747 must not
  // silently violate by nesting it inside the collapsible body.
  //
  // Accepted consequence, same shape as the showRemedy comment above:
  // manually opening the Disclosure mutates DOM inside this role="alert"
  // container, so it can re-trigger an assistive-tech announcement of the
  // newly-revealed text — acceptable here since that text is exactly what
  // the user just asked to see.
  return (
    <div className={containerClassName} role="alert">
      <Disclosure
        className="shallow-warning-disclosure"
        defaultOpen={isSevere}
        summary={
          <span className="shallow-warning__summary">
            <span className="shallow-warning__lead">{leadText}</span>
            {/* PR #763 review Blocker 2: usedDepthM and the exposure
                distance stay OUTSIDE the collapsible body too (this is an
                ADDITION alongside `.shallow-warning__detail`'s own existing
                mention of both, not a relocation of it) — deliberately kept
                in its OWN span, never appended into `.shallow-warning__lead`
                itself, so every exact-text `.toBe()` pin on the lead
                elsewhere in this file's test suite keeps reading only the
                lead sentence. */}
            <span className="shallow-warning__summary-detail">
              {' '}
              {usedDepthText}
              {exposureDist !== null && (
                <>
                  {' '}
                  {t('route.shallow.exposure', {
                    dist: exposureDist,
                    requested: formatDepthM(shallow.requestedDepthM, lang),
                  })}
                </>
              )}
            </span>
          </span>
        }
      >
        <p className="shallow-warning__detail">
          {/* PR #763 review Major A: the exposure sentence used to render
              HERE TOO, duplicating the copy now in the always-visible
              summary above (Blocker 2) — the severe case defaults OPEN, so
              both were showing at once, making the box BIGGER than pre-#763
              for the exact case #747 was filed about (measured: EN 589 ->
              711 chars, +20.7%; DE 690 -> 854, +23.8%)
              (jsdom fixture, mocked 0.3 nm exposure, no locator/remedy).
              Dropped here; it is
              never lost, only no longer duplicated — `route.shallow.confined`
              is self-contained (its own comment says so) and does not
              reference the exposure sentence's position, so removing it does
              not strand an anaphoric reference. */}
          {showConfined && (
            <>
              {t('route.shallow.confined', {
                radius: formatNm(APPROACH_RADIUS_M / 1852, lang),
              })}{' '}
            </>
          )}
          {t('route.shallow.detail', {
            requested: formatDepthM(shallow.requestedDepthM, lang),
            used: formatDepthM(shallow.usedDepthM, lang),
            minGate: formatDepthM(shallow.minGateDepthM, lang),
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
              advised to reduce it themselves. Gated on showRemedy, whose
              three conditions are enumerated at its declaration. */}
          {showRemedy && <> {t('route.shallow.remedy')}</>}
        </p>
      </Disclosure>
      <p className="shallow-warning__caveat">{t('route.shallow.caveat')}</p>
    </div>
  );
}

/**
 * #612 (the implementation half of #455): the route-scoped MARGINAL-depth
 * notice, for a route that did NOT relax.
 *
 * WHY IT EXISTS. Every `ShallowWarning` above renders off `PlanResult.shallow`,
 * which planRoute.ts sets only inside its `if (relaxed !== null)` block — so
 * an ordinary, non-relaxed route disclosed nothing at all about the ~10,746
 * gate-crossing cells #455 measured. The map's own per-cell hatch (#492,
 * `sc-depth-hatch`) does cover them, but nothing route-scoped did: a user
 * reading the results panel never learned that THEIR route crosses such water.
 *
 * WHY IT IS A QUIET <p> AND NOT A BANNER. Maintainer ruling on #455
 * (2026-08-20) plus its amendment: a bar of "> 50 % of non-relaxed plans makes
 * a bare presence notice wallpaper" was fixed BEFORE the trip rate was
 * measured, and the measurement tripped it — 61.5 % on shipped defaults
 * (`breeze`, 16/26), 82.1 % pooled (55/67). The ruling honours the bar by
 * DEMOTING THE SURFACE rather than hiding data: the line renders on every
 * tripping route with no magnitude gate to defend, and it MUST state the
 * exposure figure ("≈0.3 nm" and "≈2 nm" are different situations), because a
 * bare presence notice is precisely what the bar rejected.
 *
 * SEVERITY, and why it is not flattened into ShallowWarning's. A non-relaxed
 * crosser's CHARTED depth bottoms out AT the requested gate; a relaxed route
 * genuinely goes below it, and at DEFAULT settings below the hull (relaxation
 * searches [relaxationFloorM(boat), requestedDepthM) — realmask.repro pins
 * Flensburg->Marstal at usedDepthM ~2.3 under a 2.1 m hull, and
 * `about.caveats.depthMask` discloses exactly that). Two different risk
 * classes, so they get two different presentations. The one thing that DOES
 * escalate here is the same per-plan condition ShallowWarning uses,
 * `gate - MASK_TOLERANCE_M < draft` — false at every catalogue boat's own
 * default gate by construction, so it fires only once a user has lowered their
 * safety depth. Ruling §4: the non-relaxed / NON-SEVERE case must not be an
 * assertive role="alert"; "that stays for the relaxed-or-severe case", which
 * a non-relaxed severe route is a member of. Exposure magnitude never
 * escalates this line on its own.
 *
 * PRESENTATION-ONLY, deliberately: recomputed at render from the plan's own
 * legs, the currently-loaded mask and `plan.request.settings.safetyDepthM`.
 * `PlanResult` gains no field, `types.ts` and `routing/**` are untouched, so
 * the plan's bytes are identical and NO #282 acceptance sweep is owed — the
 * same shape #516/#518/#539 took, for the same reason.
 */
export function MarginalDepthNotice({ plan, legs }: { plan: Plan; legs?: Leg[] | null }) {
  const t = useT();
  const [lang] = useLang();
  const mask = useNavMask();
  // #651 fix-wave, Minor 4: was an inline duplicate of this exact derivation
  // (a stray second copy the original #651 extraction claimed, wrongly, that
  // it could not drift from) — now the single call site's own comment on
  // `requestedGateM` (lib/shallowExposure.ts) carries the full guard
  // rationale (#624/#551 stored-plan safety, the #630 cross-PR measurement,
  // why `Number.isFinite` and not a `typeof`/spread check). A safety notice
  // must degrade gracefully on a pre-#624 stored plan rather than blank the
  // whole app — that requirement is unchanged, only its implementation moved.
  const gateM = requestedGateM(plan);
  // A relaxed route is ShallowWarning's business, not this line's: it already
  // gets a banner carrying a strictly stronger statement, and rendering both
  // would say the same hazard twice in two vocabularies. Gated HERE rather
  // than at the two call sites so the two can never drift — the defect #612
  // exists to fix was itself a mount condition, not a component.
  //
  // TRUTHINESS, deliberately, so this is the EXACT COMPLEMENT of the gate
  // both banner call sites already use (`plan.result.shallow &&` in
  // RouteSummary below, `plan?.result.shallow ?? null` in PlannerPanel) — the
  // two disclosures are then provably never both shown and never both hidden,
  // whatever shape the field takes. `!== null` would be WRONG and silently
  // so: `PlanResult.shallow` is `readonly shallow?: ShallowInfo` and, under
  // exactOptionalPropertyTypes, a non-relaxed plan OMITS the key entirely
  // rather than setting it — so `undefined !== null` is true and this notice
  // would never render for the very routes it exists for. Caught by tsc only
  // because the test fixtures had to spell the absent state out.
  const relaxed = Boolean(plan.result.shallow);
  // Same contract as ShallowWarning's own exposure figure, deliberately: null
  // whenever there is nothing honest to say — no legs for the active rig, no
  // mask yet (useNavMask starts null and resolves asynchronously), a walk that
  // left mask coverage or tripped its iteration guard (marginalExposureNm
  // returns null for the WHOLE route in that case, per the #251/#255 rule),
  // or a MEASURED ZERO. A zero renders NOTHING at all — not an empty
  // container and not a "0.0 nm" sentence, which would be a notice about the
  // absence of the thing it is a notice about.
  const exposureDist = useMemo(() => {
    if (relaxed || !mask || !legs || legs.length === 0) return null;
    const nm = marginalExposureNm(legs, mask, gateM);
    if (nm === null || nm <= 0) return null;
    return formatNm(roundExposureNm(nm), lang);
  }, [relaxed, legs, mask, gateM, lang]);
  if (exposureDist === null) return null;
  // THE PLAN'S OWN BOAT, never the live picker selection and never a
  // `boatById` lookup — `plan.request.boat` is a by-value snapshot (#54 spec
  // §I.3) and that boat may have left the catalogue. Same read, and the same
  // reason, as ShallowWarning's `draftM` above.
  const draftM = plan.request.boat.draftM;
  const isSevere = gateM - MASK_TOLERANCE_M < draftM;
  return (
    <p
      className={
        isSevere ? 'marginal-depth-notice marginal-depth-notice--severe' : 'marginal-depth-notice'
      }
      role={isSevere ? 'alert' : undefined}
    >
      {t(isSevere ? 'route.marginal.noticeSevere' : 'route.marginal.notice', {
        dist: exposureDist,
        // #596: through formatDepthM, matching route.shallow.lead's own
        // {draft} slot exactly — both places the same number appears now
        // resolve the German decimal-comma question the SAME way, together.
        requested: formatDepthM(gateM, lang),
        draft: formatDepthM(draftM, lang),
      })}
    </p>
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

function rigTabId(sailId: SailId): string {
  return `rig-tab-${sailId}`;
}

// #704: stable id for the rig tablist's single tabpanel — there is exactly
// one per-rig content region (the `!result || !summary ? … : …` block
// below), whose CONTENT swaps with `rig`, not two separate panel elements,
// mirroring App.tsx's single-tabpanel-for-N-tabs shape.
const RIG_TABPANEL_ID = 'rig-tabpanel';

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
      {t(sailLabelKey(rig))} · {t(boardKey)} {t(pointOfSailKey(leg.twaDeg))}
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
function ShallowLegMarker({
  minDepthM,
  marginal = false,
}: {
  minDepthM: number;
  // #651 (Minor 5 fix-wave): true for a render-time MARGINAL leg — the
  // mask's own charted reading is AT OR ABOVE the plan's requested gate
  // (depthM >= gateM), and only the more cautious #493 reading of the same
  // cell falls below it (isMarginalDepthM, lib/shallowExposure.ts). This
  // component does NOT compare depthM against a gate itself — the CALLER
  // (RouteSummary's legs-table map, `marginal={legInfo.depthM >= gateM}`)
  // enforces the bound, since only the caller has gateM in scope.
  //
  // false (the default) covers TWO cases the caller must not conflate in
  // wording: (a) the router itself relaxed the gate to route through this
  // leg (leg.shallow present), so minDepthM is genuinely BELOW the plan's
  // ORIGINALLY requested safety depth; (b) a render-time walk against the
  // CURRENTLY LOADED mask — which can differ from the mask this plan was
  // routed against, lib/shallowExposure.ts's own header caveat — finds
  // depthM itself below the CURRENT gate: genuinely shallow by present
  // data, not merely marginal, even though the router never flagged it.
  //
  // Selects only the PRIMARY chip's wording below — the secondary
  // cautious-floor chip is the same fact either way, since it is derived
  // from minDepthM alone.
  marginal?: boolean;
}) {
  const t = useT();
  // #596: needed only for formatDepthM's locale below — the two chips'
  // production of the SAME depth family as ShallowWarning/MarginalDepthNotice
  // above, which already read `lang` via useLang(); this component didn't
  // until now because it only ever called the locale-invariant bare
  // `toFixed(1)`.
  const [lang] = useLang();
  return (
    <>
      <Chip className="chip-shallow">
        {t(marginal ? 'route.legs.marginalMarker' : 'route.legs.shallowMarker', {
          depth: formatDepthM(minDepthM, lang),
        })}
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
          depth: formatDepthM(cautiousDepthLowerBoundM(minDepthM), lang),
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

  // #704: roving-tabindex focus targets for the rig tablist, keyed by
  // SailId. A ref, not state — moving focus must not itself trigger a
  // render.
  const rigTabRefs = useRef<Partial<Record<SailId, HTMLButtonElement | null>>>({});

  // ArrowLeft/ArrowRight cycle (wrapping) through sailTabs; Home/End jump to
  // the first/last tab — same "automatic activation" shape as App.tsx's
  // app-shell tablist, reusing onRigChange so a no-op re-select (already the
  // active rig) still matches the existing button onClick's own guard.
  function handleRigTabsKeyDown(e: KeyboardEvent<HTMLElement>) {
    const currentIndex = sailTabs.indexOf(rig);
    let nextIndex: number;
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % sailTabs.length;
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + sailTabs.length) % sailTabs.length;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = sailTabs.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    const nextRig = sailTabs[nextIndex];
    if (nextRig === undefined) return;
    if (nextRig !== rig) onRigChange(nextRig);
    rigTabRefs.current[nextRig]?.focus();
  }

  // #651: the legs-table cautious chip's render-time complement to the
  // `leg.shallow` case above — see ShallowLegMarker's own `marginal` prop
  // comment for the two cases this covers. `useNavMask()` starts null and
  // resolves asynchronously (same acquisition path ShallowWarning and
  // MarginalDepthNotice below already use), so `legMinDepths` is null on
  // first paint — every leg falls back to the pre-existing leg.shallow-only
  // check until the mask loads, never a false "not marginal" claim in the
  // meantime. `result` is a stable reference across re-renders for an
  // unchanged plan/rig (lib/plan.ts's activeRigResult reads it straight off
  // `plan.result.sails`, never rebuilding it), so this only recomputes when
  // the mask resolves or the plan/rig actually changes.
  const mask = useNavMask();
  // Not useMemo: legMinDepthsM is a single O(legs) walk, no cheaper than the
  // unmemoized resultSummary()/rigRecommendationOf() calls above it, and no
  // effect keys off this value's referential identity — only its content,
  // read straight into JSX below.
  const legMinDepths =
    mask && result && result.legs.length > 0 ? legMinDepthsM(result.legs, mask) : null;
  const gateM = requestedGateM(plan);

  return (
    <Card
      title={t('planner.card.result')}
      className="route-summary route-ergebnis"
      titleRef={resultHeadingRef}
      titleTabIndex={-1}
    >
      {/* #704: roving tabIndex (0 on the selected rig, -1 on the rest) plus
          ArrowLeft/ArrowRight/Home/End on the tablist (handleRigTabsKeyDown)
          — previously every tab stayed in the natural Tab order and no
          arrow key did anything. aria-controls on every tab points at the
          ONE tabpanel below (RIG_TABPANEL_ID; only one panel ever renders),
          whose aria-labelledby tracks the currently active rig's tab id. */}
      <div
        role="tablist"
        aria-label={t('route.rigTabs')}
        className="rig-tabs"
        onKeyDown={handleRigTabsKeyDown}
      >
        {sailTabs.map((r) => (
          <button
            key={r}
            id={rigTabId(r)}
            type="button"
            role="tab"
            aria-selected={rig === r}
            aria-controls={RIG_TABPANEL_ID}
            tabIndex={rig === r ? 0 : -1}
            ref={(el) => {
              rigTabRefs.current[r] = el;
            }}
            onClick={() => {
              if (r !== rig) onRigChange(r);
            }}
          >
            {t(sailLabelKey(r))}
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
          ? t('route.fasterRig', { rig: t(sailLabelKey(rigRecommendation.rig)) })
          : renderRigVerdict(rigRecommendation.kind, plan.result.comparisonComplete, sailTabs, t)}
      </Chip>

      {/* #703: bare `<p role="alert">` carried no visual treatment at all —
          same muted body-copy problem as `.planner-guidance`/`.options-help`
          elsewhere, just with no class to attach a compound-selector override
          to. `.inline-alert` is a standalone class for exactly this shape
          (see its app.css comment for why it's a fresh class rather than a
          modifier of an existing muted rule). */}
      {stale && (
        <p className="inline-alert" role="alert">
          {t('route.staleForecast', { hours: staleForecastGapHours(plan) })}
        </p>
      )}

      {/* #53: plan-level shallow-water warning — both rigs solved at the same
          relaxed gate, so this renders on BOTH rig tabs (it sits outside the
          per-rig branch below). Persisted with the plan, so a reloaded plan
          renders it identically. #452: shared with PlannerPanel's compact
          Ergebnis strip via the ShallowWarning component above, so the same
          plan-level warning is visible without switching to this tab too.
          #747/Blocker 1: a key on this component is REQUIRED, not decorative
          — Disclosure.tsx's `useState(defaultOpen)` seeds once at first
          mount and never re-syncs on a `defaultOpen` prop change, so without
          it a plan-to-plan transition (same mounted RouteSummary, a new plan
          swapped in) keeps whatever open/closed state the FIRST plan's
          disclosure had.
          PR #763 review round 3, RESIDUAL BLOCKER: `key={plan.id}` alone
          narrows the bug rather than closing it — `usePlanFlow.ts`'s
          #114 recalculate-and-replace flow (`replacePlanId`) re-plans an
          EXISTING plan id against a fresh forecast, so the relaxation tier
          (and therefore `usedDepthM`/`isSevere`) can flip while `id` stays
          the SAME — same key, no remount, `useState` stays seeded from the
          previous, milder plan (MEASURED: same-id mild->severe transition
          still rendered closed under the `plan.id`-only key). Every plan
          write refreshes `createdAtMs` too (`usePlanFlow.ts`, `Date.now()`
          on every run including a replace), so `${plan.id}-${plan.createdAtMs}`
          changes on every genuine re-plan, replace included, forcing the
          remount `plan.id` alone could not guarantee. */}
      {plan.result.shallow && (
        <ShallowWarning
          key={`${plan.id}-${plan.createdAtMs}`}
          shallow={plan.result.shallow}
          legs={result?.legs ?? null}
          plan={plan}
        />
      )}

      {/* #612: the complement of the banner above — a quiet route-scoped line
          for a route that did NOT relax and so has no `shallow` block to
          render a banner from. Rendered UNCONDITIONALLY here: the
          not-relaxed / mask-loaded / non-zero-exposure gate lives inside the
          component, deliberately, so this call site and PlannerPanel's cannot
          drift apart on the very condition #612 exists to fix. Per-rig, unlike
          the plan-level banner above — the walk uses the ACTIVE rig's own
          legs, so the two rig tabs can legitimately show different figures (or
          one show none), which is the honest per-rig answer. */}
      <MarginalDepthNotice plan={plan} legs={result?.legs ?? null} />

      {/* #704: the tabpanel half of the rig tablist's ARIA association — a
          plain wrapper div (no class, no CSS) around the existing per-rig
          content (no-route message OR the full result block below).
          aria-labelledby tracks the currently active rig's tab id; every
          tab's aria-controls points at this one id since only one panel is
          ever rendered at a time. */}
      <div role="tabpanel" id={RIG_TABPANEL_ID} aria-labelledby={rigTabId(rig)}>
        {!result || !summary ? (
          <p className="inline-alert" role="alert">
            {/* #662: this branch renders ONLY for a SAVED plan (`plan` is a
              required prop, so this is never the live-planning failure
              surface — that one is App.tsx's own Retry-button banner). When
              `reason` is a recognised NoRouteReason, NO_ROUTE_MESSAGE_KEY
              names what actually happened. `reason === null` here means the
              stored reason could not be trusted (PR #656/#614) — a
              fundamentally different situation the generic, live-planning-
              flavoured `error.internal` ("Try again; reload the app")
              answers wrong on this screen, since neither action can change
              what a stored record contains. `error.savedPlanUnreadable` is
              the honest fallback: it names the one remedy that DOES apply
              here, re-planning, instead of retry/reload framing that
              cannot. */}
            {t(reason ? NO_ROUTE_MESSAGE_KEY[reason] : 'error.savedPlanUnreadable')}
          </p>
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
                    {t('route.split.sail')} · {formatNm(summary.sailNm, lang)} · {summary.sailPct}%
                  </span>
                </span>
                <span className="ergebnis-split-item">
                  <span
                    className="ergebnis-split-swatch ergebnis-split-swatch-motor"
                    aria-hidden="true"
                  />
                  <span className="tabular-nums">
                    {t('route.split.motor')} · {formatNm(summary.motorNm, lang)} ·{' '}
                    {summary.motorPct}%
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
                {/* #707: visually-hidden accessible name for the table itself —
                  reuses the SAME `route.legs.disclosure` key/params as the
                  Disclosure summary above (no new i18n key), so the table's
                  name and its collapsed-state summary always agree. */}
                <caption className="sr-only">
                  {t('route.legs.disclosure', { count: result.legs.length })}
                </caption>
                <thead>
                  <tr>
                    {/* #698: the safety signal moved to column 1 of 10 (was
                      last, then #698's first pass moved it to immediately
                      after Kind). Neither ordering alone can satisfy the
                      DoD: the populated Shallow cell's two chips on one
                      line are wider than the whole phonePortrait viewport,
                      so any position still overflows unless the cell's
                      OWN width is bounded too — see the stacked wrapper on
                      the matching <td> below, which is what actually closes
                      the gap. Column 10 of 10 sat off-screen behind the
                      horizontal scroll this table needs at narrow widths
                      (phonePortrait and below), with nothing signalling
                      that more columns existed at all, so the app's only
                      per-leg depth warning was reliably invisible on the
                      device most likely to be read on deck. Header and
                      cell order move together — see the matching <td>
                      below. */}
                    <th scope="col">{t('route.legs.shallow')}</th>
                    <th scope="col">{t('route.legs.time')}</th>
                    {/* #379: leg-scale elapsed time (endTimeMs - startTimeMs).
                      Placed next to Time (same dimension, read together) and
                      away from Distance/Speed — those two plus this one are
                      algebraically dependent (speedKn = distanceNm / hours
                      by construction, see isochrone.ts/postprocess.ts), so
                      showing all three is a deck-readability convenience —
                      cross-reading without doing arithmetic — never
                      independent confirmation of one another. */}
                    <th scope="col">{t('route.legs.duration')}</th>
                    <th scope="col">{t('route.legs.kind')}</th>
                    {/* #379: this column shows headingDeg, which is course over
                      ground despite its field name — no leeway model exists
                      in this app, so a true heading value would be
                      fabricated. Label as COG, not "Heading". */}
                    <th scope="col">{t('route.legs.cog')}</th>
                    <th scope="col">{t('route.legs.twa')}</th>
                    <th scope="col">{t('route.legs.tws')}</th>
                    <th scope="col">{t('route.legs.speed')}</th>
                    <th scope="col">{t('route.legs.distance')}</th>
                    <th scope="col">{t('route.legs.maneuver')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.legs.map((leg, i) => {
                    // #651 fix-wave, Minor 5: `legInfo` is this leg's OWN
                    // legMinDepthsM entry (per-leg null now — see that
                    // function's own doc comment for why a whole-array null
                    // was replaced), narrowed here once so the JSX below can
                    // read `legInfo.depthM` without re-deriving the check.
                    const legInfo = legMinDepths ? legMinDepths[i] : null;
                    return (
                      <tr key={i}>
                        <td>
                          {/* #698 decision memo (2026-08-31): the wrapper is
                            what makes the column's width `max(chip1, chip2)`
                            instead of their sum — the flex column lives on
                            THIS div, never on the <td> itself, since
                            `display: flex` on a table cell drops
                            `display: table-cell` and generates anonymous
                            table cells (app.css's `.shallow-cell-stack`
                            rule). `white-space: normal` alone cannot wrap
                            the two Chip spans: they are adjacent JSX
                            siblings with no whitespace text node between
                            them, and this table's `overflow-x: auto` +
                            `table-layout: auto` lays out at max-content
                            width regardless, so nothing applies the width
                            pressure a wrap would need. */}
                          <div className="shallow-cell-stack">
                            {leg.shallow ? (
                              <ShallowLegMarker minDepthM={leg.shallow.minDepthM} />
                            ) : (
                              // #651: the render-time complement — this leg was
                              // never relaxed (no leg.shallow), but the
                              // currently loaded mask finds it MARGINAL at the
                              // plan's own requested gate (isMarginalDepthM,
                              // #612's own criterion). `legInfo === null`
                              // (mask not loaded, or THIS leg's own walk was
                              // inconclusive — legMinDepthsM's own per-leg
                              // contract) correctly suppresses only THIS row,
                              // never its siblings.
                              //
                              // #651 fix-wave, Minor 5: `marginal` is bounded
                              // from BELOW too, not just by isMarginalDepthM's
                              // own `< threshold` above — this walk runs against
                              // the CURRENTLY LOADED mask, which can differ from
                              // the one this plan was routed against (#516's own
                              // residual), so a re-opened plan under a rebuilt
                              // mask could find `legInfo.depthM` itself below
                              // `gateM` even though the router never flagged
                              // this leg. That is GENUINELY shallow by present
                              // data, not merely marginal, so it falls through
                              // to the existing "Shallow" wording
                              // (`marginal={legInfo.depthM >= gateM}`) rather
                              // than under-stating it as "Marginal" — the
                              // expensive direction for a depth cue.
                              legInfo !== null &&
                              isMarginalDepthM(legInfo, gateM) && (
                                <ShallowLegMarker
                                  minDepthM={legInfo.depthM}
                                  marginal={legInfo.depthM >= gateM}
                                />
                              )
                            )}
                          </div>
                        </td>
                        <td>{formatTime(leg.startTimeMs, lang)}</td>
                        {/* endTimeMs/startTimeMs live on LegCommon, so both
                          sail and motor legs render a real duration here —
                          no `kind` narrowing needed or wanted (a defensive
                          ternary would wrongly print '—' over real data). */}
                        <td>{formatLegDuration(leg.endTimeMs - leg.startTimeMs)}</td>
                        <td>
                          <LegKindChip leg={leg} rig={rig} />
                        </td>
                        <td>{formatHeading(leg.headingDeg)}</td>
                        <td>
                          {leg.kind === 'sail' ? `${Math.round(Math.abs(leg.twaDeg))}°` : '—'}
                        </td>
                        <td>{formatKn(leg.twsKn, lang)}</td>
                        {/* #439: NOT formatLegNm — speed keeps formatKn's one-
                          decimal precision unchanged. Raising distance alone
                          (below) to two decimals reopens the algebraic-
                          mismatch readability concern this file's own
                          comment on the table header warns about (distance/
                          duration/speed are dependent by construction);
                          flagged in the PR body rather than silently
                          resolved by also touching speed's precision here. */}
                        <td>{formatKn(leg.speedKn, lang)}</td>
                        <td>{formatLegNm(leg.distanceNm, lang)}</td>
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
                      </tr>
                    );
                  })}
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
      </div>
    </Card>
  );
}
