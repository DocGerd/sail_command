import { useId, useState } from 'react';
import { useLang, useT } from '../i18n';
import type { Plan } from '../types';
import type { ReplanClient } from '../state/replan';
import { NO_ROUTE_MESSAGE_KEY } from '../lib/plan';
import { motorSplit } from '../lib/resultSummary';
import { recommendedResult } from '../types';
import { formatDateTime, formatDuration, formatNm } from '../lib/format';
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

function candidateRow(
  candidate: DepartureCandidate,
  lang: 'de' | 'en',
  t: (
    key: Parameters<ReturnType<typeof useT>>[0],
    vars?: Record<string, string | number>,
  ) => string,
): { label: string; detail: string } {
  const label = formatDateTime(candidate.departureMs, lang);
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
      label,
      detail: t('departureScan.candidate.ok', {
        eta: formatDateTime(rig.etaMs, lang),
        duration: formatDuration(rig.durationMs),
        distance: formatNm(rig.distanceNm, lang),
        motorPct,
      }),
    };
  }
  if (outcome.kind === 'no-route') {
    return { label, detail: t(NO_ROUTE_MESSAGE_KEY[outcome.reason]) };
  }
  return { label, detail: t(outcome.messageKey) };
}

/**
 * #356 part (a): "Compare departure times" — an explicit, bounded,
 * cancellable genoa-only scan over a small number of departure windows
 * around the active plan's own departure time, rendered as a plain ranked
 * list. Design: docs/superpowers/specs/2026-09-04-departure-comparison-design.md.
 * Deliberately its OWN top-level component rather than folded into
 * PlannerPanel.tsx — App.tsx renders it as a sibling of PlannerPanel inside
 * the Plan tab (see App.tsx's #830 seamarks-portal precedent for the same
 * pattern), so this feature's whole surface lives in one file instead of
 * threading new props through an already-large, concurrently-edited
 * component.
 *
 * (b) (ranked-card UI, wind character, no-route/beyond-horizon presentation
 * polish, #936) and (c) (two-rig confirm solve for the picked window, #937)
 * are explicitly NOT built here — this is the plain-list minimum the design
 * spec's §3 scopes to v0.21.0.
 */
export default function DepartureCompare({ plan, ensureClient }: DepartureCompareProps) {
  const t = useT();
  const [lang] = useLang();
  const { state, scan, cancel } = useDepartureScan(ensureClient);
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [stepHours, setStepHours] = useState<number>(DEFAULT_STEP_HOURS);
  const countId = useId();
  const stepId = useId();

  if (!plan) return null;

  const handleScan = () => {
    void scan({
      base: { ...plan.request },
      windGrid: plan.windGrid,
      stepHours,
      count,
    });
  };

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
        <ul className="departure-compare-list">
          {state.candidates.map((candidate) => {
            const row = candidateRow(candidate, lang, t);
            return (
              <li key={candidate.departureMs}>
                <span className="departure-compare-time">{row.label}</span>
                <span className="departure-compare-detail">{row.detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
