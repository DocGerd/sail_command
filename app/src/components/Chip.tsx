import type { HTMLAttributes } from 'react';

export type ChipProps = HTMLAttributes<HTMLSpanElement>;

/**
 * A small pill, reusing the existing `.chip` visual language (RouteSummary's
 * leg/maneuver chips) rather than duplicating its CSS. Extra props (className,
 * aria-*, title) are forwarded onto the span.
 */
export default function Chip({ className, children, ...rest }: ChipProps) {
  return (
    <span className={['chip', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </span>
  );
}
