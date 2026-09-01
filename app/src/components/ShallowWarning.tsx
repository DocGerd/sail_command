import { useMemo } from 'react';
import { useT, useLang } from '../i18n';
import { formatNm, formatTime } from '../lib/format';
import { APPROACH_RADIUS_M } from '../lib/depthGate';
import { formatDepthM } from '../lib/depthDisclosure';
import { cautiousDepthLowerBoundM, MASK_TOLERANCE_M } from '../lib/mask';
import { planViaPoints } from '../lib/planViaPoints';
import { roundExposureNm, shallowConfinedWithinM, shallowExposureNm } from '../lib/shallowExposure';
import { useWideLayout } from '../lib/useWideLayout';
import { useNavMask } from '../state/useNavMask';
import { safetyDepthFieldFor } from './OptionsPanel';
import type { Leg, Plan, ShallowInfo } from '../types';
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
  // #747 constraint 2, SUPERSEDED BY #788: this was `defaultOpen={isSevere}`,
  // so the below-draft case started EXPANDED. That never discriminated.
  // Three facts compose, each re-read for #788 rather than taken on trust:
  // `defaultSafetyDepthM(b) = ceilToDecimetre(b.draftM + MASK_TOLERANCE_M)`
  // (lib/boatDepth.ts), which for all three catalogue drafts (2.1/2.1/1.9)
  // makes `gate - MASK_TOLERANCE_M` the draft EXACTLY; a relaxed gate is at
  // least a decimetre under the requested one (routing/relaxedDepth.ts:124,
  // `hiDm = Math.ceil(requestedDepthM * 10 - 1e-9) - 1`); and this banner
  // mounts only on a relaxed route at all (types.ts on `PlanResultOk.shallow`:
  // "present only when the route required relaxing the depth gate below the
  // requested safety depth"). So at a default gate `isSevere` is
  // UNCONDITIONALLY true here, and the collapsed state #747 was filed to
  // deliver was unreachable unless the user first RAISED the safety depth
  // above their own boat's default. Maintainer ruling on #788: stop keying
  // the initial open state on `isSevere`. Hence the constant below.
  //
  // Sound as a constant ONLY because the SUMMARY carries the entire hazard
  // — re-verified against the JSX below, not assumed: `leadText` (which IS
  // `route.shallow.leadSevere`, the string naming the below-draft fact,
  // whenever isSevere holds), `usedDepthText`, and the exposure sentence
  // once `exposureDist` has resolved, with `.shallow-warning__caveat` a
  // SIBLING of the Disclosure. Only the MECHANISM — confined / detail /
  // locator / remedy — sits inside the collapsible body. If any of those
  // four ever moves INTO the body, this constant stops being safe.
  //
  // `isSevere` itself is deliberately UNCHANGED: it still selects the
  // container class and the severe wording. #788 ruled against widening the
  // threshold or rewording that copy.
  //
  // The KEY on this component is a SEPARATE and still-live requirement, not
  // a consequence of the above (PR #763 review Blocker 1, and round 3's
  // residual): Disclosure.tsx's `useState(defaultOpen)` seeds once and never
  // re-syncs, so a disclosure the USER opened on one plan would otherwise
  // stay open across a swap to another. Both call sites pass
  // `key={`${plan.id}-${plan.createdAtMs}`}`; `plan.id` ALONE is
  // insufficient, because `usePlanFlow.ts`'s
  // `id: opts.replacePlanId ?? crypto.randomUUID()` keeps the id fixed
  // across a #114 recalculate-and-replace (App.tsx passes
  // `replacePlanId: recalcPlan.id`) while `createdAtMs` is refreshed on
  // every write.
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
        defaultOpen={false}
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
              summary above (Blocker 2) — the severe case defaulted OPEN, so
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
