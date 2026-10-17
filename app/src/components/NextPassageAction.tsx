import { useId, useState } from 'react';
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
  const [nowMs] = useState(() => Date.now());
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
