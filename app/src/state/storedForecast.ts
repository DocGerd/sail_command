import type { Plan } from '../types';
import { cloneWaveGrid } from '../lib/waves';
import { cloneWindGrid } from './reroute';
import type { RunOptions } from './usePlanFlow';

// #1699: run() options carrying a plan's stored forecast as the #1707 fallback. Clones,
// so the new plan never aliases the old one's buffers; the wave grid travels
// with the wind grid because run() uses one exactly when it uses the other.
export function storedForecastRunOptions(
  plan: Pick<Plan, 'windGrid' | 'waveGrid'>,
): Pick<RunOptions, 'storedWindGrid' | 'storedWaveGrid'> {
  return {
    storedWindGrid: cloneWindGrid(plan.windGrid),
    ...(plan.waveGrid !== undefined ? { storedWaveGrid: cloneWaveGrid(plan.waveGrid) } : {}),
  };
}
