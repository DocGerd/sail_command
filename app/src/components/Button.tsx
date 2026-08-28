import type { ButtonHTMLAttributes, Ref } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  // #705: React 19.2.8 forwards `ref` as an ordinary prop at runtime — the
  // blocker was TypeScript's prop type, not React, so no `forwardRef` is
  // needed. Lets a parent (e.g. AboutDialog's open/close-focus management)
  // hold a ref to the rendered <button>.
  ref?: Ref<HTMLButtonElement>;
}

/**
 * The app's button hierarchy on the locked `--sc-*` tokens: `primary` (accent
 * fill), `secondary` (accent outline), `ghost` (quiet). Hover/pressed consume
 * `--sc-accent-strong`; all three carry a visible accent focus-visible ring
 * (CSS in app.css). Native button props (type, disabled, onClick, aria-*) pass
 * straight through; `type` defaults to "button" since the app has no forms.
 */
export default function Button({
  variant = 'primary',
  className,
  type,
  ref,
  ...rest
}: ButtonProps) {
  const classes = ['sc-btn', `sc-btn-${variant}`, className].filter(Boolean).join(' ');
  return <button type={type ?? 'button'} className={classes} ref={ref} {...rest} />;
}
