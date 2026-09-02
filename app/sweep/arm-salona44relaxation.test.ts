// #282/#653 acceptance sweep, arm `salona44-relaxation` — the Salona 44
// "SPEEDY GO!" mirror of `relaxation-dense` (Marstal origin, #53 depth
// relaxation exercised for a second catalogue boat). One file per arm so
// vitest runs the arms in parallel workers. Not collected by
// `npm run test` — see sweepArms.ts and README.md.
import { describe } from 'vitest';
import { runArm } from './sweepArms';

describe('#282 acceptance sweep', () => {
  runArm('salona44-relaxation');
});
