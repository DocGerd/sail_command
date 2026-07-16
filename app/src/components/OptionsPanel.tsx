import { useState } from 'react';
import type { Settings } from '../types';
import { useT } from '../i18n';
import type { MsgKey } from '../i18n/dict.de';

export interface OptionsPanelProps {
  value: Settings;
  onChange: (settings: Settings) => void;
}

type NumericKey =
  'safetyDepthM' | 'motorSpeedKn' | 'motorThresholdKn' | 'maneuverPenaltyS' | 'performanceFactor';

interface FieldSpec {
  key: NumericKey;
  labelKey: MsgKey;
  min: number;
  max: number;
  step: number;
}

const FIELDS: FieldSpec[] = [
  // 2.2 m is a safety decision, not a UI nicety: it must never allow a value
  // below the 2.1 m draft plus a minimum safety margin.
  { key: 'safetyDepthM', labelKey: 'options.safetyDepth.label', min: 2.2, max: 10, step: 0.1 },
  { key: 'motorSpeedKn', labelKey: 'options.motorSpeed.label', min: 1, max: 10, step: 0.1 },
  { key: 'motorThresholdKn', labelKey: 'options.motorThreshold.label', min: 0, max: 5, step: 0.1 },
  { key: 'maneuverPenaltyS', labelKey: 'options.maneuverPenalty.label', min: 0, max: 300, step: 1 },
  {
    key: 'performanceFactor',
    labelKey: 'options.performanceFactor.label',
    min: 0.5,
    max: 1.1,
    step: 0.05,
  },
];

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // Re-sync the draft when the committed value changes from outside (e.g. a
  // parent reset), but never mid-edit — onCommit only fires on blur, so the
  // prop can't change while this field itself is being typed into. Adjusted
  // during render (React's documented pattern for deriving state from a
  // prop change) rather than in an effect, which would cause an extra
  // render pass after the DOM has already committed the stale draft.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(String(value));
  }

  const handleBlur = () => {
    // Number('') is 0, not NaN — an emptied field must fall back to the last
    // committed value, not silently clamp to a spurious zero.
    const parsed = draft.trim() === '' ? NaN : Number(draft);
    const next = Number.isFinite(parsed) ? clamp(parsed, min, max) : value;
    setDraft(String(next));
    onCommit(next);
  };

  return (
    <div className="options-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
      />
    </div>
  );
}

export default function OptionsPanel({ value, onChange }: OptionsPanelProps) {
  const t = useT();

  const commitField = (key: NumericKey, n: number) => {
    if (n === value[key]) return; // blur without a real change: no redundant update
    onChange({ ...value, [key]: n });
  };

  return (
    <div className="options-panel">
      {FIELDS.map((f) => (
        <NumberField
          key={f.key}
          id={`options-${f.key}`}
          label={t(f.labelKey)}
          value={value[f.key]}
          min={f.min}
          max={f.max}
          step={f.step}
          onCommit={(n) => commitField(f.key, n)}
        />
      ))}
      <div className="options-field">
        <label htmlFor="options-motorEnabled">{t('options.motorEnabled.label')}</label>
        <input
          id="options-motorEnabled"
          type="checkbox"
          checked={value.motorEnabled}
          aria-describedby="options-motorEnabled-help"
          onChange={(e) => onChange({ ...value, motorEnabled: e.target.checked })}
        />
      </div>
      {/* Sibling of the checkbox field, not a child of it: the wide-layout rule
          turns the checkbox `.options-field` into a flex row, which would strand
          a third child inline. aria-describedby links by id regardless of nesting.
          A visible paragraph, never a `title` tooltip — tooltips don't exist for
          gloved touch. */}
      <p className="options-help" id="options-motorEnabled-help">
        {t('options.motorEnabled.help')}
      </p>
    </div>
  );
}
