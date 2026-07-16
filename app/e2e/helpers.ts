// Shared preview-server lifecycle for E2E specs. No Playwright `webServer`
// config (see playwright.config.ts's comment) — each spec calls
// startPreview() itself and is responsible for kill()ing it, because
// offline.spec.ts needs to kill the server mid-test while plan.spec.ts
// keeps it alive for the whole run.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const PORT = 4173;
const BASE = `http://localhost:${PORT}/sail_command/`;
const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 300;

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
      throw new Error(`preview server process failed to spawn before answering at ${BASE}: ${spawnError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`preview server process exited early (code ${child.exitCode}) before answering at ${BASE}`);
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
