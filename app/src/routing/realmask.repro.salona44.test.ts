import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { boatById } from '../data/boats';
import { DEFAULT_SETTINGS, defaultBoatSnapshot, boatSnapshot } from '../types';
import type { SailId } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import {
  SALONA_DEPS,
  SALONA44_DEPS,
  FLENSBURG,
  GLUECKSBURG,
  MARSTAL,
  T0,
  sailResult,
  expectLegsNavigable,
} from './realmaskFixtures';

// #878: split out of the former realmask.repro.test.ts (~1286 lines, five
// top-level describe blocks) so vitest can parallelise the real-mask suite
// across files/cores — one monopolizing file previously set the whole `app`
// job's wall clock while other cores idled. Pure relocation of this
// describe block (plus its three preceding pinned-literal constants); shared
// setup lives in ./realmaskFixtures.ts. These run against the real shipped
// mask and polars, unlike the synthetic masks used everywhere else in the
// suite.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// #653: pinned literals for the describe block below, recomputed from actual
// solver output observed against the real committed mask/polars (see each
// assertion site's own comment for the sanity checks applied).
const SALONA44_GLUECKSBURG_DISTANCE_NM = 4.211804567041051;
const SALONA44_GLUECKSBURG_DURATION_MS = 2374384.2580566406;
const SALONA44_MARSTAL_DURATION_MS = 28020116.832763672;

// #653: both real-mask harnesses (this suite and app/sweep/) exercised only
// the Salona 45 before this describe block — see the issue for the
// motivating concern (a boatDepth.ts/depthGate.ts regression correct for
// the Salona 45's gate but wrong for a DIFFERENT per-boat gate, or a
// boat-keyed polar lookup bug, was invisible to both). The Salona 44 shares
// the Salona 45's 2.1 m draft, so `defaultSafetyDepthM`/`relaxationFloorM`
// (both pure functions of `b.draftM`, see lib/boatDepth.ts) compute the
// IDENTICAL gate for either boat — these cases therefore do NOT discriminate
// a depth-gate difference by themselves (see each case's own comment for
// what it discriminates instead: the boat-keyed POLAR lookup and the
// plan/ETA it produces, proven via a same-request comparison against
// SALONA_DEPS whose failure mode, if this file's boat wiring regressed to
// always resolving DEFAULT_BOAT_ID, would be `expect(x).not.toBe(x)`).
describe('#653: Salona 44 real-mask coverage (second catalogue boat)', () => {
  // Cheap case (open water, ~seconds): mirrors realmask.repro.issue20.test.ts's
  // #20 repro
  // ('Flensburg -> Gluecksburg routes at default settings') at DEFAULT
  // safety depth, where neither boat is anywhere near its gate. Isolates
  // the boat-keyed polar lookup from any #53 relaxation interaction.
  it('Flensburg -> Gluecksburg with the Salona 44: boat-keyed polar changes the plan under identical wind (issue #20 repro, second boat)', () => {
    const request = {
      origin: FLENSBURG,
      destination: GLUECKSBURG,
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'gluecksburg',
      departureMs: T0,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'] as SailId[],
      // #653 review Minor 6: `request.boat` must agree with the `deps.boat`
      // it is actually paired with in EACH call below — planRoute reads only
      // `deps.boat` (never `req.boat`), so this is presentationally inert
      // today, but constructing a request/deps boat mismatch is exactly the
      // shape `workerClient.boatId.test.ts` exists to forbid at a multi-boat
      // catalogue. The res45 companion call below overrides this back to the
      // Salona 45 for its own call.
      boat: boatSnapshot(boatById('salona-44-speedy-go')),
    };
    const wind = uniformWindGrid(12, 270);

    const res44 = planRoute(request, wind, SALONA44_DEPS);
    expect(res44.status).toBe('ok');
    if (res44.status !== 'ok') return;
    expect('shallow' in res44).toBe(false);
    for (const rig of [sailResult(res44, 'genoa'), sailResult(res44, 'fock')]) {
      expect(rig).not.toBeNull();
      // ~4 nm; anything over 1.5 h means the solver padded its way out
      // (same envelope the #20 repro itself uses).
      expect(rig!.durationMs).toBeLessThan(1.5 * 3_600_000);
      expectLegsNavigable(rig!.legs, DEFAULT_SETTINGS.safetyDepthM);
    }

    // MANDATORY companion, not optional (same pattern as
    // realmask.repro.relaxationFloor.test.ts's own C.4(a) WIRING row): without it, "the Salona 44 plan looks sane" is not
    // evidence it is BOAT-SENSITIVE — a `SALONA44_DEPS` that silently
    // resolved to the Salona 45 (a wrong catalogue lookup) would pass every
    // assertion above identically, since both boats share the 2.1 m draft
    // and this route is not depth-limited for either. Plan the identical
    // request/wind against SALONA_DEPS and require the two plans' chosen-rig
    // duration to differ.
    const res45 = planRoute({ ...request, boat: defaultBoatSnapshot() }, wind, SALONA_DEPS);
    expect(res45.status).toBe('ok');
    if (res45.status !== 'ok') return;
    const rig44 = sailResult(res44, res44.recommended);
    const rig45 = sailResult(res45, res45.recommended);
    expect(rig44).not.toBeNull();
    expect(rig45).not.toBeNull();
    expect(rig44!.durationMs).not.toBe(rig45!.durationMs);

    // Pinned literals, recomputed from the actual solver output observed for
    // this PR (2026-09-02) and sanity-checked against: (a) the < 1.5 h bound
    // above, (b) the #20 repro's own ~4 nm distance note, and (c) the Salona
    // 44's polar being faster than the Salona 45's at TWS 12 kn across every
    // sampled TWA (measured against the shipped
    // salona-44-speedy-go-{genoa,fock}.json / salona-45-{genoa,fock}.json
    // tables: the Salona 44 is STRICTLY faster in all 135 cells of each rig's
    // table — every one of the 9 TWS rows x 15 TWA — with zero equal and zero
    // slower entries anywhere) — so the Salona 44 plan is expected to be
    // faster here. That is still a claim about the POLAR, not a general one
    // about plans: `salona44-breeze` in app/sweep/ is SLOWER than `breeze` on
    // rudkoebing and svendborg, so "faster polar implies faster plan" does
    // NOT hold arm-wide (#866).
    expect(rig44!.distanceNm).toBeCloseTo(SALONA44_GLUECKSBURG_DISTANCE_NM, 6);
    expect(rig44!.durationMs).toBe(SALONA44_GLUECKSBURG_DURATION_MS);
    expect(rig44!.durationMs).toBeLessThan(rig45!.durationMs);
  });

  // Heavier case (~45 s per solve x2, same runtime class as
  // realmask.repro.issue20.test.ts's own 'Flensburg -> Marstal at
  // DEFAULT_SETTINGS degrades gracefully with shallow warnings (#53)' case): the #53 relaxation path, for a SECOND
  // catalogue boat. This is the case the issue's own motivating concern
  // names directly — a defaultSafetyDepthM/relaxationFloorM mixup would be
  // invisible without it.
  it(
    'Flensburg -> Marstal at DEFAULT_SETTINGS with the Salona 44: identical relaxed depth gate to the Salona 45, different ETA (#53, second boat)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const request = {
        origin: FLENSBURG,
        destination: MARSTAL,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'marstal',
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'] as SailId[],
        // #653 review Minor 6: see the Gluecksburg case above for why this
        // must agree with SALONA44_DEPS's boat, and why the res45 companion
        // call below overrides it back.
        boat: boatSnapshot(boatById('salona-44-speedy-go')),
      };
      const wind = uniformWindGrid(12, 270);

      const res44 = planRoute(request, wind, SALONA44_DEPS);
      expect(res44.status).toBe('ok');
      if (res44.status !== 'ok') return;
      expect(res44.shallow).toBeDefined();
      expect(res44.shallow!.requestedDepthM).toBe(3.0);
      // SAME usedDepthM as the Salona 45's own DEFAULT_SETTINGS case in
      // realmask.repro.issue20.test.ts
      // (2.3 m) — NOT a coincidence: defaultSafetyDepthM/relaxationFloorM
      // are pure functions of b.draftM, and both Salonas draft 2.1 m, so the
      // search range findRelaxedGate probes is identical for either boat.
      // This equality is itself the evidence that the per-boat gate math is
      // reading `deps.boat` (a real Salona-44 BoatDef) rather than a
      // hardcoded Salona-45 value: had SALONA44_DEPS silently resolved a
      // draft-DIFFERENT boat (say the 1.9 m PIRANJA) here instead, this
      // assertion would red.
      expect(res44.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      expect(res44.shallow!.minGateDepthM).toBeGreaterThanOrEqual(2.3);
      expect(res44.shallow!.minGateDepthM).toBeLessThan(3.0);

      for (const rig of [sailResult(res44, 'genoa'), sailResult(res44, 'fock')]) {
        expect(rig).not.toBeNull();
        expect(rig!.distanceNm).toBeGreaterThan(30);
        expect(rig!.durationMs).toBeLessThan(12 * 3_600_000);
        expectLegsNavigable(rig!.legs, res44.shallow!.usedDepthM);
        const flagged = rig!.legs.filter((l) => l.shallow);
        expect(flagged.length).toBeGreaterThan(0);
      }

      // MANDATORY companion (same pattern as above): prove the plan is
      // BOAT-SENSITIVE, not merely depth-gate-sensitive — the gate math
      // alone (checked above) cannot discriminate a boat-keyed POLAR mixup,
      // since it is identical for both boats on this route.
      const res45 = planRoute({ ...request, boat: defaultBoatSnapshot() }, wind, SALONA_DEPS);
      expect(res45.status).toBe('ok');
      if (res45.status !== 'ok') return;
      expect(res45.shallow!.usedDepthM).toBeCloseTo(res44.shallow!.usedDepthM, 6);
      const rig44 = sailResult(res44, res44.recommended);
      const rig45 = sailResult(res45, res45.recommended);
      expect(rig44).not.toBeNull();
      expect(rig45).not.toBeNull();
      expect(rig44!.durationMs).not.toBe(rig45!.durationMs);

      // Pinned literal, recomputed from the actual solver output observed
      // for this PR (2026-09-02) and sanity-checked against: (a) the
      // 30 nm / 12 h envelope above (same as the Salona 45's own DEFAULT
      // case), (b) usedDepthM matching the Salona 45's case exactly,
      // minGateDepthM independently bounded to the same [2.3, 3.0) range
      // for this boat (not cross-checked between boats), and (c) at least
      // one flagged shallow leg on every sail — all consistent with a
      // route through the SAME Marstal pinch as the Salona 45's plan, at a
      // genuinely different boat speed.
      expect(rig44!.durationMs).toBe(SALONA44_MARSTAL_DURATION_MS);
    },
  );
});
