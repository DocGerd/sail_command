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

it('probe', () => {
  iso.PROBE.ringCap = 20000;
  run('A bagenkop tws8 SALV cap20000', { dest: BAGENKOP, tws: 8, rig: 'genoa', pf: 1, gate: uniformGate(3), salvage: true });
  writeFileSync(process.env.SC_OUT!, JSON.stringify(out));
});
