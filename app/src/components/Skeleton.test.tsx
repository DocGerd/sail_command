import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import Skeleton from './Skeleton';

afterEach(cleanup);

describe('Skeleton', () => {
  it('renders a decorative, aria-hidden span carrying the .sc-skeleton class', () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector('span.sc-skeleton');
    expect(el).not.toBeNull();
    // Decorative only — kept out of the accessibility tree; the live status
    // region is the screen-reader feedback while planning.
    expect(el).toHaveAttribute('aria-hidden', 'true');
  });

  it('never exposes an accessible role or text (no announcement)', () => {
    render(<Skeleton />);
    // aria-hidden hides it from every query-by-role/text lookup.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('merges an extra className alongside .sc-skeleton (the reduced-motion CSS hook)', () => {
    // The shimmer and its `prefers-reduced-motion: reduce` static fallback both
    // key off the stable `.sc-skeleton` class — assert it is always present and
    // composes with a caller class rather than replacing it.
    const { container } = render(<Skeleton className="skeleton-stat" />);
    const el = container.querySelector('span');
    expect(el).toHaveClass('sc-skeleton', 'skeleton-stat');
  });

  it('forwards inline sizing style', () => {
    const { container } = render(<Skeleton style={{ width: '4rem' }} />);
    expect(container.querySelector('span')).toHaveStyle({ width: '4rem' });
  });
});
