import { useState } from 'react';
import type { Lang } from '../lib/format';

export interface NumberInputProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  // #731: a second argument reports whether this commit pulled a real,
  // finite, out-of-range value back inside [min, max] — the "was I
  // corrected" signal the silent clamp was missing. `false` on every other
  // commit path, including the empty/garbage-input revert (handleBlur's own
  // comment below says why that one stays silent).
  onCommit: (n: number, wasClamped: boolean) => void;
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
    // committed value, not silently clamp to a spurious zero. This revert is
    // NOT a clamp (#731): the user didn't type a real out-of-range number,
    // so there is nothing to report a correction for — the issue this
    // component exists to fix is scoped to the real-out-of-range case only.
    const parsed = draft.trim() === '' ? NaN : Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      onCommit(value, false);
      return;
    }
    const next = clamp(parsed, min, max);
    setDraft(String(next));
    onCommit(next, next !== parsed);
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

/**
 * #731: the "was I corrected" signal NumberInput's `onCommit` now reports is
 * a one-shot boolean at blur time — the VISIBLE correction line is owned by
 * each caller (rendered inline, per the `Field` help-paragraph "mount only
 * while there's something to say" pattern — see SettingsPanel.tsx's
 * `NumericField` / PlannerPanel.tsx's inline safety-depth field), so this
 * hook holds just the small bit of state both callers need: the last
 * corrected value, and when to forget it.
 *
 * The reset is keyed on BOUNDS, not on value: a value can change for reasons
 * that have nothing to do with a correction (the other synced surface for
 * this same setting, a saved-plan load) without invalidating a just-shown
 * notice. But a boat switch that moves `min`/`max` out from under the field
 * means the notice's own numbers — and the bounds it was correcting
 * against — are no longer accurate, so it must not survive that. Reset
 * during render (React's documented derive-state-from-prop pattern), the
 * same technique `NumberInput`'s own `prevValue`/`draft` resync above uses —
 * not a `useEffect`, which would render one extra frame with the stale
 * notice still showing.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useClampCorrection(min: number, max: number) {
  const [correctedTo, setCorrectedTo] = useState<number | null>(null);
  const [prevBounds, setPrevBounds] = useState({ min, max });
  if (prevBounds.min !== min || prevBounds.max !== max) {
    setPrevBounds({ min, max });
    setCorrectedTo(null);
  }
  const reportCommit = (n: number, wasClamped: boolean): void => {
    setCorrectedTo(wasClamped ? n : null);
  };
  return { correctedTo, reportCommit };
}

/**
 * Locale-aware plain-number formatting for the `numberInput.corrected`
 * dict key's `{value}`/`{min}`/`{max}` placeholders (#731) — deliberately
 * unit-less, since every field's own label already carries its unit in
 * parentheses ("Sicherheitstiefe (m)", "Motorfahrtgeschwindigkeit (kn)", …).
 * Every `FieldSpec` bound in this app today has at most one decimal place;
 * `maximumFractionDigits` (with no `minimum`) renders "10", not "10.0", and
 * "2.2"/"2,2" per `lang` — no forced trailing zeros the field's own step
 * didn't ask for.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function formatBound(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-GB', {
    maximumFractionDigits: 2,
  }).format(n);
}
