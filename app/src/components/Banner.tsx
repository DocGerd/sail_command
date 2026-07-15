import type { ReactNode } from 'react';

export type BannerKind = 'info' | 'warning' | 'error';

export interface BannerProps {
  kind: BannerKind;
  children: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}

// 'info' is a passive live-region update; 'warning'/'error' need the more
// assertive role so screen readers announce them immediately even if focus
// is elsewhere (e.g. the offline/stale-forecast/persistence-error banners).
export default function Banner({ kind, children, onDismiss, dismissLabel }: BannerProps) {
  return (
    <div role={kind === 'info' ? 'status' : 'alert'} className={`banner banner-${kind}`}>
      <span className="banner-message">{children}</span>
      {onDismiss && (
        <button type="button" className="banner-dismiss" onClick={onDismiss} aria-label={dismissLabel}>
          ×
        </button>
      )}
    </div>
  );
}
