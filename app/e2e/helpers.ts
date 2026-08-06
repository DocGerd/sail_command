// Shared preview-server lifecycle for E2E specs. No Playwright `webServer`
// config (see playwright.config.ts's comment) — each spec calls
// startPreview() itself and is responsible for kill()ing it, because
// offline.spec.ts needs to kill the server mid-test while plan.spec.ts
// keeps it alive for the whole run.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const PORT = 4173;
const BASE = `http://localhost:${PORT}/sail_command/`;
const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 300;

export interface Viewport {
  width: number;
  height: number;
}

// Named viewport matrix, defined ONCE rather than inlined per spec — this
// repo already paid for the per-file version of that mistake (nine test
// files each hardcoded their own `testTimeout` literal; a fix patched only
// the two that had failed in CI, and the next run failed on a third with the
// identical shape, at ~43 min per round; CLAUDE.md's "enumerate, don't
// patch" lesson). A spec imports whichever set(s) it needs and iterates by
// `Object.entries()` so failures name the KEY, not just raw numbers.
//
// STANDARD_VIEWPORTS: the five device classes product/QA expects every
// layout-sensitive spec to cover at minimum — desktop 4K, desktop HD,
// tablet landscape, tablet portrait, phone portrait. Playwright viewports
// are CSS px, not device px: a real 4K display at the common 150%/200% OS
// scaling presents to the browser as ~2560x1440 or exactly 1920x1080 CSS
// px, so `desktopHd` (1920x1080) already doubles as that scaled-4K case —
// `desktop4k` (3840x2160) is deliberately the UNSCALED, very-wide extreme
// instead of a third near-duplicate entry. An explicit ~2560x1440 entry was
// considered and left out: at this app's single `min-width: 1024px` wide
// breakpoint (`lib/useWideLayout.ts`), 1920 and 2560 exercise the identical
// wide-layout code path — the interesting extremes are the breakpoint
// itself (`tabletPortrait` 820 vs `tabletLandscape` 1180, straddling 1024)
// and how far the wide layout stretches (3840), not a third point on the
// same side of both.
export const STANDARD_VIEWPORTS = {
  desktop4k: { width: 3840, height: 2160 },
  desktopHd: { width: 1920, height: 1080 },
  tabletLandscape: { width: 1180, height: 820 },
  tabletPortrait: { width: 820, height: 1180 },
  phonePortrait: { width: 390, height: 844 },
} as const satisfies Record<string, Viewport>;

// EDGE_VIEWPORTS: the narrow/short stress cases #368's own residuals were
// actually measured against (clamp-floor short landscape, deep portrait with
// stacked banners, and a viewport narrow enough to force a real 2-line
// wrap). `phonePortrait` above (390x844) already covers the widest of these
// — it is deliberately NOT duplicated here; every entry below is a distinct
// value STANDARD_VIEWPORTS does not already exercise. Kept in a SEPARATE
// object (not merged into STANDARD_VIEWPORTS) so a spec can iterate
// STANDARD, EDGE, or both, and it's obvious from the import alone which
// category a given test belongs to.
export const EDGE_VIEWPORTS = {
  narrowPortrait360: { width: 360, height: 740 },
  shortLandscape844: { width: 844, height: 390 },
  shortLandscape740: { width: 740, height: 360 },
  deepPortrait320: { width: 320, height: 568 },
  partialPushBand375: { width: 375, height: 667 },
  wrapForcing280: { width: 280, height: 568 },
} as const satisfies Record<string, Viewport>;

export interface PreviewServer {
  /** Base URL, e.g. `http://localhost:4173/sail_command/` — pass through `?windFixture=...`. */
  url: string;
  /** SIGKILLs the whole process tree (npm -> vite). Idempotent. */
  kill: () => void;
}

/**
 * Spawns `npm run preview -- --port 4173 --strictPort` in app/ and waits
 * until it answers with a 200, up to 30s. `detached: true` makes the child
 * the leader of its own process group so kill() can take out `npm` *and*
 * the `vite preview` process it launches with one SIGKILL to the negated
 * pid — killing only the `npm` pid can leave `vite preview` (and its bound
 * port) running, which would strand port 4173 for the next spec/run.
 */
export async function startPreview(): Promise<PreviewServer> {
  const child = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
  });

  // Captured rather than thrown immediately: 'error' (e.g. ENOENT if `npm`
  // isn't on PATH) can fire before or after the poll loop starts, and we
  // want it surfaced with useful context either way — see usage below.
  let spawnError: Error | undefined;
  child.on('error', (err) => {
    spawnError = err;
  });

  let killed = false;
  const kill = () => {
    if (killed || !child.pid) return;
    killed = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already dead — fine, kill() is best-effort/idempotent
    }
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(
        `preview server process failed to spawn before answering at ${BASE}: ${spawnError.message}`,
      );
    }
    if (child.exitCode !== null) {
      throw new Error(
        `preview server process exited early (code ${child.exitCode}) before answering at ${BASE}`,
      );
    }
    try {
      const res = await fetch(BASE);
      if (res.ok) return { url: BASE, kill };
    } catch {
      // server not accepting connections yet — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  kill();
  // A captured spawn error (e.g. ENOENT) is the real cause of a timeout here —
  // surface it instead of a bare, misleading "didn't respond in 30s".
  const cause = spawnError ? `: ${spawnError.message}` : '';
  throw new Error(`preview server did not respond at ${BASE} within ${START_TIMEOUT_MS}ms${cause}`);
}

// #253 fix-up: readiness gate for a map that has actually rendered. The app
// deliberately exposes no global map handle (there is no reason for
// production code to), so this reads MapView's `map` state through the React
// fiber instead — test-harness only, and asserted to succeed rather than
// silently skipped: a fiber layout change must fail loudly, not quietly
// delete the strongest assertions built on it.
//
// `waitForLoadState('networkidle')` is always the wrong signal for a map app
// that streams tiles forever (CLAUDE.md's verification-lessons record why),
// and maplibre-gl 6 stopped producing a `requestfinished` Playwright counts
// for its module-worker fetch. `mapReady` waits for the map handle AND for
// `map.loaded()`, which is the only signal that actually proves the tile
// pipeline — and therefore the worker — is alive. Keeping the `map.loaded()`
// half is deliberate: during the maplibre-gl 6 upgrade this gate went red for
// a REAL product bug (the worker chunk shipped with an unresolved
// `./maplibre-gl-shared.mjs` import and 404'd on its own dependency, so no
// vector/GeoJSON source ever loaded) — the gate was correctly reporting a
// broken map. That bug is fixed at source (MapView.tsx's `?worker&url`
// import); this gate is what keeps that fix honest, so do not weaken it back
// to "the handle exists" — that would pass against a map rendering nothing
// at all. It reads `map.loaded()` rather than a fiber-existence check for the
// same reason, and returns a descriptive STRING rather than a boolean on
// purpose: a boolean collapsed into `.toBe(true)` can only ever report
// `Expected: true / Received: false` plus a timeout, indistinguishable
// between "slow" and "never" — the string names the pending sources, so a CI
// failure says which part of the pipeline stalled.
//
// Promoted here from THREE independent copies (`datalayers.spec.ts`,
// `compass.spec.ts`, `layout.spec.ts` — each written "duplicated rather than
// imported... worth promoting to helpers.ts in a follow-up" and then never
// promoted) per CLAUDE.md's enumerate-don't-patch rule: a comment pointing at
// a follow-up is not a tracker, and a fourth divergent copy is exactly the
// shape that rule warns against letting recur. Only `mapReady` is exported —
// `installMapHandle`/`mapReadyState` are call-site-internal to it, and no
// spec has ever called them directly.
async function installMapHandle(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('.maplibregl-map');
    if (!el) return false;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return false;
    let f = (el as unknown as Record<string, { memoizedState?: unknown; return?: unknown }>)[key];
    while (f) {
      let h = f.memoizedState as { memoizedState?: unknown; next?: unknown } | undefined;
      let guard = 0;
      while (h && guard++ < 60) {
        const v = h.memoizedState as { getBearing?: unknown; project?: unknown } | undefined;
        if (v && typeof v.getBearing === 'function' && typeof v.project === 'function') {
          (window as unknown as Record<string, unknown>).__scE2eMap = v;
          return true;
        }
        h = h.next as typeof h;
      }
      f = f.return as typeof f;
    }
    return false;
  });
}

type ReadyMap = {
  loaded: () => boolean;
  getStyle: () => { sources: Record<string, unknown> };
  isSourceLoaded: (id: string) => boolean;
};

async function mapReadyState(page: Page): Promise<string> {
  if (!(await installMapHandle(page))) return 'no-map-handle';
  return page.evaluate(() => {
    const map = (window as unknown as { __scE2eMap?: ReadyMap }).__scE2eMap;
    if (!map) return 'handle-lost';
    if (!map.loaded()) {
      const pending = Object.keys(map.getStyle().sources).filter((id) => !map.isSourceLoaded(id));
      return `not-loaded (pending sources: ${pending.join(', ') || 'none — style still parsing'})`;
    }
    return 'loaded';
  });
}

/** Gate a spec on a map that has actually rendered, reporting WHY if it hasn't. */
export async function mapReady(page: Page): Promise<void> {
  await expect.poll(() => mapReadyState(page), { timeout: 60_000 }).toBe('loaded');
}
