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
import { formatDepthM } from '../lib/depthDisclosure';
import { cautiousDepthLowerBoundM, MASK_TOLERANCE_M } from '../lib/mask';
import { PORT_COLOR, STARBOARD_COLOR } from '../lib/mapColors';
import {
  activeRigResult,
  isStaleForecast,
  NO_ROUTE_MESSAGE_KEY,
  staleForecastGapHours,
} from '../lib/plan';
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
} from '../lib/shallowExposure';
import { nearbyHazardMarkCount, SEAMARK_PROXIMITY_M } from '../lib/seamarkProximity';
import {
  reefSuggestionsForLegs,
  REEF1_AWS_KN,
  REEF2_AWS_KN,
  REEF3_AWS_KN,
  type ReefBand,
  type ReefSuggestion,
} from '../lib/reefSuggestion';
import { useNavMask } from '../state/useNavMask';
import { useSeamarks } from '../state/useSeamarks';
import type { MsgKey } from '../i18n/dict.de';
import type { Board, Leg, NoRouteReason, Plan, SailId } from '../types';
import Card from './Card';
import Chip from './Chip';
import Button from './Button';
import Disclosure from './Disclosure';
import { ShallowWarning } from './ShallowWarning';

/**
 * #612 (the implementation half of #455): the route-scoped MARGINAL-depth
 * notice, for a route that did NOT relax.
 *
 * WHY IT EXISTS. Every `ShallowWarning` (ShallowWarning.tsx) renders off
 * `PlanResult.shallow`, which planRoute.ts sets only inside its
 * `if (relaxed !== null)` block — so an ordinary, non-relaxed route
 * disclosed nothing at all about the ~10,746 gate-crossing cells #455
 * measured. The map's own per-cell hatch (#492,
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
 * searches [relaxationFloorM(boat), requestedDepthM) —
 * routing/realmask.repro.issue20.test.ts pins Flensburg->Marstal at
 * usedDepthM ~2.3 under a 2.1 m hull, and
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
  // reason, as ShallowWarning's `draftM` (ShallowWarning.tsx).
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

/**
 * #615 (#495 option 2): the advisory SEAMARK-PROXIMITY notice — one quiet
 * line stating how many DISTINCT cardinal or isolated-danger marks the
 * active rig's route passes closer than SEAMARK_PROXIMITY_M to. A sibling of
 * MarginalDepthNotice above and modelled on it byte-for-byte in shape:
 * PRESENTATION-ONLY (recomputed at render from the plan's own legs and the
 * already-loaded `assets.seamarks` — lib/seamarkProximity.ts), so
 * `PlanResult` gains no field, `types.ts` and `routing/**` are untouched and
 * NO #282 sweep is owed. Decision record: docs/spikes/615-seamark-proximity.md.
 *
 * ONE TIER, THE LOWEST — never `role="alert"`, never a `--severe` modifier,
 * never dismissible. #612 reserved the assertive role for a severity that is
 * a MEASURED relation (gate vs this boat's draft); proximity to a mark admits
 * no such measurement — nothing makes a 37 m pass more or less severe than a
 * 174 m one without a chart the app does not have — and a tier no
 * measurement can escalate must not be assertive. Dismissal would need
 * per-plan persisted state, which breaks the presentation-only property
 * that is the whole reason no sweep is owed.
 *
 * NO ACCESSIBLE NAME, deliberately: a bare <p> has no role, so `getByRole`
 * cannot reach it and it cannot collide with the five non-`exact` Playwright
 * locators whose name contains "Seezeichen" (design brief §3.4).
 *
 * THREE SILENT STATES, each rendering NOTHING — never an empty container and
 * never a "0 marks" sentence: seamarks unresolved (`useSeamarks` starts null
 * and resolves asynchronously; a failed load stays null = "not checked"),
 * no legs for the active rig (a no-route rig), and a check that ran and
 * found zero. Silence and "none nearby" are different messages: rendering a
 * zero during the pre-resolve window would be a false all-clear of the
 * #251/#255 `segmentShallowestBelow` shape. Per the guard-asymmetry rule the
 * nudge fails OPEN to silence, never to a thrown error and never to
 * reassurance.
 *
 * MEMO KEY. The count depends on exactly two inputs, and both are deps:
 * `seamarks` (the module-cached collection, one identity per session) and
 * `legs`, the active rig's own array. `legs` is what makes the #114
 * recalculate-and-replace path recompute: usePlanFlow.ts reuses `plan.id`
 * on a replace but every write builds a NEW Plan whose result (and legs
 * array) came fresh from the worker, and a rig-tab switch hands this
 * component the other rig's array — so the reference already carries what a
 * `[plan.id, plan.createdAtMs, rig]` key would encode, without deps the
 * memo body never reads (which react-hooks/exhaustive-deps would flag as
 * unnecessary). The transition is pinned by RouteSummary.test.tsx's '#114
 * recalculate-and-replace' row, which reds under a `[plan.id]`-only key.
 */
export function SeamarkProximityNotice({ legs }: { legs?: Leg[] | null }) {
  const t = useT();
  const seamarks = useSeamarks();
  const count = useMemo(() => {
    if (!seamarks || !legs || legs.length === 0) return 0;
    return nearbyHazardMarkCount(legs, seamarks, SEAMARK_PROXIMITY_M);
  }, [seamarks, legs]);
  if (count === 0) return null;
  return (
    <p className="seamark-proximity-notice">
      {t(count === 1 ? 'route.seamarks.proximity' : 'route.seamarks.proximity.plural', {
        // `{dist}` comes from the constant, never from the dict, so copy and
        // threshold cannot drift apart silently (both dicts' own comment).
        dist: SEAMARK_PROXIMITY_M,
        count,
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
// #715: sourced from the shared lib/mapColors.ts module rather than a
// second raw-literal declaration.
const BOARD_COLOR: Record<Board, string> = { starboard: STARBOARD_COLOR, port: PORT_COLOR };

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

// #774: id of the visually-hidden operating hint the legs table points at
// through `aria-describedby`. A module constant like RIG_TABPANEL_ID above —
// RouteSummary renders at most once at a time (the Routes tab's own card), so
// a fixed id cannot collide.
const LEGS_SCROLL_HINT_ID = 'route-legs-scroll-hint';

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

const REEF_LABEL_KEY: Record<ReefBand, MsgKey> = {
  full: 'route.reef.full',
  reef1: 'route.reef.reef1',
  reef2: 'route.reef.reef2',
  reef3: 'route.reef.reef3',
};

// #325: per-leg mainsail reef suggestion, rendered as a SIBLING chip inside
// the SAME Kind <td> as LegKindChip above — deliberately never a new table
// column, so the #707/#698 header-order pins below and the mirrored e2e
// header-text array (app/e2e/panel-resize.spec.ts, outside this PR's file
// allowlist) stay untouched. Presentation-only: the suggestion this chip
// renders derives everything from fields `Leg` already carries, so
// `PlanResult` stays byte-identical (see reefSuggestion.ts's own header
// comment for the full #282 no-sweep argument). Renders NOTHING on a motor
// leg (`suggestion === null`) — the Kind chip already reads "Motor" for
// that row, and the issue's own DoD accepts "no suggestion" as one of the
// two licensed motor-leg treatments; a second, redundant annotation would
// add no information.
//
// #946: takes the ALREADY-COMPUTED suggestion as a prop rather than a `Leg`
// and deriving it itself — the parent computes `reefSuggestionsForLegs`
// ONCE for the whole ordered route (see that call site's own comment) so
// consecutive legs' hysteresis state threads correctly; a chip that called
// `reefSuggestionForLeg` per-row here would band each leg in isolation
// again and silently undo the damping.
function ReefChip({ suggestion }: { suggestion: ReefSuggestion | null }) {
  const t = useT();
  if (suggestion === null) return null;
  return <span className="chip chip-reef">{t(REEF_LABEL_KEY[suggestion.band])}</span>;
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
// banner (ShallowWarning.tsx), so the same hazard reads consistently
// wherever it appears.
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
  // production of the SAME depth family as ShallowWarning (ShallowWarning.tsx)
  // and MarginalDepthNotice above, which already read `lang` via useLang();
  // this component didn't until now because it only ever called the
  // locale-invariant bare `toFixed(1)`.
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
  // resolves asynchronously (same acquisition path ShallowWarning.tsx and
  // MarginalDepthNotice already use), so `legMinDepths` is null on
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
  // #946: computed ONCE for the whole ordered route, never per-leg inside
  // the render — `reefSuggestionsForLegs` threads each sail leg's DISPLAYED
  // band into the next leg's hysteresis decision (a Schmitt-trigger dead
  // zone around each threshold, see reefSuggestion.ts's own #946 comment),
  // so calling it per-row would reset that thread every render and undo the
  // damping it exists to provide. `null` (no plan / no result) reproduces
  // the same "nothing rendered" state `ReefChip` already handled before
  // this wiring — see that component's own comment.
  const reefSuggestions = result ? reefSuggestionsForLegs(result.legs) : null;

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
          Ergebnis strip via the ShallowWarning component (now in
          ShallowWarning.tsx), so the same plan-level warning is visible
          without switching to this tab too.
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

      {/* #615: the advisory seamark-proximity line, a SIBLING of the two
          depth surfaces above and, like MarginalDepthNotice, rendered
          UNCONDITIONALLY — the unresolved / no-legs / zero gate lives inside
          the component. Per-rig for the same reason: the count is over the
          ACTIVE rig's own legs, so the two rig tabs can honestly differ. */}
      <SeamarkProximityNotice legs={result?.legs ?? null} />

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
              {/* #774 (WCAG 2.1.1 Keyboard): `.route-legs` IS the scroll
                container — app.css makes the <table> itself `display: block;
                overflow-x: auto`, and a scroll container that is neither
                focusable nor holds a focusable descendant cannot be operated
                by keyboard at all. `tabIndex={0}` puts it in the tab order,
                which is what makes the arrow keys scroll it.

                Deliberately NO `role` and NO `aria-label` on this element.
                The canonical wrapper-div form (`<div role="region" tabindex=0>`
                around the table) is the cleaner shape in the abstract, but it
                only works if the WRAPPER owns the overflow — moving the scroll
                off the table would silently defeat panel-resize.spec.ts's two
                #355/#698 guards, which both measure scroll geometry on
                `.route-legs` itself. And putting `role="region"` on the <table>
                instead would REPLACE its implicit `table` role, destroying the
                cell-by-cell screen-reader navigation #774 explicitly says is
                NOT the problem here.

                So the accessible NAME stays #707's <caption> and the operating
                hint rides on `aria-describedby` instead — an `aria-label` would
                have won the name computation and silently shadowed that
                caption, breaking the "table's name and its collapsed-state
                summary always agree" invariant the caption exists for. */}
              <table className="route-legs" tabIndex={0} aria-describedby={LEGS_SCROLL_HINT_ID}>
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
                          <ReefChip suggestion={reefSuggestions ? reefSuggestions[i] : null} />
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
              {/* #774: the `aria-describedby` target. Rendered unconditionally
                beside the table it describes (never gated on a row count, so
                the reference can never dangle) and visually hidden — the
                SIGHTED affordance for the same fact is #698's CSS scroll
                shadow on `.route-legs`. */}
              <p id={LEGS_SCROLL_HINT_ID} className="sr-only">
                {t('route.legs.scrollHint')}
              </p>
              {result.legs.length > 0 && (
                <p className="route-legs-note">{t('route.legs.motorNote')}</p>
              )}
              {/* #325: the reef suggestion is advisory seamanship guidance,
                computed AFTER routing from apparent wind speed — it is NOT
                part of the time optimisation (the boat speed every leg used
                still assumes full main) and the router has no reefed polar
                to check it against. Stated plainly here, with the actual
                thresholds, per the issue's own "documented where a user can
                find them" requirement — never only in a code comment. */}
              {result.legs.some((l) => l.kind === 'sail') && (
                <p className="route-legs-note">
                  {t('route.legs.reefNote', {
                    first: String(REEF1_AWS_KN),
                    second: String(REEF2_AWS_KN),
                    third: String(REEF3_AWS_KN),
                  })}
                </p>
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
