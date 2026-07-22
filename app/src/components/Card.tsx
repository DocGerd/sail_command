import type { ReactNode, Ref } from 'react';

export interface CardProps {
  /** Section label, rendered uppercase + letter-spaced via CSS. */
  title: string;
  className?: string;
  children: ReactNode;
  /**
   * Optional ref + tabIndex on the title `<h2>` so a card heading can be a
   * programmatic focus target (#64 phase 3: the Plan-tab "Details ansehen"
   * link moves focus to the Routes Ergebnis heading). Omitted by default, so
   * existing cards are unchanged.
   */
  titleRef?: Ref<HTMLHeadingElement> | undefined;
  titleTabIndex?: number | undefined;
}

/**
 * A bordered surface grouping one concern, with a muted, uppercase section
 * label heading. Deliberately a plain <div>, NOT a <section>/region landmark:
 * the endpoint sections it wraps already own the region tree (#64 phase 1), and
 * a second labelled region here would clutter the a11y landmark map. The title
 * is an <h2> so the wrapped endpoint headings sit one level below it (<h3>),
 * keeping a sane document outline (app <h1> → card <h2> → endpoint <h3>).
 */
export default function Card({ title, className, children, titleRef, titleTabIndex }: CardProps) {
  return (
    <div className={['sc-card', className].filter(Boolean).join(' ')}>
      <h2 className="sc-card-title" ref={titleRef} tabIndex={titleTabIndex}>
        {title}
      </h2>
      {children}
    </div>
  );
}
