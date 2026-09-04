import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { connect } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreview, assertCleanServiceWorkerState } from './helpers';

// #803: startPreview() used to return as soon as ANY 200 answered its
// readiness poll on port 4173, with no check that the responder was its own
// spawned child or that it was serving this run's own build. This spec
// pins BOTH directions of the fix so a future edit that reintroduces the
// bug (or weakens the check into a no-op) reds loudly instead of silently:
// a decoy already bound to the port must make startPreview() REFUSE, a
// LOCAL build that fails its own shape validation must never even reach a
// spawn, and the ordinary path (no foreign server, a real `dist/` on disk
// from this run's own `pree2e` build) must still succeed.
//
// `workers: 1` / `fullyParallel: false` (playwright.config.ts) makes this
// safe to run alongside every other spec in the suite: tests execute
// strictly serially, so nothing else is contending for port 4173 while
// this spec's decoy holds it, and no other spec observes the local
// `dist/index.html` mutations below (each is written, exercised, and
// restored inside ONE test, synchronously before that test resolves).

const PORT = 4173;
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_INDEX_HTML = resolve(APP_DIR, 'dist', 'index.html');
const DIST_SW_JS = resolve(APP_DIR, 'dist', 'sw.js');

type DecoyHandler = (req: IncomingMessage, res: ServerResponse) => void;

const blanketDecoyHandler: DecoyHandler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head></head><body>decoy - not the real app</body></html>');
};

function startDecoyServer(
  port: number,
  handler: DecoyHandler = blanketDecoyHandler,
): Promise<Server> {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer(handler);
    server.on('error', rejectServer);
    server.listen(port, '127.0.0.1', () => resolveServer(server));
  });
}

function stopDecoyServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

// #803 MAJOR 2 (PR #823 review): `expect(startPreview()).rejects...` alone
// DISCARDS a resolved `PreviewServer` if the identity check ever regresses
// into a no-op. That resolved value's `kill()` targets the process THIS
// call spawned — discarding it orphans that process once whatever occupied
// the port at test start goes away and frees it for the orphan to bind
// late (reproduced by the reviewer: a real `vite preview` bound to 4173
// and outlived the run). Every "expect this to reject" assertion in this
// file goes through this helper so a resolution — expected or a
// regression — is always captured and killed BEFORE anything can fail the
// assertion and end the test.
function expectStartPreviewToReject(matcher: RegExp): Promise<void> {
  const started = startPreview().then((s) => {
    s.kill();
    throw new Error(`startPreview() unexpectedly resolved (url: ${s.url}) — expected it to reject`);
  });
  return expect(started).rejects.toThrow(matcher);
}

/** #803 MAJOR 2: is anything accepting a TCP connection on 127.0.0.1:PORT
 * right now? A raw connect probe, not `fetch`, so it also catches a bound
 * socket that never answers HTTP — the actual, functional hazard a
 * discarded resolved handle produces (a stuck port poisoning every later
 * spec/run, per CLAUDE.md's "e2e's preview port is fixed" note). */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolveListening) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolveListening(true);
    });
    socket.once('error', () => resolveListening(false));
  });
}

/** #803 MAJOR 2: process-table half of the same check — a killed listener
 * and a killed PROCESS are different facts. Matches on the exact spawn
 * arguments (`--port 4173 --strictPort`, from `helpers.ts`'s `spawn(...)`
 * call) AND this worktree's own `APP_DIR` path — matching the arguments
 * ALONE is measurably NOT worktree-specific: every worktree's `vite
 * preview` is invoked with the identical arguments (only the binary's
 * absolute path differs), so an unrelated worktree's leaked preview on
 * this shared machine satisfied the args-only filter and redded this
 * test on 5/5 consecutive runs, going green immediately once that
 * process was killed (PR #823 review). Filters `ps`'s own output in JS
 * rather than passing the pattern to `pgrep -f`/`grep -f`, which would
 * self-match its own invocation (CLAUDE.md's documented pgrep gotcha: the
 * pattern string ends up in the matching tool's OWN argv). */
function findOwnPreviewProcesses(): string[] {
  let out: string;
  try {
    out = execSync('ps -eo pid,args', { encoding: 'utf8' });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter((line) => line.includes(`--port ${PORT} --strictPort`) && line.includes(APP_DIR));
}

test('#803: refuses a foreign server already bound to the preview port, and leaves nothing running', async () => {
  const decoy = await startDecoyServer(PORT);
  try {
    await expectStartPreviewToReject(/#803/);
  } finally {
    await stopDecoyServer(decoy);
  }

  // Prove the teardown rather than just asserting the throw: the decoy is
  // closed above, so nothing legitimate should still be listening or
  // running — a real `expect.poll`, not a bare check, since SIGKILL
  // delivery and socket release are not perfectly synchronous with the
  // call that issues them.
  await expect.poll(() => isPortListening(PORT), { timeout: 5_000 }).toBe(false);
  await expect.poll(() => findOwnPreviewProcesses().length, { timeout: 5_000 }).toBe(0);
});

// #803 MAJOR 1 (PR #823 review): a decoy whose `index.html` is
// byte-identical to this run's own build — but whose `sw.js` differs —
// RESOLVED before this fix (measured: "row 11" of the reviewer's
// fail-closed enumeration). Discovered while re-deriving this file's own
// mutation table for the MINOR 1 fix above: the OTHER three tests in this
// file cannot pin `assertSwJsMatches` at all — the blanket decoy above is
// already caught by the earlier `assertServingThisBuild` check before the
// `sw.js` fetch is ever reached, so deleting `assertSwJsMatches` entirely
// (or making it a no-op) left every existing test green. This is the one
// committed test that actually exercises it.
test('#803 MAJOR 1: refuses a server whose index.html matches but whose sw.js does not', async () => {
  const indexHtml = readFileSync(DIST_INDEX_HTML, 'utf8');
  const decoy = await startDecoyServer(PORT, (req, res) => {
    if (req.url?.endsWith('/sw.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('// not the real sw.js');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(indexHtml);
  });
  try {
    await expectStartPreviewToReject(/service worker doesn't byte-match/);
  } finally {
    await stopDecoyServer(decoy);
  }
  await expect.poll(() => isPortListening(PORT), { timeout: 5_000 }).toBe(false);
  await expect.poll(() => findOwnPreviewProcesses().length, { timeout: 5_000 }).toBe(0);
});

// #803 MAJOR (round 2, PR #823 review): the MIRROR of the test above —
// `assertServingThisBuild` was found UNPINNED after the MAJOR 1 fix landed.
// `dist/sw.js`'s workbox precache manifest carries `index.html`'s own MD5
// revision, so for any COHERENT build the two checks AGREE — meaning the
// blanket decoy above (identical body on every path) makes
// `assertSwJsMatches` throw whenever `assertServingThisBuild` would have,
// masking the FIRST check's deletion entirely (deleting the call, or making
// its byte-compare always-true, left every test in this file green).
// Discriminating input, an INCOHERENT responder where the two artifacts do
// NOT move together (a proxy, a hand-assembled dist): the REAL `sw.js` with
// a one-byte-wrong `index.html`. The matcher targets `assertServingThisBuild`'s
// own diagnostic text ("expected entry chunk"), which never appears in
// `assertSwJsMatches`'s message — a tightened T1 matcher was considered and
// rejected in favour of this test, per the review: brittle to distinguish
// two `#803`-prefixed messages, where a dedicated test states the property
// directly.
test('#803 MAJOR: refuses a server whose sw.js matches but whose index.html does not', async () => {
  const indexHtml = readFileSync(DIST_INDEX_HTML, 'utf8');
  const swJs = readFileSync(DIST_SW_JS, 'utf8');
  const mutatedIndexHtml = indexHtml.replace(
    '<title>SailCommand</title>',
    '<title>SailCommand!</title>',
  );
  // Sanity: the mutation actually matched something in the real build.
  expect(mutatedIndexHtml).not.toBe(indexHtml);
  const decoy = await startDecoyServer(PORT, (req, res) => {
    if (req.url?.endsWith('/sw.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(swJs);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(mutatedIndexHtml);
  });
  try {
    await expectStartPreviewToReject(/expected entry chunk/);
  } finally {
    await stopDecoyServer(decoy);
  }
  await expect.poll(() => isPortListening(PORT), { timeout: 5_000 }).toBe(false);
  await expect.poll(() => findOwnPreviewProcesses().length, { timeout: 5_000 }).toBe(0);
});

// #803 MINOR 1 (PR #823 review): the hashed-asset shape check inside
// `extractEntryScriptSrc` and the pre-spawn `extractEntryScriptSrc(localHtml,
// …)` call in `startPreview()` were both unpinned — deleting either left
// this file's mutation table green. ONE local malformation discriminates
// BOTH, and the reason is structural, not incidental: `assertServingThisBuild`
// short-circuits on byte EQUALITY, and a real `vite preview` serves
// `dist/index.html` verbatim regardless of whether its referenced script
// path is a real built asset — so a malformed-but-INTERNALLY-CONSISTENT
// local file is invisible to the served-vs-local comparison. Only the
// PRE-SPAWN shape check (both halves) can ever catch it.
test('#803 MINOR 1: refuses a local dist/index.html whose entry src is not a hashed asset', async () => {
  const original = readFileSync(DIST_INDEX_HTML, 'utf8');
  const mutated = original.replace(
    /(<script[^>]*\stype="module"[^>]*\ssrc=")[^"]+("[^>]*>)/,
    '$1/src/main.tsx$2',
  );
  // Sanity: the replace actually matched something, and produced the
  // expected content — an unreachable mutation is zero evidence
  // (CLAUDE.md's mutation-vacuity lessons).
  expect(mutated).not.toBe(original);
  expect(mutated).toContain('src="/src/main.tsx"');
  writeFileSync(DIST_INDEX_HTML, mutated, 'utf8');
  try {
    await expectStartPreviewToReject(/doesn't look like a hashed built asset/);
  } finally {
    writeFileSync(DIST_INDEX_HTML, original, 'utf8');
  }
});

test('#803 MINOR 1: refuses a local dist/index.html with no module script tag at all', async () => {
  const original = readFileSync(DIST_INDEX_HTML, 'utf8');
  // Disable the attribute value rather than stripping the element — same
  // effect on extractEntryScriptSrc's regex (no `type="module"` left to
  // match) without a tag-removal shape CodeQL flags as incomplete
  // multi-character sanitization (js/incomplete-multi-character-sanitization,
  // alert 22 — this string is never rendered, but the rewrite avoids the
  // finding rather than justifying a dismissal).
  const mutated = original.replace('type="module"', 'type="module-DISABLED"');
  expect(mutated).not.toBe(original);
  expect(mutated).not.toContain('type="module"');
  writeFileSync(DIST_INDEX_HTML, mutated, 'utf8');
  try {
    await expectStartPreviewToReject(/no <script type="module"/);
  } finally {
    writeFileSync(DIST_INDEX_HTML, original, 'utf8');
  }
});

test('#803: still starts normally against its own build with no foreign server', async () => {
  const server = await startPreview();
  try {
    expect(server.url).toBe(`http://localhost:${PORT}/sail_command/`);
    const res = await fetch(server.url);
    expect(res.ok).toBe(true);
  } finally {
    server.kill();
  }
});

// #832: this is the "demonstrate the guard has teeth" experiment, kept as a
// permanent regression pin rather than a one-off manual check — it
// constructs the EXACT failure `assertCleanServiceWorkerState` defends
// against (a registration + a cache already present on this origin, as a
// stale/foreign build would leave behind) and shows the guard actually
// clearing both, not merely reporting success. A version of this guard that
// silently no-oped (e.g. `getRegistrations()` returning early, or a
// swallowed `unregister()` rejection) would either THROW (asserted via
// `resolves` below — an unhandled rejection reds the test) or, if it also
// stopped throwing, would return non-zero `remainingRegs`/`remainingCaches`
// — asserted directly against the function's OWN atomic in-page query,
// never via a SEPARATE later `page.evaluate()`: this app's real bootstrap
// legitimately re-registers its own honest service worker and starts glyph
// warm-up (CLAUDE.md's #28 bullet) moments after `assertCleanServiceWorkerState`'s
// own internal `page.goto(BASE)` reloads it, so a later independent check
// would race that expected app behaviour rather than test this guard.
test('#832: assertCleanServiceWorkerState clears a pre-existing registration and cache before the first real navigation', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);
    // Register this build's own sw.js (any registration on this origin
    // demonstrates the guard — it doesn't need to be a FOREIGN build's
    // worker to prove the clear step works) plus a synthetic cache entry,
    // and confirm the browser genuinely holds both before testing the clear
    // — a positive control, per CLAUDE.md's "give any probe whose emptiness
    // you intend to interpret a positive control" rule.
    const before = await page.evaluate(async () => {
      await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      const cache = await caches.open('sc-e2e-832-probe');
      await cache.put('/probe', new Response('probe'));
      return {
        regs: (await navigator.serviceWorker.getRegistrations()).length,
        caches: (await caches.keys()).length,
      };
    });
    expect(before.regs).toBeGreaterThan(0);
    expect(before.caches).toBeGreaterThan(0);

    // The guard under test — asserts on its OWN return, the exact counts
    // it used to decide whether to throw.
    const result = await assertCleanServiceWorkerState(page);
    expect(result.unregisteredCount).toBeGreaterThan(0);
    expect(result.deletedCacheCount).toBeGreaterThan(0);
    expect(result.remainingRegs).toBe(0);
    expect(result.remainingCaches).toBe(0);
  } finally {
    server.kill();
  }
});
