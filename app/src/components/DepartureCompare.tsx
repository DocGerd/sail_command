import { useId, useMemo, useState } from 'react';
import { useLang, useT } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import type { LatLon, Plan, PlanResultOk } from '../types';
import type { ReplanClient } from '../state/replan';
import { NO_ROUTE_MESSAGE_KEY } from '../lib/plan';
import { motorSplit } from '../lib/resultSummary';
import { recommendedResult } from '../types';
import { formatDateTime, formatDuration, formatHeading, formatNm } from '../lib/format';
import { WindField } from '../lib/wind';
import { useDepartureScan, type DepartureCandidate } from '../state/useDepartureScan';
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
// table — 0: 0-1, 1: 1-3, 2: 4-6, 3: 7-10, 4: 11-16, 5: 17-21, 6: 22-27,
// 7: 28-33, 8: 34-40, 9: 41-47, 10: 48-55, 11: 56-63, 12: 64+). This is a
// real, universal maritime convention, not an invented category scale — the
// number it summarizes always comes from a real windGrid sample.
// index i = force i's inclusive upper bound; a speed above the last entry is
// force 12 (hurricane).
const BEAUFORT_UPPER_BOUNDS_KN = [1, 3, 6, 10, 16, 21, 27, 33, 40, 47, 55, 63] as const;

function beaufortForce(speedKn: number): number {
  for (let force = 0; force < BEAUFORT_UPPER_BOUNDS_KN.length; force++) {
    if (speedKn <= BEAUFORT_UPPER_BOUNDS_KN[force]) return force;
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
 * #936 (this file, part b): each candidate is now its own `Card` ("ranked
 * card" — an ordered list, `<ol>`, since rank IS list order for 'ok'
 * candidates), carrying a rank badge (fastest / #n, by ascending duration —
 * 'ok' candidates only), a wind-character badge (Beaufort force + heading,
 * sampled at the origin at that candidate's own departure time, present for
 * EVERY outcome kind), and — for an unroutable candidate — its own typed
 * cause rather than a generic "no route" sentence. Known trade-off: `Card`
 * hardcodes an `<h2>` title with no level prop, so nesting one per candidate
 * inside this component's own outer `Card` produces a flat sequence of `<h2>`
 * elements rather than a `<h2>` -> `<h3>` hierarchy; `Card.tsx` is outside
 * this PR's file scope, so this is accepted rather than worked around with a
 * bespoke bordered `<div>` (which would mean inventing new CSS — the one
 * thing this PR was briefed not to do).
 *
 * (c) (two-rig confirm solve for the picked window, #937) is explicitly NOT
 * built here — this PR adds no click target for picking a window; #937 will
 * add the confirm action on top of the card shape below.
 */
export default function DepartureCompare({ plan, ensureClient }: DepartureCompareProps) {
  const t = useT();
  const [lang] = useLang();
  const { state, scan, cancel } = useDepartureScan(ensureClient);
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [stepHours, setStepHours] = useState<number>(DEFAULT_STEP_HOURS);
  const countId = useId();
  const stepId = useId();
  // Constructed unconditionally (before the `!plan` early return below) so
  // hook order stays fixed across a plan going from null to non-null and
  // back — same rule DepthProfile.tsx's own WindField follows. Wraps the
  // plan's own STORED grid only, never re-fetched.
  const windField = useMemo(() => (plan ? new WindField(plan.windGrid) : null), [plan]);

  if (!plan || !windField) return null;

  const handleScan = () => {
    void scan({
      base: { ...plan.request },
      windGrid: plan.windGrid,
      stepHours,
      count,
    });
  };

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
          <Button variant="secondary" onClick={handleScan}>
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
                <Card title={card.title}>
                  <div className="departure-compare-badges">
                    {card.badges.map((badge) => (
                      <Chip key={badge}>{badge}</Chip>
                    ))}
                  </div>
                  <p className="sc-field-help">{card.detail}</p>
                </Card>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
