import { useT, useLang } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import { formatDateTime, formatDuration, formatHeading, formatKn, formatNm, formatTime } from '../lib/format';
import { toGpx } from '../lib/gpx';
import { activeRigResult, isStaleForecast } from '../lib/plan';
import type { Board, Leg, NoRouteReason, Plan, Rig } from '../types';

export interface RouteSummaryProps {
  plan: Plan;
  rig: Rig;
  onRigChange: (rig: Rig) => void;
}

const RIGS: Rig[] = ['genoa', 'fock'];

const RIG_LABEL_KEY: Record<Rig, MsgKey> = {
  genoa: 'route.rig.genoa',
  fock: 'route.rig.fock',
};

// Mirrors usePlanFlow.ts's NO_ROUTE_MESSAGE_KEY. Kept as a separate local
// copy rather than imported/shared: usePlanFlow.ts is outside this task's
// file list, and the mapping is small enough that duplicating it doesn't
// cost much.
const NO_ROUTE_MESSAGE_KEY: Record<NoRouteReason, MsgKey> = {
  unreachable: 'error.noRoute.unreachable',
  'beyond-horizon': 'error.noRoute.beyondHorizon',
  'calm-motor-off': 'error.noRoute.calmMotorOff',
  'snap-failed-origin': 'error.noRoute.snapOrigin',
  'snap-failed-destination': 'error.noRoute.snapDestination',
  'snap-failed-via': 'error.noRoute.snapVia',
};

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

function LegKindChip({ leg }: { leg: Leg }) {
  const t = useT();
  if (leg.kind === 'motor') {
    return <span className="chip chip-motor">{t('route.kind.motor')}</span>;
  }
  const boardKey = leg.board === 'port' ? 'route.board.port' : 'route.board.starboard';
  return (
    <span className="chip chip-sail">
      <span
        className={`board-dot board-dot-${leg.board}`}
        aria-hidden="true"
        style={{ backgroundColor: BOARD_COLOR[leg.board] }}
      />
      {t(boardKey)} {t(pointOfSailKey(leg.twaDeg))}
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

export default function RouteSummary({ plan, rig, onRigChange }: RouteSummaryProps) {
  const t = useT();
  const [lang] = useLang();
  const result = activeRigResult(plan, rig);
  const stale = isStaleForecast(plan);
  const reason = !result ? reasonForRig(plan, rig) : null;

  return (
    <div className="route-summary">
      <div role="tablist" aria-label={t('route.rigTabs')}>
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

      {stale && <p role="alert">{t('route.staleForecast')}</p>}

      {!result ? (
        <p role="alert">{t(reason ? NO_ROUTE_MESSAGE_KEY[reason] : 'error.internal')}</p>
      ) : (
        <>
          <dl className="route-totals">
            <dt>{t('route.totals.distance')}</dt>
            <dd>{formatNm(result.distanceNm)}</dd>
            <dt>{t('route.totals.duration')}</dt>
            <dd>{formatDuration(result.durationMs)}</dd>
            <dt>{t('route.totals.eta')}</dt>
            <dd>{formatDateTime(result.etaMs, lang)}</dd>
            <dt>{t('route.totals.maneuvers')}</dt>
            <dd>{result.maneuverCount}</dd>
            {result.motorDistanceNm > 0 && (
              <>
                <dt>{t('route.totals.motorDistance')}</dt>
                <dd>{formatNm(result.motorDistanceNm)}</dd>
              </>
            )}
          </dl>

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
                    <LegKindChip leg={leg} />
                  </td>
                  <td>{formatHeading(leg.headingDeg)}</td>
                  <td>{leg.kind === 'sail' ? `${Math.round(Math.abs(leg.twaDeg))}°` : '—'}</td>
                  <td>{formatKn(leg.twsKn)}</td>
                  <td>{formatKn(leg.speedKn)}</td>
                  <td>{formatNm(leg.distanceNm)}</td>
                  <td>
                    {leg.maneuverAtStart && (
                      <span className="chip chip-maneuver">
                        {t(leg.maneuverAtStart === 'tack' ? 'route.maneuver.tack' : 'route.maneuver.gybe')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button type="button" onClick={() => downloadGpx(plan, rig)}>
            {t('route.exportGpx')}
          </button>
        </>
      )}
    </div>
  );
}
