import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { LONG_RUNNING_NOTICE_MS, formatElapsed } from '../lib/planningElapsed';

/**
 * Elapsed time of the in-flight plan run. Deliberately outside the panel's
 * live region: a per-second text swap there would be announced every second.
 * Callers key it on the start time, so a new run remounts it.
 */
export default function PlanningElapsed({ startedAtMs }: { startedAtMs: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedMs = now - startedAtMs;
  return (
    <div className="planner-elapsed">
      <p className="planner-elapsed-time">
        {t('planner.status.elapsed', { time: formatElapsed(elapsedMs) })}
      </p>
      {elapsedMs >= LONG_RUNNING_NOTICE_MS && (
        <p className="planner-elapsed-notice">{t('planner.status.longRunning')}</p>
      )}
    </div>
  );
}
