// #1360 probe: salona44-relaxation inputs, marstal -> aaroesund, through
// planRouteWithRecord(). The solver is NOT edited: vi.mock wraps solve() to
// (a) optionally override maxFrontier and (b) count rings whose POST-cap
// frontierSize equals the cap in force (same counter as spike 1330).
// Env: SC_PROBE_CAP = 'default' | 'inf' | <integer>; SC_PROBE_OUT = file path;
// SC_PROBE_DEST (default 'aaroesund').
// Run from a `git archive` extract of a tree, with this file and
// vitest.config.ts copied to <extract>/app/probe1360/:
//   node node_modules/vitest/vitest.mjs run --config probe1360/vitest.config.ts
import { it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const H = vi.hoisted(() => {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  return {
    log: [] as Record<string, unknown>[],
    cap: env?.SC_PROBE_CAP ?? "default",
  };
});

vi.mock("../src/routing/isochrone", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown> & {
    solve: (p: Record<string, unknown>) => Record<string, unknown>;
    defaultMaxFrontier?: (meta: unknown) => number;
  };
  return {
    ...orig,
    solve: (p: Record<string, unknown>) => {
      const cap =
        H.cap === "default"
          ? undefined
          : H.cap === "inf"
            ? Number.MAX_SAFE_INTEGER
            : Number(H.cap);
      const mask = p.mask as { meta: unknown };
      // Default cap per tree: 30 000 constant at 36d86a7/16c7c6b
      // (`p.maxFrontier ?? MAX_FRONTIER`), defaultMaxFrontier(meta) on develop.
      const countCap =
        cap ??
        (typeof orig.defaultMaxFrontier === "function"
          ? orig.defaultMaxFrontier(mask.meta)
          : 30_000);
      const e = {
        idx: H.log.length,
        countCap,
        comfortDepthM: (p.comfortDepthM as number | undefined) ?? null,
        salvage: p.salvage === true,
        rings: 0,
        peak: 0,
        trunc: 0,
        firstTrunc: null as number | null,
        lastTrunc: null as number | null,
      } as Record<string, unknown> & {
        rings: number;
        peak: number;
        trunc: number;
        firstTrunc: number | null;
        lastTrunc: number | null;
      };
      const inner = p.onProgress as
        ((i: { tMs: number; frontierSize: number }) => void) | undefined;
      const res = orig.solve({
        ...p,
        ...(cap !== undefined ? { maxFrontier: cap } : {}),
        onProgress: (info: { tMs: number; frontierSize: number }) => {
          e.rings++;
          if (info.frontierSize > e.peak) e.peak = info.frontierSize;
          if (info.frontierSize === countCap) {
            e.trunc++;
            if (e.firstTrunc === null) e.firstTrunc = e.rings;
            e.lastTrunc = e.rings;
          }
          inner?.(info);
        },
      });
      e.status = res.status;
      e.cause = res.cause ?? null;
      e.etaMs = res.etaMs ?? null;
      e.costMs = res.costMs ?? null;
      e.legs = Array.isArray(res.legs) ? res.legs.length : null;
      H.log.push(e);
      return res;
    },
  };
});

import { NavMask } from "../src/lib/mask";
import { planRouteWithRecord } from "../src/routing/planRoute";
import { uniformWindGrid } from "../src/test/fixtures";
import { boatById, polarKey } from "../src/data/boats";
import { boatSnapshot, DEFAULT_SETTINGS } from "../src/types";
import type { LatLon, MaskMeta, PolarTable, SailId } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "../public/data");
const T0 = Date.UTC(2026, 6, 15, 6, 0, 0); // app/sweep/sweepArms.ts T0

it("#1360 probe", () => {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  const out = env?.SC_PROBE_OUT;
  expect(out).toBeTruthy();
  const dest = env?.SC_PROBE_DEST ?? "aaroesund";
  const meta = JSON.parse(
    readFileSync(resolve(dataDir, "mask.meta.json"), "utf8"),
  ) as MaskMeta;
  const mask = new NavMask(
    meta,
    new Uint8Array(readFileSync(resolve(dataDir, "mask.bin"))),
  );
  const boat = boatById("salona-44-speedy-go");
  const polars: Record<string, PolarTable> = {};
  for (const s of boat.sails)
    polars[polarKey(boat.id, s.id)] = JSON.parse(
      readFileSync(resolve(dataDir, "..", s.polarAsset), "utf8"),
    ) as PolarTable;
  const sailIds = boat.sails.map((s) => s.id as SailId);
  const harbors = JSON.parse(
    readFileSync(resolve(dataDir, "harbors.json"), "utf8"),
  ) as {
    id: string;
    snap: LatLon;
  }[];
  const o = harbors.find((h) => h.id === "marstal")!;
  const d = harbors.find((h) => h.id === dest)!;
  const { result, record } = planRouteWithRecord(
    {
      origin: o.snap,
      destination: d.snap,
      viaPoints: [],
      originHarborId: o.id,
      destinationHarborId: d.id,
      departureMs: T0,
      settings: DEFAULT_SETTINGS,
      sailIds,
      boat: boatSnapshot(boat),
    },
    uniformWindGrid(12, 225),
    { polars, boat, mask },
  );
  const r = result as unknown as Record<string, unknown> & {
    sails?: { sailId: string; result: Record<string, unknown> | null }[];
  };
  const summary = {
    cap: H.cap,
    dest,
    status: r.status,
    recommended: r.recommended ?? null,
    shallowUsedDepthM:
      (r.shallow as { usedDepthM?: number } | undefined)?.usedDepthM ?? null,
    sails: (r.sails ?? []).map((s) => {
      const rr = s.result as {
        etaMs: number;
        durationMs: number;
        distanceNm: number;
        legs: { kind: string }[];
        maneuverCount: number;
        motorDistanceNm: number;
      } | null;
      return rr
        ? {
            sailId: s.sailId,
            durationMin: rr.durationMs / 60_000,
            distanceNm: rr.distanceNm,
            legs: rr.legs.length,
            motorLegs: rr.legs.filter((l) => l.kind === "motor").length,
            maneuvers: rr.maneuverCount,
            motorNm: rr.motorDistanceNm,
          }
        : { sailId: s.sailId, result: null };
    }),
    tiers: record.tiers.map((t) => ({
      tier: t.tier,
      usedDepthM: t.usedDepthM,
      comfortDepthM: t.comfortDepthM ?? null,
      causes: t.causes,
    })),
    solves: H.log.map((e) => ({
      ...e,
      etaMin:
        typeof e.etaMs === "number"
          ? ((e.etaMs as number) - T0) / 60_000
          : null,
      costMin:
        typeof e.costMs === "number"
          ? ((e.costMs as number) - T0) / 60_000
          : null,
    })),
  };
  writeFileSync(out as string, JSON.stringify(summary, null, 1));
}, 7_200_000);
