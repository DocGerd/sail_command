// #615: the results panel needs the shipped seamark collection on the MAIN
// thread to count hazard marks near the active rig's route
// (lib/seamarkProximity.ts). Same acquisition path useNavMask.ts already
// takes — loadRoutingAssets is a fetch-once module-cached singleton that
// ALREADY fetches data/seamarks.json unconditionally, in the same
// Promise.all as the mask and polars (services/assets.ts), so this adds no
// network work and no new asset; it merely observes what was loaded. The
// routing Web Worker is not involved.
import { useEffect, useState } from 'react';
import type { SeamarkFeatureCollection } from '../lib/seamarkGeoJson';
import { loadRoutingAssets } from '../services/assets';

export function useSeamarks(): SeamarkFeatureCollection | null {
  const [seamarks, setSeamarks] = useState<SeamarkFeatureCollection | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadRoutingAssets()
      .then((assets) => {
        if (cancelled) return;
        setSeamarks(assets.seamarks);
      })
      .catch((err: unknown) => {
        // Stays null, which the consumer renders as NOTHING — "not checked",
        // never a fabricated all-clear. Never throws into the results panel:
        // the notice is an advisory nudge and fails open (guard asymmetry).
        console.warn('useSeamarks: routing assets unavailable, seamark check disabled', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return seamarks;
}
