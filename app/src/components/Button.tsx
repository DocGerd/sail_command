import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

/**
 * The app's button hierarchy on the locked `--sc-*` tokens: `primary` (accent
 * fill), `secondary` (accent outline), `ghost` (quiet). Hover/pressed consume
 * `--sc-accent-strong`; all three carry a visible accent focus-visible ring
 * (CSS in app.css). Native button props (type, disabled, onClick, aria-*) pass
 * straight through; `type` defaults to "button" since the app has no forms.
 */
export default function Button({ variant = 'primary', className, type, ...rest }: ButtonProps) {
  const classes = ['sc-btn', `sc-btn-${variant}`, className].filter(Boolean).join(' ');
  return <button type={type ?? 'button'} className={classes} {...rest} />;
}
