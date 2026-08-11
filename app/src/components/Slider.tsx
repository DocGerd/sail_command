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
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
