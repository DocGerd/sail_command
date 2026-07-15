# SailCommand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build SailCommand — an offline-capable PWA that plans time-optimal sailing routes for a Salona 45 in the Flensburg Fjord / Danish South Sea, using hourly Open-Meteo wind forecasts and an isochrone router that prices tacks/gybes as time penalties.

**Architecture:** Two parts: a build-time data pipeline (`pipeline/`) producing committed static assets in `app/public/data/` (land/depth mask, harbors, polars, PMTiles basemap), and a client-only PWA (`app/`, Vite + React + TypeScript) whose routing engine runs in a Web Worker. No backend, ever. Spec: `docs/superpowers/specs/2026-07-14-sail-command-design.md`.

**Tech Stack:** Vite + React + TypeScript (React context for state — no state library), MapLibre GL + PMTiles, idb (IndexedDB), vite-plugin-pwa (Workbox, injectManifest), Vitest + fast-check (unit/property), Playwright (E2E), Python 3.11+ (mask pipeline), GitHub Actions → GitHub Pages. Exact versions in the "Package versions" appendix (research-verified 2026-07-14).

## Global Constraints

- Area bbox: **54.3–55.3°N, 9.4–11.0°E** (all data, all routing).
- Defaults (all user-tunable at plan time, snapshotted into each plan): safety depth **3.0 m** (boat draft 2.1 m), motor speed **6.5 kn**, motor threshold **2.5 kn**, maneuver penalty **45 s**, performance factor **0.90**.
- Navigability is decided at **query time** (`cellDepth >= safetyDepth`), never baked into the mask.
- Wind grids are **stored with each plan**; a saved route always renders against the forecast it was computed from.
- Tack/gybe minimization emerges from the maneuver penalty inside the isochrone cost — **no post-hoc tack reducer**. Only allowed post-processing: merging near-collinear legs with re-validation.
- The router runs **twice per plan** (genoa polar, fock polar) and recommends the faster rig; both results user-visible.
- Motor legs are first-class and always flagged as motor.
- Wind direction is meteorological (coming FROM, degrees true). Polars are TWA × TWS → boat speed (kn). Positions WGS84. Distances nm, speeds kn. Internal times are epoch ms UTC.
- Open-Meteo called directly from the browser; **no backend, no API key**.
- Planning requires network; **everything else must work offline**.
- All UI strings via i18n dictionary (de/en), never hardcoded; language toggle persisted.
- User-facing copy must never claim chart authority (passage-planning aid, not a navigation device).
- Code changes are delivered via PRs to `main` (one PR per phase), each self-reviewed. Never `--no-verify`, never force-push.
- App scaffold uses two independent package roots: `app/package.json` and `pipeline/package.json` (+ `pipeline/requirements.txt`). There is no root package.json.
- GitHub Pages serves from `https://docgerd.github.io/sail_command/` → Vite `base: '/sail_command/'` (breaks SW + assets if forgotten).

## Execution notes

- Phases: A scaffold → B domain core → C data pipeline → D services → E UI → F PWA/E2E/deploy. Phase C is independent of B and may run in parallel worktrees. One PR per phase.
- Commands below assume repo root as cwd. Per the user's global CLAUDE.md, never `cd app && npm …` — use `npm --prefix app/ …`; use absolute paths for pytest/python scripts.
- Binary assets (`*.bin`, `*.pmtiles`) are pipeline outputs — a PreToolUse hook denies editing them directly; always regenerate via pipeline scripts.
- Test runner: `npm --prefix app/ run test` (Vitest, run mode). E2E: `npm --prefix app/ run e2e`.

## File structure

```
pipeline/
  package.json               # node scripts: polars, harbors
  requirements.txt           # python: mask build (rasterio, geopandas, …)
  README.md                  # how/when to regenerate each asset
  data-src/                  # downloaded raw inputs (gitignored)
  build_polars.mjs           # → app/public/data/polar-genoa.json, polar-fock.json
  build_harbors.mjs          # → app/public/data/harbors.json (bbox + snap validation)
  build_mask.py              # → app/public/data/mask.bin + mask.meta.json
  verify_mask.py             # probe-based sanity check of mask.bin
  extract_basemap.sh         # → app/public/data/basemap.pmtiles
app/
  package.json  vite.config.ts  tsconfig.json  index.html
  playwright.config.ts  eslint.config.js  .prettierrc.json
  public/
    data/                    # committed pipeline outputs (see above)
    icons/                   # PWA icons
  src/
    main.tsx  App.tsx  app.css
    types.ts                 # all shared domain types
    i18n/                    # dict.de.ts, dict.en.ts, index.tsx (I18nProvider, useT)
    lib/
      geo.ts                 # haversine, bearings, destination, angle helpers
      polar.ts               # Polar (bilinear TWA×TWS), beat/gybe angles
      wind.ts                # WindField over stored WindGrid (u/v interpolation)
      mask.ts                # NavMask: depth queries, segment tests, snapping
      gpx.ts                 # GPX 1.1 export
      format.ts              # nm/kn/deg/time formatting for UI
    routing/
      maneuver.ts            # board & tack/gybe classification
      isochrone.ts           # core solver
      postprocess.ts         # collinear-leg merge + re-validation
      planRoute.ts           # 2 rigs, recommendation, totals
      worker.ts              # Web Worker entry (message protocol)
      workerClient.ts        # typed main-thread wrapper
    services/
      openMeteo.ts           # forecast grid fetch (batch, retry/backoff)
      db.ts                  # idb: plans + settings stores
      geolocation.ts         # watchPosition wrapper
    state/
      AppState.tsx           # React context: settings, active plan, ui state
    components/
      MapView.tsx  PlannerPanel.tsx  HarborPicker.tsx  OptionsPanel.tsx
      RouteSummary.tsx  PlansList.tsx  LiveView.tsx  Banner.tsx  AboutDialog.tsx
  e2e/
    plan.spec.ts  offline.spec.ts
  src/**/*.test.ts           # Vitest colocated unit/property tests
  src/test/fixtures.ts       # synthetic winds, masks, polar for tests
.github/workflows/
  ci.yml                     # lint + typecheck + unit + e2e on PRs
  deploy.yml                 # build + deploy Pages on main
```

## Shared domain types (referenced by every task)

`app/src/types.ts` — single source of truth, created in Task B1:

```ts
export interface LatLon {
  lat: number;
  lon: number;
}

export type Rig = 'genoa' | 'fock';
export type Board = 'port' | 'starboard';
export type LegKind = 'sail' | 'motor';
export type ManeuverKind = 'tack' | 'gybe';

export interface Settings {
  safetyDepthM: number; // default 3.0
  motorSpeedKn: number; // default 6.5
  motorThresholdKn: number; // default 2.5
  maneuverPenaltyS: number; // default 45
  performanceFactor: number; // default 0.9
  motorEnabled: boolean; // default true
}

export const DEFAULT_SETTINGS: Settings = {
  safetyDepthM: 3.0,
  motorSpeedKn: 6.5,
  motorThresholdKn: 2.5,
  maneuverPenaltyS: 45,
  performanceFactor: 0.9,
  motorEnabled: true,
};

export interface PolarTable {
  rig: Rig;
  boat: string;
  tws: number[]; // knots, ascending
  twa: number[]; // degrees 0..180, ascending
  speeds: number[][]; // speeds[twaIdx][twsIdx] = boat speed kn
  beat: { tws: number[]; angle: number[] }; // optimal beat TWA per TWS
  gybe: { tws: number[]; angle: number[] }; // optimal downwind TWA per TWS
  source: string;
}

// Flattened index: ((ti * lats.length) + latIdx) * lons.length + lonIdx
export interface WindGrid {
  lats: number[]; // ascending
  lons: number[]; // ascending
  timesMs: number[]; // hourly, ascending, UTC epoch ms
  speedKn: Float32Array;
  dirFromDeg: Float32Array; // meteorological: coming FROM, degrees true
  gustKn: Float32Array;
  fetchedAtMs: number;
  model: string;
}

export interface WindSample {
  speedKn: number;
  dirFromDeg: number;
  gustKn: number;
}

export interface Leg {
  kind: LegKind;
  board: Board | null; // null for motor
  start: LatLon;
  end: LatLon;
  startTimeMs: number;
  endTimeMs: number;
  headingDeg: number; // course over ground, degrees true
  twaDeg: number; // signed: >= 0 starboard board, < 0 port board (0 = head-to-wind edge case, starboard); NaN for motor
  twsKn: number; // TWS at leg start
  speedKn: number;
  distanceNm: number;
  maneuverAtStart: ManeuverKind | null;
}

export interface RigResult {
  rig: Rig;
  legs: Leg[];
  etaMs: number;
  durationMs: number;
  distanceNm: number;
  maneuverCount: number;
  motorDistanceNm: number;
}

export type NoRouteReason =
  | 'unreachable' // frontier died against land/depth everywhere
  | 'beyond-horizon' // forecast horizon exceeded before arrival
  | 'calm-motor-off' // no progress possible under sail, motor disabled
  | 'snap-failed-origin' // origin not navigable within 300 m
  | 'snap-failed-destination';

export interface PlanRequest {
  origin: LatLon;
  destination: LatLon;
  originHarborId: string | null;
  destinationHarborId: string | null;
  departureMs: number;
  settings: Settings;
}

export interface PlanResultOk {
  status: 'ok';
  genoa: RigResult | null; // null if that rig found no route
  fock: RigResult | null;
  // Amendment 2026-07-15 (PR #5 self-review, user-approved): why a null rig
  // found no route — the spec's "both results are user-visible" needs the
  // reason, not just the absence. null when the rig has a result.
  genoaReason: NoRouteReason | null;
  fockReason: NoRouteReason | null;
  recommended: Rig;
  snappedOrigin: LatLon;
  snappedDestination: LatLon;
}

export interface PlanResultError {
  status: 'error';
  reason: NoRouteReason;
}

export type PlanResult = PlanResultOk | PlanResultError;

export interface Plan {
  id: string; // crypto.randomUUID()
  name: string; // e.g. "Flensburg → Marstal"
  createdAtMs: number;
  request: PlanRequest;
  windGrid: WindGrid; // the forecast this plan was computed from
  result: PlanResultOk;
}

export interface Harbor {
  id: string;
  names: { de: string; da: string; en: string };
  country: 'DE' | 'DK';
  snap: LatLon; // guaranteed-navigable point off the harbor mouth
  approachNote?: { de: string; en: string };
}

export interface MaskMeta {
  west: number;
  south: number;
  east: number;
  north: number;
  cols: number;
  rows: number;
  // encoding: byte 0 = LAND or unknown/unsurveyed (non-navigable);
  // 1..254 = depth in decimeters, rounded DOWN (0.1..25.4 m);
  // 255 = deep (>= 25.4 m). Row 0 = southernmost row,
  // col 0 = westernmost col; cell center = origin + (idx + 0.5) * step.
}
```

Boards and signed TWA convention (used consistently everywhere):
`twaSigned = normalizeDeg180(windFromDeg - headingDeg)`; `twaSigned >= 0` → wind over the **starboard** side (starboard board), `< 0` → **port**. Polar lookups always use `Math.abs(twaSigned)`.

---

# Phase A — Scaffold & tooling

### Task A1: App scaffold, test tooling, CI

**Files:**
- Create: `app/package.json`, `app/vite.config.ts`, `app/tsconfig.json`, `app/index.html`, `app/src/main.tsx`, `app/src/App.tsx`, `app/src/app.css`, `app/eslint.config.js`, `app/.prettierrc.json`, `app/src/App.test.tsx`, `.github/workflows/ci.yml`
- Modify: `.gitignore` (add `app/node_modules/`, `app/dist/`, `app/test-results/`, `app/playwright-report/`, `pipeline/data-src/`, `pipeline/node_modules/`, `pipeline/.venv/`)

**Interfaces:**
- Produces: `npm --prefix app/ run dev|build|test|lint|typecheck` scripts every later task relies on. Vite `base: '/sail_command/'`.

- [ ] **Step 1: Scaffold the Vite app**

Run: `npm create vite@latest app -- --template react-ts` then `npm --prefix app/ install`.
Pin exact dependency versions from the "Package versions" appendix at the end of this plan (research-verified); install dev deps: `vitest`, `@vitest/coverage-v8`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `fast-check`, `fake-indexeddb`, `@playwright/test`, `eslint`, `prettier`, `typescript-eslint`.

- [ ] **Step 2: Configure Vite + Vitest**

`app/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/sail_command/',
  plugins: [react()],
  build: { target: 'es2022' },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

`app/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

`app/package.json` scripts:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src e2e",
    "typecheck": "tsc -b --noEmit",
    "e2e": "playwright test"
  }
}
```

- [ ] **Step 3: Minimal App shell + smoke test**

`app/src/App.tsx` (placeholder replaced in Phase E):

```tsx
export default function App() {
  return (
    <main>
      <h1>SailCommand</h1>
    </main>
  );
}
```

`app/src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import App from './App';

it('renders the app shell', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'SailCommand' })).toBeInTheDocument();
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix app/ run test`
Expected: 1 passed.

- [ ] **Step 5: CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  app:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: app } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: app/package-lock.json }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build
```

(Playwright job is added in Task F2 when E2E exists.)

- [ ] **Step 6: Commit**

```bash
git add app/ .github/ .gitignore
git commit -m "feat: scaffold Vite+React+TS app with Vitest, ESLint, CI"
```

### Task A2: i18n dictionary + provider

**Files:**
- Create: `app/src/i18n/dict.de.ts`, `app/src/i18n/dict.en.ts`, `app/src/i18n/index.tsx`, `app/src/i18n/i18n.test.tsx`

**Interfaces:**
- Produces: `useT(): (key: MsgKey, vars?: Record<string, string | number>) => string`, `useLang(): ['de' | 'en', (l: 'de' | 'en') => void]`, `<I18nProvider>`. `MsgKey = keyof typeof de`. Every UI task adds its keys to BOTH dictionaries; TypeScript enforces key parity via `satisfies Record<MsgKey, string>` on the English dict.

- [ ] **Step 1: Write failing tests**

`app/src/i18n/i18n.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider, useT, useLang } from './index';

function Probe() {
  const t = useT();
  const [lang, setLang] = useLang();
  return (
    <div>
      <span data-testid="msg">{t('app.title')}</span>
      <span data-testid="vars">{t('plan.eta', { time: '14:30' })}</span>
      <button onClick={() => setLang(lang === 'de' ? 'en' : 'de')}>toggle</button>
    </div>
  );
}

it('translates, interpolates and toggles language with persistence', () => {
  localStorage.setItem('sc-lang', 'de');
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>,
  );
  expect(screen.getByTestId('msg')).toHaveTextContent('SailCommand');
  expect(screen.getByTestId('vars').textContent).toContain('14:30');
  fireEvent.click(screen.getByText('toggle'));
  expect(localStorage.getItem('sc-lang')).toBe('en');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app/ run test -- i18n`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`app/src/i18n/dict.de.ts` (seed — every later UI task extends both dicts):

```ts
export const de = {
  'app.title': 'SailCommand',
  'app.disclaimer':
    'SailCommand ist eine Törnplanungshilfe, kein Navigationsgerät. Kartendaten sind vereinfacht; maßgeblich bleiben amtliche Seekarten und der Plotter.',
  'plan.eta': 'Ankunft {time}',
} as const;
export type MsgKey = keyof typeof de;
```

`app/src/i18n/dict.en.ts`:

```ts
import type { MsgKey } from './dict.de';

export const en = {
  'app.title': 'SailCommand',
  'app.disclaimer':
    'SailCommand is a passage-planning aid, not a navigation device. Chart data is simplified; official charts and your plotter remain authoritative.',
  'plan.eta': 'Arrival {time}',
} satisfies Record<MsgKey, string>;
```

`app/src/i18n/index.tsx`:

```tsx
import { createContext, useContext, useState, type ReactNode } from 'react';
import { de, type MsgKey } from './dict.de';
import { en } from './dict.en';

export type Lang = 'de' | 'en';
const dicts: Record<Lang, Record<MsgKey, string>> = { de, en };

const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: 'de',
  setLang: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() =>
    localStorage.getItem('sc-lang') === 'en' ? 'en' : 'de',
  );
  const setLang = (l: Lang) => {
    localStorage.setItem('sc-lang', l);
    setLangState(l);
  };
  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
}

export function useLang(): [Lang, (l: Lang) => void] {
  const { lang, setLang } = useContext(LangCtx);
  return [lang, setLang];
}

export function useT() {
  const { lang } = useContext(LangCtx);
  return (key: MsgKey, vars?: Record<string, string | number>): string => {
    let msg: string = dicts[lang][key];
    for (const [k, v] of Object.entries(vars ?? {})) msg = msg.replaceAll(`{${k}}`, String(v));
    return msg;
  };
}
```

- [ ] **Step 4: Run tests, expect PASS**, then **Step 5: Commit**

```bash
git add app/src/i18n
git commit -m "feat: de/en i18n dictionary with typed keys and persisted toggle"
```

---

# Phase B — Domain core (pure TS, no DOM)

All Phase B modules are pure TypeScript with no browser APIs (except the worker entry in B12), so they run in Vitest's node/jsdom environment and inside the Web Worker unchanged. Synthetic fixtures live in `app/src/test/fixtures.ts` and grow task by task.

### Task B1: Domain types + geo helpers

**Files:**
- Create: `app/src/types.ts` (exact content from "Shared domain types" section above), `app/src/lib/geo.ts`, `app/src/lib/geo.test.ts`

**Interfaces:**
- Produces: everything in `types.ts`; from `geo.ts`:
  `toRad(deg)`, `toDeg(rad)`, `normalizeDeg360(deg)`, `normalizeDeg180(deg)` (result in (-180, 180]), `haversineNm(a: LatLon, b: LatLon): number`, `initialBearingDeg(a, b): number` (0..360), `destinationPoint(a: LatLon, bearingDeg: number, distNm: number): LatLon`, `crossTrackNm(p: LatLon, a: LatLon, b: LatLon): number`, `alongTrackFraction(p: LatLon, a: LatLon, b: LatLon): number`.

- [ ] **Step 1: Write failing tests**

`app/src/lib/geo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  destinationPoint,
  haversineNm,
  initialBearingDeg,
  normalizeDeg180,
  normalizeDeg360,
} from './geo';

const flensburg = { lat: 54.7937, lon: 9.4327 };
const marstal = { lat: 54.8497, lon: 10.5177 };

describe('geo', () => {
  it('normalizes angles', () => {
    expect(normalizeDeg360(-90)).toBe(270);
    expect(normalizeDeg360(720)).toBe(0);
    expect(normalizeDeg180(270)).toBe(-90);
    expect(normalizeDeg180(180)).toBe(180);
    expect(normalizeDeg180(-180)).toBe(180);
  });

  it('computes haversine distance Flensburg→Marstal ≈ 37.7 nm', () => {
    expect(haversineNm(flensburg, marstal)).toBeGreaterThan(36);
    expect(haversineNm(flensburg, marstal)).toBeLessThan(39);
  });

  it('destinationPoint inverts haversine+bearing', () => {
    const brg = initialBearingDeg(flensburg, marstal);
    const d = haversineNm(flensburg, marstal);
    const p = destinationPoint(flensburg, brg, d);
    expect(haversineNm(p, marstal)).toBeLessThan(0.05);
  });

  it('bearing east at this latitude is ≈ 90°', () => {
    const p = destinationPoint(flensburg, 90, 5);
    expect(p.lat).toBeCloseTo(flensburg.lat, 2);
    expect(p.lon).toBeGreaterThan(flensburg.lon);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** (`npm --prefix app/ run test -- geo`)

- [ ] **Step 3: Implement**

`app/src/lib/geo.ts`:

```ts
import type { LatLon } from '../types';

export const EARTH_RADIUS_NM = 3440.065;

export const toRad = (deg: number): number => (deg * Math.PI) / 180;
export const toDeg = (rad: number): number => (rad * 180) / Math.PI;

export function normalizeDeg360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Normalize to (-180, 180]. */
export function normalizeDeg180(deg: number): number {
  const d = normalizeDeg360(deg);
  return d > 180 ? d - 360 : d;
}

export function haversineNm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(s));
}

export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg360(toDeg(Math.atan2(y, x)));
}

export function destinationPoint(a: LatLon, bearingDeg: number, distNm: number): LatLon {
  const δ = distNm / EARTH_RADIUS_NM;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: normalizeDeg180(toDeg(λ2)) };
}

/** Signed cross-track distance (nm) of p from great-circle segment a→b. */
export function crossTrackNm(p: LatLon, a: LatLon, b: LatLon): number {
  const d13 = haversineNm(a, p) / EARTH_RADIUS_NM;
  const θ13 = toRad(initialBearingDeg(a, p));
  const θ12 = toRad(initialBearingDeg(a, b));
  return Math.asin(Math.sin(d13) * Math.sin(θ13 - θ12)) * EARTH_RADIUS_NM;
}

/** Fraction (can be <0 or >1) of p's projection along segment a→b. */
export function alongTrackFraction(p: LatLon, a: LatLon, b: LatLon): number {
  const d13 = haversineNm(a, p) / EARTH_RADIUS_NM;
  const xt = crossTrackNm(p, a, b) / EARTH_RADIUS_NM;
  const at = Math.acos(Math.min(1, Math.max(-1, Math.cos(d13) / Math.cos(xt)))) * EARTH_RADIUS_NM;
  const total = haversineNm(a, b);
  const θ13 = toRad(initialBearingDeg(a, p));
  const θ12 = toRad(initialBearingDeg(a, b));
  const sign = Math.cos(θ13 - θ12) >= 0 ? 1 : -1;
  return total === 0 ? 0 : (sign * at) / total;
}
```

Also create `app/src/types.ts` with the exact content of the "Shared domain types" section at the top of this plan.

- [ ] **Step 4: Run tests, expect PASS** — also `npm --prefix app/ run typecheck`

- [ ] **Step 5: Commit** — `git add app/src && git commit -m "feat: domain types and spherical geo helpers"`

### Task B2: Polar interpolation

**Files:**
- Create: `app/src/lib/polar.ts`, `app/src/lib/polar.test.ts`, `app/src/test/fixtures.ts` (start)

**Interfaces:**
- Consumes: `PolarTable` from `types.ts`.
- Produces: `class Polar { constructor(table: PolarTable, performanceFactor?: number); speedKn(twaDeg: number, twsKn: number): number; beatAngleDeg(twsKn: number): number; gybeAngleDeg(twsKn: number): number; readonly rig: Rig }`. `speedKn` accepts signed or unsigned TWA (uses `|normalizeDeg180(twa)|`), applies the performance factor, bilinear-interpolates the grid, clamps TWS above table max, scales linearly toward 0 below table min TWS, and tapers linearly to 0 between TWA=0 and the first table TWA row (no-go zone).

- [ ] **Step 1: Write failing tests**

`app/src/test/fixtures.ts` (start — grows in later tasks):

```ts
import type { PolarTable } from '../types';

/** Tiny synthetic polar: symmetric, monotone in TWS, humped over TWA. */
export const TEST_POLAR: PolarTable = {
  rig: 'genoa',
  boat: 'test',
  tws: [4, 8, 12, 16, 20],
  twa: [40, 60, 90, 120, 150, 180],
  speeds: [
    [2.0, 4.0, 5.5, 6.0, 6.2], // 40
    [2.6, 5.0, 6.5, 7.2, 7.4], // 60
    [3.0, 5.6, 7.2, 8.2, 8.6], // 90
    [2.8, 5.2, 7.0, 8.4, 8.8], // 120
    [2.0, 4.0, 5.8, 7.0, 7.8], // 150
    [1.6, 3.2, 4.8, 6.0, 6.8], // 180
  ],
  beat: { tws: [4, 8, 12, 16, 20], angle: [47, 44, 42, 40, 40] },
  gybe: { tws: [4, 8, 12, 16, 20], angle: [150, 155, 165, 170, 175] },
  source: 'synthetic test fixture',
};
```

`app/src/lib/polar.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Polar } from './polar';
import { TEST_POLAR } from '../test/fixtures';

describe('Polar', () => {
  const p = new Polar(TEST_POLAR, 1.0);

  it('returns exact grid values at grid points', () => {
    expect(p.speedKn(90, 12)).toBeCloseTo(7.2, 5);
    expect(p.speedKn(180, 4)).toBeCloseTo(1.6, 5);
  });

  it('is symmetric in signed TWA', () => {
    expect(p.speedKn(-90, 12)).toBeCloseTo(p.speedKn(90, 12), 10);
  });

  it('bilinearly interpolates between grid points', () => {
    // midway 90..120 TWA, 12..16 TWS: mean of 7.2, 8.2, 7.0, 8.4 = 7.7
    expect(p.speedKn(105, 14)).toBeCloseTo(7.7, 5);
  });

  it('clamps TWS above table max and scales below min', () => {
    expect(p.speedKn(90, 30)).toBeCloseTo(8.6, 5);
    expect(p.speedKn(90, 2)).toBeCloseTo(3.0 * (2 / 4), 5);
    expect(p.speedKn(90, 0)).toBe(0);
  });

  it('tapers to zero inside the no-go zone', () => {
    expect(p.speedKn(0, 12)).toBe(0);
    expect(p.speedKn(20, 12)).toBeCloseTo(5.5 * (20 / 40), 5);
    expect(p.speedKn(40, 12)).toBeCloseTo(5.5, 5);
  });

  it('applies the performance factor', () => {
    const p09 = new Polar(TEST_POLAR, 0.9);
    expect(p09.speedKn(90, 12)).toBeCloseTo(7.2 * 0.9, 5);
  });

  it('interpolates beat and gybe angles over TWS', () => {
    expect(p.beatAngleDeg(4)).toBeCloseTo(47, 5);
    expect(p.beatAngleDeg(6)).toBeCloseTo(45.5, 5);
    expect(p.beatAngleDeg(99)).toBeCloseTo(40, 5);
    expect(p.gybeAngleDeg(12)).toBeCloseTo(165, 5);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

`app/src/lib/polar.ts`:

```ts
import type { PolarTable, Rig } from '../types';
import { normalizeDeg180 } from './geo';

function interp1(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (xs[i] < x) i++;
  const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + f * (ys[i] - ys[i - 1]);
}

export class Polar {
  readonly rig: Rig;

  constructor(
    private table: PolarTable,
    private performanceFactor = 1.0,
  ) {
    this.rig = table.rig;
  }

  speedKn(twaDeg: number, twsKn: number): number {
    const { tws, twa, speeds } = this.table;
    const a = Math.abs(normalizeDeg180(twaDeg));
    if (twsKn <= 0) return 0;

    // TWS: clamp above max, scale linearly to 0 below min.
    let twsFactor = 1;
    let w = twsKn;
    if (w > tws[tws.length - 1]) w = tws[tws.length - 1];
    if (w < tws[0]) {
      twsFactor = w / tws[0];
      w = tws[0];
    }
    let j = 1;
    while (j < tws.length - 1 && tws[j] < w) j++;
    const fw = (w - tws[j - 1]) / (tws[j] - tws[j - 1]);

    const speedAtTwa = (rowLo: number, rowHi: number, fa: number): number => {
      const lo = speeds[rowLo][j - 1] + fw * (speeds[rowLo][j] - speeds[rowLo][j - 1]);
      const hi = speeds[rowHi][j - 1] + fw * (speeds[rowHi][j] - speeds[rowHi][j - 1]);
      return lo + fa * (hi - lo);
    };

    let v: number;
    if (a <= twa[0]) {
      // no-go taper: 0 at TWA 0 → full value at first table row
      v = speedAtTwa(0, 0, 0) * (a / twa[0]);
    } else if (a >= twa[twa.length - 1]) {
      v = speedAtTwa(twa.length - 1, twa.length - 1, 0);
    } else {
      let i = 1;
      while (twa[i] < a) i++;
      const fa = (a - twa[i - 1]) / (twa[i] - twa[i - 1]);
      v = speedAtTwa(i - 1, i, fa);
    }
    return v * twsFactor * this.performanceFactor;
  }

  beatAngleDeg(twsKn: number): number {
    return interp1(this.table.beat.tws, this.table.beat.angle, twsKn);
  }

  gybeAngleDeg(twsKn: number): number {
    return interp1(this.table.gybe.tws, this.table.gybe.angle, twsKn);
  }
}
```

- [ ] **Step 4: Run tests, expect PASS** · **Step 5: Commit** (`feat: polar table bilinear interpolation with no-go taper`)

### Task B3: Wind field interpolation

**Files:**
- Create: `app/src/lib/wind.ts`, `app/src/lib/wind.test.ts`
- Modify: `app/src/test/fixtures.ts` (add wind fixture builders)

**Interfaces:**
- Consumes: `WindGrid`, `WindSample`, `LatLon` from `types.ts`.
- Produces: `class WindField { constructor(grid: WindGrid); sample(p: LatLon, tMs: number): WindSample; horizonMs(): number; startMs(): number }`. Spatially bilinear + temporally linear, **interpolating wind vectors as u/v components** (never raw angles). Positions/times outside the grid are clamped to the nearest edge. Also produces fixture helper `uniformWindGrid(speedKn, dirFromDeg, opts?): WindGrid` and `makeWindGrid(fn, opts?)` where `fn(lat, lon, hourIdx) → {speedKn, dirFromDeg}` used by all router tests.

- [ ] **Step 1: Write failing tests**

Add to `app/src/test/fixtures.ts`:

```ts
import type { WindGrid } from '../types';

export interface WindGridOpts {
  south?: number; north?: number; west?: number; east?: number;
  latStep?: number; lonStep?: number; hours?: number; t0Ms?: number;
}

export function makeWindGrid(
  fn: (lat: number, lon: number, hourIdx: number) => { speedKn: number; dirFromDeg: number },
  opts: WindGridOpts = {},
): WindGrid {
  const {
    south = 54.3, north = 55.3, west = 9.4, east = 11.0,
    latStep = 0.1, lonStep = 0.1, hours = 48,
    t0Ms = Date.UTC(2026, 6, 15, 6, 0, 0),
  } = opts;
  const lats: number[] = [];
  const lons: number[] = [];
  for (let la = south; la <= north + 1e-9; la += latStep) lats.push(Number(la.toFixed(6)));
  for (let lo = west; lo <= east + 1e-9; lo += lonStep) lons.push(Number(lo.toFixed(6)));
  const timesMs = Array.from({ length: hours }, (_, i) => t0Ms + i * 3_600_000);
  const n = timesMs.length * lats.length * lons.length;
  const speedKn = new Float32Array(n);
  const dirFromDeg = new Float32Array(n);
  const gustKn = new Float32Array(n);
  let k = 0;
  for (let ti = 0; ti < timesMs.length; ti++)
    for (const lat of lats)
      for (const lon of lons) {
        const w = fn(lat, lon, ti);
        speedKn[k] = w.speedKn;
        dirFromDeg[k] = w.dirFromDeg;
        gustKn[k] = w.speedKn * 1.3;
        k++;
      }
  return { lats, lons, timesMs, speedKn, dirFromDeg, gustKn, fetchedAtMs: t0Ms, model: 'test' };
}

export const uniformWindGrid = (speedKn: number, dirFromDeg: number, opts: WindGridOpts = {}) =>
  makeWindGrid(() => ({ speedKn, dirFromDeg }), opts);
```

`app/src/lib/wind.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { WindField } from './wind';
import { makeWindGrid, uniformWindGrid } from '../test/fixtures';

describe('WindField', () => {
  it('returns the uniform value everywhere, any time', () => {
    const wf = new WindField(uniformWindGrid(12, 270));
    const s = wf.sample({ lat: 54.75, lon: 10.123 }, wf.startMs() + 90 * 60_000);
    expect(s.speedKn).toBeCloseTo(12, 4);
    expect(s.dirFromDeg).toBeCloseTo(270, 3);
  });

  it('interpolates direction across the 0°/360° wrap via vectors', () => {
    // Two adjacent columns: 350° and 10° — the midpoint must be 0°, never 180°.
    const wf = new WindField(
      makeWindGrid((_, lon) => ({ speedKn: 10, dirFromDeg: lon < 10.2 ? 350 : 10 }), {
        lonStep: 0.1, latStep: 0.5,
      }),
    );
    const mid = wf.sample({ lat: 54.8, lon: 10.25 }, wf.startMs());
    expect(Math.abs(((mid.dirFromDeg + 180) % 360) - 180)).toBeLessThan(1); // ≈ 0°/360°
    expect(mid.speedKn).toBeGreaterThan(9); // vector mean of same-speed near-parallel winds
  });

  it('interpolates linearly in time', () => {
    const wf = new WindField(makeWindGrid((_la, _lo, h) => ({ speedKn: 10 + h, dirFromDeg: 180 })));
    const s = wf.sample({ lat: 54.8, lon: 10.2 }, wf.startMs() + 30 * 60_000);
    expect(s.speedKn).toBeCloseTo(10.5, 3);
  });

  it('clamps outside the grid spatially and temporally', () => {
    const wf = new WindField(uniformWindGrid(8, 90));
    expect(wf.sample({ lat: 60, lon: 20 }, wf.startMs() - 3_600_000).speedKn).toBeCloseTo(8, 4);
    expect(wf.sample({ lat: 54.8, lon: 10 }, wf.horizonMs() + 3_600_000).speedKn).toBeCloseTo(8, 4);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

`app/src/lib/wind.ts`:

```ts
import type { LatLon, WindGrid, WindSample } from '../types';
import { normalizeDeg360, toDeg, toRad } from './geo';

/** Index of the last element <= x (clamped to [0, xs.length-2]) plus fraction. */
function bracket(xs: number[], x: number): { i: number; f: number } {
  if (x <= xs[0]) return { i: 0, f: 0 };
  const n = xs.length;
  if (n === 1) return { i: 0, f: 0 };
  if (x >= xs[n - 1]) return { i: n - 2, f: 1 };
  let i = 0;
  while (xs[i + 1] < x) i++;
  return { i, f: (x - xs[i]) / (xs[i + 1] - xs[i]) };
}

export class WindField {
  constructor(private grid: WindGrid) {}

  startMs(): number {
    return this.grid.timesMs[0];
  }

  horizonMs(): number {
    return this.grid.timesMs[this.grid.timesMs.length - 1];
  }

  sample(p: LatLon, tMs: number): WindSample {
    const { lats, lons, timesMs, speedKn, dirFromDeg, gustKn } = this.grid;
    const la = bracket(lats, p.lat);
    const lo = bracket(lons, p.lon);
    const tt = bracket(timesMs, tMs);
    const nLon = lons.length;
    const nLat = lats.length;

    // Accumulate u/v (wind vector TOWARD which air moves) and gust bilinearly,
    // then linearly across the two time slices.
    let u = 0, v = 0, g = 0;
    for (const [ti, wt] of [
      [tt.i, 1 - tt.f],
      [tt.i + 1 < timesMs.length ? tt.i + 1 : tt.i, tt.f],
    ] as const) {
      if (wt === 0) continue;
      for (const [lai, wla] of [
        [la.i, 1 - la.f],
        [la.i + 1 < nLat ? la.i + 1 : la.i, la.f],
      ] as const) {
        if (wla === 0) continue;
        for (const [loi, wlo] of [
          [lo.i, 1 - lo.f],
          [lo.i + 1 < nLon ? lo.i + 1 : lo.i, lo.f],
        ] as const) {
          if (wlo === 0) continue;
          const k = (ti * nLat + lai) * nLon + loi;
          const w = wt * wla * wlo;
          const sp = speedKn[k];
          const dir = toRad(dirFromDeg[k]);
          u += w * -sp * Math.sin(dir);
          v += w * -sp * Math.cos(dir);
          g += w * gustKn[k];
        }
      }
    }
    const speed = Math.hypot(u, v);
    const dir = speed < 1e-6 ? 0 : normalizeDeg360(toDeg(Math.atan2(-u, -v)));
    return { speedKn: speed, dirFromDeg: dir, gustKn: g };
  }
}
```

- [ ] **Step 4: Run tests, expect PASS** · **Step 5: Commit** (`feat: wind grid space/time interpolation on vector components`)

### Task B4: NavMask — depth queries, segment tests, snapping

**Files:**
- Create: `app/src/lib/mask.ts`, `app/src/lib/mask.test.ts`
- Modify: `app/src/test/fixtures.ts` (add `makeMask`)

**Interfaces:**
- Consumes: `MaskMeta`, `LatLon` from `types.ts`.
- Produces:
  ```ts
  class NavMask {
    constructor(meta: MaskMeta, data: Uint8Array);
    depthM(p: LatLon): number;            // 0 = land; 255 → 25.4
    isNavigable(p: LatLon, safetyDepthM: number): boolean;
    segmentNavigable(a: LatLon, b: LatLon, safetyDepthM: number): boolean;
    snapToNavigable(p: LatLon, safetyDepthM: number, maxRadiusM?: number): LatLon | null; // default 300 m
  }
  ```
  Cells outside the bbox are NOT navigable (routing stays inside the data area). `segmentNavigable` visits every cell the segment passes through (Amanatides–Woo traversal in grid space, straight line in lat/lon — fine at ≤2 nm step lengths). Fixture: `makeMask(rows, cols, fn)` where `fn(row, col) → depth byte`, plus `openWaterMask()` (all 200 ≙ 20 m) and `wallMask()` (vertical land wall with a gap) used by router tests.

- [ ] **Step 1: Write failing tests**

Add to `app/src/test/fixtures.ts`:

```ts
import type { MaskMeta } from '../types';
import { NavMask } from '../lib/mask';

export const TEST_MASK_META: MaskMeta = {
  west: 9.4, south: 54.3, east: 11.0, north: 55.3, cols: 320, rows: 200,
};

export function makeMask(fn: (row: number, col: number) => number, meta = TEST_MASK_META): NavMask {
  const data = new Uint8Array(meta.rows * meta.cols);
  for (let r = 0; r < meta.rows; r++)
    for (let c = 0; c < meta.cols; c++) data[r * meta.cols + c] = fn(r, c);
  return new NavMask(meta, data);
}

/** All water, 20 m deep. */
export const openWaterMask = () => makeMask(() => 200);

/** Land wall at col 160 (lon ≈ 10.2), except rows 90..99 (a gap). */
export const wallMask = () =>
  makeMask((r, c) => (c === 160 && (r < 90 || r > 99) ? 0 : 200));
```

`app/src/lib/mask.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeMask, openWaterMask, TEST_MASK_META } from '../test/fixtures';

const CELL_LAT = (TEST_MASK_META.north - TEST_MASK_META.south) / TEST_MASK_META.rows; // 0.005
const CELL_LON = (TEST_MASK_META.east - TEST_MASK_META.west) / TEST_MASK_META.cols; // 0.005

describe('NavMask', () => {
  it('reads depth per cell (row 0 = south, col 0 = west)', () => {
    const m = makeMask((r, c) => (r === 0 && c === 0 ? 31 : 200));
    // center of cell (0,0)
    const p = { lat: 54.3 + CELL_LAT / 2, lon: 9.4 + CELL_LON / 2 };
    expect(m.depthM(p)).toBeCloseTo(3.1, 5);
    expect(m.isNavigable(p, 3.0)).toBe(true);
    expect(m.isNavigable(p, 3.2)).toBe(false);
  });

  it('treats land, out-of-bbox and 255 correctly', () => {
    const m = makeMask((r) => (r < 5 ? 0 : 255));
    expect(m.isNavigable({ lat: 54.301, lon: 10 }, 3)).toBe(false); // land
    expect(m.isNavigable({ lat: 55.2, lon: 10 }, 3)).toBe(true); // 255 → 25.4 m
    expect(m.isNavigable({ lat: 56, lon: 10 }, 3)).toBe(false); // outside bbox
  });

  it('segment test catches a one-cell wall the endpoints straddle', () => {
    // wall at col 160 across all rows
    const m = makeMask((_, c) => (c === 160 ? 0 : 200));
    const a = { lat: 54.75, lon: 10.19 };
    const b = { lat: 54.76, lon: 10.22 };
    expect(m.isNavigable(a, 3)).toBe(true);
    expect(m.isNavigable(b, 3)).toBe(true);
    expect(m.segmentNavigable(a, b, 3)).toBe(false);
    expect(m.segmentNavigable(a, { lat: 54.76, lon: 10.19 }, 3)).toBe(true);
  });

  it('segment test respects safety depth at query time', () => {
    const m = makeMask((_, c) => (c === 160 ? 25 : 200)); // 2.5 m shoal line
    const a = { lat: 54.75, lon: 10.19 };
    const b = { lat: 54.75, lon: 10.22 };
    expect(m.segmentNavigable(a, b, 3.0)).toBe(false);
    expect(m.segmentNavigable(a, b, 2.0)).toBe(true);
  });

  it('snaps to the nearest navigable cell within 300 m, else null', () => {
    // land everywhere except col >= 162
    const m = makeMask((_, c) => (c < 162 ? 0 : 200));
    const onLand = { lat: 54.75, lon: 10.205 }; // col ≈ 161 → land, ~160 m from col 162
    const snapped = m.snapToNavigable(onLand, 3.0);
    expect(snapped).not.toBeNull();
    expect(m.isNavigable(snapped!, 3.0)).toBe(true);
    const deepInland = { lat: 54.75, lon: 9.5 };
    expect(m.snapToNavigable(deepInland, 3.0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

`app/src/lib/mask.ts`:

```ts
import type { LatLon, MaskMeta } from '../types';
import { haversineNm } from './geo';

const LAND = 0;
const NM_PER_M = 1 / 1852;

export class NavMask {
  private latStep: number;
  private lonStep: number;

  constructor(
    readonly meta: MaskMeta,
    private data: Uint8Array,
  ) {
    if (data.length !== meta.rows * meta.cols)
      throw new Error(`mask data length ${data.length} != rows*cols ${meta.rows * meta.cols}`);
    this.latStep = (meta.north - meta.south) / meta.rows;
    this.lonStep = (meta.east - meta.west) / meta.cols;
  }

  private cellOf(p: LatLon): { row: number; col: number } | null {
    const row = Math.floor((p.lat - this.meta.south) / this.latStep);
    const col = Math.floor((p.lon - this.meta.west) / this.lonStep);
    if (row < 0 || row >= this.meta.rows || col < 0 || col >= this.meta.cols) return null;
    return { row, col };
  }

  private depthByte(row: number, col: number): number {
    return this.data[row * this.meta.cols + col];
  }

  private byteToDepthM(b: number): number {
    return b === LAND ? 0 : b === 255 ? 25.4 : b / 10;
  }

  depthM(p: LatLon): number {
    const c = this.cellOf(p);
    return c ? this.byteToDepthM(this.depthByte(c.row, c.col)) : 0;
  }

  isNavigable(p: LatLon, safetyDepthM: number): boolean {
    const c = this.cellOf(p);
    if (!c) return false;
    const b = this.depthByte(c.row, c.col);
    return b !== LAND && this.byteToDepthM(b) >= safetyDepthM;
  }

  private cellNavigable(row: number, col: number, safetyDepthM: number): boolean {
    if (row < 0 || row >= this.meta.rows || col < 0 || col >= this.meta.cols) return false;
    const b = this.depthByte(row, col);
    return b !== LAND && this.byteToDepthM(b) >= safetyDepthM;
  }

  /** Amanatides–Woo grid traversal from a to b; every touched cell must be navigable. */
  segmentNavigable(a: LatLon, b: LatLon, safetyDepthM: number): boolean {
    // continuous grid coordinates (col-space x, row-space y)
    const x0 = (a.lon - this.meta.west) / this.lonStep;
    const y0 = (a.lat - this.meta.south) / this.latStep;
    const x1 = (b.lon - this.meta.west) / this.lonStep;
    const y1 = (b.lat - this.meta.south) / this.latStep;
    let cx = Math.floor(x0);
    let cy = Math.floor(y0);
    const ex = Math.floor(x1);
    const ey = Math.floor(y1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
    let tMaxX =
      stepX === 0 ? Infinity : (stepX > 0 ? cx + 1 - x0 : x0 - cx) * tDeltaX;
    let tMaxY =
      stepY === 0 ? Infinity : (stepY > 0 ? cy + 1 - y0 : y0 - cy) * tDeltaY;

    if (!this.cellNavigable(cy, cx, safetyDepthM)) return false;
    // guard: bounded number of iterations
    for (let iter = 0; iter < this.meta.rows + this.meta.cols + 4; iter++) {
      if (cx === ex && cy === ey) return true;
      if (tMaxX < tMaxY) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        cy += stepY;
        tMaxY += tDeltaY;
      }
      if (!this.cellNavigable(cy, cx, safetyDepthM)) return false;
    }
    return false;
  }

  /** Expanding ring search; returns center of nearest navigable cell within maxRadiusM. */
  snapToNavigable(p: LatLon, safetyDepthM: number, maxRadiusM = 300): LatLon | null {
    const start = {
      row: Math.floor((p.lat - this.meta.south) / this.latStep),
      col: Math.floor((p.lon - this.meta.west) / this.lonStep),
    };
    const cellM = 111_320 * this.latStep; // ~cell height in meters
    const maxRing = Math.ceil(maxRadiusM / cellM) + 1;
    let best: { p: LatLon; d: number } | null = null;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const row = start.row + dr;
          const col = start.col + dc;
          if (!this.cellNavigable(row, col, safetyDepthM)) continue;
          const center = {
            lat: this.meta.south + (row + 0.5) * this.latStep,
            lon: this.meta.west + (col + 0.5) * this.lonStep,
          };
          const dM = haversineNm(p, center) / NM_PER_M;
          if (dM <= maxRadiusM && (!best || dM < best.d)) best = { p: center, d: dM };
        }
      }
      if (best) return best.p; // rings grow outward; first ring with a hit is nearest (±ring width)
    }
    return best ? best.p : null;
  }
}
```

- [ ] **Step 4: Run tests, expect PASS** · **Step 5: Commit** (`feat: land/depth mask queries with grid-traversal segment tests and snapping`)

### Task B5: Maneuver detection

**Files:**
- Create: `app/src/routing/maneuver.ts`, `app/src/routing/maneuver.test.ts`

**Interfaces:**
- Produces:
  ```ts
  boardOf(twaSigned: number): Board;                       // >= 0 → 'starboard', < 0 → 'port'
  boardForCandidate(twaSigned: number, parentBoard: Board | null): Board; // |twa|==180 inherits parent
  classifyManeuver(prevTwaSigned: number, nextTwaSigned: number): ManeuverKind; // tack if |prev|+|next| <= 180, else gybe
  ```
  The isochrone charges `settings.maneuverPenaltyS` whenever a sail edge's board differs from a sail parent's board. Sail↔motor transitions carry **no** penalty and are **not** counted as maneuvers (documented assumption; the spec prices only tacks/gybes).

- [ ] **Step 1: Write failing tests**

`app/src/routing/maneuver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { boardForCandidate, boardOf, classifyManeuver } from './maneuver';

describe('maneuver', () => {
  it('derives board from signed TWA', () => {
    expect(boardOf(45)).toBe('starboard');
    expect(boardOf(-45)).toBe('port');
    expect(boardOf(0)).toBe('starboard'); // head-to-wind edge: arbitrary but stable
  });

  it('dead run inherits the parent board (no phantom gybe at exactly 180°)', () => {
    expect(boardForCandidate(180, 'port')).toBe('port');
    expect(boardForCandidate(-180, 'starboard')).toBe('starboard');
    expect(boardForCandidate(180, null)).toBe('starboard');
    expect(boardForCandidate(-45, 'starboard')).toBe('port');
  });

  it('classifies tack vs gybe by which way the boat turns through the wind', () => {
    expect(classifyManeuver(-45, 45)).toBe('tack'); // beat: through head-to-wind
    expect(classifyManeuver(-150, 150)).toBe('gybe'); // run: through dead-downwind
    expect(classifyManeuver(-60, 130)).toBe('gybe'); // mixed, shorter turn is through the stern
    expect(classifyManeuver(-60, 110)).toBe('tack'); // mixed, shorter turn is through the bow
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

`app/src/routing/maneuver.ts`:

```ts
import type { Board, ManeuverKind } from '../types';

export function boardOf(twaSigned: number): Board {
  return twaSigned >= 0 ? 'starboard' : 'port';
}

/** Board of a candidate heading; at exactly ±180° TWA the board is ambiguous → inherit. */
export function boardForCandidate(twaSigned: number, parentBoard: Board | null): Board {
  if (Math.abs(twaSigned) === 180 && parentBoard) return parentBoard;
  return boardOf(twaSigned);
}

/** Only called when the board actually changed between two sail legs. */
export function classifyManeuver(prevTwaSigned: number, nextTwaSigned: number): ManeuverKind {
  return Math.abs(prevTwaSigned) + Math.abs(nextTwaSigned) <= 180 ? 'tack' : 'gybe';
}
```

- [ ] **Step 4: Run tests, expect PASS** · **Step 5: Commit** (`feat: board and tack/gybe classification`)

### Task B6: Isochrone solver — sailing core

This is the heart of the app. Read the spec §3.2 "Routing engine" before starting.

**Files:**
- Create: `app/src/routing/isochrone.ts`, `app/src/routing/isochrone.test.ts`

**Interfaces:**
- Consumes: `Polar` (B2), `WindField` (B3), `NavMask` (B4), `boardForCandidate`/`classifyManeuver` (B5), geo helpers (B1).
- Produces:
  ```ts
  interface SolveParams {
    origin: LatLon;        // must already be navigable (snapping is planRoute's job)
    destination: LatLon;   // must already be navigable
    departureMs: number;
    polar: Polar;
    wind: WindField;
    mask: NavMask;
    settings: Settings;
    onProgress?: (info: { tMs: number; frontierSize: number }) => void;
  }
  type SolveResult =
    | { status: 'ok'; legs: Leg[]; etaMs: number }
    | { status: 'no-route'; reason: 'unreachable' | 'beyond-horizon' | 'calm-motor-off' };
  function solve(params: SolveParams): SolveResult;
  ```
  Algorithm (deterministic, no randomness):
  - Frontier of nodes all at the same elapsed time; step `dtS` = 600 s, shortening to 300 s when the closest frontier node is < 5 nm from destination and 150 s when < 2 nm ("adaptive Δt" per spec).
  - Candidate TWAs per node: `±beatAngle(tws)`, `±gybeAngle(tws)`, `±(45…175 in 10° steps)`, `180`, motor-enabling extras `±{0,20,35}` — plus always the **direct candidate** (heading = bearing to destination). (Survey of production routers: 3–5° candidate spacing is ideal; 10° + exact beat/gybe anchors + the direct candidate is the perf compromise — if routes zig-zag artificially, densify to 5° before touching anything else.) For each candidate heading: sail speed = `polar.speedKn(twa, tws)`; if `speed >= settings.motorThresholdKn` → sail edge; else if `settings.motorEnabled` → **motor edge** at `motorSpeedKn` (kind 'motor', board null); else if `speed >= MIN_SAIL_KN (0.2)` → slow sail edge; else the candidate dies (tracked as calm-death).
  - Maneuver penalty: sail edge whose board ≠ sail parent's board → effective step time `dtS - maneuverPenaltyS`, `maneuverAtStart` set via `classifyManeuver`, maneuver count +1.
  - Every edge segment must pass `mask.segmentNavigable(from, to, safetyDepthM)` (blocked-death otherwise).
  - Arrival: on the direct candidate, if `distToDest <= edge distance` and `segmentNavigable(node → destination)`, record arrival at `t + penalty + distToDest/speed`; also, any endpoint within 0.1 nm of the destination records arrival with a final exact leg. Keep the best (earliest) arrival.
  - Pruning after each step: key = `floor(lat/0.002)':'floor(lon/0.003)':'boardKey` (~200 m cells; boardKey ∈ P|S|M). Keep the best node per key: fewer cumulative maneuvers, then smaller distance-to-destination. A persistent `visited` map (same key → min maneuvers seen) drops nodes that fold back onto earlier isochrones with no maneuver advantage. Frontier hard cap 30 000 (keep closest-to-destination; deterministic sort with full tiebreak).
  - Termination: stop when frontier time ≥ best arrival (optimal within discretization) → backtrack; frontier empty without arrival → 'unreachable' if any blocked-deaths ≥ calm-deaths else 'calm-motor-off'; next step would pass `wind.horizonMs()` without an arrival → 'beyond-horizon'.
  - Backtrack merges only exactly-collinear consecutive steps (|Δheading| < 0.5°, same kind+board, no maneuver at the joint); everything else is postprocess's job (B8).
  - `twaDeg` on motor legs: `NaN`; `speedKn` on a leg = distance/time (accounts for penalty time loss).

- [ ] **Step 1: Write failing golden-route tests** (synthetic wind + masks from fixtures)

`app/src/routing/isochrone.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { solve, type SolveParams } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { openWaterMask, TEST_POLAR, uniformWindGrid, wallMask } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import { haversineNm } from '../lib/geo';

const A = { lat: 54.75, lon: 10.0 };
const B_EAST = { lat: 54.75, lon: 10.4 }; // ~13.9 nm due east of A

function params(overrides: Partial<SolveParams>): SolveParams {
  return {
    origin: A,
    destination: B_EAST,
    departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
    polar: new Polar(TEST_POLAR, 1.0),
    wind: new WindField(uniformWindGrid(12, 0)), // 12 kn from north
    mask: openWaterMask(),
    settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
    ...overrides,
  };
}

describe('isochrone golden routes', () => {
  it('beam reach: sails ~straight with zero maneuvers', () => {
    const r = solve(params({}));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.legs.every((l) => l.kind === 'sail')).toBe(true);
    expect(r.legs.filter((l) => l.maneuverAtStart).length).toBe(0);
    const dist = r.legs.reduce((s, l) => s + l.distanceNm, 0);
    expect(dist).toBeLessThan(haversineNm(A, B_EAST) * 1.15);
    // ~13.9 nm at ~7.2 kn ≈ 1.9 h
    const hours = (r.etaMs - params({}).departureMs) / 3_600_000;
    expect(hours).toBeGreaterThan(1.5);
    expect(hours).toBeLessThan(2.6);
  });

  it('dead upwind: tacks a small, bounded number of times', () => {
    const r = solve(params({ wind: new WindField(uniformWindGrid(12, 90)) })); // wind FROM east
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const maneuvers = r.legs.filter((l) => l.maneuverAtStart).length;
    expect(maneuvers).toBeGreaterThanOrEqual(1);
    expect(maneuvers).toBeLessThanOrEqual(4); // penalty must suppress tack spam
    // VMG sanity: beat at ~42° at ~6.5 kn → VMG ~4.8 kn → ~2.9h for 13.9 nm; allow slack
    const hours = (r.etaMs - params({}).departureMs) / 3_600_000;
    expect(hours).toBeGreaterThan(2.2);
    expect(hours).toBeLessThan(4.2);
    // legs alternate boards only at flagged maneuvers
    for (let i = 1; i < r.legs.length; i++) {
      const prev = r.legs[i - 1];
      const cur = r.legs[i];
      if (prev.kind === 'sail' && cur.kind === 'sail' && prev.board !== cur.board) {
        expect(cur.maneuverAtStart).not.toBeNull();
      }
    }
  });

  it('rounds an island between the ports instead of crossing it', () => {
    // wall at lon≈10.2 with a gap at lat≈54.75..54.80 → must aim for the gap
    const r = solve(params({ mask: wallMask(), wind: new WindField(uniformWindGrid(14, 0)) }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // every leg strictly navigable
    const m = wallMask();
    for (const l of r.legs) expect(m.segmentNavigable(l.start, l.end, 3)).toBe(true);
  });

  it('blocked destination → unreachable with reason', () => {
    // solid wall, no gap
    const solid = { ...params({}) };
    const r = solve({
      ...solid,
      mask: (() => {
        const { makeMask } = require('../test/fixtures');
        return makeMask((_: number, c: number) => (c === 160 ? 0 : 200));
      })(),
    });
    expect(r).toEqual({ status: 'no-route', reason: 'unreachable' });
  });

  it('calm with motor off → calm-motor-off; beyond horizon reported', () => {
    // 0.1 kn TWS → polar speeds ~0.07 kn < MIN_SAIL_KN → every sail edge dies.
    // (At 0.5 kn the boat still "sails" at ~0.37 kn and would crawl in — not calm.)
    const calm = solve(params({ wind: new WindField(uniformWindGrid(0.1, 0)) }));
    expect(calm).toEqual({ status: 'no-route', reason: 'calm-motor-off' });

    const short = solve(
      params({
        wind: new WindField(uniformWindGrid(4, 90, { hours: 2 })), // 2h horizon, upwind, light
      }),
    );
    expect(short).toEqual({ status: 'no-route', reason: 'beyond-horizon' });
  });

  it('is deterministic', () => {
    const a = solve(params({ wind: new WindField(uniformWindGrid(12, 45)) }));
    const b = solve(params({ wind: new WindField(uniformWindGrid(12, 45)) }));
    expect(a).toEqual(b);
  });
});
```

Note the `require` in the blocked test is a test-file shortcut; import `makeMask` at the top instead when writing the real file.

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

`app/src/routing/isochrone.ts`:

```ts
import type { Board, Leg, LegKind, LatLon, ManeuverKind, Settings } from '../types';
import type { Polar } from '../lib/polar';
import type { WindField } from '../lib/wind';
import type { NavMask } from '../lib/mask';
import {
  destinationPoint,
  haversineNm,
  initialBearingDeg,
  normalizeDeg180,
} from '../lib/geo';
import { boardForCandidate, classifyManeuver } from './maneuver';

export interface SolveParams {
  origin: LatLon;
  destination: LatLon;
  departureMs: number;
  polar: Polar;
  wind: WindField;
  mask: NavMask;
  settings: Settings;
  onProgress?: (info: { tMs: number; frontierSize: number }) => void;
}

export type SolveResult =
  | { status: 'ok'; legs: Leg[]; etaMs: number }
  | { status: 'no-route'; reason: 'unreachable' | 'beyond-horizon' | 'calm-motor-off' };

interface Node {
  lat: number;
  lon: number;
  tMs: number;
  kind: LegKind | 'start';
  board: Board | null; // null for motor/start
  headingDeg: number;
  twaSigned: number; // NaN for motor/start
  stepSpeedKn: number; // through-water speed used on this edge
  twsKn: number;
  maneuverAtStart: ManeuverKind | null;
  maneuvers: number;
  distToDestNm: number;
  parent: Node | null;
}

const MIN_SAIL_KN = 0.2;
const CAPTURE_NM = 0.1;
const PRUNE_LAT = 0.002; // ~220 m
const PRUNE_LON = 0.003; // ~190 m at 55°N
const MAX_FRONTIER = 30_000;
const EXTRA_TWAS = [45, 55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155, 165, 175];
const MOTOR_TWAS = [0, 20, 35];

function pruneKey(lat: number, lon: number, kind: LegKind | 'start', board: Board | null): string {
  const b = kind === 'motor' ? 'M' : board === 'port' ? 'P' : 'S';
  return `${Math.floor(lat / PRUNE_LAT)}:${Math.floor(lon / PRUNE_LON)}:${b}`;
}

/** Deterministic "is a better than b" for same-cell pruning and frontier capping. */
function better(a: Node, b: Node): boolean {
  if (a.maneuvers !== b.maneuvers) return a.maneuvers < b.maneuvers;
  if (a.distToDestNm !== b.distToDestNm) return a.distToDestNm < b.distToDestNm;
  if (a.headingDeg !== b.headingDeg) return a.headingDeg < b.headingDeg;
  return a.lat !== b.lat ? a.lat < b.lat : a.lon < b.lon;
}

export function solve(p: SolveParams): SolveResult {
  const { polar, wind, mask, settings, destination } = p;
  const horizonMs = wind.horizonMs();

  const start: Node = {
    lat: p.origin.lat,
    lon: p.origin.lon,
    tMs: p.departureMs,
    kind: 'start',
    board: null,
    headingDeg: NaN,
    twaSigned: NaN,
    stepSpeedKn: 0,
    twsKn: 0,
    maneuverAtStart: null,
    maneuvers: 0,
    distToDestNm: haversineNm(p.origin, destination),
    parent: null,
  };

  let frontier: Node[] = [start];
  let tMs = p.departureMs;
  let best: { etaMs: number; last: Node } | null = null;
  const visited = new Map<string, number>(); // pruneKey → min maneuvers seen
  let blockedDeaths = 0;
  let calmDeaths = 0;

  while (frontier.length > 0) {
    if (best && tMs >= best.etaMs) break;
    const minDist = Math.min(...frontier.map((n) => n.distToDestNm));
    const dtS = minDist < 2 ? 150 : minDist < 5 ? 300 : 600;
    if (tMs + dtS * 1000 > horizonMs) {
      if (best) break;
      return { status: 'no-route', reason: 'beyond-horizon' };
    }

    const byKey = new Map<string, Node>();
    for (const node of frontier) {
      const from = { lat: node.lat, lon: node.lon };
      const w = wind.sample(from, node.tMs);
      const bearingToDest = initialBearingDeg(from, destination);

      // Candidate signed TWAs (deduped within 1°), plus the direct candidate.
      const mags = [
        polar.beatAngleDeg(w.speedKn),
        polar.gybeAngleDeg(w.speedKn),
        ...EXTRA_TWAS,
        ...(settings.motorEnabled ? MOTOR_TWAS : []),
      ];
      const twas: number[] = [];
      for (const m of mags)
        for (const s of [1, -1]) {
          const t = s * m;
          if (!twas.some((x) => Math.abs(x - t) < 1)) twas.push(t);
        }
      if (!twas.includes(180)) twas.push(180);
      const directTwa = normalizeDeg180(w.dirFromDeg - bearingToDest);
      if (!twas.some((x) => Math.abs(x - directTwa) < 0.5)) twas.push(directTwa);

      let produced = 0;
      let sawBlocked = false;
      let sawCalm = false;

      for (const twa of twas) {
        const headingDeg = ((w.dirFromDeg - twa) % 360 + 360) % 360;
        const sailSpeed = polar.speedKn(twa, w.speedKn);
        let kind: LegKind;
        let speed: number;
        if (sailSpeed >= settings.motorThresholdKn) {
          kind = 'sail';
          speed = sailSpeed;
        } else if (settings.motorEnabled) {
          kind = 'motor';
          speed = settings.motorSpeedKn;
        } else if (sailSpeed >= MIN_SAIL_KN) {
          kind = 'sail';
          speed = sailSpeed;
        } else {
          sawCalm = true;
          continue;
        }

        const board = kind === 'sail' ? boardForCandidate(twa, node.board) : null;
        let maneuver: ManeuverKind | null = null;
        let effS = dtS;
        if (kind === 'sail' && node.kind === 'sail' && node.board && board !== node.board) {
          maneuver = classifyManeuver(node.twaSigned, twa);
          effS = Math.max(dtS - settings.maneuverPenaltyS, 0);
        }
        const distNm = (speed * effS) / 3600;
        if (distNm <= 0) continue;

        // Direct-candidate arrival test (exact leg to destination)
        const isDirect = Math.abs(normalizeDeg180(headingDeg - bearingToDest)) < 0.5;
        if (isDirect && node.distToDestNm <= distNm) {
          if (mask.segmentNavigable(from, destination, settings.safetyDepthM)) {
            const penaltyS = dtS - effS;
            const etaMs = node.tMs + (penaltyS + (node.distToDestNm / speed) * 3600) * 1000;
            if (etaMs <= horizonMs && (!best || etaMs < best.etaMs)) {
              const last: Node = {
                lat: destination.lat, lon: destination.lon, tMs: etaMs, kind, board,
                headingDeg, twaSigned: kind === 'motor' ? NaN : twa, stepSpeedKn: speed,
                twsKn: w.speedKn, maneuverAtStart: maneuver,
                maneuvers: node.maneuvers + (maneuver ? 1 : 0), distToDestNm: 0, parent: node,
              };
              best = { etaMs, last };
            }
          }
          continue; // the direct edge is consumed by the arrival attempt
        }

        const end = destinationPoint(from, headingDeg, distNm);
        if (!mask.segmentNavigable(from, end, settings.safetyDepthM)) {
          sawBlocked = true;
          continue;
        }

        const child: Node = {
          lat: end.lat, lon: end.lon, tMs: node.tMs + dtS * 1000, kind, board,
          headingDeg, twaSigned: kind === 'motor' ? NaN : twa, stepSpeedKn: speed,
          twsKn: w.speedKn, maneuverAtStart: maneuver,
          maneuvers: node.maneuvers + (maneuver ? 1 : 0),
          distToDestNm: haversineNm(end, destination), parent: node,
        };

        // Endpoint-capture arrival (covers non-direct approaches, e.g. beating in)
        if (child.distToDestNm < CAPTURE_NM) {
          const finalEtaMs =
            child.tMs + ((child.distToDestNm / Math.max(speed, MIN_SAIL_KN)) * 3600) * 1000;
          if (finalEtaMs <= horizonMs && (!best || finalEtaMs < best.etaMs)) {
            const last: Node = {
              ...child, lat: destination.lat, lon: destination.lon,
              tMs: finalEtaMs, distToDestNm: 0, parent: child,
              maneuverAtStart: null, headingDeg: initialBearingDeg(end, destination),
            };
            best = { etaMs: finalEtaMs, last };
          }
        }

        const key = pruneKey(child.lat, child.lon, child.kind, child.board);
        const seen = visited.get(key);
        if (seen !== undefined && seen <= child.maneuvers) continue;
        const incumbent = byKey.get(key);
        if (!incumbent || better(child, incumbent)) byKey.set(key, child);
        produced++;
      }

      if (produced === 0) {
        if (sawBlocked) blockedDeaths++;
        if (sawCalm && !sawBlocked) calmDeaths++;
      }
    }

    let next = [...byKey.values()];
    for (const [k, n] of byKey) {
      const seen = visited.get(k);
      if (seen === undefined || n.maneuvers < seen) visited.set(k, n.maneuvers);
    }
    if (next.length > MAX_FRONTIER) {
      next.sort((a, b) => (better(a, b) ? -1 : 1));
      next = next.slice(0, MAX_FRONTIER);
    }
    frontier = next;
    tMs += dtS * 1000;
    p.onProgress?.({ tMs, frontierSize: frontier.length });
  }

  if (!best) {
    return {
      status: 'no-route',
      reason: blockedDeaths >= calmDeaths && blockedDeaths > 0 ? 'unreachable' : 'calm-motor-off',
    };
  }
  return { status: 'ok', legs: backtrack(best.last, p.departureMs), etaMs: best.etaMs };
}

function backtrack(last: Node, departureMs: number): Leg[] {
  const chain: Node[] = [];
  for (let n: Node | null = last; n && n.kind !== 'start'; n = n.parent) chain.unshift(n);
  const legs: Leg[] = [];
  for (const n of chain) {
    const parent = n.parent!;
    const start = { lat: parent.lat, lon: parent.lon };
    const end = { lat: n.lat, lon: n.lon };
    const distanceNm = haversineNm(start, end);
    const prev = legs[legs.length - 1];
    const collinear =
      prev &&
      prev.kind === n.kind &&
      prev.board === n.board &&
      n.maneuverAtStart === null &&
      Math.abs(normalizeDeg180(prev.headingDeg - n.headingDeg)) < 0.5;
    if (collinear) {
      prev.end = end;
      prev.endTimeMs = n.tMs;
      prev.distanceNm += distanceNm;
      prev.speedKn =
        prev.distanceNm / Math.max((prev.endTimeMs - prev.startTimeMs) / 3_600_000, 1e-9);
    } else {
      legs.push({
        kind: n.kind as LegKind,
        board: n.board,
        start, end,
        startTimeMs: parent.tMs,
        endTimeMs: n.tMs,
        headingDeg: n.headingDeg,
        twaDeg: n.twaSigned,
        twsKn: n.twsKn,
        speedKn: distanceNm / Math.max((n.tMs - parent.tMs) / 3_600_000, 1e-9),
        distanceNm,
        maneuverAtStart: n.maneuverAtStart,
      } as Leg);
    }
  }
  if (legs.length > 0) legs[0].startTimeMs = departureMs;
  return legs;
}
```

- [ ] **Step 4: Run tests — expect PASS.** These golden tests are the router's safety net; if a bound fails (e.g. tack count 5), fix the router (pruning/penalty bug), do NOT loosen the bound without understanding why.

- [ ] **Step 5: Commit** (`feat: isochrone solver with maneuver penalties and board-aware pruning`)

### Task B7: Motor fallback golden tests

Motor logic is already inside B6's expansion (per-candidate threshold). This task pins its behavior with tests before UI work depends on it.

**Files:**
- Create: `app/src/routing/motor.test.ts`

**Interfaces:**
- Consumes: `solve` (B6), fixtures.

- [ ] **Step 1: Write the tests**

`app/src/routing/motor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { solve } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { openWaterMask, TEST_POLAR, uniformWindGrid, makeWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../types';
import { haversineNm } from '../lib/geo';

const A = { lat: 54.75, lon: 10.0 };
const B = { lat: 54.75, lon: 10.4 };
const dep = Date.UTC(2026, 6, 15, 8, 0, 0);
const base = {
  origin: A, destination: B, departureMs: dep,
  polar: new Polar(TEST_POLAR, 1.0), mask: openWaterMask(), settings: DEFAULT_SETTINGS,
};

describe('motor fallback', () => {
  it('calm + motor on → one straight motor leg at motor speed', () => {
    const r = solve({ ...base, wind: new WindField(uniformWindGrid(0.5, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.legs.every((l) => l.kind === 'motor' && l.board === null)).toBe(true);
    expect(r.legs.length).toBe(1); // collinear motor steps merge in backtrack
    const hours = (r.etaMs - dep) / 3_600_000;
    expect(hours).toBeCloseTo(haversineNm(A, B) / DEFAULT_SETTINGS.motorSpeedKn, 1);
  });

  it('wind dying en route → sail first, flagged motor leg after', () => {
    const wind = new WindField(
      makeWindGrid((_la, lon) => ({ speedKn: lon < 10.2 ? 14 : 0.5, dirFromDeg: 0 })),
    );
    const r = solve({ ...base, wind });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const kinds = r.legs.map((l) => l.kind);
    expect(kinds[0]).toBe('sail');
    expect(kinds[kinds.length - 1]).toBe('motor');
  });

  it('motor threshold respected: marginal wind sails when above threshold', () => {
    // 6 kn TWS beam reach → TEST_POLAR speed ~4.3 kn > 2.5 threshold → must sail, not motor
    const r = solve({ ...base, wind: new WindField(uniformWindGrid(6, 0)) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.legs.every((l) => l.kind === 'sail')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expected PASS immediately** (behavior implemented in B6). If any fail, that is a B6 bug: debug the router, don't adjust tests.

- [ ] **Step 3: Commit** (`test: pin motor fallback golden behavior`)

### Task B8: Post-processing — collinear leg merge with re-validation

**Files:**
- Create: `app/src/routing/postprocess.ts`, `app/src/routing/postprocess.test.ts`

**Interfaces:**
- Consumes: `Leg`, `NavMask`, `WindField`, geo helpers.
- Produces: `mergeCollinearLegs(legs: Leg[], mask: NavMask, wind: WindField, settings: Settings): Leg[]`. Merges consecutive legs when: same kind and board, no maneuver at the joint, heading difference ≤ 10°, the merged straight segment passes `segmentNavigable`, and (sail legs) the merged heading keeps the same board at the joint's wind sample. Recomputes heading/distance/speed; keeps original start/end times. Iterates to fixpoint. This is the ONLY allowed post-processing (spec).

- [ ] **Step 1: Write failing tests**

`app/src/routing/postprocess.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeCollinearLegs } from './postprocess';
import { WindField } from '../lib/wind';
import { openWaterMask, uniformWindGrid, makeMask } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Leg } from '../types';
import { destinationPoint, initialBearingDeg } from '../lib/geo';

const t0 = Date.UTC(2026, 6, 15, 8, 0, 0);

function legFrom(start: { lat: number; lon: number }, headingDeg: number, distNm: number, startMs: number, speedKn = 6): Leg {
  const end = destinationPoint(start, headingDeg, distNm);
  const durMs = (distNm / speedKn) * 3_600_000;
  return {
    kind: 'sail', board: 'starboard', start, end,
    startTimeMs: startMs, endTimeMs: startMs + durMs,
    headingDeg, twaDeg: 90, twsKn: 12, speedKn, distanceNm: distNm, maneuverAtStart: null,
  };
}

describe('mergeCollinearLegs', () => {
  // Wind FROM SOUTH: eastbound headings (~90°) give twa = +90 → starboard,
  // matching legFrom's board fixture. (Wind from north would make them port.)
  const wind = new WindField(uniformWindGrid(12, 180));

  it('merges a slightly dog-legged pair into one leg', () => {
    const a = legFrom({ lat: 54.7, lon: 10.0 }, 88, 2, t0);
    const b = legFrom(a.end, 92, 2, a.endTimeMs);
    const merged = mergeCollinearLegs([a, b], openWaterMask(), wind, DEFAULT_SETTINGS);
    expect(merged.length).toBe(1);
    expect(merged[0].start).toEqual(a.start);
    expect(merged[0].end).toEqual(b.end);
    expect(merged[0].headingDeg).toBeCloseTo(initialBearingDeg(a.start, b.end), 0);
    expect(merged[0].endTimeMs).toBe(b.endTimeMs);
  });

  it('does not merge across a maneuver, board change, or kind change', () => {
    const a = legFrom({ lat: 54.7, lon: 10.0 }, 90, 2, t0);
    const b = { ...legFrom(a.end, 91, 2, a.endTimeMs), maneuverAtStart: 'tack' as const };
    expect(mergeCollinearLegs([a, b], openWaterMask(), wind, DEFAULT_SETTINGS).length).toBe(2);
    const c = { ...legFrom(a.end, 91, 2, a.endTimeMs), board: 'port' as const };
    expect(mergeCollinearLegs([a, c], openWaterMask(), wind, DEFAULT_SETTINGS).length).toBe(2);
    const d = { ...legFrom(a.end, 91, 2, a.endTimeMs), kind: 'motor' as const, board: null };
    expect(mergeCollinearLegs([a, d], openWaterMask(), wind, DEFAULT_SETTINGS).length).toBe(2);
  });

  it('does not merge when the straight chord would clip land the dogleg avoids', () => {
    // Northbound dogleg: 7 nm at 005°, then 7 nm at 355° (10° turn — mergeable).
    // The straight chord runs due north through a shoal ridge at row 90
    // (lat 54.75–54.755, cols 140–165) whose gap (cols 152–156) only the
    // dogleg's eastward bulge passes through.
    // Wind FROM EAST so all headings ~0° are starboard (twa ≈ +90).
    const windE = new WindField(uniformWindGrid(12, 90));
    const ridge = makeMask((r, c) =>
      r === 90 && c >= 140 && c <= 165 && !(c >= 152 && c <= 156) ? 0 : 200,
    );
    const a = { ...legFrom({ lat: 54.6, lon: 10.1525 }, 5, 7, t0), twaDeg: 85 };
    const b = { ...legFrom(a.end, 355, 7, a.endTimeMs), twaDeg: 95 };
    // sanity: the dogleg itself is clean, the chord is not
    expect(ridge.segmentNavigable(a.start, a.end, 3)).toBe(true);
    expect(ridge.segmentNavigable(b.start, b.end, 3)).toBe(true);
    expect(ridge.segmentNavigable(a.start, b.end, 3)).toBe(false);
    expect(mergeCollinearLegs([a, b], ridge, windE, DEFAULT_SETTINGS).length).toBe(2);
    // control: same legs over open water DO merge
    expect(mergeCollinearLegs([a, b], openWaterMask(), windE, DEFAULT_SETTINGS).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

`app/src/routing/postprocess.ts`:

```ts
import type { Leg, Settings } from '../types';
import type { NavMask } from '../lib/mask';
import type { WindField } from '../lib/wind';
import { haversineNm, initialBearingDeg, normalizeDeg180 } from '../lib/geo';
import { boardOf } from './maneuver';

const MAX_MERGE_DEG = 10;

function tryMerge(a: Leg, b: Leg, mask: NavMask, wind: WindField, s: Settings): Leg | null {
  if (a.kind !== b.kind || a.board !== b.board || b.maneuverAtStart !== null) return null;
  if (Math.abs(normalizeDeg180(a.headingDeg - b.headingDeg)) > MAX_MERGE_DEG) return null;
  if (!mask.segmentNavigable(a.start, b.end, s.safetyDepthM)) return null;
  const headingDeg = initialBearingDeg(a.start, b.end);
  if (a.kind === 'sail') {
    const w = wind.sample(b.start, b.startTimeMs); // wind at the joint
    const twa = normalizeDeg180(w.dirFromDeg - headingDeg);
    if (a.board && boardOf(twa) !== a.board) return null; // merged course would flip the board
  }
  const distanceNm = haversineNm(a.start, b.end);
  return {
    ...a,
    end: b.end,
    endTimeMs: b.endTimeMs,
    headingDeg,
    distanceNm,
    speedKn: distanceNm / Math.max((b.endTimeMs - a.startTimeMs) / 3_600_000, 1e-9),
  };
}

export function mergeCollinearLegs(
  legs: Leg[],
  mask: NavMask,
  wind: WindField,
  settings: Settings,
): Leg[] {
  let out = [...legs];
  let changed = true;
  while (changed) {
    changed = false;
    const next: Leg[] = [];
    for (const leg of out) {
      const prev = next[next.length - 1];
      const merged = prev ? tryMerge(prev, leg, mask, wind, settings) : null;
      if (merged) {
        next[next.length - 1] = merged;
        changed = true;
      } else {
        next.push(leg);
      }
    }
    out = next;
  }
  return out;
}
```

- [ ] **Step 4: Run tests, expect PASS** · **Step 5: Commit** (`feat: collinear leg merging with mask and wind re-validation`)

### Task B9: planRoute — two rigs, snapping, recommendation

**Files:**
- Create: `app/src/routing/planRoute.ts`, `app/src/routing/planRoute.test.ts`

**Interfaces:**
- Consumes: `solve` (B6), `mergeCollinearLegs` (B8), `NavMask.snapToNavigable` (B4), types.
- Produces:
  ```ts
  interface PlanDeps {
    polarGenoa: PolarTable;
    polarFock: PolarTable;
    mask: NavMask;
  }
  type RigProgress = (rig: Rig, info: { tMs: number; frontierSize: number }) => void;
  function planRoute(req: PlanRequest, windGrid: WindGrid, deps: PlanDeps, onProgress?: RigProgress): PlanResult;
  ```
  Behavior: snap origin/destination (300 m) → error `snap-failed-*`; build `WindField`; run `solve` once per rig with `new Polar(table, req.settings.performanceFactor)`; postprocess each ok result; build `RigResult` totals (`maneuverCount` = legs with `maneuverAtStart`, `motorDistanceNm` = sum of motor leg distances, `durationMs = etaMs - departureMs`); if both rigs fail → the genoa reason; `recommended` = rig with smaller `etaMs` (ties → genoa; single survivor → that rig).

- [ ] **Step 1: Write failing tests**

`app/src/routing/planRoute.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planRoute } from './planRoute';
import { openWaterMask, TEST_POLAR, uniformWindGrid, makeMask } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PlanRequest, type PolarTable } from '../types';

/** Fock fixture: uniformly 12% slower than TEST_POLAR (genoa must win). */
const SLOW_FOCK: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.88)),
};

const req: PlanRequest = {
  origin: { lat: 54.75, lon: 10.0 },
  destination: { lat: 54.75, lon: 10.4 },
  originHarborId: null,
  destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
  settings: DEFAULT_SETTINGS,
};
const deps = { polarGenoa: TEST_POLAR, polarFock: SLOW_FOCK, mask: openWaterMask() };

describe('planRoute', () => {
  it('runs both rigs and recommends the faster one', () => {
    const r = planRoute(req, uniformWindGrid(12, 0), deps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.genoa).not.toBeNull();
    expect(r.fock).not.toBeNull();
    expect(r.recommended).toBe('genoa');
    expect(r.genoa!.etaMs).toBeLessThanOrEqual(r.fock!.etaMs);
    expect(r.genoa!.maneuverCount).toBe(r.genoa!.legs.filter((l) => l.maneuverAtStart).length);
  });

  it('snaps origin off land and reports snapped coordinates', () => {
    // land west of col 162 (lon ≈ 10.21); origin on land near the edge
    const mask = makeMask((_, c) => (c < 162 ? 0 : 200));
    const r = planRoute(
      { ...req, origin: { lat: 54.75, lon: 10.207 }, destination: { lat: 54.75, lon: 10.6 } },
      uniformWindGrid(12, 0),
      { ...deps, mask },
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.snappedOrigin.lon).toBeGreaterThan(10.207);
    expect(mask.isNavigable(r.snappedOrigin, DEFAULT_SETTINGS.safetyDepthM)).toBe(true);
  });

  it('fails with snap-failed-origin when origin is deep inland', () => {
    const mask = makeMask((_, c) => (c < 162 ? 0 : 200));
    const r = planRoute(
      { ...req, origin: { lat: 54.75, lon: 9.6 } },
      uniformWindGrid(12, 0),
      { ...deps, mask },
    );
    expect(r).toEqual({ status: 'error', reason: 'snap-failed-origin' });
  });

  it('reports progress per rig', () => {
    const seen = new Set<string>();
    planRoute(req, uniformWindGrid(12, 0), deps, (rig) => seen.add(rig));
    expect(seen).toEqual(new Set(['genoa', 'fock']));
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

`app/src/routing/planRoute.ts`:

```ts
import type {
  PlanRequest, PlanResult, PolarTable, Rig, RigResult, WindGrid,
} from '../types';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import type { NavMask } from '../lib/mask';
import { solve } from './isochrone';
import { mergeCollinearLegs } from './postprocess';

export interface PlanDeps {
  polarGenoa: PolarTable;
  polarFock: PolarTable;
  mask: NavMask;
}

export type RigProgress = (rig: Rig, info: { tMs: number; frontierSize: number }) => void;

export function planRoute(
  req: PlanRequest,
  windGrid: WindGrid,
  deps: PlanDeps,
  onProgress?: RigProgress,
): PlanResult {
  const { mask } = deps;
  const s = req.settings;
  const origin = mask.snapToNavigable(req.origin, s.safetyDepthM);
  if (!origin) return { status: 'error', reason: 'snap-failed-origin' };
  const destination = mask.snapToNavigable(req.destination, s.safetyDepthM);
  if (!destination) return { status: 'error', reason: 'snap-failed-destination' };

  const wind = new WindField(windGrid);
  const run = (rig: Rig, table: PolarTable) => {
    const res = solve({
      origin, destination, departureMs: req.departureMs,
      polar: new Polar(table, s.performanceFactor),
      wind, mask, settings: s,
      onProgress: (info) => onProgress?.(rig, info),
    });
    if (res.status !== 'ok') return { rigResult: null, reason: res.reason };
    const legs = mergeCollinearLegs(res.legs, mask, wind, s);
    const rigResult: RigResult = {
      rig, legs, etaMs: res.etaMs,
      durationMs: res.etaMs - req.departureMs,
      distanceNm: legs.reduce((d, l) => d + l.distanceNm, 0),
      maneuverCount: legs.filter((l) => l.maneuverAtStart !== null).length,
      motorDistanceNm: legs.filter((l) => l.kind === 'motor').reduce((d, l) => d + l.distanceNm, 0),
    };
    return { rigResult, reason: null };
  };

  const genoa = run('genoa', deps.polarGenoa);
  const fock = run('fock', deps.polarFock);
  if (!genoa.rigResult && !fock.rigResult)
    return { status: 'error', reason: genoa.reason! };

  const recommended: Rig =
    genoa.rigResult && fock.rigResult
      ? genoa.rigResult.etaMs <= fock.rigResult.etaMs
        ? 'genoa'
        : 'fock'
      : genoa.rigResult
        ? 'genoa'
        : 'fock';

  return {
    status: 'ok',
    genoa: genoa.rigResult,
    fock: fock.rigResult,
    recommended,
    snappedOrigin: origin,
    snappedDestination: destination,
  };
}
```

- [ ] **Step 4: Run tests, expect PASS** · **Step 5: Commit** (`feat: two-rig plan orchestration with snapping and recommendation`)

### Task B10: Property tests (fast-check)

**Files:**
- Create: `app/src/routing/invariants.property.test.ts`

**Interfaces:**
- Consumes: `planRoute` (B9), fixtures.

- [ ] **Step 1: Write the property suite**

`app/src/routing/invariants.property.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { planRoute } from './planRoute';
import { makeMask, makeWindGrid, TEST_POLAR } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PolarTable } from '../types';
import { haversineNm } from '../lib/geo';

const FOCK: PolarTable = {
  ...TEST_POLAR, rig: 'fock',
  speeds: TEST_POLAR.speeds.map((r) => r.map((v) => v * 0.9)),
};

/** Random blob mask: a few circular islands in otherwise open water. */
function blobMask(seedBlobs: { r: number; c: number; rad: number }[]) {
  return makeMask((row, col) =>
    seedBlobs.some((b) => (row - b.r) ** 2 + (col - b.c) ** 2 < b.rad ** 2) ? 0 : 200,
  );
}

const arbScenario = fc.record({
  blobs: fc.array(
    fc.record({
      r: fc.integer({ min: 40, max: 160 }),
      c: fc.integer({ min: 60, max: 260 }),
      rad: fc.integer({ min: 3, max: 12 }),
    }),
    { minLength: 0, maxLength: 4 },
  ),
  windDir: fc.integer({ min: 0, max: 359 }),
  windKn: fc.integer({ min: 4, max: 22 }),
  oLat: fc.double({ min: 54.45, max: 55.15, noNaN: true }),
  oLon: fc.double({ min: 9.55, max: 10.85, noNaN: true }),
  dLat: fc.double({ min: 54.45, max: 55.15, noNaN: true }),
  dLon: fc.double({ min: 9.55, max: 10.85, noNaN: true }),
});

describe('router invariants', () => {
  it('holds core invariants on random scenarios', () => {
    fc.assert(
      fc.property(arbScenario, (sc) => {
        const mask = blobMask(sc.blobs);
        const origin = { lat: sc.oLat, lon: sc.oLon };
        const destination = { lat: sc.dLat, lon: sc.dLon };
        fc.pre(haversineNm(origin, destination) > 3);
        const r = planRoute(
          {
            origin, destination, originHarborId: null, destinationHarborId: null,
            departureMs: Date.UTC(2026, 6, 15, 6, 0, 0),
            settings: DEFAULT_SETTINGS,
          },
          makeWindGrid(() => ({ speedKn: sc.windKn, dirFromDeg: sc.windDir }), { hours: 72 }),
          { polarGenoa: TEST_POLAR, polarFock: FOCK, mask },
        );
        if (r.status !== 'ok') return true; // unreachable scenarios are legitimate
        for (const rig of [r.genoa, r.fock]) {
          if (!rig) continue;
          for (let i = 0; i < rig.legs.length; i++) {
            const leg = rig.legs[i];
            // 1. no leg crosses land/shallow
            expect(mask.segmentNavigable(leg.start, leg.end, DEFAULT_SETTINGS.safetyDepthM)).toBe(true);
            // 2. times strictly increasing
            expect(leg.endTimeMs).toBeGreaterThan(leg.startTimeMs);
            if (i > 0) {
              // 3. geometric + temporal continuity
              expect(haversineNm(rig.legs[i - 1].end, leg.start)).toBeLessThan(0.01);
              expect(leg.startTimeMs).toBe(rig.legs[i - 1].endTimeMs);
            }
            // 4. motor legs flagged consistently
            if (leg.kind === 'motor') expect(leg.board).toBeNull();
          }
          // 5. maneuver count consistency
          expect(rig.maneuverCount).toBe(rig.legs.filter((l) => l.maneuverAtStart).length);
        }
        // 6. recommendation is the faster rig
        if (r.genoa && r.fock)
          expect(r.recommended).toBe(r.genoa.etaMs <= r.fock.etaMs ? 'genoa' : 'fock');
        return true;
      }),
      { numRuns: 25, seed: 42 }, // deterministic CI; bump numRuns locally when touching the router
    );
  });
});
```

- [ ] **Step 2: Run** (`npm --prefix app/ run test -- invariants`) — expect PASS; any counterexample is a genuine router bug: minimize with the fast-check reporter output and fix in B6/B8 before proceeding.

- [ ] **Step 3: Commit** (`test: property-based router invariants`)

### Task B11: GPX export

**Files:**
- Create: `app/src/lib/gpx.ts`, `app/src/lib/gpx.test.ts`

**Interfaces:**
- Consumes: `Plan`, `Rig`, `Leg`.
- Produces: `toGpx(plan: Plan, rig: Rig): string` — GPX 1.1 `<rte>` with one `<rtept>` per leg start plus the final destination; `<name>` from plan name + rig; per-point `<time>` (ISO 8601 UTC), `<desc>` like `sail starboard 087°T 6.4 kn` or `motor 090°T 6.5 kn`, maneuvers noted as `tack`/`gybe` prefix. XML-escapes all text content.

- [ ] **Step 1: Write failing tests**

`app/src/lib/gpx.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toGpx } from './gpx';
import { TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import type { Plan } from '../types';

const plan: Plan = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Flensburg → <Marstal> & back',
  createdAtMs: Date.UTC(2026, 6, 15, 7, 0, 0),
  request: {
    origin: { lat: 54.79, lon: 9.43 }, destination: { lat: 54.85, lon: 10.52 },
    originHarborId: 'flensburg', destinationHarborId: 'marstal',
    departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
    settings: {
      safetyDepthM: 3, motorSpeedKn: 6.5, motorThresholdKn: 2.5,
      maneuverPenaltyS: 45, performanceFactor: 0.9, motorEnabled: true,
    },
  },
  windGrid: uniformWindGrid(10, 270),
  result: {
    status: 'ok',
    recommended: 'genoa',
    snappedOrigin: { lat: 54.79, lon: 9.43 },
    snappedDestination: { lat: 54.85, lon: 10.52 },
    fock: null,
    genoa: {
      rig: 'genoa',
      etaMs: Date.UTC(2026, 6, 15, 12, 0, 0),
      durationMs: 4 * 3_600_000,
      distanceNm: 20, maneuverCount: 1, motorDistanceNm: 5,
      legs: [
        {
          kind: 'sail', board: 'starboard',
          start: { lat: 54.79, lon: 9.43 }, end: { lat: 54.8, lon: 10.0 },
          startTimeMs: Date.UTC(2026, 6, 15, 8, 0, 0), endTimeMs: Date.UTC(2026, 6, 15, 10, 0, 0),
          headingDeg: 88, twaDeg: 92, twsKn: 10, speedKn: 7, distanceNm: 15, maneuverAtStart: null,
        },
        {
          kind: 'motor', board: null,
          start: { lat: 54.8, lon: 10.0 }, end: { lat: 54.85, lon: 10.52 },
          startTimeMs: Date.UTC(2026, 6, 15, 10, 0, 0), endTimeMs: Date.UTC(2026, 6, 15, 12, 0, 0),
          headingDeg: 90, twaDeg: NaN, twsKn: 2, speedKn: 6.5, distanceNm: 5, maneuverAtStart: null,
        },
      ],
    },
  },
};

describe('toGpx', () => {
  const xml = toGpx(plan, 'genoa');

  it('produces a GPX 1.1 route with rtepts for each leg start + destination', () => {
    expect(xml).toContain('<gpx version="1.1"');
    expect((xml.match(/<rtept /g) ?? []).length).toBe(3); // 2 legs + final point
    expect(xml).toContain('lat="54.85"');
    expect(xml).toContain('<time>2026-07-15T08:00:00.000Z</time>');
  });

  it('escapes XML and marks motor legs', () => {
    expect(xml).toContain('&lt;Marstal&gt; &amp; back');
    expect(xml).toContain('motor');
    expect(xml).not.toContain('<Marstal>');
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

`app/src/lib/gpx.ts`:

```ts
import type { Leg, Plan, Rig } from '../types';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtDeg = (d: number) => `${String(Math.round(d)).padStart(3, '0')}°T`;

function legDesc(leg: Leg): string {
  const man = leg.maneuverAtStart ? `${leg.maneuverAtStart} → ` : '';
  const what =
    leg.kind === 'motor'
      ? `motor ${fmtDeg(leg.headingDeg)} ${leg.speedKn.toFixed(1)} kn`
      : `sail ${leg.board} ${fmtDeg(leg.headingDeg)} ${leg.speedKn.toFixed(1)} kn`;
  return man + what;
}

export function toGpx(plan: Plan, rig: Rig): string {
  const result = rig === 'genoa' ? plan.result.genoa : plan.result.fock;
  if (!result) throw new Error(`no ${rig} result on plan ${plan.id}`);
  const pts = result.legs.map(
    (leg) =>
      `    <rtept lat="${leg.start.lat}" lon="${leg.start.lon}">\n` +
      `      <time>${new Date(leg.startTimeMs).toISOString()}</time>\n` +
      `      <desc>${esc(legDesc(leg))}</desc>\n` +
      `    </rtept>`,
  );
  const last = result.legs[result.legs.length - 1];
  pts.push(
    `    <rtept lat="${last.end.lat}" lon="${last.end.lon}">\n` +
      `      <time>${new Date(last.endTimeMs).toISOString()}</time>\n` +
      `      <desc>destination</desc>\n` +
      `    </rtept>`,
  );
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="SailCommand" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <rte>\n    <name>${esc(plan.name)} (${rig})</name>\n${pts.join('\n')}\n  </rte>\n</gpx>\n`
  );
}
```

- [ ] **Step 4: Run tests, expect PASS** · **Step 5: Commit** (`feat: GPX 1.1 route export`)

### Task B12: Web Worker wrapper + typed client

**Files:**
- Create: `app/src/routing/protocol.ts`, `app/src/routing/worker.ts`, `app/src/routing/workerClient.ts`, `app/src/routing/protocol.test.ts`

**Interfaces:**
- Consumes: `planRoute` (B9), `NavMask` (B4), types.
- Produces:
  `protocol.ts`:
  ```ts
  type WorkerRequest =
    | { type: 'init'; maskMeta: MaskMeta; maskBuffer: ArrayBuffer; polarGenoa: PolarTable; polarFock: PolarTable }
    | { type: 'plan'; id: string; request: PlanRequest; windGrid: WindGrid };
  type WorkerResponse =
    | { type: 'ready' }
    | { type: 'progress'; id: string; rig: Rig; tMs: number; frontierSize: number }
    | { type: 'result'; id: string; result: PlanResult }
    | { type: 'fatal'; id: string | null; message: string };
  // pure, testable message handler used by worker.ts:
  function createHandler(post: (r: WorkerResponse) => void): (req: WorkerRequest) => void;
  ```
  `worker.ts` (thin shell): `const handler = createHandler((m) => self.postMessage(m)); self.onmessage = (e) => handler(e.data);`
  `workerClient.ts`: `class RoutingClient { constructor(workerFactory?: () => Worker); init(assets): Promise<void>; plan(request, windGrid, onProgress?): Promise<PlanResult>; dispose(): void }` — creates the worker via `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` by default; progress throttled to ≥1 per 100 ms per rig.

- [ ] **Step 1: Write failing tests** — test `createHandler` synchronously (no real Worker; the real thread is covered by E2E):

`app/src/routing/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createHandler, type WorkerResponse } from './protocol';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PolarTable } from '../types';

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };

function openWaterBuffer(): ArrayBuffer {
  const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200);
  return data.buffer;
}

describe('worker protocol handler', () => {
  it('answers init with ready, plan with progress + result', () => {
    const out: WorkerResponse[] = [];
    const handle = createHandler((m) => out.push(m));
    handle({
      type: 'init',
      maskMeta: TEST_MASK_META,
      maskBuffer: openWaterBuffer(),
      polarGenoa: TEST_POLAR,
      polarFock: FOCK,
    });
    expect(out).toEqual([{ type: 'ready' }]);

    handle({
      type: 'plan',
      id: 'p1',
      request: {
        origin: { lat: 54.75, lon: 10.0 }, destination: { lat: 54.75, lon: 10.3 },
        originHarborId: null, destinationHarborId: null,
        departureMs: Date.UTC(2026, 6, 15, 8, 0, 0), settings: DEFAULT_SETTINGS,
      },
      windGrid: uniformWindGrid(12, 0),
    });
    const result = out.find((m) => m.type === 'result');
    expect(result && result.type === 'result' && result.result.status).toBe('ok');
    expect(out.some((m) => m.type === 'progress')).toBe(true);
  });

  it('plan before init → fatal', () => {
    const out: WorkerResponse[] = [];
    const handle = createHandler((m) => out.push(m));
    handle({ type: 'plan', id: 'p1' } as never);
    expect(out[0].type).toBe('fatal');
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement** `protocol.ts` (handler holds `NavMask`/polars in closure state, wraps `planRoute` in try/catch → `fatal`), `worker.ts` (2 lines above), `workerClient.ts` (Promise map keyed by request id via `crypto.randomUUID()`, resolves on `result`, rejects on `fatal`; `init` transfers `maskBuffer`).

`app/src/routing/protocol.ts`:

```ts
import type {
  MaskMeta, PlanRequest, PlanResult, PolarTable, Rig, WindGrid,
} from '../types';
import { NavMask } from '../lib/mask';
import { planRoute } from './planRoute';

export type WorkerRequest =
  | { type: 'init'; maskMeta: MaskMeta; maskBuffer: ArrayBuffer; polarGenoa: PolarTable; polarFock: PolarTable }
  | { type: 'plan'; id: string; request: PlanRequest; windGrid: WindGrid };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: string; rig: Rig; tMs: number; frontierSize: number }
  | { type: 'result'; id: string; result: PlanResult }
  | { type: 'fatal'; id: string | null; message: string };

export function createHandler(post: (r: WorkerResponse) => void): (req: WorkerRequest) => void {
  let state: { mask: NavMask; polarGenoa: PolarTable; polarFock: PolarTable } | null = null;
  return (req) => {
    try {
      if (req.type === 'init') {
        state = {
          mask: new NavMask(req.maskMeta, new Uint8Array(req.maskBuffer)),
          polarGenoa: req.polarGenoa,
          polarFock: req.polarFock,
        };
        post({ type: 'ready' });
        return;
      }
      if (!state) throw new Error('plan requested before init');
      const result = planRoute(req.request, req.windGrid, state, (rig, info) =>
        post({ type: 'progress', id: req.id, rig, tMs: info.tMs, frontierSize: info.frontierSize }),
      );
      post({ type: 'result', id: req.id, result });
    } catch (err) {
      post({
        type: 'fatal',
        id: req.type === 'plan' ? req.id : null,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
```

`app/src/routing/worker.ts`:

```ts
import { createHandler, type WorkerRequest } from './protocol';

const handler = createHandler((m) => self.postMessage(m));
self.onmessage = (e: MessageEvent<WorkerRequest>) => handler(e.data);
```

`app/src/routing/workerClient.ts`:

```ts
import type { PlanRequest, PlanResult, Rig, WindGrid } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

type ProgressCb = (rig: Rig, tMs: number, frontierSize: number) => void;

export class RoutingClient {
  private worker: Worker;
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private pending = new Map<string, { resolve: (r: PlanResult) => void; reject: (e: Error) => void; onProgress?: ProgressCb }>();

  constructor(workerFactory?: () => Worker) {
    this.worker = workerFactory
      ? workerFactory()
      : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((res) => (this.readyResolve = res));
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
  }

  private handle(msg: WorkerResponse) {
    if (msg.type === 'ready') this.readyResolve();
    else if (msg.type === 'progress')
      this.pending.get(msg.id)?.onProgress?.(msg.rig, msg.tMs, msg.frontierSize);
    else if (msg.type === 'result') {
      this.pending.get(msg.id)?.resolve(msg.result);
      this.pending.delete(msg.id);
    } else {
      const entry = msg.id ? this.pending.get(msg.id) : null;
      entry?.reject(new Error(msg.message));
      if (msg.id) this.pending.delete(msg.id);
    }
  }

  init(assets: Omit<Extract<WorkerRequest, { type: 'init' }>, 'type'>): Promise<void> {
    this.worker.postMessage({ type: 'init', ...assets }, [assets.maskBuffer]);
    return this.ready;
  }

  async plan(request: PlanRequest, windGrid: WindGrid, onProgress?: ProgressCb): Promise<PlanResult> {
    await this.ready;
    const id = crypto.randomUUID();
    return new Promise<PlanResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: 'plan', id, request, windGrid } satisfies WorkerRequest);
    });
  }

  dispose() {
    this.worker.terminate();
  }
}
```

- [ ] **Step 4: Run all tests + typecheck, expect PASS** · **Step 5: Commit** (`feat: routing web worker protocol and typed client`)


### Task B13: Via-waypoints — segmented routing (added 2026-07-15, issue #4)

**Files:**
- Modify: `app/src/types.ts` (PlanRequest, NoRouteReason), `app/src/routing/planRoute.ts`
- Create: `app/src/routing/viaPoints.test.ts`

**Interfaces:**
- Consumes: `solve` (B6), `mergeCollinearLegs` (B8), `snapToNavigable` (B4).
- Produces: `PlanRequest.viaPoints: LatLon[]` (new required field — update ALL existing constructions of PlanRequest in tests/briefs to `viaPoints: []`); `NoRouteReason` gains `'snap-failed-via'`. `planRoute` behavior: snap origin, each via (300 m), destination — via snap failure → `{status:'error', reason:'snap-failed-via'}`; per rig, solve segments origin→via1→…→destination sequentially, each segment departing at the previous segment's `etaMs`; concatenate postprocessed legs (do NOT merge across joints); totals summed; any segment no-route fails that rig with the segment's reason. Recommendation on total ETA as before. Documented v1 simplification: maneuver state resets at joints (a board change across a via is not charged).

- [ ] **Step 1: Write failing tests** (`viaPoints.test.ts`): (a) open water, wind 12 kn from N, origin (54.7525, 10.0025) → dest (54.7525, 10.4025) with via (54.9025, 10.2025) well north of the direct line → status ok; some leg endpoint within 0.05 nm of the snapped via; legs continuous (each start == previous end) and times strictly increasing ACROSS the joint; total distance > direct distance + 15 nm-ish sanity. (b) `viaPoints: []` behaves exactly as before (regression: reuse an existing planRoute test scenario and assert equal ETA). (c) via deep inland (54.7525, 9.6) with the col<162-land mask → `snap-failed-via`.
- [ ] **Step 2: FAIL** → **Step 3: implement** (loop over waypoint chain per rig; thread departure time; keep progress callback wiring — report the rig once per segment) → **Step 4: PASS + full suite + lint + typecheck** → **Step 5: commit** (`feat: via-waypoint segmented routing`).

**Phase B gate:** all unit + property tests green; `npm --prefix app/ run typecheck && npm --prefix app/ run lint` clean. Open PR "Phase B: routing domain core" → self-review → merge.

---

# Phase C — Data pipeline (independent of Phase B; parallelizable)

All Phase C outputs are committed static assets in `app/public/data/`. Research provenance (verified 2026-07-14): a real ORC International 2026 certificate for a Salona 45 ("Miles Ahead", AUT, CertNo 035/26, draft 2.129 m) drives the polars; EMODnet WCS + OSM land polygons drive the mask; Protomaps daily builds drive the basemap. Sources are cited inside each task.

### Task C1: Salona 45 polar tables

**Files:**
- Create: `pipeline/package.json`, `pipeline/build_polars.mjs`, `pipeline/polars-source.json`
- Output (committed): `app/public/data/polar-genoa.json`, `app/public/data/polar-fock.json`

**Interfaces:**
- Produces: two JSON files matching `PolarTable` (`app/src/types.ts`). The app loads them at startup (Task E3).

**Data provenance (put this, condensed, into each JSON's `source` field):** Base: ORC International 2026 certificate, Salona 45 "Miles Ahead" (AUT, CertNo 035/26, RefNo 03210004RM3, draft 2.129 m, displ. 11 960 kg), allowances converted via v = 3600/(s/nm). Downwind (TWA ≥ 110°) corrected to white-sails using mean non-spinnaker/spinnaker certificate speed ratios of 23 comparable 36–48 ft cruiser-racers (ORC Family=5 vs Family=1, 2026). The certificate's measured jib (48.94 m², ~110 % foretriangle) ≙ **fock** config; the **genoa** (~135 %) table is a modeled overlay (+3–5 % light-air upwind/reach, 0 at 14–20 kn, −2 % upwind at 25 kn). TWA 35/40/45/70/80/100 and the TWS 25 column are interpolated/extrapolated. ORC VPP = flat water, racing crew; the app's default performance factor 0.90 absorbs the typical cruising delta. API source: `https://data.orc.org/public/WPub.dll?action=DownRMS&ext=json&Family=1&VPPYear=2026&CountryId=AUT`.

- [ ] **Step 1: Create `pipeline/package.json`**

```json
{
  "name": "sailcommand-pipeline",
  "private": true,
  "type": "module",
  "scripts": {
    "polars": "node build_polars.mjs",
    "harbors": "node build_harbors.mjs"
  }
}
```

- [ ] **Step 2: Create `pipeline/polars-source.json`** with EXACTLY this content (research-derived tables; speeds in knots, `speeds[twaIdx][twsIdx]`):

```json
{
  "boat": "Salona 45",
  "tws": [4, 6, 8, 10, 12, 14, 16, 20, 25],
  "twa": [35, 40, 45, 52, 60, 70, 80, 90, 100, 110, 120, 135, 150, 165, 180],
  "genoa": [
    [2.43, 3.84, 4.97, 5.79, 6.39, 6.73, 6.92, 7.06, 6.92],
    [3.08, 4.62, 5.78, 6.59, 7.13, 7.38, 7.52, 7.64, 7.49],
    [3.59, 5.19, 6.29, 7.02, 7.47, 7.71, 7.84, 7.96, 7.8],
    [4.08, 5.71, 6.8, 7.48, 7.87, 8.09, 8.22, 8.33, 8.18],
    [4.44, 6.09, 7.14, 7.75, 8.09, 8.3, 8.45, 8.59, 8.46],
    [4.7, 6.32, 7.35, 7.9, 8.22, 8.45, 8.66, 8.89, 8.81],
    [4.72, 6.34, 7.39, 8.01, 8.34, 8.58, 8.79, 9.15, 9.19],
    [4.61, 6.23, 7.37, 8.07, 8.44, 8.66, 8.86, 9.36, 9.58],
    [4.3, 5.91, 7.1, 7.89, 8.32, 8.62, 8.92, 9.58, 9.85],
    [3.84, 5.41, 6.61, 7.55, 8.11, 8.53, 8.96, 9.7, 10.34],
    [3.47, 5.05, 6.3, 7.29, 7.91, 8.32, 8.71, 9.62, 10.74],
    [2.94, 4.4, 5.59, 6.64, 7.46, 7.97, 8.3, 8.97, 9.8],
    [2.44, 3.7, 4.79, 5.72, 6.54, 7.26, 7.72, 8.36, 8.98],
    [2.03, 3.05, 4.05, 4.98, 5.8, 6.57, 7.25, 8.14, 8.86],
    [1.94, 2.92, 3.88, 4.78, 5.6, 6.34, 7.02, 8.03, 8.8]
  ],
  "fock": [
    [2.31, 3.69, 4.82, 5.7, 6.36, 6.73, 6.92, 7.06, 7.06],
    [2.94, 4.44, 5.61, 6.49, 7.09, 7.38, 7.52, 7.64, 7.64],
    [3.42, 4.99, 6.11, 6.91, 7.43, 7.71, 7.84, 7.96, 7.96],
    [3.88, 5.49, 6.6, 7.37, 7.83, 8.09, 8.22, 8.33, 8.35],
    [4.23, 5.85, 6.93, 7.64, 8.05, 8.3, 8.45, 8.59, 8.63],
    [4.47, 6.07, 7.14, 7.79, 8.18, 8.45, 8.66, 8.89, 8.99],
    [4.5, 6.09, 7.17, 7.89, 8.3, 8.58, 8.79, 9.15, 9.38],
    [4.39, 5.99, 7.16, 7.95, 8.4, 8.66, 8.86, 9.36, 9.77],
    [4.1, 5.68, 6.89, 7.78, 8.28, 8.62, 8.92, 9.58, 10.05],
    [3.7, 5.25, 6.48, 7.48, 8.07, 8.53, 8.96, 9.7, 10.34],
    [3.33, 4.9, 6.18, 7.22, 7.88, 8.32, 8.71, 9.62, 10.74],
    [2.83, 4.27, 5.48, 6.54, 7.39, 7.93, 8.3, 8.97, 9.8],
    [2.35, 3.59, 4.7, 5.63, 6.47, 7.22, 7.72, 8.36, 8.98],
    [1.95, 2.96, 3.97, 4.91, 5.74, 6.53, 7.25, 8.14, 8.86],
    [1.87, 2.83, 3.8, 4.71, 5.54, 6.31, 7.02, 8.03, 8.8]
  ],
  "beat": { "tws": [4, 6, 8, 10, 12, 14, 16, 20, 25], "angle": [47.8, 45, 42.8, 41.1, 39.6, 38.7, 38.2, 38, 38.7] },
  "gybe": { "tws": [4, 6, 8, 10, 12, 14, 16, 20, 25], "angle": [142, 144, 146, 161, 173, 174, 176, 177, 178] }
}
```

Note the gybe angles: with white sails below ~8 kn TWS the optimal downwind angle is ~142–146° TWA — dead-running in light air is much slower. The router's `±gybeAngle(tws)` candidates exploit exactly this.

- [ ] **Step 3: Write `pipeline/build_polars.mjs`** — reads `polars-source.json`, validates, emits the two `PolarTable` JSONs:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(join(here, 'polars-source.json'), 'utf8'));
const outDir = join(here, '..', 'app', 'public', 'data');

const SOURCE_NOTE =
  'Estimate derived from ORC International 2026 certificate Salona 45 "Miles Ahead" (AUT 035/26); ' +
  'downwind corrected to white sails via 23-boat ORC non-spinnaker ratio study; genoa table modeled overlay. ' +
  'Flat-water racing VPP — tune with the performance factor. NOT race-calibrated.';

function validate(name, speeds) {
  if (speeds.length !== src.twa.length) throw new Error(`${name}: twa row count`);
  for (const [i, row] of speeds.entries()) {
    if (row.length !== src.tws.length) throw new Error(`${name}: tws col count @twa ${src.twa[i]}`);
    for (const [j, v] of row.entries()) {
      if (!(v > 0 && v < 12)) throw new Error(`${name}: implausible ${v} kn @ ${src.twa[i]}/${src.tws[j]}`);
      // monotone in TWS up to 20 kn (25-kn column may be depowered)
      if (j > 0 && j < row.length - 1 && row[j] < row[j - 1] - 1e-9)
        throw new Error(`${name}: non-monotone TWS @ twa ${src.twa[i]}, tws ${src.tws[j]}`);
    }
  }
  // sanity anchors (research-verified magnitudes)
  const at = (twa, tws) => speeds[src.twa.indexOf(twa)][src.tws.indexOf(tws)];
  if (Math.abs(at(90, 16) - 8.86) > 0.6) throw new Error(`${name}: beam reach @16kn drifted`);
  if (at(52, 12) < 6.5 || at(52, 12) > 8.5) throw new Error(`${name}: upwind @12kn implausible`);
}

for (const rig of ['genoa', 'fock']) {
  validate(rig, src[rig]);
  const table = {
    rig,
    boat: src.boat,
    tws: src.tws,
    twa: src.twa,
    speeds: src[rig],
    beat: src.beat,
    gybe: src.gybe,
    source: SOURCE_NOTE,
  };
  writeFileSync(join(outDir, `polar-${rig}.json`), JSON.stringify(table));
  console.log(`wrote polar-${rig}.json (${src.twa.length}x${src.tws.length})`);
}
```

- [ ] **Step 4: Run and verify**

Run: `mkdir -p app/public/data && node pipeline/build_polars.mjs`
Expected: `wrote polar-genoa.json (15x9)` and `wrote polar-fock.json (15x9)`. Then validate against the app type: `npx tsx -e` is NOT set up — instead Task E3's asset-loading test asserts the parsed shape.

- [ ] **Step 5: Commit** — `git add pipeline/ app/public/data/polar-*.json && git commit -m "feat: Salona 45 polar tables from ORC 2026 certificate (white-sails corrected)"`

### Task C2: Harbor list

**Files:**
- Create: `pipeline/harbors-source.json`, `pipeline/build_harbors.mjs`
- Output (committed): `app/public/data/harbors.json`

**Interfaces:**
- Produces: `harbors.json` = `Harbor[]` (see `types.ts`): `{ id, names: {de, da, en}, country, snap: {lat, lon}, approachNote?: {de, en} }`, sorted by name. Consumed by HarborPicker (E2) and by `verify_mask.py` (C3), which asserts every snap point is navigable at **2.2 m** in the generated mask.

**Data provenance:** 33 harbors, geolocated via OSM Nominatim + Overpass breakwater/marina geometry; snap points hand-placed 100–300 m off each entrance on the fairway side; draft-critical depths cross-checked against danskehavnelods.dk / havneguide.dk / esys.org (2026-07-14). Ristinge was researched and **deliberately excluded** (charted 2.0 m < 2.1 m draft at mean water). Bridge openings (Kappeln, Sønderborg, Egernsund) are noted in approach notes, not modeled.

- [ ] **Step 1: Create `pipeline/harbors-source.json`** with EXACTLY these 33 entries (format: `[id, nameDe, nameDa, nameEn, country, lat, lon, approachNoteEn]`; `null` note = no draft concerns):

```json
[
  ["flensburg", "Flensburg", "Flensborg", "Flensburg", "DE", 54.798, 9.4335, null],
  ["gluecksburg", "Glücksburg", "Lyksborg", "Glücksburg", "DE", 54.8415, 9.5225, "Marina basin approx 2.0-2.5 m; little margin for 2.1 m draft at wind-driven low water."],
  ["langballigau", "Langballigau", "Langballigau", "Langballigau", "DE", 54.8215, 9.653, "Entrance dredged approx 2.5-3 m but silts; easterly winds can lower the level 0.5 m+; marginal at low water."],
  ["kappeln", "Kappeln", "Kappel", "Kappeln", "DE", 54.66, 9.9355, "Schlei fairway maintained approx 5 m; bascule bridge opens at fixed times for passage further up-Schlei."],
  ["maasholm", "Maasholm", "Maasholm", "Maasholm", "DE", 54.6845, 9.997, "Short buoyed side channel approx 2.5-3 m; keep strictly to the buoys, flats on both sides."],
  ["schleimuende", "Schleimünde", "Slieminde", "Schleimünde", "DE", 54.673, 10.037, "Small basin only approx 2-2.5 m in parts and very tight; pick your spot carefully with 2.1 m."],
  ["gelting-mole", "Gelting Mole", "Gelting Mole", "Gelting Mole", "DE", 54.7555, 9.8645, "Buoyed approach approx 2.5-3 m; adequate at normal water levels."],
  ["wackerballig", "Wackerballig", "Wackerballig", "Wackerballig", "DE", 54.7605, 9.8745, "Entrance silts; wind-driven low water can make entry impossible - treat as marginal for 2.1 m."],
  ["damp", "Damp", "Damp", "Damp", "DE", 54.5855, 10.031, "Dredged entrance channel approx 2.5-3 m, prone to silting after storms; follow the buoys exactly."],
  ["olpenitz", "Olpenitz", "Olpenitz", "Olpenitz", "DE", 54.6606, 10.0435, null],
  ["arnis", "Arnis", "Arnæs", "Arnis", "DE", 54.629, 9.935, "Above the Kappeln bridge (opening required); narrow marked channel off Arnis."],
  ["soenderborg", "Sonderburg", "Sønderborg", "Sønderborg", "DK", 54.908, 9.783, "Deep water in Alssund; the bascule bridge opens at scheduled times for passage north."],
  ["aabenraa", "Apenrade", "Aabenraa", "Aabenraa", "DK", 55.0345, 9.427, null],
  ["dyvig", "Dyvig", "Dyvig", "Dyvig", "DK", 55.043, 9.71, "Enter via Stegsvig through a narrow buoyed channel (approx 3.0-3.5 m, ~30 m wide, 5 kn max)."],
  ["augustenborg", "Augustenburg", "Augustenborg", "Augustenborg", "DK", 54.942, 9.866, "Buoyed fairway up Augustenborg Fjord, approx 3 m in the upper reaches."],
  ["hoeruphav", "Höruphaff", "Høruphav", "Høruphav", "DK", 54.9045, 9.887, "Buoyed channel across shoal ground, approx 2.5-3 m; respect the buoyage."],
  ["mommark", "Mommark", "Mommark", "Mommark", "DK", 54.9325, 10.0485, "Entrance approx 2.5-3 m; exposed in strong easterly winds."],
  ["fynshav", "Fünenshaff", "Fynshav", "Fynshav", "DK", 54.9925, 9.9905, "Keep well clear of the Als-Fyn/Ærø ferries when approaching."],
  ["aeroeskoebing", "Ærøskøbing", "Ærøskøbing", "Ærøskøbing", "DK", 54.8935, 10.416, "Buoyed approach channel through flats; keep strictly to the channel, shoals close on both sides."],
  ["marstal", "Marstal", "Marstal", "Marstal", "DK", 54.859, 10.524, "Buoyed approaches approx 3.2 m (N and W), 4.5 m from S; parts of the yacht basin only approx 2 m."],
  ["soeby", "Søby", "Søby", "Søby", "DK", 54.944, 10.254, null],
  ["faaborg", "Faaborg", "Faaborg", "Faaborg", "DK", 55.092, 10.24, null],
  ["svendborg", "Svendborg", "Svendborg", "Svendborg", "DK", 55.0585, 10.616, "Deep water but strong reversing current (up to ~2.5 kn) in Svendborg Sund."],
  ["troense", "Troense", "Troense", "Troense", "DK", 55.0375, 10.642, "Small basin approx 2-2.5 m - tight for 2.1 m; current sets across the entrance."],
  ["rudkoebing", "Rudkøbing", "Rudkøbing", "Rudkøbing", "DK", 54.941, 10.706, "Only via Rudkøbing Løb, a narrow dredged channel (approx 3 m) through extensive flats; hard reversing current."],
  ["bagenkop", "Bagenkop", "Bagenkop", "Bagenkop", "DK", 54.753, 10.668, null],
  ["lyoe", "Lyø", "Lyø", "Lyø", "DK", 55.0525, 10.1615, "Basin approx 2.5 m with shallow flats around the island; follow the buoyed approach."],
  ["avernakoe", "Avernakø", "Avernakø", "Avernakø", "DK", 55.042, 10.2525, "Basin approx 2.5 m; approach from N over gradually shoaling ground."],
  ["drejoe", "Drejø", "Drejø", "Drejø", "DK", 54.9645, 10.439, "Basin approx 2.5-3 m, shoal ground close outside the moles."],
  ["assens", "Assens", "Assens", "Assens", "DK", 55.265, 9.885, null],
  ["aaroesund", "Årösund", "Årøsund", "Årøsund", "DK", 55.26, 9.7165, "Harbor approx 2.5-3 m; strong current in the Årøsund channel."],
  ["graasten", "Gravenstein", "Gråsten", "Gråsten", "DK", 54.917, 9.603, "Via Egernsund bascule bridge (scheduled openings), then buoyed channel approx 2.5 m across shallow Nybøl Nor."],
  ["faldsled", "Faldsled", "Faldsled", "Faldsled", "DK", 55.15, 10.142, "Buoyed approach approx 2.5 m through a shallow bay - little margin for 2.1 m."]
]
```

- [ ] **Step 2: Write `pipeline/build_harbors.mjs`** — validates bbox + shape, translates notes, emits `Harbor[]`:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, 'harbors-source.json'), 'utf8'));
// German translations of the English approach notes, keyed by harbor id.
// MUST cover every id whose note is non-null (build fails otherwise).
const notesDe = JSON.parse(readFileSync(join(here, 'harbors-notes-de.json'), 'utf8'));

const BBOX = { south: 54.3, north: 55.3, west: 9.4, east: 11.0 };
const seen = new Set();
const harbors = rows.map(([id, de, da, en, country, lat, lon, noteEn]) => {
  if (seen.has(id)) throw new Error(`duplicate id ${id}`);
  seen.add(id);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad id ${id}`);
  if (lat < BBOX.south || lat > BBOX.north || lon < BBOX.west || lon > BBOX.east)
    throw new Error(`${id} outside bbox: ${lat},${lon}`);
  if (!['DE', 'DK'].includes(country)) throw new Error(`${id}: bad country`);
  const harbor = { id, names: { de, da, en }, country, snap: { lat, lon } };
  if (noteEn) {
    if (!notesDe[id]) throw new Error(`${id}: missing German note translation`);
    harbor.approachNote = { de: notesDe[id], en: noteEn };
  }
  return harbor;
});
harbors.sort((a, b) => a.names.de.localeCompare(b.names.de, 'de'));
writeFileSync(join(here, '..', 'app', 'public', 'data', 'harbors.json'), JSON.stringify(harbors, null, 1));
console.log(`wrote harbors.json: ${harbors.length} harbors`);
```

- [ ] **Step 3: Create `pipeline/harbors-notes-de.json`** — German translations of every non-null English note above. Translate them yourself, faithfully and nautically idiomatic (e.g. `gluecksburg`: `"Hafenbecken ca. 2,0–2,5 m; bei Niedrigwasser durch Ostwind wenig Reserve für 2,1 m Tiefgang."`). Every id with a note in Step 1 must appear.

- [ ] **Step 4: Run and verify**

Run: `node pipeline/build_harbors.mjs`
Expected: `wrote harbors.json: 33 harbors`. Spot-check: `jq '.[] | select(.id=="dyvig")' app/public/data/harbors.json` shows names + snap + both note languages.

- [ ] **Step 5: Commit** (`feat: curated harbor list with navigable snap points and de/en approach notes`)

### Task C3: Land/depth mask (Python)

**Files:**
- Create: `pipeline/requirements.txt`, `pipeline/build_mask.py`, `pipeline/verify_mask.py`, `pipeline/README.md`
- Output (committed): `app/public/data/mask.bin` (1 320 000 bytes), `app/public/data/mask.meta.json`

**Interfaces:**
- Produces: `mask.bin` + `mask.meta.json` matching `MaskMeta` and the byte encoding in `types.ts` (0 = land/unknown, 1–254 = depth dm floored, 255 = ≥25.4 m; **row 0 = south**). Grid: **1200 rows × 1100 cols** (dLat = 1.0/1200 ≈ 92.6 m, dLon = 1.6/1100 ≈ 92.8 m E-W at 54.8°N).
- Consumes: `app/public/data/harbors.json` (C2) for snap-point validation.

**Data sources (cite in `mask.meta.json` and the About dialog):**
- Bathymetry: EMODnet DTM 2024, WCS GetCoverage (live-verified): `https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=emodnet__mean&subset=Lat(54.3,55.3)&subset=Long(9.4,11.0)&format=image/tiff` → float32 GeoTIFF, 1536×960 px, EPSG:4326, values = elevation **relative to LAT** (negative = depth; conservative near-lowest-tide datum — good for a safety mask), NoData = NaN (no tag set — handle explicitly). License CC-BY 4.0, cite "EMODnet Bathymetry Consortium (2024). EMODnet Digital Bathymetry (DTM 2024)", DOI 10.12770/cf51df64-56f9-4a99-b1aa-36b8d7b743a1.
- Land: `https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip` (~881 MB global zip, daily rebuild; only ~1 MB of geometry in our bbox — download to `pipeline/data-src/`, gitignored, read with bbox filter). ODbL, © OpenStreetMap contributors.

- [ ] **Step 1: Create `pipeline/requirements.txt`** (versions verified on PyPI 2026-07-14):

```
rasterio==1.5.0
geopandas==1.1.4
shapely==2.1.2
pyogrio==0.13.0
numpy==2.5.1
pyproj==3.7.2
```

Setup: `python3 -m venv pipeline/.venv && pipeline/.venv/bin/pip install -r pipeline/requirements.txt`

- [ ] **Step 2: Write `pipeline/build_mask.py`**

```python
"""Build the packed land/depth mask from EMODnet bathymetry + OSM land polygons.

Encoding (must match app/src/types.ts MaskMeta):
  0        land or unknown/unsurveyed (non-navigable)
  1..254   depth in decimeters, floored (0.1 .. 25.4 m)
  255      deep (>= 25.4 m)
Row 0 = SOUTH edge (the app's convention; numpy arrays are north-first, so flip before writing).
"""

import json
import pathlib
import sys
import urllib.request

import numpy as np
import geopandas as gpd
import rasterio
from rasterio import features
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling

HERE = pathlib.Path(__file__).parent
SRC = HERE / "data-src"
OUT = HERE.parent / "app" / "public" / "data"
WEST, SOUTH, EAST, NORTH = 9.4, 54.3, 11.0, 55.3
COLS, ROWS = 1100, 1200

WCS_URL = (
    "https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1"
    "&request=GetCoverage&coverageId=emodnet__mean"
    f"&subset=Lat({SOUTH},{NORTH})&subset=Long({WEST},{EAST})&format=image/tiff"
)
LAND_URL = "https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip"


def fetch(url: str, dest: pathlib.Path) -> None:
    if dest.exists():
        print(f"cached: {dest.name}")
        return
    print(f"downloading {url} -> {dest.name}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(url, dest)


def main() -> None:
    fetch(WCS_URL, SRC / "emodnet_dtm.tif")
    fetch(LAND_URL, SRC / "land-polygons-split-4326.zip")

    dst_transform = from_origin(WEST, NORTH, (EAST - WEST) / COLS, (NORTH - SOUTH) / ROWS)
    elev = np.full((ROWS, COLS), np.nan, dtype=np.float32)  # row 0 = north (numpy)
    with rasterio.open(SRC / "emodnet_dtm.tif") as src:
        # Resampling.max on LAT-referenced *elevation* picks the SHALLOWEST
        # contributing source cell -> conservative for navigability.
        reproject(
            source=rasterio.band(src, 1),
            destination=elev,
            src_nodata=float("nan"),
            dst_transform=dst_transform,
            dst_crs="EPSG:4326",
            dst_nodata=float("nan"),
            resampling=Resampling.max,
        )

    print("rasterizing OSM land polygons (bbox-filtered read of the global zip)...")
    gdf = gpd.read_file(SRC / "land-polygons-split-4326.zip", bbox=(WEST, SOUTH, EAST, NORTH))
    land = features.rasterize(
        gdf.geometry,
        out_shape=(ROWS, COLS),
        transform=dst_transform,
        all_touched=True,  # any cell touching land counts as land - conservative for a 45-footer
        fill=0,
        default_value=1,
    ).astype(bool)

    depth_m = np.where(np.isnan(elev), np.nan, np.maximum(-elev, 0.0))
    code = np.zeros((ROWS, COLS), dtype=np.uint8)
    known = ~np.isnan(depth_m)
    dm = np.floor(np.nan_to_num(depth_m) * 10.0)  # floor: never overstate depth
    code[known] = np.clip(dm[known], 0, 255).astype(np.uint8)
    code[known & (dm >= 254)] = 255  # >= 25.4 m -> deep
    code[known & (dm < 1)] = 0  # drying / zero depth -> land
    code[~known] = 0  # unknown -> non-navigable
    code[land] = 0

    water_frac = float((code > 0).mean())
    print(f"water fraction: {water_frac:.3f}")
    assert 0.45 < water_frac < 0.85, "implausible land/water split - inspect inputs"

    code_south_first = np.flipud(code)  # app convention: row 0 = south
    (OUT).mkdir(parents=True, exist_ok=True)
    (OUT / "mask.bin").write_bytes(code_south_first.tobytes())
    meta = {
        "west": WEST, "south": SOUTH, "east": EAST, "north": NORTH,
        "cols": COLS, "rows": ROWS,
        "encoding": "uint8 row-major, row 0 = south; 0=land/unknown, 1-254=depth dm floored, 255=deep(>=25.4m)",
        "verticalDatum": "LAT (EMODnet DTM 2024)",
        "sources": [
            "EMODnet Bathymetry Consortium (2024). EMODnet Digital Bathymetry (DTM 2024). doi:10.12770/cf51df64-56f9-4a99-b1aa-36b8d7b743a1 (CC-BY 4.0)",
            "Land polygons (c) OpenStreetMap contributors (ODbL), osmdata.openstreetmap.de",
        ],
    }
    (OUT / "mask.meta.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote mask.bin ({code.size} bytes) + mask.meta.json")


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Write `pipeline/verify_mask.py`** — probe assertions against known geography + all harbor snap points:

```python
"""Sanity-probe the generated mask. Fails loudly if the mask is unusable."""

import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent / "app" / "public" / "data"

meta = json.loads((OUT / "mask.meta.json").read_text())
grid = np.frombuffer((OUT / "mask.bin").read_bytes(), dtype=np.uint8).reshape(
    meta["rows"], meta["cols"]
)  # row 0 = south


def depth_m(lat: float, lon: float) -> float:
    row = int((lat - meta["south"]) / (meta["north"] - meta["south"]) * meta["rows"])
    col = int((lon - meta["west"]) / (meta["east"] - meta["west"]) * meta["cols"])
    b = int(grid[row, col])
    return 0.0 if b == 0 else (25.4 if b == 255 else b / 10.0)


WATER_PROBES = [  # (name, lat, lon, min expected depth m)
    ("Flensburg Fjord mid", 54.80, 9.90, 5.0),
    ("Sonderborg Bucht", 54.88, 9.83, 5.0),
    ("Als Fjord", 55.05, 9.72, 5.0),
    ("Little Belt south", 55.10, 9.85, 10.0),
    ("Aeroe SE open water", 54.75, 10.55, 5.0),
    ("Kiel Bight edge", 54.55, 10.30, 10.0),
]
LAND_PROBES = [
    ("Flensburg city", 54.79, 9.42),
    ("Als island center", 54.95, 9.85),
    ("Aeroe center", 54.87, 10.35),
    ("Langeland center", 54.90, 10.75),
    ("Angeln inland", 54.70, 9.70),
]

failures = []
for name, lat, lon, want in WATER_PROBES:
    d = depth_m(lat, lon)
    if d < want:
        failures.append(f"WATER {name} ({lat},{lon}): {d} m < {want} m")
for name, lat, lon in LAND_PROBES:
    d = depth_m(lat, lon)
    if d != 0.0:
        failures.append(f"LAND {name} ({lat},{lon}): depth {d} m, expected land")

harbors = json.loads((OUT / "harbors.json").read_text())
for h in harbors:
    d = depth_m(h["snap"]["lat"], h["snap"]["lon"])
    if d < 2.2:
        failures.append(f"HARBOR {h['id']} snap ({h['snap']['lat']},{h['snap']['lon']}): {d} m < 2.2 m")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} mask probe failures")
print(f"all probes OK ({len(WATER_PROBES)} water, {len(LAND_PROBES)} land, {len(harbors)} harbor snaps)")
```

- [ ] **Step 4: Run the pipeline**

```
pipeline/.venv/bin/python /home/pkuhn/sail_command/pipeline/build_mask.py
pipeline/.venv/bin/python /home/pkuhn/sail_command/pipeline/verify_mask.py
```

Expected: `water fraction: 0.6…`, `wrote mask.bin (1320000 bytes)`, then `all probes OK (…, 33 harbor snaps)`.
**If a harbor snap probe fails:** the snap point is on a mask land/shallow cell — move that harbor's snap coordinate in `pipeline/harbors-source.json` further out along the approach fairway (check the location on OSM), rebuild harbors + rerun verify. Do NOT weaken the 2.2 m threshold; harbors with genuinely <2.2 m approaches don't belong in the list (that's why Ristinge is excluded). The land probes use coarse coordinates — if one fails, first check the coordinate actually is inland on OSM before suspecting the mask.

- [ ] **Step 5: Write `pipeline/README.md`** — one paragraph per asset: what it is, data sources + licenses + citation strings, exact regeneration commands (venv setup, build, verify), and a warning that `mask.bin`/`basemap.pmtiles` are hook-protected binaries (regenerate, never hand-edit). Document that EMODnet's `emodnet__mean` coverage tracks the latest DTM release, so rebuilds may differ; the build date is pinned in `mask.meta.json`.

- [ ] **Step 6: Commit** (`feat: EMODnet+OSM land/depth mask pipeline and generated mask`) — includes `app/public/data/mask.bin` (~1.3 MB, gzips well).

### Task C4: PMTiles basemap extract + offline style assets

**Files:**
- Create: `pipeline/extract_basemap.sh`
- Modify: `.claude/settings.json` (allowlist `Bash(pipeline/bin/pmtiles:*)`)
- Output (committed): `app/public/data/basemap.pmtiles` (~25 MB at maxzoom 13), `app/public/basemap-assets/` (fonts + sprites)

**Interfaces:**
- Produces: the `.pmtiles` file consumed by MapView (E1) via URL `pmtiles://…/data/basemap.pmtiles`, plus self-hosted glyphs (`basemap-assets/fonts/{fontstack}/{range}.pbf`) and sprites (`basemap-assets/sprites/v4/light.*`). **Never** reference `protomaps.github.io` at runtime — that breaks offline.

- [ ] **Step 1: Write `pipeline/extract_basemap.sh`**

```bash
#!/usr/bin/env bash
# Extract the regional basemap from the Protomaps daily build.
# Usage: pipeline/extract_basemap.sh [YYYYMMDD]  (default: yesterday's build)
set -euo pipefail
cd "$(dirname "$0")"

BUILD_DATE="${1:-$(date -u -d yesterday +%Y%m%d)}"
BBOX="9.4,54.3,11.0,55.3"          # min_lon,min_lat,max_lon,max_lat
MAXZOOM=13                          # ~25 MB; z14 ≈ 2x, z15 (full) ≈ 91 MB (measured 2026-07-14)
PMTILES_VERSION="1.31.1"
BIN=bin/pmtiles

if [ ! -x "$BIN" ]; then
  mkdir -p bin
  echo "installing pmtiles CLI v${PMTILES_VERSION}..."
  curl -sL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" \
    | tar xz -C bin pmtiles
fi

"$BIN" extract "https://build.protomaps.com/${BUILD_DATE}.pmtiles" \
  ../app/public/data/basemap.pmtiles \
  --bbox="$BBOX" --maxzoom="$MAXZOOM"

echo "--- verify ---"
"$BIN" show ../app/public/data/basemap.pmtiles
```

`chmod +x pipeline/extract_basemap.sh`. Add `pipeline/bin/` to `.gitignore`. Add `"Bash(pipeline/bin/pmtiles:*)"` and `"Bash(pipeline/extract_basemap.sh:*)"` to the allow list in `.claude/settings.json` (commit this — future regenerations shouldn't trip permission prompts).

- [ ] **Step 2: Run it** — `pipeline/extract_basemap.sh`
Expected: range-request download (~30–100 MB transferred), then `pmtiles show` reporting bounds ≈ 9.4,54.3,11.0,55.3, zooms 0–13, tileset version 4.x. Check size: `ls -la app/public/data/basemap.pmtiles` ≈ 20–30 MB. If >35 MB, drop MAXZOOM to 12 (spec budget: ~30 MB first-load basemap).

- [ ] **Step 3: Fetch offline style assets** — glyphs + sprites from the `protomaps/basemaps-assets` GitHub repo (BSD/OFL): copy `fonts/Noto Sans Regular`, `fonts/Noto Sans Medium`, `fonts/Noto Sans Italic` and `sprites/v4/light.{json,png}` + `light@2x.{json,png}` into `app/public/basemap-assets/…` (git clone --depth 1 https://github.com/protomaps/basemaps-assets into `pipeline/data-src/` and `cp -r` the needed dirs; add the clone dir to .gitignore, commit the copied assets).

- [ ] **Step 4: Commit** (`feat: regional Protomaps basemap extract (z0-13) with self-hosted glyphs/sprites`)

**Phase C gate:** all four assets exist in `app/public/data/`, `verify_mask.py` green. PR "Phase C: static data pipeline" → self-review → merge.

---

# Phase D — Services & state

### Task D0: Leg discriminated-union refactor (added 2026-07-15, PR #5 self-review, user-approved)

Restructure `Leg` from the flat shape into a discriminated union on `kind`:
sail legs carry `board: Board` (non-null) and `twaDeg: number`; motor legs
carry `board: null` and **no `twaDeg` field** (the NaN sentinel disappears,
which also removes the JSON-unsafety caveat for that field). Rationale: the
flat shape admits illegal states (`{kind:'sail', board:null}` compiles) and
TS cannot narrow `board` from a `kind` check (live gap in `gpx.ts`).
Scope: `types.ts`, leg construction in `isochrone.ts`, consumers
(`postprocess.ts`, `gpx.ts`), and test fixtures. Behavior must be identical —
pin with the existing golden/property suites. Update this appendix's `Leg`
definition in the same commit.

### Phase D intake (from Phase B reviews, ledger-tracked)

- `MaskMeta`: optional `encoding`/`verticalDatum`/`sources` fields when
  `mask.meta.json` is first parsed (About dialog consumes `sources` in E7).
- Frontier-truncation surfacing: `MAX_FRONTIER` cap currently only documented;
  decide between a progress flag or a dedicated `NoRouteReason`.
- `RoutingClient` cancellation: decide dispose/recreate vs per-plan cancel at
  the first real consumer.
- Plan file serializer (NaN/Float32Array-safe) before Garmin import/export (#3).

### Task D1: Open-Meteo wind service

**Files:**
- Create: `app/src/services/openMeteo.ts`, `app/src/services/openMeteo.test.ts`

**Interfaces:**
- Produces:
  ```ts
  class OpenMeteoError extends Error { kind: 'offline' | 'rate-limited' | 'http' | 'malformed' }
  function fetchWindGrid(opts?: {
    fetchFn?: typeof fetch;        // injection point for tests
    fixtureUrl?: string;           // test/E2E escape hatch: fetch this URL instead (same response shape)
  }): Promise<WindGrid>;
  const FORECAST_DAYS = 6;
  ```
  Grid: lat 54.3…55.3 step 0.1 (11), lon 9.4…11.0 step 0.1 (17) → **187 points in ONE request** (research-verified: fits the ~8 KB URL limit; request weight ≈ 187 of the free tier's 600/min, 10 000/day; 0.05° would need 2 requests and 693 calls — rejected). Params: `hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&timeformat=unixtime&timezone=UTC&forecast_days=6&models=icon_seamless` (deterministic DWD ICON chain: D2 → EU → global). Response: JSON **array** of 187 objects in request order (no location ids — order is the contract); each has `hourly.time` (unix seconds) + the three value arrays (144 entries).
  Retry: network errors and 5xx → 2 retries with 1 s / 4 s backoff, then `OpenMeteoError('offline')`; HTTP 429 → `'rate-limited'` immediately (no retry — the limit is minutely); other 4xx → `'http'`; ragged/missing arrays → `'malformed'`. Result timestamps: seconds × 1000 → `timesMs`; `fetchedAtMs = Date.now()`; `model: 'icon_seamless'`.

- [ ] **Step 1: Write failing tests** — build a fake 187-element response where each point's speed encodes its index (`speedKn = pointIdx`), then assert `grid.speedKn[(t*11+la)*17+lo]` recovers the right point (this pins the flattening order against `types.ts`). Plus: one URL-assertion test (all params above, 187 comma-separated coords), 500-then-200 retry test (fake timers for backoff), 429 → kind `'rate-limited'`, ragged arrays → `'malformed'`, `fixtureUrl` bypasses the API URL.

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

`app/src/services/openMeteo.ts`:

```ts
import type { WindGrid } from '../types';

export const FORECAST_DAYS = 6;
const API = 'https://api.open-meteo.com/v1/forecast';
const LATS = Array.from({ length: 11 }, (_, i) => Number((54.3 + i * 0.1).toFixed(1)));
const LONS = Array.from({ length: 17 }, (_, i) => Number((9.4 + i * 0.1).toFixed(1)));
const RETRY_DELAYS_MS = [1000, 4000];

export type OpenMeteoErrorKind = 'offline' | 'rate-limited' | 'http' | 'malformed';

export class OpenMeteoError extends Error {
  constructor(
    readonly kind: OpenMeteoErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'OpenMeteoError';
  }
}

interface PointResponse {
  hourly: {
    time: number[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
    wind_gusts_10m: number[];
  };
}

function buildUrl(): string {
  const points: string[][] = [];
  for (const lat of LATS) for (const lon of LONS) points.push([String(lat), String(lon)]);
  const p = new URLSearchParams({
    latitude: points.map((x) => x[0]).join(','),
    longitude: points.map((x) => x[1]).join(','),
    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'kn',
    timeformat: 'unixtime',
    timezone: 'UTC',
    forecast_days: String(FORECAST_DAYS),
    models: 'icon_seamless',
  });
  return `${API}?${p}`;
}

async function fetchWithRetry(url: string, fetchFn: typeof fetch): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length)
        throw new OpenMeteoError('offline', `network failure: ${String(err)}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    if (res.ok) return res;
    if (res.status === 429)
      throw new OpenMeteoError('rate-limited', 'Open-Meteo minutely limit reached');
    if (res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    throw new OpenMeteoError(res.status >= 500 ? 'offline' : 'http', `HTTP ${res.status}`);
  }
}

export async function fetchWindGrid(opts?: {
  fetchFn?: typeof fetch;
  fixtureUrl?: string;
}): Promise<WindGrid> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const res = await fetchWithRetry(opts?.fixtureUrl ?? buildUrl(), fetchFn);
  const data = (await res.json()) as PointResponse[];
  const nPoints = LATS.length * LONS.length;
  if (!Array.isArray(data) || data.length !== nPoints)
    throw new OpenMeteoError('malformed', `expected ${nPoints} points, got ${Array.isArray(data) ? data.length : typeof data}`);

  const timesS = data[0].hourly.time;
  const nT = timesS.length;
  const speedKn = new Float32Array(nT * nPoints);
  const dirFromDeg = new Float32Array(nT * nPoints);
  const gustKn = new Float32Array(nT * nPoints);
  for (let p = 0; p < nPoints; p++) {
    const h = data[p]?.hourly;
    if (
      !h ||
      h.time.length !== nT ||
      h.wind_speed_10m.length !== nT ||
      h.wind_direction_10m.length !== nT ||
      h.wind_gusts_10m.length !== nT
    )
      throw new OpenMeteoError('malformed', `ragged hourly arrays at point ${p}`);
    for (let t = 0; t < nT; t++) {
      const k = t * nPoints + p; // p = latIdx * LONS.length + lonIdx — matches WindGrid layout
      speedKn[k] = h.wind_speed_10m[t];
      dirFromDeg[k] = h.wind_direction_10m[t];
      gustKn[k] = h.wind_gusts_10m[t];
    }
  }
  return {
    lats: LATS,
    lons: LONS,
    timesMs: timesS.map((s) => s * 1000),
    speedKn,
    dirFromDeg,
    gustKn,
    fetchedAtMs: Date.now(),
    model: 'icon_seamless',
  };
}
```

- [ ] **Step 4: Run tests, expect PASS** · **Step 5: Commit** (`feat: Open-Meteo 187-point wind grid fetch with retry/backoff`)

### Task D2: IndexedDB persistence

**Files:**
- Create: `app/src/services/db.ts`, `app/src/services/db.test.ts`
- Modify: `app/package.json` (add `idb`; dev `fake-indexeddb` — already installed in A1)

**Interfaces:**
- Produces:
  ```ts
  interface PlanSummary { id: string; name: string; createdAtMs: number; departureMs: number; recommended: Rig; etaMs: number }
  savePlan(plan: Plan): Promise<void>
  listPlans(): Promise<PlanSummary[]>        // newest first
  getPlan(id: string): Promise<Plan | undefined>
  deletePlan(id: string): Promise<void>
  loadSettings(): Promise<Settings | undefined>
  saveSettings(s: Settings): Promise<void>
  ```
  idb `DBSchema`-typed database `sailcommand` v1: store `plans` (keyPath `id`, index `by-createdAt`), store `settings` (out-of-line, single key `'user'`). Wind grid `Float32Array`s survive structured clone — plans are stored as-is, **never JSON-serialized**.

- [ ] **Step 1: Write failing tests** (`import 'fake-indexeddb/auto'` at top; `indexedDB.deleteDatabase('sailcommand')` in `beforeEach`): save→get roundtrip preserves `windGrid.speedKn instanceof Float32Array` and all values; listPlans returns summaries newest-first without wind grids; deletePlan removes; settings roundtrip; `loadSettings` on fresh DB → undefined.

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

```ts
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Plan, Rig, Settings } from '../types';

interface SailDB extends DBSchema {
  plans: { key: string; value: Plan; indexes: { 'by-createdAt': number } };
  settings: { key: string; value: Settings };
}

let dbPromise: Promise<IDBPDatabase<SailDB>> | null = null;

function db(): Promise<IDBPDatabase<SailDB>> {
  dbPromise ??= openDB<SailDB>('sailcommand', 1, {
    upgrade(d) {
      const plans = d.createObjectStore('plans', { keyPath: 'id' });
      plans.createIndex('by-createdAt', 'createdAtMs');
      d.createObjectStore('settings');
    },
  });
  return dbPromise;
}

export interface PlanSummary {
  id: string;
  name: string;
  createdAtMs: number;
  departureMs: number;
  recommended: Rig;
  etaMs: number;
}

export async function savePlan(plan: Plan): Promise<void> {
  await (await db()).put('plans', plan);
}

export async function listPlans(): Promise<PlanSummary[]> {
  const all = await (await db()).getAllFromIndex('plans', 'by-createdAt');
  return all.reverse().map((p) => {
    const rec = p.result.recommended === 'genoa' ? p.result.genoa : p.result.fock;
    return {
      id: p.id,
      name: p.name,
      createdAtMs: p.createdAtMs,
      departureMs: p.request.departureMs,
      recommended: p.result.recommended,
      etaMs: rec ? rec.etaMs : p.request.departureMs,
    };
  });
}

export async function getPlan(id: string): Promise<Plan | undefined> {
  return (await db()).get('plans', id);
}

export async function deletePlan(id: string): Promise<void> {
  await (await db()).delete('plans', id);
}

export async function loadSettings(): Promise<Settings | undefined> {
  return (await db()).get('settings', 'user');
}

export async function saveSettings(s: Settings): Promise<void> {
  await (await db()).put('settings', s, 'user');
}
```

- [ ] **Step 4: Run tests, expect PASS** · **Step 5: Commit** (`feat: IndexedDB plan and settings persistence`)

### Task D3: App state contexts

**Files:**
- Create: `app/src/state/AppState.tsx`, `app/src/state/AppState.test.tsx`

**Interfaces:**
- Produces:
  ```tsx
  <AppStateProvider>                       // wraps I18nProvider children in App
  useSettings(): [Settings, (patch: Partial<Settings>) => void]  // persists via saveSettings on change
  useActivePlan(): { plan: Plan | null; rig: Rig | null; setPlan: (p: Plan | null) => void; setRig: (r: Rig) => void }
  // setPlan defaults rig to plan.result.recommended
  useOnline(): boolean                     // navigator.onLine + online/offline events
  ```
  On mount, the provider loads persisted settings (`loadSettings()`) and merges over `DEFAULT_SETTINGS`. GPS position is NOT global state — it stays local to LiveView (1 Hz updates must not re-render the app).

- [ ] **Step 1: Write failing tests** — provider renders children with defaults; `useSettings` patch persists (fake-indexeddb: remount provider → patched value restored); `useActivePlan().setPlan` sets rig to recommended; `useOnline` flips on `window.dispatchEvent(new Event('offline'))`.

- [ ] **Step 2–4: Implement (straightforward context + `useSyncExternalStore` for online), run, PASS**

- [ ] **Step 5: Commit** (`feat: app state contexts for settings, active plan, online status`)

**Phase D gate:** all tests green, typecheck+lint clean. PR "Phase D: services and state" → self-review → merge.

---

# Phase E — UI

UI notes for every E task: ALL user-visible strings go through `useT()` — add keys to BOTH `dict.de.ts` and `dict.en.ts` (TS enforces parity). German is the primary copy voice; keep terms nautical (Wende/Halse, Bug/Heck, rwK für rechtweisende Kurse). The `frontend-design` plugin is enabled — visual polish is welcome but never at the expense of offline weight (no webfonts, no icon CDNs; inline SVG icons only). Mobile-first: the app is used on a phone in a cockpit — big touch targets, panel as bottom sheet in portrait, sidebar ≥768 px.

### Task E1: Map bootstrap + formatting lib

**Files:**
- Create: `app/src/components/MapView.tsx`, `app/src/lib/format.ts`, `app/src/lib/format.test.ts`
- Modify: `app/package.json` (add `maplibre-gl`, `pmtiles`, `@protomaps/basemaps`)

**Interfaces:**
- Produces:
  - `format.ts`: `formatNm(nm)` → `"12.3 nm"`, `formatKn(kn)` → `"6.5 kn"`, `formatHeading(deg)` → `"087°"`, `formatTime(ms, lang)`, `formatDateTime(ms, lang)`, `formatDuration(ms)` → `"4 h 05 min"` — all unit-tested.
  - `MapView.tsx`: `<MapView tapActive={bool} onTap={(p: LatLon) => void}>{children}</MapView>` plus exported `useMapInstance(): maplibregl.Map | null` context hook for child layer components (RouteLayer E4, BoatMarker E6). Registers the pmtiles protocol once (module scope), builds the style with `layers('protomaps', flavor, { lang })` from `@protomaps/basemaps` (**flavor API** — the old "theme" API is obsolete), flavor = `{ ...namedFlavor('light'), water: '#bfd9ea' }`. Source url `pmtiles://` + `new URL(import.meta.env.BASE_URL + 'data/basemap.pmtiles', location.href)`. **Glyphs/sprite MUST point at the self-hosted copies**: `glyphs: import.meta.env.BASE_URL + 'basemap-assets/fonts/{fontstack}/{range}.pbf'`, `sprite: …/basemap-assets/sprites/v4/light'` — never protomaps.github.io (offline!). `maxBounds [[8.9,54.05],[11.5,55.55]]`, center `[9.9,54.85]`, zoom 9. Attribution control (compact): OSM © / Protomaps / EMODnet Bathymetry (CC-BY 4.0) / Open-Meteo (CC-BY 4.0).
  - MapLibre cannot run in jsdom: MapView has **no unit test** (E2E covers it); `format.ts` is fully unit-tested. Keep ALL logic out of MapView beyond map wiring.

- [ ] Steps: failing format tests → implement format.ts → PASS → implement MapView (verify with `npm --prefix app/ run dev` + browser: basemap renders, water recolored, tap logs coordinates) → typecheck/lint → commit (`feat: MapLibre+PMTiles map with offline style assets; formatting helpers`).

### Task E2: Planner panel (pickers + options)

**Files:**
- Create: `app/src/components/HarborPicker.tsx`, `app/src/components/OptionsPanel.tsx`, `app/src/components/PlannerPanel.tsx`, tests for each
- Modify: both i18n dicts

**Interfaces:**
- Produces (presentational — wired to the flow in E3):
  ```ts
  interface PickedPoint { point: LatLon; harborId: string | null; label: string }
  <HarborPicker harbors={Harbor[]} onSelect={(h: Harbor) => void} />   // search input + list
  <OptionsPanel value={Settings} onChange={(s: Settings) => void} />   // numeric fields + motor toggle, clamped
  <PlannerPanel
    harbors={Harbor[]}
    origin={PickedPoint | null} destination={PickedPoint | null}
    onPickOrigin={(p: PickedPoint) => void} onPickDestination={…}
    onRequestMapTap={(target: 'origin' | 'destination') => void}   // parent arms MapView tap mode
    departureMs={number} onDepartureChange={(ms: number) => void}
    settings={Settings} onSettingsChange={…}
    canPlan={boolean} planDisabledReason={string | null}
    onPlan={() => void}
    planning={PlanningState}   // from E3's type: idle/fetching/routing/error — render spinner/progress/error
  />
  ```
  Details that matter: harbor search is diacritic-insensitive (`'aero'` finds `Ærøskøbing`: compare on `s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('ø', 'o').replaceAll('æ', 'ae')` (lowercase FIRST — 'Æ'/'Ø' are not decomposable and won't match the lowercase replacements otherwise)), matches any of the three names, shows `approachNote` (current lang) under the name when present. Departure input: `<input type="datetime-local">` in LOCAL time, converted to epoch ms; default = next full hour; min = now; max = now + 6 days (`FORECAST_DAYS`). Options bounds: safetyDepth 2.2–10 step 0.1 (never below the 2.1 m draft + 0.1), motorSpeed 1–10, motorThreshold 0–5, maneuverPenalty 0–300 s, performanceFactor 0.5–1.1 step 0.05; out-of-range input clamps on blur. Every setting label carries its unit.

- [ ] Steps (TDD per component): harbor search normalization + selection callback; options clamping (type `12` into safetyDepth → blur → `10`); planner renders pickers/disabled-reason/plan button state; departure default within horizon. Implement, PASS, commit (`feat: planner panel with harbor search, map-tap picking, options`).

### Task E3: Plan flow — wiring wind → worker → persistence

**Files:**
- Create: `app/src/services/assets.ts`, `app/src/state/usePlanFlow.ts`, `app/src/state/usePlanFlow.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // assets.ts — fetched once, module-cached; BASE_URL-relative
  loadRoutingAssets(): Promise<{ maskMeta: MaskMeta; maskBuffer: ArrayBuffer; polarGenoa: PolarTable; polarFock: PolarTable; harbors: Harbor[] }>

  // usePlanFlow.ts
  type PlanningState =
    | { phase: 'idle' }
    | { phase: 'fetching-wind' }
    | { phase: 'routing'; rig: Rig; simulatedToMs: number }
    | { phase: 'error'; messageKey: MsgKey }
  function usePlanFlow(deps?: PlanFlowDeps): {
    planning: PlanningState;
    run: (req: Omit<PlanRequest, 'settings'> & { settings: Settings }, name: string) => Promise<void>;
  }
  interface PlanFlowDeps { fetchWind?: typeof fetchWindGrid; makeClient?: () => RoutingClient; save?: typeof savePlan }
  ```
  Flow of `run`: guard `navigator.onLine` (else error `'error.offline'` — planning requires network, spec) → `fetchWindGrid({ fixtureUrl })` where `fixtureUrl` comes from `new URLSearchParams(location.search).get('windFixture') ?? undefined` (E2E/demo escape hatch, same response shape) → `loadRoutingAssets()` → singleton `RoutingClient`, `init`ed once with `maskBuffer.slice(0)` (**the buffer is transferred to the worker — always pass a copy, keep the original cached**) → `client.plan(...)` with progress → on `status:'ok'`: build `Plan` (`id: crypto.randomUUID()`, `name`, `createdAtMs: Date.now()`, request, windGrid, result), `savePlan` (auto-save: spec says plans persist), `setActivePlan(plan)`, phase `'idle'`. Error mapping to i18n keys: OpenMeteoError offline→`error.offline`, rate-limited→`error.rateLimited`, http/malformed→`error.windService`; PlanResultError reasons→`error.noRoute.unreachable` / `.beyondHorizon` / `.calmMotorOff` / `.snapOrigin` / `.snapDestination`; worker fatal→`error.internal`. Every key exists in both dicts with actionable copy (e.g. calm-motor-off DE: „Zu wenig Wind zum Segeln und Motor deaktiviert — Motor in den Optionen aktivieren oder Abfahrt verschieben.").

- [ ] Steps: failing tests with injected fakes (happy path saves plan + sets active plan + returns to idle; offline guard; wind error; no-route reason mapping; progress reaches routing phase with both rigs) → implement → PASS → commit (`feat: plan flow orchestration with auto-save and error mapping`).

### Task E4: Route rendering + summary

**Files:**
- Create: `app/src/lib/routeGeoJson.ts` (+ test), `app/src/lib/windBarbs.ts`, `app/src/components/RouteLayer.tsx`, `app/src/components/RouteSummary.tsx` (+ test), `app/src/lib/plan.ts` (+ test)
- Modify: both i18n dicts

**Interfaces:**
- Produces:
  - `routeGeoJson.ts` (pure, tested): `legsToFeatureCollection(legs)` (LineString per leg, props `{kind, board, maneuver}`), `maneuverFeatures(legs)` (Point at each `maneuverAtStart` leg start, prop `kind: 'tack'|'gybe'`), `barbFeatures(grid: WindGrid, tMs: number, stride = 2)` (Point per stride-th grid node, props `{speedKn, dirFromDeg}` at nearest hour).
  - `plan.ts` (pure, tested): `isStaleForecast(plan): boolean` — true when `request.departureMs - windGrid.fetchedAtMs > 12 * 3_600_000` (spec §4); `activeRigResult(plan, rig): RigResult | null`.
  - `windBarbs.ts`: `registerBarbImages(map)` — draws WMO-style barbs (half=5 kn, full=10 kn, pennant=50 kn) on a canvas for speeds 0–50 in 5-kn steps, `map.addImage('barb-N', …)`; barb layer uses `icon-image: barb-{round(speed/5)*5}`, `icon-rotate: dirFromDeg` (barb points INTO the FROM direction, standard convention).
  - `RouteLayer.tsx` (map child via `useMapInstance()`): GeoJSON sources `route`/`maneuvers`/`barbs`; line paint data-driven: starboard `#009E73`, port `#D55E00` (Okabe-Ito colorblind-safe green/red echoing nav-light convention), motor `#5b5b5b` + dasharray `[2,1.5]`, width 3.5; maneuver circles (white fill, dark stroke) + text `W`/`H` (de) or `T`/`G` (en) from i18n; barb symbol layer togglable + time-driven by a slider (departure→ETA, snaps to forecast hours); fits bounds on plan change.
  - `RouteSummary.tsx` (tested): rig tabs (`Genua`/`Fock`) each showing ETA — recommended tab carries a `★` badge (i18n `route.recommended`); switching tabs calls `setRig` (both results user-visible, spec); totals row (distance, duration, ETA, maneuver count, motor nm — omit motor row when 0); stale-forecast warning banner when `isStaleForecast` (spec §4); legs table: per leg start time, kind chip (sail: board color dot + `Bb`/`Stb` + point-of-sail label derived from |TWA| — <60° `Kreuz`/beat, 60–110° `Halbwind`/reach, 110–155° `Raum`/broad reach, >155° `Vorwind`/run (spec names leg types explicitly); motor: `Motor` chip), heading `087°`, |TWA|°, TWS kn, speed kn, distance nm, maneuver badge (`Wende`/`Halse`); GPX export button → `Blob` + anchor download `<name>-<rig>.gpx` (from B11 `toGpx`).

- [ ] Steps: TDD the pure modules (`routeGeoJson`, `plan.ts`) and `RouteSummary` (tab switch, recommended badge, stale banner shown/hidden, GPX click calls `URL.createObjectURL` — mock it); implement `RouteLayer`/`windBarbs` (verify in dev browser with a real plan); commit (`feat: route map layers, wind barbs, rig comparison summary with GPX export`).

### Task E5: Saved plans list

**Files:**
- Create: `app/src/components/PlansList.tsx`, `app/src/components/PlansList.test.tsx`

**Interfaces:**
- Consumes: `listPlans`/`getPlan`/`deletePlan` (D2), `useActivePlan` (D3).
- Produces: `<PlansList />` — rows: name, created date, ETA, recommended-rig tag; tap row → `getPlan` → `setPlan` (**renders against its STORED wind grid — no refetch, ever**; spec hard rule); delete via two-tap inline confirm (trash → check, no `window.confirm`); empty-state copy. Refreshes on mount and after `setPlan`/delete.

- [ ] Steps: failing tests with fake-indexeddb-seeded plans (renders newest-first, tap loads full plan into active state, two-tap delete removes, single tap does not) → implement → PASS → commit (`feat: saved plans list with load and delete`).

### Task E6: Live view (GPS guidance)

**Files:**
- Create: `app/src/services/geolocation.ts`, `app/src/lib/live.ts` (+ test), `app/src/components/LiveView.tsx` (+ test), `app/src/components/BoatMarker.tsx`

**Interfaces:**
- Produces:
  - `geolocation.ts`: `watchPosition(onFix: (fix: GpsFix) => void, onError: (e: 'denied' | 'unavailable') => void): () => void` where `GpsFix = { point: LatLon; cogDeg: number | null; sogKn: number | null; accuracyM: number }` (`coords.speed` m/s → kn; null-safe). `enableHighAccuracy: true`.
  - `live.ts` (pure, heavily tested — this runs while sailing):
    ```ts
    activeLegIndex(legs: Leg[], p: LatLon): number            // leg minimizing distance to segment (clamped projection)
    headingToSteerDeg(legs: Leg[], i: number, p: LatLon): number   // bearing p → legs[i].end
    distanceToNextManeuverNm(legs: Leg[], i: number, p: LatLon): { distNm: number; kind: ManeuverKind | 'motor-start' } | null
    projectedEtaMs(legs: Leg[], i: number, p: LatLon, nowMs: number): number
    // = plan ETA + (nowMs − expected time at the projected position along leg i); no re-routing (spec)
    ```
  - `LiveView.tsx`: sail-mode toggle; while active, subscribes to `watchPosition` (LOCAL state — see D3 note), shows: HTS (large), COG/SOG, distance + type of next maneuver, projected ETA with drift vs plan (`+12 min`), active-leg highlight (passes `activeLegIndex` up to RouteLayer via prop or shared context field on `useActivePlan`). GPS denied → one-time dismissible hint (localStorage `sc-gps-hint-shown`), app remains fully usable (spec §4). No plan → prompt to load/create one.
  - `BoatMarker.tsx` (map child): triangle marker rotated to COG (fallback HTS), accuracy circle.

- [ ] Steps: TDD `live.ts` with a synthetic 3-leg route incl. a tack (projection mid-leg, before-start clamps to leg 0, past-end picks last leg; maneuver distance sums remaining leg + next legs to the flagged one; ETA drift positive when behind schedule); LiveView tests with injected fake geolocation (fix updates render; denied → hint once); implement marker; commit (`feat: live GPS guidance with heading-to-steer and ETA projection`).

### Task E7: Banners, About/caveats, app assembly

**Files:**
- Create: `app/src/components/Banner.tsx`, `app/src/components/AboutDialog.tsx`
- Modify: `app/src/App.tsx` (+ `App.test.tsx`), `app/src/app.css`, both i18n dicts

**Interfaces:**
- Produces the assembled app: header (title, DE/EN toggle from A2, about `ⓘ`), full-viewport `MapView` with `RouteLayer` + `BoatMarker` children, bottom-sheet/side panel with three tabs — `Planen` (PlannerPanel), `Routen` (PlansList + RouteSummary of active plan), `Live` (LiveView). Banner area (stacking, dismissible where appropriate): offline banner via `useOnline()` — „Offline — Planung deaktiviert. Gespeicherte Routen bleiben verfügbar." (spec §4; the Plan button independently guards); stale-forecast banner from E4's `isStaleForecast`; GPS hint from E6. `AboutDialog`: spec §7 caveats verbatim-in-spirit in both languages — polars are ORC-derived ESTIMATES tunable via performance factor; **SailCommand ist eine Törnplanungshilfe, kein Navigationsgerät** (the A2 disclaimer string, prominent); first load ~30–40 MB; full data attributions (EMODnet DTM 2024 citation + DOI, © OpenStreetMap/ODbL, Protomaps, Open-Meteo CC-BY 4.0, ORC certificate provenance from C1).
- Map tap-to-pick wiring: `PlannerPanel.onRequestMapTap` arms `MapView.tapActive`; next tap resolves to `PickedPoint` (label = `formatHeading`-free coordinate string `54.789°N 9.433°E`) and disarms.

- [ ] Steps: App test (tabs switch, offline event shows banner, about opens with disclaimer text in current language); assemble; **manual check in dev browser of the complete flow: pick harbors → plan → route on map → switch rig → live tab**; commit (`feat: app shell with banners, caveats dialog, panel navigation`).


### Task E8: Draggable via-waypoints + auto re-route (added 2026-07-15, issue #4)

**Files:**
- Modify: `app/src/components/PlannerPanel.tsx` (via list: add-by-map-tap, remove, reorder), `app/src/components/RouteLayer.tsx` (via markers), `app/src/state/usePlanFlow.ts`
- Create: `app/src/state/replan.ts` (+ test), `app/src/components/ViaMarkers.tsx`

**Interfaces:**
- Produces: `replanWithVias(plan: Plan, viaPoints: LatLon[], deps): Promise<Plan>` — re-runs the routing worker with the plan's **stored** `windGrid` (never refetches; spec hard rule) and the same settings snapshot, returns an updated Plan (same id, result/vias replaced), saves via `savePlan`. Guard: if `departureMs` is beyond the stored grid horizon (stale saved plan), surface `error.replanStaleWind` instead (both dicts). `ViaMarkers`: draggable MapLibre markers for `plan.request.viaPoints`; on `dragend` → `replanWithVias`; while replanning, markers disabled + spinner chip; on error, marker snaps back and a banner shows the reason. PlannerPanel: "Wegpunkt hinzufügen" arms map-tap → appends via before planning; via chips removable and reorderable (up/down buttons suffice — no DnD lists).
- All new strings in BOTH dicts. Unit tests: `replan.ts` with injected fakes (stored-grid reuse asserted — the fake fetchWind must NOT be called; stale-horizon error path; save called with same plan id). Marker/drag behavior is covered by E2E (F2 adds a drag step to plan.spec if feasible via mouse events on the marker element; otherwise assert via the panel's via-list edit path).

- [ ] TDD replan.ts → implement components → wire → full suite + lint + typecheck → commit (`feat: draggable via-waypoints with stored-wind re-route`).

**Phase E gate:** all tests green; `npm --prefix app/ run build` succeeds; manual dev-browser flow works end-to-end (with real Open-Meteo). PR "Phase E: UI" → self-review → merge.

---

# Phase F — PWA, E2E, deploy

### Task F1: Service worker + installability

**Files:**
- Create: `app/src/sw.ts`, `app/src/components/ReloadPrompt.tsx`, `app/public/icons/icon.svg`, `pipeline/build_icons.mjs`
- Modify: `app/vite.config.ts`, `app/src/main.tsx`, `app/tsconfig.json`, `app/package.json` (add `vite-plugin-pwa`, `workbox-window`; pipeline adds dev-dep `sharp`)

**Research-verified constraints (do not re-litigate; sources in plan appendix):**
1. `pmtiles`' `FetchSource` sends a `Range` header for every read and **throws** if it receives a full-body 200 whose Content-Length exceeds the request — so the Workbox default precache route must NEVER answer `.pmtiles` requests.
2. Workbox never caches 206 responses; the cache must hold the full 200 (precache does this atomically at install) and `workbox-range-requests`' `createPartialResponse` slices it into a proper 206.
3. `workbox-routing` matches in registration order — register the `.pmtiles` route **before** `precacheAndRoute`.
4. Update strategy: `registerType: 'prompt'` — autoUpdate reloading mid-passage-planning is unacceptable; precache installs are atomic, so a connection lost mid-update just leaves the old version fully working.

- [ ] **Step 1: Vite config** — add to `app/vite.config.ts`:

```ts
import { VitePWA } from 'vite-plugin-pwa';
// inside plugins: [react(), VitePWA({ ... })]
VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  registerType: 'prompt',
  injectManifest: {
    maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
    globPatterns: ['**/*.{js,css,html,ico,png,svg,json,bin,pmtiles,pbf}'],
    globIgnores: ['**/test-fixtures/**'],
  },
  manifest: {
    name: 'SailCommand',
    short_name: 'SailCommand',
    description: 'Törnplanung Flensburger Förde & Dänische Südsee',
    theme_color: '#0b3d5c',
    background_color: '#0b3d5c',
    display: 'standalone',
    start_url: '.',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
})
```

- [ ] **Step 2: `app/src/sw.ts`** (exactly this shape):

```ts
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { clientsClaim } from 'workbox-core';
import { matchPrecache, precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { createPartialResponse } from 'workbox-range-requests';
import { registerRoute } from 'workbox-routing';

// MUST be registered before precacheAndRoute: first-registered route wins, and the
// default precache route replays a full 200 to Range requests, which makes
// pmtiles' FetchSource throw (verified against pmtiles 4.4.1 source).
registerRoute(
  ({ url }) => url.pathname.endsWith('.pmtiles'),
  async ({ request }) => {
    const full = await matchPrecache(request.url);
    if (full) {
      return request.headers.has('range') ? createPartialResponse(request, full) : full;
    }
    return fetch(request); // dev / cache-miss fallthrough
  },
);

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
```

- [ ] **Step 3: `ReloadPrompt.tsx`** — `useRegisterSW` from `virtual:pwa-register/react`: `needRefresh` → banner „Update verfügbar" with reload button (`updateServiceWorker(true)`); `offlineReady` → one-shot toast „App & Karten offline verfügbar"; `onRegisteredSW(url, reg)` → `window.addEventListener('focus', () => navigator.onLine && reg?.update())` (deliberate update checks on good connectivity only). Mount in App. Add `navigator.storage?.persist?.()` to `main.tsx` (protect plans + 30 MB cache from eviction). tsconfig: add `"WebWorker"` lib and `vite-plugin-pwa/react` + `vite-plugin-pwa/info` types.

- [ ] **Step 4: Icons** — `icon.svg`: minimal flat sail (dark-blue circle `#0b3d5c`, white mainsail triangle + smaller genoa triangle). `pipeline/build_icons.mjs` uses `sharp` to render 192/512/maskable-512 PNGs into `app/public/icons/` (maskable: 20 % safe-zone padding). Run it, commit outputs.

- [ ] **Step 5: Verify build** — `npm --prefix app/ run build`, then: `grep -o 'basemap.pmtiles' app/dist/sw.js | head -1` → present (precached); `ls app/dist/manifest.webmanifest`. Then `npm --prefix app/ run preview` + Chrome DevTools: Application→Service Worker active, Application→Manifest installable, Network tab: map tiles served `206 (from ServiceWorker)` after reload.

- [ ] **Step 6: Commit** (`feat: offline PWA with range-request pmtiles serving and prompt-style updates`)

### Task F2: Playwright E2E

**Files:**
- Create: `app/playwright.config.ts`, `app/e2e/helpers.ts`, `app/e2e/plan.spec.ts`, `app/e2e/offline.spec.ts`, `app/scripts/gen-wind-fixture.mjs`
- Output (committed): `app/public/test-fixtures/wind-sw12.json`
- Modify: `.github/workflows/ci.yml` (e2e job)

**Research-verified constraint:** `context.setOffline(true)` does NOT block fetches made from inside a service worker (Playwright #2311, empirically confirmed) — an offline test that only calls `setOffline` can pass while the SW silently hits the network. The offline spec must **kill the preview server** for the offline phase. Consequently specs spawn their own server (no `webServer` config). Also: `page.route()` cannot intercept SW-handled requests — deterministic wind comes from the `?windFixture=` app escape hatch (E3), not route interception. Chromium project only (SW APIs are Chromium-only in Playwright).

- [ ] **Step 1: Fixture generator** `app/scripts/gen-wind-fixture.mjs` — writes `app/public/test-fixtures/wind-sw12.json`: the exact Open-Meteo multi-location array shape (187 elements, 144 hourly values) with uniform 12 kn / 225° (SW — a broad reach Langballigau→Sønderborg, fast test) and `time` arrays starting at the CURRENT hour (regenerated per run in CI: departure default must fall inside the fixture horizon). Run it via a `pree2e` script hook in `app/package.json` so fixtures are always fresh: `"pree2e": "node scripts/gen-wind-fixture.mjs && npm run build"`.

- [ ] **Step 2: `helpers.ts`** — `startPreview(): Promise<{ url: string; kill: () => void }>`: spawn `npm run preview -- --port 4173 --strictPort`, poll `http://localhost:4173/sail_command/` until 200 (30 s timeout), return kill that SIGKILLs the process tree. `playwright.config.ts`: `testDir: 'e2e'`, chromium only, `workers: 1`, `timeout: 120_000`.

- [ ] **Step 3: `plan.spec.ts`** — start server; `page.goto(url + '?windFixture=test-fixtures/wind-sw12.json')`; open Planen tab; origin: search „Langballigau" in HarborPicker → select; destination: „Sønderborg"; click Plan; `await expect(rig tabs)` (both Genua & Fock with ETAs, one ★); legs table ≥ 1 row; map canvas visible; Routen tab shows 1 saved plan. Assertions target i18n-DE strings via test-ids (`data-testid`) where text is volatile.

- [ ] **Step 4: `offline.spec.ts`** — start server; goto with fixture param; `await page.evaluate(() => navigator.serviceWorker.ready)` (precache complete — includes the 25 MB pmtiles); create + auto-save a plan (as in plan.spec); **`server.kill()`** then `context.setOffline(true)` (flips `navigator.onLine` for the banner); `page.reload()`; assert: app shell renders (SW-served), offline banner visible, Plan button disabled, Routen tab lists the saved plan, loading it renders RouteSummary + map canvas (pmtiles 206-from-SW, stored wind grid). This is the spec's flagship E2E: plan → save → offline reload → plan still visible.

- [ ] **Step 5: CI** — add `e2e` job to `ci.yml` (after the unit job): setup-node, `npm ci`, `npx playwright install --with-deps chromium`, `npm run e2e` (the `pree2e` hook builds). Upload `playwright-report` on failure (`actions/upload-artifact`, `if: failure()`).

- [ ] **Step 6: Run locally** (`npm --prefix app/ run e2e`) — both specs green. Commit (`test: E2E plan flow and true-offline reload (server-kill pattern)`).

### Task F3: Deploy, README, acceptance runbook

**Files:**
- Create: `.github/workflows/deploy.yml`, `README.md`, `docs/acceptance.md`

- [ ] **Step 1: `deploy.yml`**

```yaml
name: Deploy
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
concurrency: { group: pages, cancel-in-progress: true }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: app/package-lock.json }
      - run: npm ci
        working-directory: app
      - run: npm run build
        working-directory: app
      - uses: actions/upload-pages-artifact@v3
        with: { path: app/dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Enable Pages once: `gh api repos/DocGerd/sail_command/pages -X POST -f build_type=workflow` (ignore 409 if already enabled; fallback: repo Settings → Pages → Source „GitHub Actions").

- [ ] **Step 2: `README.md`** — what SailCommand is (2 sentences + disclaimer), live URL `https://docgerd.github.io/sail_command/`, Android install note (Add to Home Screen), dev quickstart (`npm --prefix app/ install`, `run dev|test|e2e`), pipeline regeneration pointer to `pipeline/README.md`, full attribution/license block (EMODnet citation + DOI, OSM/ODbL, Protomaps, Open-Meteo CC-BY 4.0, ORC provenance), first-load size note.

- [ ] **Step 3: `docs/acceptance.md`** — the spec §5 manual acceptance, as a checklist: with a REAL forecast, plan Flensburg → Marstal and Flensburg → Sønderborg; verify visually: route stays in water and rounds Holnis/Broager Land/Kegnæs sanely, tack pattern plausible (bounded count, no zig-zag spam), both rigs shown with distinct ETAs and ★ on the faster, motor legs (if any) gray-dashed and listed, ETA plausible (~5–7 kn average), stale-forecast banner appears when departure > 12 h after fetch. PWA: install on Android, airplane mode, cold start, saved plan renders incl. basemap; live view shows position/HTS on a short walk. Record results in the checklist; file issues for deviations.

- [ ] **Step 4: Verify deploy** — after the Phase F PR merges: `gh run watch` the Deploy workflow, then fetch the live URL (expect 200 and correct `<title>`), and load it once in a real browser (SW registers under `/sail_command/` scope).

- [ ] **Step 5: Commit** (`feat: GitHub Pages deployment, README, acceptance runbook`)

**Phase F gate = project gate:** CI green (unit + e2e), deploy live, acceptance runbook executed against a real forecast (the two named routes reviewed visually — this needs the user or an explicit sign-off note in the PR).

---

## Execution handoff

Recommended: **subagent-driven** (superpowers:subagent-driven-development) in this session — fresh subagent per task, two-stage review between tasks; Phase C can run in a parallel worktree to Phase B. Alternative: inline via superpowers:executing-plans. Either way: one PR per phase to `main`, self-reviewed per the global CLAUDE.md rules (`pr-review-toolkit:review-pr`, inline threads, fixes, resolve threads).

Phase order: A → B → (C parallel to B) → D → E → F. Tasks within B are strictly ordered (B1→B12); C1–C4 are mutually independent except C3 needs C2's `harbors.json`.

## Appendix: Package versions (npm-verified 2026-07-14)

App runtime: `react@19.2.7`, `react-dom@19.2.7`, `maplibre-gl@5.24.0`, `pmtiles@4.4.1`, `@protomaps/basemaps@5.7.2` (flavor API; do NOT use legacy `protomaps-themes-base`), `idb@8.0.3`.
App tooling: `vite@8.1.4`, `@vitejs/plugin-react@6.0.3`, `typescript@5.9.3` (**pin — TS 7.x is outside @typescript-eslint's peer range**), `@types/react@19.2.17`, `@types/react-dom@19.2.3`, `vite-plugin-pwa@1.3.0` (workbox 7.4.1), `workbox-window@7.4.1`, `vitest@4.1.10` + `@vitest/coverage-v8@4.1.10` (version-locked pair), `fast-check@4.9.0`, `@playwright/test@1.61.1`, `eslint@10.7.0`, `@typescript-eslint/parser@8.64.0`, `prettier@3.9.5`, plus `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `fake-indexeddb` (latest at install).
Pipeline: Node ≥ 22 (local: v24.15.0), `sharp` (latest), Python venv per `pipeline/requirements.txt` (rasterio 1.5.0, geopandas 1.1.4, shapely 2.1.2, pyogrio 0.13.0, numpy 2.5.1, pyproj 3.7.2), pmtiles CLI v1.31.1.

Key research sources backing this plan: ORC RMS database (data.orc.org, Salona 45 cert AUT 035/26) · EMODnet Bathymetry WCS (DTM 2024, live-tested) · osmdata.openstreetmap.de land polygons · Protomaps daily builds + @protomaps/basemaps 5.7.2 flavor API (extract executed: 91 MB z15 full-region measured) · Open-Meteo multi-location API (187-point request live-tested; 660-point limit + 429 behavior empirically verified) · pmtiles 4.4.1 FetchSource source + workbox-range-requests 7.4.1 source + real-Chromium offline verification · Playwright #2311 SW/offline caveat (reproduced) · OpenCPN weather_routing_pi + libweatherrouting + qtVlm manual + Hagiwara/Chen isochrone literature (sources cloned and read).
