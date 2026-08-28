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
 * Pure parse-then-clamp resolution for a blur commit (#731 review round 2).
 * Extracted out of `handleBlur` so it can be unit-tested directly, INCLUDING
 * the `Infinity`/`-Infinity` branch of the finite guard — which a rendered
 * `<input type="number">` can never actually exercise. Per the WHATWG HTML
 * "rules for parsing floating-point number values" algorithm, a value whose
 * parsed RESULT is non-finite (e.g. "1e400") is not a valid floating-point
 * number, so a spec-compliant `<input type="number">` (jsdom included —
 * measured directly against jsdom's own sanitizer) sanitizes it to the empty
 * string BEFORE this component's `onChange` ever sees it: `draft` can never
 * actually hold a string that parses to a non-finite number when reached
 * through the rendered widget. A DOM-level test asserting the Infinity case
 * would therefore be silently vacuous — the mutation it exists to catch
 * could never fire, since the empty-string branch would take over instead.
 * This function is exported ONLY so its own test file can drive `draft`
 * values the real widget structurally cannot produce, proving the finite
 * guard correct for the FULL domain the type signature promises, not just
 * the widget's reachable subset of it.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveNumberCommit(
  draft: string,
  lastCommitted: number,
  min: number,
  max: number,
): { next: number; wasClamped: boolean } {
  // Number('') is 0, not NaN — an emptied field must fall back to the last
  // committed value, not silently clamp to a spurious zero. This revert is
  // NOT a clamp (#731): the user didn't type a real out-of-range number, so
  // there is nothing to report a correction for — the issue this component
  // exists to fix is scoped to the real-out-of-range case only. A non-finite
  // parse (NaN, or the Infinity/-Infinity this widget can't actually
  // produce — see this function's own doc comment) takes the SAME silent
  // revert, deliberately: neither is "a real number outside [min, max]".
  const parsed = draft.trim() === '' ? NaN : Number(draft);
  if (!Number.isFinite(parsed)) {
    return { next: lastCommitted, wasClamped: false };
  }
  const next = clamp(parsed, min, max);
  return { next, wasClamped: next !== parsed };
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
    const { next, wasClamped } = resolveNumberCommit(draft, value, min, max);
    setDraft(String(next));
    onCommit(next, wasClamped);
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
 * each caller (rendered inline — see SettingsPanel.tsx's `NumericField` /
 * PlannerPanel.tsx's inline safety-depth field), so this hook holds just the
 * small bit of state both callers need: the last corrected value, and when
 * to forget it.
 *
 * MOUNT SHAPE (PR #758 review round 2): the rendered `role="status"`
 * element is now ALWAYS MOUNTED, empty until a correction occurs — the same
 * shape `BoatPicker`'s #563 MAJOR 1 fix established (a live region must
 * already be in the accessibility tree BEFORE its text changes, or AT has
 * nothing to observe the mutation on). #731's own issue text pre-approved a
 * CONDITIONALLY-mounted alternative as "a deliberate trade-off", which is
 * what this shipped as through PR #758's first round — but safety depth is
 * a safety-relevant field, and per the guard-asymmetry principle
 * (CLAUDE.md) the weaker AT guarantee is the wrong default for it. Switched
 * to always-mounted because it turned out to be genuinely free here: both
 * callers already reuse `.boat-picker-notice`, whose `:empty` rule (added
 * for BoatPicker itself) already zeroes the box to no layout cost — no new
 * CSS, no new visual claim, just the SAME rule BoatPicker's own
 * always-mounted notice already relies on. See NumericField's / the inline
 * field's own render for the `correctedTo !== null ? … : null` shape that
 * keeps the element genuinely EMPTY (no child nodes at all) when there is
 * nothing to say, which is what makes `:empty` match.
 *
 * The correction-state reset is keyed on BOUNDS, not on value: a value can
 * change for reasons that have nothing to do with a correction (the other
 * synced surface for this same setting, a saved-plan load) without
 * invalidating a just-shown notice. But a boat switch that moves `min`/`max`
 * out from under the field means the notice's own numbers — and the bounds
 * it was correcting against — are no longer accurate, so it must not
 * survive that. Reset during render (React's documented derive-state-from-
 * prop pattern), the same technique `NumberInput`'s own `prevValue`/`draft`
 * resync above uses — not a `useEffect`, which would render one extra frame
 * with the stale notice still showing.
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
