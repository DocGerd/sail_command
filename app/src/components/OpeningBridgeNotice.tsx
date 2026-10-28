import { useMemo } from 'react';
import { useT } from '../i18n';
import { bridgesPassed } from '../lib/openingBridges';
import type { Leg } from '../types';

// #1881: quiet advisory per opening bridge the active rig passes. Memoised on
// `legs` alone: a #114 recalculate-and-replace or a rig-tab switch hands this
// a different array, as for SeamarkProximityNotice (RouteSummary.tsx).
export function OpeningBridgeNotice({ legs }: { legs: readonly Leg[] | null | undefined }) {
  const t = useT();
  const bridges = useMemo(() => bridgesPassed(legs), [legs]);
  if (bridges.length === 0) return null;
  return (
    <>
      {bridges.map((bridge) => (
        <p key={bridge.id} className="opening-bridge-notice">
          {t('route.bridge.notice', { name: bridge.name })}{' '}
          <a href={bridge.infoUrl} target="_blank" rel="noopener noreferrer">
            {t('route.bridge.link')}
          </a>
        </p>
      ))}
    </>
  );
}
