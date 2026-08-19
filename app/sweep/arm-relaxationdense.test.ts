// #282/#452 acceptance sweep, arm `relaxation-dense`. One file per arm so
// vitest runs the arms in parallel workers (~20 min wall instead of much
// longer serial). Not collected by `npm run test` — see sweepArms.ts and
// README.md.
import { describe } from 'vitest';
import { runArm } from './sweepArms';

describe('#282 acceptance sweep', () => {
  runArm('relaxation-dense');
});
