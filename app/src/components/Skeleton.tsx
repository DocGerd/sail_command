import type { CSSProperties } from 'react';

export interface SkeletonProps {
  className?: string;
  /** Inline sizing (width/height); the shimmer itself is CSS-driven. */
  style?: CSSProperties;
}

/**
 * A decorative loading placeholder (#64 phase 4, §3.5). Always `aria-hidden`:
 * it carries no information — the live status region (`role="status"`) is the
 * screen-reader feedback while planning is in flight. The subtle shimmer is a
 * CSS animation on the `.sc-skeleton` class, disabled to a static block under
 * `@media (prefers-reduced-motion: reduce)` (app.css).
 */
export default function Skeleton({ className, style }: SkeletonProps) {
  return (
    <span
      className={['sc-skeleton', className].filter(Boolean).join(' ')}
      style={style}
      aria-hidden="true"
    />
  );
}
