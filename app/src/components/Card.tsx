import type { ReactNode } from 'react';

export interface CardProps {
  /** Section label, rendered uppercase + letter-spaced via CSS. */
  title: string;
  className?: string;
  children: ReactNode;
}

/**
 * A bordered surface grouping one concern, with a muted, uppercase section
 * label heading. Deliberately a plain <div>, NOT a <section>/region landmark:
 * the endpoint sections it wraps already own the region tree (#64 phase 1), and
 * a second labelled region here would clutter the a11y landmark map. The title
 * is an <h2> so the wrapped endpoint headings sit one level below it (<h3>),
 * keeping a sane document outline (app <h1> → card <h2> → endpoint <h3>).
 */
export default function Card({ title, className, children }: CardProps) {
  return (
    <div className={['sc-card', className].filter(Boolean).join(' ')}>
      <h2 className="sc-card-title">{title}</h2>
      {children}
    </div>
  );
}
