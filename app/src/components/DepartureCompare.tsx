import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLang, useT } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import type { LatLon, Plan, PlanResultOk, SailId } from '../types';
import type { ReplanClient } from '../state/replan';
import { NO_ROUTE_MESSAGE_KEY } from '../lib/plan';
import { motorSplit, rigRecommendationOf, sailLabelKey } from '../lib/resultSummary';
import { recommendedResult } from '../types';
import { formatDateTime, formatDuration, formatHeading, formatNm } from '../lib/format';
import { WindField } from '../lib/wind';
import { GENOA_SAIL_ID } from '../data/boats';
import { useDepartureScan, type DepartureCandidate } from '../state/useDepartureScan';
import { useDepartureConfirm } from '../state/useDepartureConfirm';
import Card from './Card';
import Field from './Field';
import Button from './Button';
import Chip from './Chip';

const STEP_HOURS_OPTIONS = [1, 3, 6] as const;
const MIN_COUNT = 4;
const MAX_COUNT = 8;
const DEFAULT_COUNT = 6;
const DEFAULT_STEP_HOURS = 3;

// #936: standard Beaufort-scale upper bounds in knots (WMO/Met Office knots
// table — 0: <1, 1: 1-3, 2: 4-6, 3: 7-10, 4: 11-16, 5: 17-21, 6: 22-27,
// 7: 28-33, 8: 34-40, 9: 41-47, 10: 48-55, 11: 56-63, 12: 64+). This is a
// real, universal maritime convention, not an invented category scale — the
// number it summarizes always comes from a real windGrid sample.
// index i = force i's inclusive upper bound; a speed above the last entry is
// force 12 (hurricane).
const BEAUFORT_UPPER_BOUNDS_KN = [1, 3, 6, 10, 16, 21, 27, 33, 40, 47, 55, 63] as const;

function beaufortForce(speedKn: number): number {
  for (let force = 0; force < BEAUFORT_UPPER_BOUNDS_KN.length; force++) {
    const bound = BEAUFORT_UPPER_BOUNDS_KN[force];
    // Force 0's band is 0 kn up to but NOT including 1 kn — the force-1 band
    // (1-3 kn) is closed on the left, so 1.0 kn exactly is force 1, not 0.
    // Every other boundary in this table is closed on both ends.
    if (force === 0 ? speedKn < bound : speedKn <= bound) return force;
  }
  return BEAUFORT_UPPER_BOUNDS_KN.length;
}

export interface DepartureCompareProps {
  // Null until a plan exists — #356a §3: "an explicit action on an EXISTING
  // plan", never something that runs standalone off raw form state. The
  // component renders nothing before that.
  plan: Plan | null;
  // usePlanFlow.ts's own exposed ensureClient — same pattern
  // state/replan.ts's useViaReplan and state/reroute.ts's useLiveReroute
  // already take, so this shares the one lazily-created worker singleton
  // rather than standing up a second one.
  ensureClient: () => Promise<ReplanClient | null>;
  // #937: called with the updated Plan once a two-rig confirm solve
  // succeeds — the ACTIVE plan is replaced (App.tsx passes its own
  // `setPlan`), same "the result you asked for becomes active
  // unconditionally on success" precedent handleLiveReroute follows.
  onConfirmed: (plan: Plan) => void;
}

type TFn = (key: MsgKey, vars?: Record<string, string | number>) => string;

// #936: among 'ok' candidates only, 1-based rank by ascending durationMs
// (fastest first) — the genoa-only scan's own comparable metric (§2.2, every
// 'ok' candidate is a single-rig result, so duration is directly comparable
// across candidates with no rig-mix confound). Unroutable candidates (both
// 'no-route' and 'failed') get `null`: they have no duration to rank by, and
// a rank number next to a failure would misrepresent it as merely "slower"
// rather than not achieved at all — the honesty rule this issue exists for.
// Returned as an array parallel to `candidates` (by index, not by
// departureMs) so a caller can zip it back without a lookup structure.
function rankCandidates(candidates: readonly DepartureCandidate[]): (number | null)[] {
  const okByDuration = candidates
    .map((c, i) => ({ i, c }))
    .filter(
      (
        entry,
      ): entry is {
        i: number;
        c: DepartureCandidate & { outcome: { kind: 'ok'; result: PlanResultOk } };
      } => entry.c.outcome.kind === 'ok',
    )
    .sort(
      (a, b) =>
        recommendedResult(a.c.outcome.result).durationMs -
        recommendedResult(b.c.outcome.result).durationMs,
    );
  const ranks: (number | null)[] = candidates.map(() => null);
  okByDuration.forEach((entry, rankIndex) => {
    ranks[entry.i] = rankIndex + 1;
  });
  return ranks;
}

interface CandidateCard {
  title: string;
  badges: string[];
  detail: string;
}

function candidateCard(
  candidate: DepartureCandidate,
  rank: number | null,
  windField: WindField,
  originPos: LatLon,
  lang: 'de' | 'en',
  t: TFn,
): CandidateCard {
  const title = formatDateTime(candidate.departureMs, lang);
  const badges: string[] = [];
  if (rank !== null) {
    badges.push(
      rank === 1
        ? t('departureScan.card.rank.fastest')
        : t('departureScan.card.rank.nth', { rank }),
    );
  }
  // Wind character is sampled at the ORIGIN, at this candidate's own
  // departure time — deliberately NOT a route-wide average, so it is
  // available identically for every outcome kind, including 'no-route' and
  // 'failed' candidates that never produced a route to average over. It
  // characterizes the departure window's own conditions, not the passage.
  const sample = windField.sample(originPos, candidate.departureMs);
  badges.push(
    t('departureScan.card.wind', {
      force: beaufortForce(sample.speedKn),
      heading: formatHeading(sample.dirFromDeg),
    }),
  );

  const { outcome } = candidate;
  if (outcome.kind === 'ok') {
    // §2.2: genoa-only by design (useDepartureScan.ts's GENOA_SCAN_SAIL_IDS)
    // — recommendedResult() is safe here because a genoa-only request always
    // resolves `recommended` to the scanned genoa sail when it produced a
    // route (PlanResultOk guarantees the recommended sail's result is
    // non-null).
    const rig = recommendedResult(outcome.result);
    const { motorPct } = motorSplit(rig);
    return {
      title,
      badges,
      detail: t('departureScan.candidate.ok', {
        eta: formatDateTime(rig.etaMs, lang),
        duration: formatDuration(rig.durationMs),
        distance: formatNm(rig.distanceNm, lang),
        motorPct,
      }),
    };
  }
  // Distinct causes render distinct text — never inferred from a message
  // string. 'no-route' carries a typed NoRouteReason (beyond-horizon is not
  // the same as unreachable is not the same as a snap failure); 'failed' is
  // a worker/infra failure, mapped through the same routingFailureKey()
  // classifier usePlanFlow.ts/replanWithVias use. Neither is presented as
  // merely "slower" than an 'ok' candidate — it has no rank badge and its
  // detail names its own cause, not a generic "no route" sentence.
  const detail =
    outcome.kind === 'no-route' ? t(NO_ROUTE_MESSAGE_KEY[outcome.reason]) : t(outcome.messageKey);
  return { title, badges, detail };
}

/**
 * #356 part (a) + (b): "Compare departure times" — an explicit, bounded,
 * cancellable genoa-only scan over a small number of departure windows
 * around the active plan's own departure time, rendered as a ranked list of
 * cards. Design: docs/superpowers/specs/2026-09-04-departure-comparison-design.md.
 * Deliberately its OWN top-level component rather than folded into
 * PlannerPanel.tsx — App.tsx renders it as a sibling of PlannerPanel inside
 * the Plan tab (see App.tsx's #830 seamarks-portal precedent for the same
 * pattern), so this feature's whole surface lives in one file instead of
 * threading new props through an already-large, concurrently-edited
 * component.
 *
 * #936 (this file, part b): each candidate is now its own ranked card in an
 * `<ol>` — the DOM order is chronological (`state.candidates`, by
 * `departureMs`), NOT rank order; `<ol>` numbers that chronological
 * position, and the rank badge (fastest / #n, by ascending duration — 'ok'
 * candidates only) is a separately-computed, independent signal shown as
 * badge content. rankCandidates()'s own test deliberately lists the slower
 * of two 'ok' candidates FIRST and asserts its `#2` badge resolves
 * correctly in that position, precisely to pin that DOM order and rank are
 * not the same thing. Every candidate also carries a wind-character badge
 * (Beaufort force + heading, sampled at the origin at that candidate's own
 * departure time, present for EVERY outcome kind), and an unroutable
 * candidate carries its own typed cause rather than a generic "no route"
 * sentence.
 *
 * (c) (two-rig confirm solve for the picked window, #937): each 'ok'
 * candidate's card gets a confirm action (useDepartureConfirm.ts) that
 * re-solves that exact window with the plan's own two rigs and replaces the
 * active plan on success. §2.2's genoa-only scan ranks windows; this is what
 * makes the plan the user actually sails carry the app's real, two-rig
 * recommendation. An 'ok' candidate whose confirmed two-rig result recommends
 * a DIFFERENT rig than the genoa the scan ranked it by is surfaced honestly
 * (the issue's own "worth surfacing rather than silently accepting" —
 * disagreement is evidence §2.2's measured aperture may be too narrow, not
 * something to hide), and a plan whose comparison is not 'decided' (tie,
 * moot, or a tier-C boat's not-compared) is never claimed as a disagreement
 * either way — no rig is named unless the router itself named one.
 */
export default function DepartureCompare({
  plan,
  ensureClient,
  onConfirmed,
}: DepartureCompareProps) {
  const t = useT();
  const [lang] = useLang();
  const { state, scan, cancel, reset: resetScan } = useDepartureScan(ensureClient);
  const { state: confirmState, confirm } = useDepartureConfirm(ensureClient);
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [stepHours, setStepHours] = useState<number>(DEFAULT_STEP_HOURS);
  // Set once a confirm() resolves successfully, keyed by that candidate's
  // departureMs — independent of confirmState (which only ever remembers the
  // MOST RECENT confirm attempt) because a stale success notice must not
  // linger once the user starts a later confirm elsewhere.
  const [confirmed, setConfirmed] = useState<{
    departureMs: number;
    // Set only when the confirmed two-rig result 'decided' a DIFFERENT rig
    // than the genoa the scan ranked this window by — never for 'tie'/
    // 'moot'/'not-compared' (nothing to disagree WITH there; claiming a rig
    // in that case would be the same unearned ★ the brief warns against).
    disagreeingRig: SailId | null;
  } | null>(null);
  const countId = useId();
  const stepId = useId();
  // Constructed unconditionally (before the `!plan` early return below) so
  // hook order stays fixed across a plan going from null to non-null and
  // back — same rule DepthProfile.tsx's own WindField follows. Wraps the
  // plan's own STORED grid only, never re-fetched.
  const windField = useMemo(() => (plan ? new WindField(plan.windGrid) : null), [plan]);

  // #960 review Major 1: the identity a confirm() continuation must still
  // match at resolution time — kept in sync after every render, so it always
  // names the CURRENTLY active plan, not the one a pending confirm() was
  // called against.
  const activePlanIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    activePlanIdentityRef.current = plan ? `${plan.id}-${plan.createdAtMs}` : null;
  });

  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // A different plan.id means a different route — candidates computed
  // against the prior one no longer describe it.
  useEffect(() => {
    resetScan();
  }, [plan?.id, resetScan]);

  if (!plan || !windField) return null;

  const handleScan = () => {
    setConfirmed(null);
    void scan({
      base: { ...plan.request },
      windGrid: plan.windGrid,
      stepHours,
      count,
    });
  };

  // #937: never generalises the scan's own genoa-only rig choice (§2.2) —
  // this re-solves with `plan.request.sailIds` unchanged (useDepartureConfirm.ts).
  const handleConfirm = (departureMs: number) => {
    setConfirmed(null);
    const identity = `${plan.id}-${plan.createdAtMs}`;
    void confirm(plan, departureMs).then((updated) => {
      // #960 review Major 1: discard a resolution that arrives after unmount
      // (tab switched away) or after the active plan has moved on (a
      // different confirm, recalc, or reroute already superseded it).
      if (!mountedRef.current || activePlanIdentityRef.current !== identity || !updated) return;
      const rec = rigRecommendationOf(updated.result);
      setConfirmed({
        departureMs,
        disagreeingRig: rec.kind === 'decided' && rec.rig !== GENOA_SAIL_ID ? rec.rig : null,
      });
      onConfirmed(updated);
    });
  };

  // A confirm and a scan share one worker singleton (ensureClient) — running
  // both at once risks one's failure disposing the client out from under the
  // other (disposeAfterFailure/failAll, state/replan.ts). Simplest safe rule:
  // neither may start while the other is in flight.
  const busy = state.scanning || confirmState.confirming;

  const ranks = rankCandidates(state.candidates);

  return (
    <Card title={t('departureScan.title')} className="departure-compare">
      <p className="sc-field-help">{t('departureScan.help')}</p>
      {!state.scanning && (
        <div className="departure-compare-controls">
          <Field label={t('departureScan.count.label')} htmlFor={countId}>
            <input
              id={countId}
              type="number"
              min={MIN_COUNT}
              max={MAX_COUNT}
              step={1}
              value={count}
              onChange={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isFinite(n)) {
                  setCount(Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(n))));
                }
              }}
            />
          </Field>
          <Field label={t('departureScan.step.label')} htmlFor={stepId}>
            <select
              id={stepId}
              value={stepHours}
              onChange={(e) => setStepHours(Number(e.currentTarget.value))}
            >
              {STEP_HOURS_OPTIONS.map((h) => (
                <option key={h} value={h}>
                  {t('departureScan.step.option', { hours: h })}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="secondary" onClick={handleScan} disabled={confirmState.confirming}>
            {t('departureScan.action')}
          </Button>
        </div>
      )}
      {state.error && <p role="status">{t(state.error)}</p>}
      {state.scanning && (
        <div className="departure-compare-progress">
          <p role="status">
            {t('departureScan.status.scanning', { index: state.index, total: state.total })}
          </p>
          <Button variant="ghost" onClick={cancel}>
            {t('departureScan.cancel')}
          </Button>
        </div>
      )}
      {!state.scanning && state.cancelled && (
        <Chip>{t('departureScan.status.cancelled', { count: state.candidates.length })}</Chip>
      )}
      {state.candidates.length > 0 && (
        <ol className="departure-compare-list">
          {state.candidates.map((candidate, i) => {
            const card = candidateCard(
              candidate,
              ranks[i] ?? null,
              windField,
              plan.request.origin,
              lang,
              t,
            );
            return (
              <li key={candidate.departureMs}>
                {/* #936 review Major 2: plain .sc-card/.sc-card-title, not
                    Card — avoids a second <h2> per candidate. */}
                <div className="sc-card">
                  <p className="sc-card-title">{card.title}</p>
                  <div className="departure-compare-badges">
                    {card.badges.map((badge) => (
                      <Chip key={badge}>{badge}</Chip>
                    ))}
                  </div>
                  <p className="sc-field-help">{card.detail}</p>
                  {/* #937: confirm action, 'ok' candidates only — nothing to
                      confirm for a no-route/failed window. */}
                  {candidate.outcome.kind === 'ok' &&
                    (confirmState.confirming &&
                    confirmState.departureMs === candidate.departureMs ? (
                      <p role="status">{t('departureScan.confirm.confirming')}</p>
                    ) : (
                      <Button
                        variant="primary"
                        onClick={() => handleConfirm(candidate.departureMs)}
                        disabled={busy}
                      >
                        {t('departureScan.confirm.action')}
                      </Button>
                    ))}
                  {confirmState.error && confirmState.departureMs === candidate.departureMs && (
                    <p className="inline-alert" role="alert">
                      {t(confirmState.error)}
                    </p>
                  )}
                  {confirmed?.departureMs === candidate.departureMs && (
                    <p role="status">
                      {confirmed.disagreeingRig
                        ? t('departureScan.confirm.done.disagreement', {
                            rig: t(sailLabelKey(confirmed.disagreeingRig)),
                          })
                        : t('departureScan.confirm.done')}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
