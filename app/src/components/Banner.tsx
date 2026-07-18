import type { ReactNode } from 'react';

export type BannerKind = 'info' | 'warning' | 'error';

// An optional primary action rendered inside the banner (e.g. "Try again" on a
// recoverable network error). Distinct from `onDismiss`, which only clears the
// banner — an action re-drives a flow.
export interface BannerAction {
  label: string;
  onClick: () => void;
}

export interface BannerProps {
  kind: BannerKind;
  children: ReactNode;
  // `| undefined` so callers may pass a conditional `action={cond ? … : undefined}`
  // under exactOptionalPropertyTypes (App's retry action is network-only).
  action?: BannerAction | undefined;
  onDismiss?: () => void;
  dismissLabel?: string;
}

// 'info' is a passive live-region update; 'warning'/'error' need the more
// assertive role so screen readers announce them immediately even if focus
// is elsewhere (e.g. the offline/stale-forecast/persistence-error banners).
export default function Banner({ kind, children, action, onDismiss, dismissLabel }: BannerProps) {
  return (
    <div role={kind === 'info' ? 'status' : 'alert'} className={`banner banner-${kind}`}>
      <span className="banner-message">{children}</span>
      {action && (
        <button type="button" className="banner-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="banner-dismiss"
          onClick={onDismiss}
          aria-label={dismissLabel}
        >
          ×
        </button>
      )}
    </div>
  );
}
