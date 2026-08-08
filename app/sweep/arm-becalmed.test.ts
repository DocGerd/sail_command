// #282 acceptance sweep, arm `becalmed`. One file per arm so vitest runs the six
// arms in parallel workers (~20 min wall instead of ~50 min serial).
// Not collected by `npm run test` — see sweepArms.ts and README.md.
import { describe } from 'vitest';
import { runArm } from './sweepArms';

describe('#282 acceptance sweep', () => {
  runArm('becalmed');
});
