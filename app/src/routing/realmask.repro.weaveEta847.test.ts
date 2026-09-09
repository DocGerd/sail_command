import { describe, expect, it } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid, makeWindGrid } from '../test/fixtures';
import { haversineNm, normalizeDeg180 } from '../lib/geo';
import { uniformGate } from '../lib/depthGate';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { LatLon, Leg, PlanResultOk } from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import {
  mask,
  SALONA_DEPS,
  T0,
  sailResult,
  FLENSBURG,
  GLUECKSBURG,
} from '../test/realmaskFixtures';

// #847: "Some routes make slight course corrections every 2-3 minutes."
//
// This file is a MEASUREMENT-ONLY harness (issue #847's own scoping — no
// solver change is authorised at this triage stage). It builds on top of
// `../test/realmaskFixtures` exactly as `realmask.repro.*.test.ts` does:
// real committed mask + polars, `planRoute()` as the only entry point.
//
// #264 (see CLAUDE.md's "motor-tacking" bullet) already ruled on the LARGE
// heading-swing shape of this complaint ("zigzag" = motor-tacking around a
// sail-locked arc, usually FASTER, do not fix). This route DOES carry a
// mode change near the ORIGIN (sail -> motor -> sail -> sail -> motor in
// the first five legs, near Aeroeskoebing's own buoyed approach channel) —
// so #354's mode-churn shape is present too, at the opposite end of the
// route from the span this file measures. The span measured here (the
// LAST run of legs, immediately before arrival at Soeby) is a THIRD,
// narrower shape and is what this harness asserts on: every leg in it is
// `kind: 'motor'` with NO mode change at all — repeated small-to-moderate
// (roughly 10-20 deg) heading corrections, each lasting a few minutes,
// inside the harbour APPROACH. That is close to (within ~2x of) the ~1 nm
// disc `depthGate.ts`'s `APPROACH_RADIUS_M` names — a numerical
// coincidence worth noting, not evidence of a shared mechanism: this route
// never triggers #53 relaxation (asserted below), so the approach-disc GATE
// code is not what is running here.
//
// #264's own method is reused: measure the weave's ETA against a chord
// that is FIRST VERIFIED NAVIGABLE at the plan's own requested safety depth
// (#264's "32.9% detour" was measured against a chord that crossed land —
// CLAUDE.md's Verification-lessons bullet on infeasible baselines). Every
// print below states the baseline's navigability on the same line as its
// implied ETA, per the task brief.
//
// #1079 (2026-09-09) WIDENS this beyond the single Aeroeskoebing -> Soeby
// / uniform-TWS-5.5 case above, along the two axes #1079's own body names:
//
//   (b) MORE ROUTES: 'Flensburg -> Glücksburg' (below) reproduces the SAME
//       near-zero-cost shape at a DIFFERENT harbour pair, DIFFERENT wind
//       cell, and a MID-ROUTE weave position rather than a destination
//       approach -- structurally the same detector output, so it widens
//       axis (b) rather than merely repeating axis (a)'s existing case.
//       'Glücksburg -> Aeroeskoebing' widens it a second way: the
//       reproducing span there is `kind: 'sail'` (board 'port'), not
//       motor -- the ORIGINAL case and 'Flensburg -> Glücksburg' both
//       happen to isolate all-MOTOR spans, so this is the first case in
//       this file measuring a SAIL weave's ETA cost.
//   (a) NON-UNIFORM WIND: 'route-scoped gradient' plans the ORIGINAL
//       Aeroeskoebing -> Soeby route again, geography and rig held fixed,
//       replacing ONLY the uniform wind grid with a `makeWindGrid` spatial
//       gradient scaled to this route's own ~13 km bounding box (same
//       technique `app/scripts/gen-docs-wind-fixture.mjs` uses to make a
//       gradient visible across a short route, rather than the
//       whole-forecast-domain gradient CLAUDE.md's #264 bullet records as
//       already tried and NOT reproducing #847's "slight" shape). This is
//       the sharpest isolation of the wind-field variable this session
//       produced: it is NOT a fresh route search, it is the SAME
//       origin/destination/rig/departure as the case above with only the
//       wind construction changed.
//
// A real (live-fetched) Open-Meteo forecast was NOT substituted for any of
// these, on the same grounds the original spike gave for not attempting it:
// this harness runs OFFLINE against committed fixtures (CLAUDE.md:
// "Planning requires network; everything else must keep working offline"),
// and a routing-package `*.test.ts` file fetching a live forecast would
// violate that. `makeWindGrid` is the same synthetic-gradient escape hatch
// the original spike's own §5 aperture note already named as tried.
//
// WHAT THE GRADIENT CASE ESTABLISHES, precisely: under this route-scoped
// gradient the SAME phenomenon (a run of >=3 same-kind legs with small
// heading deltas, ending at the destination, all `kind: 'motor'`) still
// occurs -- so the phenomenon is NOT an artefact of a uniform field. But
// this gradient case's own weave-span chord (first waypoint of the span to
// its last) is NOT navigable at the plan's requested depth --
// `chordNavigable: false` below, asserted explicitly rather than silently
// skipped -- so the #264 chord-ETA method this file otherwise relies on
// CANNOT be applied to it without repeating the exact infeasible-baseline
// mistake #264 itself opened with. No ETA-cost percentage is computed or
// asserted for that case for this reason; the test instead asserts the
// STRUCTURAL reproduction (a weave span exists, ends at the route's last
// leg, and is all-motor) and records the chord-navigability finding.
// WHAT THIS DOES NOT ESTABLISH: whether a gradient-wind weave costs more,
// less, or the same ETA as a uniform-wind one -- that comparison remains
// OPEN, exactly as CLAUDE.md's #264 motor-decision-rule bullet already
// records the broader gradient-vs-uniform gap as "narrowed, not closed".
// This case narrows it further (the phenomenon itself is confirmed
// gradient-reproducible) without closing the ETA-cost half.

interface WeaveSpan {
  startIdx: number;
  endIdx: number;
  legs: Leg[];
}

/** A maximal run of >=3 consecutive same-kind/same-board legs, each running
 * <=300s, with a genuine (but sub-#264, sub-MAX_MERGE_DEG) heading change
 * between EVERY adjacent pair in the run (1-45 deg) -- i.e. legs that are
 * neither identical-heading (nothing to explain) nor a hard tack/gybe/mode
 * swing (#264's own archetype) but were not merged by
 * `postprocess.ts`'s `mergeCollinearLegs` either. */
function findWeaveSpans(legs: Leg[]): WeaveSpan[] {
  const spans: WeaveSpan[] = [];
  let runStart = 0;
  for (let i = 1; i <= legs.length; i++) {
    const prev = legs[i - 1];
    const cur = i < legs.length ? legs[i] : null;
    const continues =
      cur !== null &&
      cur.kind === prev.kind &&
      cur.board === prev.board &&
      prev.endTimeMs - prev.startTimeMs <= 300_000 &&
      (() => {
        const d = Math.abs(normalizeDeg180(cur.headingDeg - prev.headingDeg));
        return d > 1 && d <= 45;
      })();
    if (!continues) {
      const runLegs = legs.slice(runStart, i);
      if (runLegs.length >= 3 && runLegs.every((l) => l.endTimeMs - l.startTimeMs <= 300_000)) {
        spans.push({ startIdx: runStart, endIdx: i - 1, legs: runLegs });
      }
      runStart = i;
    }
  }
  return spans;
}

interface WeaveMeasurement {
  span: WeaveSpan;
  actualDurationS: number;
  chordDistanceNm: number;
  chordClearanceM: number | null;
  chordNavigable: boolean;
  avgSpeedKn: number;
  chordEtaS: number;
  etaDeltaS: number;
}

/** Measures one weave span's ETA cost against a chord from the span's first
 * waypoint to its last, verified navigable at the plan's REQUESTED safety
 * depth (never the relaxed gate -- #264's lesson) before the comparison is
 * trusted at all. The chord's implied travel time uses the span's own
 * average speed (distance/time over the whole span) rather than an assumed
 * constant, so it is valid for a sail span too, not only a motor one. */
function measureWeaveSpan(span: WeaveSpan, safetyDepthM: number): WeaveMeasurement {
  const first = span.legs[0];
  const last = span.legs[span.legs.length - 1];
  const actualDurationS = (last.endTimeMs - first.startTimeMs) / 1000;
  const totalDistanceNm = span.legs.reduce((d, l) => d + l.distanceNm, 0);
  const avgSpeedKn = totalDistanceNm / (actualDurationS / 3600);
  const chordDistanceNm = haversineNm(first.start, last.end);
  const gate = uniformGate(safetyDepthM);
  const chordClearanceM = mask.segmentClearanceM(first.start, last.end, gate);
  const chordNavigable = chordClearanceM !== null;
  const chordEtaS = (chordDistanceNm / avgSpeedKn) * 3600;
  return {
    span,
    actualDurationS,
    chordDistanceNm,
    chordClearanceM,
    chordNavigable,
    avgSpeedKn,
    chordEtaS,
    etaDeltaS: actualDurationS - chordEtaS,
  };
}

function printMeasurement(label: string, m: WeaveMeasurement) {
  const legHeadings = m.span.legs.map((l) => l.headingDeg.toFixed(1)).join(' -> ');
  console.log(
    `\n=== ${label}: weave span legs[${m.span.startIdx}..${m.span.endIdx}] ===\n` +
      `  headings: ${legHeadings}\n` +
      `  kind/board: ${m.span.legs[0].kind}/${m.span.legs[0].board ?? '-'}\n` +
      `  actual duration:  ${m.actualDurationS.toFixed(1)} s\n` +
      `  chord distance:   ${m.chordDistanceNm.toFixed(4)} nm\n` +
      `  chord navigable (requested depth): ${m.chordNavigable} ` +
      `(clearance ${m.chordClearanceM === null ? 'BLOCKED' : m.chordClearanceM.toFixed(2) + ' m'})\n` +
      `  avg speed in span: ${m.avgSpeedKn.toFixed(3)} kn\n` +
      `  chord-implied ETA: ${m.chordEtaS.toFixed(1)} s\n` +
      `  ETA DELTA (actual - chord): ${m.etaDeltaS.toFixed(1)} s ` +
      `(${((m.etaDeltaS / m.actualDurationS) * 100).toFixed(1)}% of span duration)`,
  );
}

const AEROESKOEBING: LatLon = { lat: 54.8935, lon: 10.416 };
const SOEBY: LatLon = { lat: 54.9454, lon: 10.256 };

describe('#847 weave ETA cost — reproduction + measurement', () => {
  it(
    'Aeroeskoebing -> Soeby, TWS 5.5 / wdir 120 (genoa): reproduces a small-correction weave near the destination approach',
    { timeout: SOLVER_TEST_TIMEOUT_MS },
    () => {
      const res = planRoute(
        {
          origin: AEROESKOEBING,
          destination: SOEBY,
          viaPoints: [],
          originHarborId: 'aeroeskoebing',
          destinationHarborId: 'soeby',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
          sailIds: ['genoa'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(5.5, 120),
        SALONA_DEPS,
      ) as PlanResultOk;
      expect(res.status).toBe('ok');
      // #452/#494's relaxation-disc mechanism must NOT be in play here --
      // otherwise the weave could be an artefact of the relaxed-gate
      // approach ring rather of ordinary ring-to-ring routing.
      expect('shallow' in res).toBe(false);

      const rig = sailResult(res, 'genoa');
      expect(rig).not.toBeNull();
      const legs = rig!.legs;

      // The route as a whole is NOT purely #264's shape (a sail-locked-arc
      // motor-tack) and DOES carry a #354-shaped mode change near the
      // origin -- print the mode sequence so the spike doc can quote it
      // verbatim rather than restate a claim from memory.
      console.log(
        `\nMode sequence (all ${legs.length} legs): ` +
          legs
            .map((l) => (l.kind === 'motor' ? 'M' : l.board === 'port' ? 'S(port)' : 'S(stbd)'))
            .join(' -> '),
      );

      const spans = findWeaveSpans(legs);
      console.log(
        `\nRoute: ${legs.length} legs, ${rig!.distanceNm.toFixed(2)} nm, ` +
          `${(rig!.durationMs / 60000).toFixed(1)} min. Weave spans found: ${spans.length}.`,
      );
      expect(spans.length).toBeGreaterThan(0);

      const measurements = spans.map((s) => measureWeaveSpan(s, DEFAULT_SETTINGS.safetyDepthM));
      measurements.forEach((m, i) => printMeasurement(`span ${i}`, m));

      // The reproducing span asserted on below is the one nearest the
      // destination (issue's own screenshot: the corrections read as
      // happening on an otherwise straight final approach), and it is the
      // one span in this route where EVERY leg is a motor leg with no mode
      // change -- the cleanest isolation of the heading-only phenomenon.
      // Assert it exists and print its numbers; the VERDICT (cost ~zero vs
      // real) is recorded in the spike doc, never asserted here as a
      // pass/fail threshold -- a measurement
      // harness's job is to produce the number, not to pre-judge it.
      const lastSpan = measurements[measurements.length - 1];
      expect(lastSpan.span.endIdx).toBe(legs.length - 1);
      expect(lastSpan.span.legs.every((l) => l.kind === 'motor')).toBe(true);

      // The comparison only means something if the baseline is reachable
      // at the plan's own requested depth (#264's lesson) -- assert this
      // explicitly so a future run that silently lost navigability (a mask
      // rebuild, a route change) fails LOUDLY here rather than shipping a
      // meaningless percentage in the spike doc.
      expect(lastSpan.chordNavigable).toBe(true);

      // POSITIVE CONTROL for that assertion, using the SAME
      // `mask.segmentClearanceM` call: a `chordNavigable: true` reading is
      // worth nothing if the function can never return false. The real
      // route took 67.6 min / 7.16 nm to thread from origin to
      // destination -- a straight chord between them, through the very
      // island/shoal geometry the router routed AROUND, is exactly the
      // "infeasible baseline" shape #264 warns about, so it must read
      // BLOCKED here.
      const wholeRouteChord = mask.segmentClearanceM(
        AEROESKOEBING,
        SOEBY,
        uniformGate(DEFAULT_SETTINGS.safetyDepthM),
      );
      console.log(
        `\nPositive control: whole-route chord (origin->destination direct) navigable: ` +
          `${wholeRouteChord !== null} (clearance ${wholeRouteChord === null ? 'BLOCKED' : wholeRouteChord.toFixed(2) + ' m'})`,
      );
      expect(wholeRouteChord).toBeNull();

      // Print the whole leg table too, so the spike doc's route/wind/leg
      // description can be quoted verbatim from this run's own output.
      console.log('\nFull leg table:');
      for (const leg of legs) {
        console.log(
          `  ${leg.kind}/${leg.board ?? '-'} hdg=${leg.headingDeg.toFixed(1)} ` +
            `dur=${((leg.endTimeMs - leg.startTimeMs) / 1000).toFixed(0)}s ` +
            `dist=${leg.distanceNm.toFixed(3)}nm speed=${leg.speedKn.toFixed(2)}kn`,
        );
      }
    },
  );

  // #1079: axis (b) widening #1 -- a DIFFERENT harbour pair and wind cell,
  // reproducing a MID-ROUTE (not destination-approach) all-motor weave.
  it(
    'Flensburg -> Glücksburg, TWS 8 / wdir 60 (genoa): reproduces an all-motor weave mid-route (not a destination approach)',
    { timeout: SOLVER_TEST_TIMEOUT_MS },
    () => {
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: GLUECKSBURG,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'gluecksburg',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
          sailIds: ['genoa'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(8, 60),
        SALONA_DEPS,
      ) as PlanResultOk;
      expect(res.status).toBe('ok');
      expect('shallow' in res).toBe(false);
      const rig = sailResult(res, 'genoa');
      expect(rig).not.toBeNull();
      const legs = rig!.legs;

      const spans = findWeaveSpans(legs);
      console.log(
        `\nFlensburg->Glücksburg: ${legs.length} legs, ${rig!.distanceNm.toFixed(2)} nm, ` +
          `${(rig!.durationMs / 60000).toFixed(1)} min. Weave spans found: ${spans.length}.`,
      );
      expect(spans.length).toBeGreaterThan(0);

      const m = measureWeaveSpan(spans[0], DEFAULT_SETTINGS.safetyDepthM);
      printMeasurement('span 0', m);

      // Unlike the original case, this span is NOT the route's final legs
      // -- it sits mid-route (legs[2..4] of 8), so this widens the
      // phenomenon beyond "harbour-approach shape" specifically.
      expect(m.span.endIdx).toBeLessThan(legs.length - 1);
      expect(m.span.legs.every((l) => l.kind === 'motor')).toBe(true);
      expect(m.chordNavigable).toBe(true);
      // Bound, not a pinned literal: this is a real solver output, not a
      // recomputed constant, so an exact-value assertion would be brittle
      // to any future mask/polar change. 5% is well above the measured
      // 0.7% and well below #264's large-swing regime, so it stays a
      // genuine (mutation-reachable) bound rather than a theorem.
      expect(Math.abs(m.etaDeltaS) / m.actualDurationS).toBeLessThan(0.05);

      const wholeRouteChord = mask.segmentClearanceM(
        FLENSBURG,
        GLUECKSBURG,
        uniformGate(DEFAULT_SETTINGS.safetyDepthM),
      );
      console.log(
        `\nPositive control: whole-route chord navigable: ${wholeRouteChord !== null} ` +
          `(clearance ${wholeRouteChord === null ? 'BLOCKED' : wholeRouteChord.toFixed(2) + ' m'})`,
      );
      expect(wholeRouteChord).toBeNull();
    },
  );

  // #1079: axis (b) widening #2 -- a THIRD harbour pair, and the first
  // SAIL-mode weave span this file measures (the original and the case
  // above both happen to isolate all-motor spans).
  it(
    'Glücksburg -> Aeroeskoebing, TWS 5 / wdir 100 (genoa): reproduces an all-sail weave near the destination approach',
    { timeout: SOLVER_TEST_TIMEOUT_MS },
    () => {
      const res = planRoute(
        {
          origin: GLUECKSBURG,
          destination: AEROESKOEBING,
          viaPoints: [],
          originHarborId: 'gluecksburg',
          destinationHarborId: 'aeroeskoebing',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
          sailIds: ['genoa'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(5, 100),
        SALONA_DEPS,
      ) as PlanResultOk;
      expect(res.status).toBe('ok');
      expect('shallow' in res).toBe(false);
      const rig = sailResult(res, 'genoa');
      expect(rig).not.toBeNull();
      const legs = rig!.legs;

      const spans = findWeaveSpans(legs);
      console.log(
        `\nGlücksburg->Aeroeskoebing: ${legs.length} legs, ${rig!.distanceNm.toFixed(2)} nm, ` +
          `${(rig!.durationMs / 60000).toFixed(1)} min. Weave spans found: ${spans.length}.`,
      );
      expect(spans.length).toBeGreaterThan(0);

      const lastSpan = spans[spans.length - 1];
      const m = measureWeaveSpan(lastSpan, DEFAULT_SETTINGS.safetyDepthM);
      printMeasurement('last span', m);

      expect(m.span.legs.every((l) => l.kind === 'sail')).toBe(true);
      expect(m.chordNavigable).toBe(true);
      // Measured 1.5% here (higher than the motor-span cases' 0.7%, still
      // far below #264's large-swing regime) -- 5% keeps the same margin
      // as the case above rather than a per-case-tuned bound.
      expect(Math.abs(m.etaDeltaS) / m.actualDurationS).toBeLessThan(0.05);

      const wholeRouteChord = mask.segmentClearanceM(
        GLUECKSBURG,
        AEROESKOEBING,
        uniformGate(DEFAULT_SETTINGS.safetyDepthM),
      );
      console.log(
        `\nPositive control: whole-route chord navigable: ${wholeRouteChord !== null} ` +
          `(clearance ${wholeRouteChord === null ? 'BLOCKED' : wholeRouteChord.toFixed(2) + ' m'})`,
      );
      expect(wholeRouteChord).toBeNull();
    },
  );

  // #1079: axis (a) widening -- SAME route/rig/departure as the original
  // case above, ONLY the wind field construction changes (uniform ->
  // route-scoped spatial gradient). See the file-header comment for the
  // full rationale and for what this case does and does not establish.
  it(
    'Aeroeskoebing -> Soeby under a ROUTE-SCOPED GRADIENT (not uniform) wind field: the weave still occurs; its chord is NOT navigable, so no ETA-cost percentage is computed',
    { timeout: SOLVER_TEST_TIMEOUT_MS },
    () => {
      // Gradient scaled to the ROUTE's own bounding box (padded slightly
      // beyond the harbours themselves), not the whole forecast domain --
      // the same technique `gen-docs-wind-fixture.mjs` uses so a gradient
      // is actually visible across a route this short (~13 km). Centered
      // on the original case's own wind cell (TWS 5.5 / wdir 120) with a
      // deliberately modest spread (1 kn / 20 deg) across that span --
      // a physically plausible gradient over 13 km, not an exaggerated one.
      const LAT0 = 54.85;
      const LAT1 = 54.98;
      const LON0 = 10.2;
      const LON1 = 10.45;
      const grid = makeWindGrid((lat, lon) => {
        const latFrac = Math.min(1, Math.max(0, (lat - LAT0) / (LAT1 - LAT0)));
        const lonFrac = Math.min(1, Math.max(0, (lon - LON0) / (LON1 - LON0)));
        return {
          speedKn: 5.0 + 1.0 * lonFrac,
          dirFromDeg: (110 + 20 * latFrac) % 360,
        };
      });

      const res = planRoute(
        {
          origin: AEROESKOEBING,
          destination: SOEBY,
          viaPoints: [],
          originHarborId: 'aeroeskoebing',
          destinationHarborId: 'soeby',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
          sailIds: ['genoa'],
          boat: defaultBoatSnapshot(),
        },
        grid,
        SALONA_DEPS,
      ) as PlanResultOk;
      expect(res.status).toBe('ok');
      expect('shallow' in res).toBe(false);
      const rig = sailResult(res, 'genoa');
      expect(rig).not.toBeNull();
      const legs = rig!.legs;

      console.log(
        `\nGradient-wind Aeroeskoebing->Soeby: ${legs.length} legs, ` +
          `${rig!.distanceNm.toFixed(2)} nm, ${(rig!.durationMs / 60000).toFixed(1)} min.`,
      );
      for (const leg of legs) {
        console.log(
          `  ${leg.kind}/${leg.board ?? '-'} hdg=${leg.headingDeg.toFixed(1)} ` +
            `dur=${((leg.endTimeMs - leg.startTimeMs) / 1000).toFixed(0)}s ` +
            `dist=${leg.distanceNm.toFixed(3)}nm`,
        );
      }

      const spans = findWeaveSpans(legs);
      expect(spans.length).toBeGreaterThan(0);
      const lastSpan = spans[spans.length - 1];
      const m = measureWeaveSpan(lastSpan, DEFAULT_SETTINGS.safetyDepthM);
      printMeasurement('last span (gradient wind)', m);

      // The STRUCTURAL reproduction: the same shape (a run of >=3 all-motor
      // legs, small heading deltas, ending at the route's last leg) occurs
      // under this non-uniform field too.
      expect(m.span.endIdx).toBe(legs.length - 1);
      expect(m.span.legs.every((l) => l.kind === 'motor')).toBe(true);

      // The chord-ETA method is NOT applied here: this span's own chord is
      // BLOCKED at the requested depth (measured 2026-09-09), so treating
      // its implied ETA as a baseline would repeat #264's own
      // infeasible-baseline mistake. Assert the navigability reading
      // explicitly (rather than silently skip it) so a future mask/solver
      // change that makes the chord navigable is caught here, not missed --
      // at that point a real ETA-cost percentage could be computed for
      // this case, which it cannot honestly be today.
      expect(m.chordNavigable).toBe(false);
    },
  );

  // NEGATIVE CONTROL for `findWeaveSpans`, using the SAME detector code as
  // the reproducing case above -- a route/wind cell with no reported #354
  // mode churn and no #264 large-swing motor-tacking (Flensburg ->
  // Gelting-Mole, TWS 12/225 is `docs/spikes/354-mode-churn.md`'s own
  // R6-control, chosen there specifically because "every heading clears the
  // 3.7 kn floor by a wide margin, so the correct output is all-sail with
  // zero mode changes"). If this ALSO reported weave spans, the detector
  // would be finding something in every route regardless of input --
  // exactly the vacuity CLAUDE.md's mutation-check rule asks to rule out
  // for a new test's own detection logic.
  it(
    'negative control: Flensburg -> Gelting-Mole, TWS 12/225 (genoa) reports NO weave spans',
    { timeout: SOLVER_TEST_TIMEOUT_MS },
    () => {
      const res = planRoute(
        {
          origin: { lat: 54.798, lon: 9.4335 },
          destination: { lat: 54.7571, lon: 9.8676 },
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'gelting-mole',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
          sailIds: ['genoa'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(12, 225),
        SALONA_DEPS,
      ) as PlanResultOk;
      expect(res.status).toBe('ok');
      const rig = sailResult(res, 'genoa');
      expect(rig).not.toBeNull();
      const spans = findWeaveSpans(rig!.legs);
      console.log(
        `\nNegative control: ${rig!.legs.length} legs, weave spans found: ${spans.length} (expect 0).`,
      );
      expect(spans.length).toBe(0);
    },
  );
});
