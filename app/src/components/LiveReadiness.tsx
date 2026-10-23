import { useT } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';
import type { Plan } from '../types';
import type { AisStatus } from '../state/useAisTraffic';
import { useLiveReadiness, type LiveReadinessDeps } from '../state/useLiveReadiness';
import type { ReadinessCheckId } from '../lib/liveReadiness';
import Disclosure from './Disclosure';

const LABEL_KEY: Record<ReadinessCheckId, MsgKey> = {
  regions: 'live.ready.regions.label',
  glyphs: 'live.ready.glyphs.label',
  gps: 'live.ready.gps.label',
  forecast: 'live.ready.forecast.label',
  wakeLock: 'live.ready.wakeLock.label',
  ais: 'live.ready.ais.label',
};

// Text carries the state; the icon is decorative (WCAG 1.4.1).
function StateIcon({ ready }: { ready: boolean }) {
  return (
    <svg
      className="live-readiness-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ready ? <path d="M3 8.5 6.5 12 13 4.5" /> : <path d="M4 4l8 8M12 4l-8 8" />}
    </svg>
  );
}

export interface LiveReadinessProps {
  plan: Plan;
  arrivalMs: number;
  wakeLockSupported: boolean;
  aisStatus: AisStatus | null;
  gpsDenied: boolean;
  deps?: LiveReadinessDeps;
}

/** #1807: pre-sail checklist, collapsed so the glanceable card keeps its room. */
export default function LiveReadiness({
  plan,
  arrivalMs,
  wakeLockSupported,
  aisStatus,
  gpsDenied,
  deps,
}: LiveReadinessProps) {
  const t = useT();
  const checks = useLiveReadiness(
    plan,
    arrivalMs,
    { wakeLockSupported, aisStatus, gpsDenied },
    deps,
  );
  const ready = checks.filter((c) => c.ready).length;
  return (
    <Disclosure
      className="live-readiness"
      summary={t('live.ready.summary', { ready: String(ready), total: String(checks.length) })}
    >
      <p className="live-readiness-intro">{t('live.ready.intro')}</p>
      <ul className="live-readiness-list">
        {checks.map((c) => (
          <li
            key={c.id}
            data-check={c.id}
            className={
              c.ready ? 'live-readiness-item live-readiness-item--ok' : 'live-readiness-item'
            }
          >
            <StateIcon ready={c.ready} />
            <span className="live-readiness-label">{t(LABEL_KEY[c.id])}</span>
            <span className="live-readiness-state">
              {t(c.ready ? 'live.ready.state.ok' : 'live.ready.state.no')}
            </span>
            <span className="live-readiness-detail">{t(c.detailKey)}</span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
