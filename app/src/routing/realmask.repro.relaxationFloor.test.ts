import { describe, expect, it, vi } from 'vitest';
import { findRelaxedGate } from './relaxedDepth';
import { APPROACH_RADIUS_M } from '../lib/depthGate';
import type { LatLon } from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { mask, FLENSBURG } from '../test/realmaskFixtures';

// #878: split out of the former realmask.repro.test.ts (~1286 lines, five
// top-level describe blocks) so vitest can parallelise the real-mask suite
// across files/cores — one monopolizing file previously set the whole `app`
// job's wall clock while other cores idled. Pure relocation of this
// describe block; shared setup lives in ../test/realmaskFixtures.ts. These run
// against the real shipped mask and polars, unlike the synthetic masks used
// everywhere else in the suite.
//
// #1261: (b) WIRING (the `planRoute`-level case, ~531 s CI — the file's own
// heaviest test) was split into its own sibling file,
// realmask.repro.relaxationFloor.wiring.test.ts, so vitest can schedule it
// on a separate worker. Pure relocation; (a)/(a2) below call `findRelaxedGate`
// directly and stay fast.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

describe('#54 spec C.4(a): the relaxation floor comes from the selected boat', () => {
  const POCKET: LatLon = { lat: 54.8652, lon: 10.5313 };
  const REQUESTED_DEPTH_M = 3.0;

  // The two rows below are NOT redundant. (a) guards the FIXTURE at the
  // `findRelaxedGate` level and cannot see this task's wiring at all; (b) is
  // the wiring test (realmask.repro.relaxationFloor.wiring.test.ts) and is
  // the only row a `planRoute.ts` perturbation can red. Without (a), a
  // future mask rebuild that made this pocket unroutable at every gate
  // would leave (b) passing for the wrong reason.
  it('(a) FIXTURE KEEPER: the pocket still diverges between floor 2.1 and floor 2.3', () => {
    const origin = mask.snapToNavigable(FLENSBURG, REQUESTED_DEPTH_M);
    const dest = mask.snapToNavigable(POCKET, REQUESTED_DEPTH_M);
    expect(origin, 'Flensburg must still snap at 3.0 m').not.toBeNull();
    expect(dest, 'the pocket must still snap at 3.0 m').not.toBeNull();

    const deep = findRelaxedGate(mask, [origin!, dest!], REQUESTED_DEPTH_M, APPROACH_RADIUS_M, 2.3);
    expect(deep, 'a 2.30 m boat must NOT be granted a gate below its own draft').toBeNull();

    // Licences the assertion above: without this the null could mean the
    // fixture has gone unroutable at every gate (a mask change), not that
    // the floor held.
    const shallow = findRelaxedGate(
      mask,
      [origin!, dest!],
      REQUESTED_DEPTH_M,
      APPROACH_RADIUS_M,
      2.1,
    );
    expect(shallow?.usedDepthM).toBeCloseTo(2.1, 6);
  });

  // #54 fix round 1: findRelaxedGate must quantise `floorM` UP, so it fails
  // closed for a caller that hands over a RAW draft. Round would take a
  // 2.14 m boat to a 2.1 m gate — under its own keel — which is the class
  // lib/boatDepth.ts's ceilToDecimetre forbids in capitals (spec C.8).
  //
  // This row calls findRelaxedGate DIRECTLY, and it has to: MEASURED over
  // 4501 millimetre-spaced drafts, ceil-vs-round in the callee is invisible
  // through planRoute (0 disagreements) because the caller already quantises
  // via relaxationFloorM. Only a raw floor reaches the branch.
  //
  // 2.14 is the discriminating value for THIS fixture, not 2.24: the pocket's
  // maximum connecting gate is 21 dm, and round(2.14*10)=21 connects while
  // ceil=22 does not. round(2.24*10)=22 also fails to connect, so a 2.24 row
  // would pass either way.
  it('(a2) CALLEE KEEPER: a RAW non-decimetre floor is quantised UP, not down', () => {
    const origin = mask.snapToNavigable(FLENSBURG, REQUESTED_DEPTH_M);
    const dest = mask.snapToNavigable(POCKET, REQUESTED_DEPTH_M);
    const raw = findRelaxedGate(mask, [origin!, dest!], REQUESTED_DEPTH_M, APPROACH_RADIUS_M, 2.14);
    expect(raw, 'a 2.14 m floor must not be granted the 2.1 m gate below it').toBeNull();
  });
});
