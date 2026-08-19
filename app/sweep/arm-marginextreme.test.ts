// #282/#452 acceptance sweep, arm `margin-extreme`. One file per arm so
// vitest runs each arm in its own parallel worker (see vitest.config.ts's
// `fileParallelism` comment for current timing). Not collected by
// `npm run test` — see sweepArms.ts and README.md.
import { describe } from 'vitest';
import { runArm } from './sweepArms';

describe('#282 acceptance sweep', () => {
  runArm('margin-extreme');
});
