import { useState, type ReactNode } from 'react';

export interface DisclosureProps {
  /** The always-visible summary row content. */
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/**
 * A labelled expandable wrapping native <details>/<summary>, with a chevron
 * affordance that flips on open (CSS ::before glyph swap, matching the
 * route-legend / depth-profile convention). The summary is a >=44px touch
 * target for gloved cockpit use. Controlled internally (state seeded from
 * defaultOpen, kept in sync via onToggle) — the same pattern DepthProfile uses
 * to avoid React's controlled-<details> footgun.
 */
export default function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className={['sc-disclosure', className].filter(Boolean).join(' ')}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="sc-disclosure-summary">{summary}</summary>
      <div className="sc-disclosure-body">{children}</div>
    </details>
  );
}
