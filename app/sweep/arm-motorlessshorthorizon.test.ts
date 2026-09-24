// #282 acceptance sweep, arm `motorless-short-horizon` (#1334). One file per
// arm so vitest runs each arm in its own parallel worker.
// Not collected by `npm run test` — see sweepArms.ts and README.md.
import { describe } from 'vitest';
import { runArm } from './sweepArms';

describe('#282 acceptance sweep', () => {
  runArm('motorless-short-horizon');
});
