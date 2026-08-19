// #282 acceptance sweep, arm `breeze`. One file per arm so vitest runs each
// arm in its own parallel worker (see vitest.config.ts's `fileParallelism`
// comment for current timing — nine arms as of #452, not six).
// Not collected by `npm run test` — see sweepArms.ts and README.md.
import { describe } from 'vitest';
import { runArm } from './sweepArms';

describe('#282 acceptance sweep', () => {
  runArm('breeze');
});
