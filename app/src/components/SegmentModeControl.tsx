import { useId } from 'react';
import Button from './Button';
import { useT } from '../i18n';
import type { SegmentMode } from '../types';

export interface SegmentModeControlProps {
  /** 0-based segment index: waypoint `index` -> `index + 1`. */
  index: number;
  fromLabel: string;
  toLabel: string;
  mode: SegmentMode | null;
  motorEnabled: boolean;
  onChange: (index: number, mode: SegmentMode | null) => void;
}

/**
 * #885 §6: the per-segment mode (solver decides / motor / sail) between two
 * waypoint rows. Button names are the bare mode words; the group's label carries
 * which segment they act on, so they never widen an existing accessible name.
 */
export default function SegmentModeControl({
  index,
  fromLabel,
  toLabel,
  mode,
  motorEnabled,
  onChange,
}: SegmentModeControlProps) {
  const t = useT();
  const labelId = useId();
  const noticeId = useId();
  // R4: shown while the motor is off. A segment already marked motor stays
  // pressed so the conflict is visible rather than silently cleared.
  const conflict = !motorEnabled && mode === 'motor';
  // The motor-off reason once (first segment), the conflict on its own segment.
  const showNotice = !motorEnabled && (conflict || index === 0);
  const options: { value: SegmentMode | null; label: string }[] = [
    { value: null, label: t('planner.segment.auto') },
    { value: 'motor', label: t('planner.segment.motor') },
    { value: 'sail', label: t('planner.segment.sail') },
  ];
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      {...(showNotice ? { 'aria-describedby': noticeId } : {})}
      className="planner-segment-mode"
    >
      <span id={labelId} className="sc-field-help">
        {t('planner.segment.group', { index: index + 1, from: fromLabel, to: toLabel })}
      </span>
      <div>
        {options.map((o) => (
          <Button
            key={o.value ?? 'auto'}
            variant={mode === o.value ? 'secondary' : 'ghost'}
            aria-pressed={mode === o.value}
            disabled={o.value === 'motor' && !motorEnabled && mode !== 'motor'}
            onClick={() => onChange(index, o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>
      {showNotice && (
        <p id={noticeId} className={conflict ? 'inline-alert' : 'sc-field-help'}>
          {t(conflict ? 'planner.segment.conflict' : 'planner.segment.motorOff')}
        </p>
      )}
    </div>
  );
}
