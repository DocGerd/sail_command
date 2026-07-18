import type { Ref } from 'react';
import { useT, useLang } from '../i18n';
import { formatHeading, formatKn, formatNm, formatTime } from '../lib/format';
import { toGpx } from '../lib/gpx';
import { activeRigResult, isStaleForecast, NO_ROUTE_MESSAGE_KEY } from '../lib/plan';
import { RIG_LABEL_KEY, resultSummary } from '../lib/resultSummary';
import type { MsgKey } from '../i18n/dict.de';
import type { Board, Leg, NoRouteReason, Plan, Rig } from '../types';
import Card from './Card';
import Chip from './Chip';
import Button from './Button';
import Disclosure from './Disclosure';

export interface RouteSummaryProps {
  plan: Plan;
  rig: Rig;
  onRigChange: (rig: Rig) => void;
  // #64 phase 3: focus target for the Plan-tab "Details ansehen" link — App
  // forwards it onto the Ergebnis card heading (tabIndex -1, focused on jump).
  resultHeadingRef?: Ref<HTMLHeadingElement>;
}

const RIGS: Rig[] = ['genoa', 'fock'];

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

function reasonForRig(plan: Plan, rig: Rig): NoRouteReason | null {
  return rig === 'genoa' ? plan.result.genoaReason : plan.result.fockReason;
}

function LegKindChip({ leg, rig }: { leg: Leg; rig: Rig }) {
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

function downloadGpx(plan: Plan, rig: Rig): void {
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

  return (
    <Card
      title={t('planner.card.result')}
      className="route-summary route-ergebnis"
      titleRef={resultHeadingRef}
      titleTabIndex={-1}
    >
      <div role="tablist" aria-label={t('route.rigTabs')} className="rig-tabs">
        {RIGS.map((r) => (
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
            {plan.result.recommended === r && (
              <span aria-label={t('route.recommended')} title={t('route.recommended')}>
                {' '}
                ★
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Additive faster-rig chip (the ★ on the tab stays — e2e depends on it). */}
      <Chip className="chip-faster-rig">
        {t('route.fasterRig', { rig: t(RIG_LABEL_KEY[plan.result.recommended]) })}
      </Chip>

      {stale && <p role="alert">{t('route.staleForecast')}</p>}

      {/* #53: plan-level shallow-water warning — both rigs solved at the same
          relaxed gate, so this renders on BOTH rig tabs (it sits outside the
          per-rig branch below). Persisted with the plan, so a reloaded plan
          renders it identically. */}
      {plan.result.shallow && (
        <p className="shallow-warning" role="alert">
          {t('route.shallow.banner', {
            requested: plan.result.shallow.requestedDepthM.toFixed(1),
            minGate: plan.result.shallow.minGateDepthM.toFixed(1),
          })}
        </p>
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
                  <th>{t('route.legs.kind')}</th>
                  <th>{t('route.legs.heading')}</th>
                  <th>{t('route.legs.twa')}</th>
                  <th>{t('route.legs.tws')}</th>
                  <th>{t('route.legs.speed')}</th>
                  <th>{t('route.legs.distance')}</th>
                  <th>{t('route.legs.maneuver')}</th>
                </tr>
              </thead>
              <tbody>
                {result.legs.map((leg, i) => (
                  <tr key={i}>
                    <td>{formatTime(leg.startTimeMs, lang)}</td>
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
