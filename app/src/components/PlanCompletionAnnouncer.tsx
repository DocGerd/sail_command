import { useEffect, useRef, useState } from 'react';
import { useLang, useT } from '../i18n';
import { formatDateTime, formatDuration, formatNm } from '../lib/format';
import type { RigResult } from '../types';

export interface PlanCompletionAnnouncerProps {
  // The rig result to announce, or null while there is nothing new to say.
  result: RigResult | null;
  // Identity of the completion `result` belongs to — this component's own
  // defensive dedup key (`${plan.id}-${plan.createdAtMs}`, this repo's
  // standing composite-identity idiom, e.g. ShallowWarning's `key` and
  // PlannerPanel's superseded `planAnnounceKey`). `null` whenever `result`
  // is null.
  resultKey: string | null;
}

// #983: ONE app-level `role="status"` region that announces a plan's
// completion regardless of which tab is active — mounted unconditionally in
// App.tsx (outside the tab-gated `<main className="app-panel">` subtree), so
// a recalculate (or an ordinary first plan, or a #937 departure-confirm
// solve) completing while the user is on the Live or Boat tab is still
// announced. It REPLACES two per-tab live regions that used to carry this
// same sentence and went silent on exactly those two tabs because a live
// region must already be present in the document when its content changes
// to be announced at all (#983's own issue text):
//   - PlannerPanel's `planner.result.announce` fold into its `.planner-status`
//     region, mounted only under `tab === 'plan'`.
//   - PlansList's `plansList.recalcAnnounce` region (#961), mounted only
//     under `tab === 'routes'`.
// Both components keep their OTHER live regions untouched (PlannerPanel's
// in-flight fetching/routing/probing progress text and its `formDirty`
// staleness fold; PlansList's `role="alert"` recalc-error line) — those are
// tab-local concerns (you can only act on either while actually on that
// tab), unlike a completion announcement, which is meaningful no matter
// where the user has gone. Because this region REPLACES rather than
// coexists with the two removed ones, there is exactly one owner and no
// double-announcement to guard against.
//
// This component does NOT decide whether a `plan`/`rig` change is a
// "genuine completion" worth announcing at all — only App.tsx knows that:
// its own `prevPlanningPhaseRef` comment documents which callbacks
// (handlePlan, handleRecalculate, DepartureCompare's confirm-solve) arm it,
// and why PlansList's plain "Load" and session restore (both of which write
// the same shared `plan` state directly, bypassing App.tsx entirely) never
// do — so a plain load of an existing saved plan stays silent, exactly as
// it always has. By the time `result` reaches this component non-null, it
// is already a genuine completion; this component's own job is narrower:
// format the sentence and make sure the SAME completion is never announced
// twice, even across a React StrictMode double-effect-invocation (the
// `lastAnnouncedKeyRef` dedup below, same shape PlannerPanel's superseded
// version used).
export default function PlanCompletionAnnouncer({
  result,
  resultKey,
}: PlanCompletionAnnouncerProps) {
  const t = useT();
  const [lang] = useLang();
  const lastAnnouncedKeyRef = useRef<string | null>(null);
  // RESIDUAL, not fixed here (review, Minor 4): recalculating the SAME plan
  // twice at the same departure against an unchanged cached forecast yields
  // a byte-identical announcement sentence — React's `Object.is` bail-out on
  // an unchanged string skips the re-render, so the live region's text node
  // is never mutated and nothing is announced the second time.
  // PlannerPanel's own region (`planner.result.announce`) has the identical
  // limitation, so this is not a regression introduced here.
  const [announcedResult, setAnnouncedResult] = useState<RigResult | null>(null);

  useEffect(() => {
    if (!result || !resultKey || resultKey === lastAnnouncedKeyRef.current) return;
    lastAnnouncedKeyRef.current = resultKey;
    setAnnouncedResult(result);
  }, [result, resultKey]);

  const announcement = announcedResult
    ? t('planner.result.announce', {
        arrival: formatDateTime(announcedResult.etaMs, lang),
        duration: formatDuration(announcedResult.durationMs),
        distance: formatNm(announcedResult.distanceNm, lang),
      })
    : '';

  return (
    <p className="sr-only plan-completion-announce" role="status" aria-atomic="true">
      {announcement}
    </p>
  );
}
