export interface SliderProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  /** Forwarded so a describing help paragraph can be linked (mirrors
      NumberInput.tsx's identical prop). */
  'aria-describedby'?: string;
  /**
   * Overrides what a screen reader announces for the CURRENT value (#513
   * F6) — without it, a range input announces its bare numeric `value`
   * ("0.5", "1", "1.5"), which disagrees with whatever unit the caller
   * displays visually (e.g. a percent readout showing "50%"/"100%"/"150%").
   * Kept as an OPTIONAL prop rather than baking in percent formatting here:
   * this primitive is meant to stay reusable for a future non-percent
   * caller, so unit formatting is the caller's concern, same as the label
   * text itself.
   */
  'aria-valuetext'?: string;
}

/**
 * A bare `<input type="range">` — the continuous-value sibling of
 * NumberInput.tsx (#353: the seamark symbol-size control). Unlike
 * NumberInput's commit-on-blur draft, a range input's native 'input' event
 * already fires live as the user drags, so there is no local draft state to
 * manage here: `onChange` is called with the live value on every tick, the
 * same way OpenCPN's own scale-factor slider (cited in #353) behaves.
 * Wrap it in `Field` for the visible label, same convention as NumberInput
 * — this component supplies only the control, unstyled beyond the global
 * `input, select { min-height: 40px }` rule every other input in this app
 * already gets (no hardcoded colors/spacing, per the locked `--sc-*` token
 * rule — a plain range input needs none to read correctly here).
 */
export default function Slider({
  id,
  value,
  min,
  max,
  step,
  onChange,
  'aria-describedby': ariaDescribedby,
  'aria-valuetext': ariaValuetext,
}: SliderProps) {
  return (
    <input
      id={id}
      type="range"
      className="sc-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-describedby={ariaDescribedby}
      aria-valuetext={ariaValuetext}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
