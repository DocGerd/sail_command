import { useEffect, useId, useState } from 'react';
import { useLang, useT } from '../i18n';
import { formatWeekdayTime } from '../lib/format';
import { seedNextPassage } from '../lib/planForm';
import type { SailId } from '../data/boats';
import type { Harbor, Plan } from '../types';
import Button from './Button';

export interface NextPassageProps {
  harbors: Harbor[];
  disabled: boolean;
  onNextPassage: () => void;
}

// Keeps the preview in step with the departure the tap will seed.
const NOW_REFRESH_MS = 60_000;

export default function NextPassageAction({
  plan,
  rig,
  harbors,
  disabled,
  onNextPassage,
}: NextPassageProps & { plan: Plan; rig: SailId | null }) {
  const t = useT();
  const [lang] = useLang();
  const previewId = useId();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const refresh = () => setNowMs(Date.now());
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const id = setInterval(refresh, NOW_REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  const seed = seedNextPassage(plan, rig, harbors, lang, nowMs);
  if (seed === null) return null;
  return (
    <div className="next-passage">
      <Button
        variant="secondary"
        disabled={disabled}
        aria-describedby={previewId}
        onClick={onNextPassage}
      >
        {t('planner.nextPassage.action')}
      </Button>
      <p className="planner-guidance" id={previewId}>
        {t('planner.nextPassage.preview', {
          harbor: seed.origin.label,
          departure: formatWeekdayTime(seed.departureMs, lang),
        })}
      </p>
    </div>
  );
}
