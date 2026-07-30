// #251: the Live view needs the depth mask on the MAIN thread to probe the
// heading-to-steer bearing. Same acquisition path RouteLayer and DepthProfile
// already use — loadRoutingAssets is a fetch-once module-cached singleton, so
// this adds no extra network work. The routing Web Worker is not involved.
import { useEffect, useState } from 'react';
import { NavMask } from '../lib/mask';
import { loadRoutingAssets } from '../services/assets';

export function useNavMask(): NavMask | null {
  const [mask, setMask] = useState<NavMask | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadRoutingAssets()
      .then((assets) => {
        if (cancelled) return;
        setMask(new NavMask(assets.maskMeta, new Uint8Array(assets.maskBuffer)));
      })
      .catch((err: unknown) => {
        // Stays null, which the caller renders as 'depth not checked'. Never
        // throws into the Live view: a missing mask must degrade to an honest
        // "could not check", never to a blank readout.
        console.warn('useNavMask: routing assets unavailable, depth check disabled', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return mask;
}
