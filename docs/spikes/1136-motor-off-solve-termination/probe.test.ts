// #1136 design-pass probe harness. Requires apply_probe.py applied to the
// worktree's isochrone.ts. Writes one JSON record per run to $SC_OUT.
import { it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";

const WT = process.env.SC_WT!; // worktree root
const { NavMask } = await import(`${WT}/app/src/lib/mask`);
const { Polar } = await import(`${WT}/app/src/lib/polar`);
const { WindField } = await import(`${WT}/app/src/lib/wind`);
const iso = await import(`${WT}/app/src/routing/isochrone`);
const { uniformWindGrid } = await import(`${WT}/app/src/test/fixtures`);
const { DEFAULT_SETTINGS } = await import(`${WT}/app/src/types`);
const { uniformGate, APPROACH_RADIUS_M } = await import(
  `${WT}/app/src/lib/depthGate`
);
const { findRelaxedGate } = await import(`${WT}/app/src/routing/relaxedDepth`);
const { relaxationFloorM } = await import(`${WT}/app/src/lib/boatDepth`);
const { boatById, DEFAULT_BOAT_ID } = await import(`${WT}/app/src/data/boats`);

const dd = `${WT}/app/public/data`;
const meta = JSON.parse(readFileSync(`${dd}/mask.meta.json`, "utf8"));
const mask = new NavMask(meta, new Uint8Array(readFileSync(`${dd}/mask.bin`)));
const table = (rig: string) =>
  JSON.parse(readFileSync(`${dd}/polars/salona-45-${rig}.json`, "utf8"));
const FLENSBURG = { lat: 54.798, lon: 9.4335 };
const BAGENKOP = { lat: 54.753, lon: 10.668 };
const MARSTAL = { lat: 54.8579, lon: 10.528 };
const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);
const snap = (p: { lat: number; lon: number }) => mask.snapToNavigable(p, 3)!;

const out: unknown[] = [];

function run(
  label: string,
  o: {
    dest: { lat: number; lon: number };
    tws: number;
    rig: string;
    pf: number;
    gate: unknown;
    comfort?: number;
    salvage: boolean;
  },
) {
  iso.PROBE.trace.length = 0;
  iso.PROBE.enabled = o.salvage;
  const settings = {
    ...DEFAULT_SETTINGS,
    safetyDepthM: 3,
    motorEnabled: false,
  };
  const t = performance.now();
  let res: any;
  try {
    res = iso.solve({
      origin: snap(FLENSBURG),
      destination: snap(o.dest),
      departureMs: T0,
      polar: new Polar(table(o.rig), o.pf),
      wind: new WindField(uniformWindGrid(o.tws, 0)),
      mask,
      settings,
      gate: o.gate,
      ...(o.comfort !== undefined ? { comfortDepthM: o.comfort } : {}),
    });
  } catch (e) {
    res = { status: "threw", cause: (e as Error).message };
  }
  const ms = performance.now() - t;
  const trace = iso.PROBE.trace.slice();
  const rec = {
    label,
    ...o,
    gate: undefined,
    status: res.status,
    cause: res.cause ?? null,
    etaH: res.status === "ok" ? (res.etaMs - T0) / 3.6e6 : null,
    rings: trace.length,
    salvages: trace.filter((r: any) => r.pass === "S").length,
    ms,
    trace,
  };
  out.push(rec);
  console.log(
    `${label}: ${rec.status} ${rec.cause ?? ""} eta=${rec.etaH} rings=${rec.rings} salv=${rec.salvages} ${ms.toFixed(0)}ms`,
  );
}

it("probe", () => {
  const g3 = uniformGate(3);
  const connB = mask.cellsConnected(snap(FLENSBURG), snap(BAGENKOP), g3);
  const connM = mask.cellsConnected(snap(FLENSBURG), snap(MARSTAL), g3);
  const relaxed = findRelaxedGate(
    mask,
    [snap(FLENSBURG), snap(MARSTAL)],
    3,
    APPROACH_RADIUS_M,
    relaxationFloorM(boatById(DEFAULT_BOAT_ID)),
  );
  out.push({
    oracle: {
      bagenkopAt3: connB,
      marstalAt3: connM,
      marstalRelaxedUsedDepthM: relaxed?.usedDepthM ?? null,
    },
  });
  console.log("oracle", connB, connM, relaxed?.usedDepthM);

  // A: spike §1/§10 configuration (bare solve, pf 1.0, no comfort).
  for (const tws of [2.8, 3, 8])
    for (const salvage of [false, true])
      run(`A bagenkop tws${tws} ${salvage ? "SALV" : "ctrl"}`, {
        dest: BAGENKOP,
        tws,
        rig: "genoa",
        pf: 1,
        gate: g3,
        salvage,
      });

  // B: hole 5 instance — oracle-DISCONNECTED pair at the uniform 3.0 m gate.
  for (const salvage of [false, true])
    run(`B marstal@3.0 tws3 ${salvage ? "SALV" : "ctrl"}`, {
      dest: MARSTAL,
      tws: 3,
      rig: "genoa",
      pf: 1,
      gate: g3,
      salvage,
    });

  // C: mirrorCase tiers 3/4 at plan fidelity (pf 0.9, relaxed gate field).
  if (relaxed)
    for (const rig of ["genoa", "fock"])
      for (const comfort of [5, undefined])
        for (const salvage of [false, true])
          run(
            `C marstal relaxed ${rig} comfort${comfort ?? "-"} ${salvage ? "SALV" : "ctrl"}`,
            {
              dest: MARSTAL,
              tws: 3,
              rig,
              pf: 0.9,
              gate: relaxed.gate,
              ...(comfort !== undefined ? { comfort } : {}),
              salvage,
            },
          );

  writeFileSync(process.env.SC_OUT!, JSON.stringify(out));
});
