import { useState } from 'react';

export interface NumberInputProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (n: number) => void;
  /** Forwarded so a describing help paragraph can be linked (OptionsPanel). */
  'aria-describedby'?: string;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * A bare numeric `<input>` that keeps a local text draft while typing and
 * commits a clamped value on blur — the single source of the clamp/draft
 * behavior shared by OptionsPanel's advanced fields and PlannerPanel's compact
 * safety-depth field (#64 phase 3). Wrap it in a label/Field for the visible
 * label; this component supplies only the control.
 */
export default function NumberInput({
  id,
  value,
  min,
  max,
  step,
  onCommit,
  'aria-describedby': ariaDescribedby,
}: NumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  // Re-sync the draft when the committed value changes from outside (e.g. a
  // parent reset), but never mid-edit — onCommit only fires on blur, so the
  // prop can't change while this field itself is being typed into. Adjusted
  // during render (React's documented derive-state-from-prop pattern) rather
  // than in an effect, which would render once with the stale draft.
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
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      aria-describedby={ariaDescribedby}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleBlur}
    />
  );
}
