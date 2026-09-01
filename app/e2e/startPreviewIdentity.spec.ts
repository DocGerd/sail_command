import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { startPreview } from './helpers';

// #803: startPreview() used to return as soon as ANY 200 answered its
// readiness poll on port 4173, with no check that the responder was its own
// spawned child or that it was serving this run's own build. This spec
// pins BOTH directions of the fix so a future edit that reintroduces the
// bug (or weakens the check into a no-op) reds loudly instead of silently:
// a decoy already bound to the port must make startPreview() REFUSE, and
// the ordinary path (no foreign server, a real `dist/` on disk from this
// run's own `pree2e` build) must still succeed.
//
// `workers: 1` / `fullyParallel: false` (playwright.config.ts) makes this
// safe to run alongside every other spec in the suite: tests execute
// strictly serially, so nothing else is contending for port 4173 while
// this spec's decoy holds it.

const PORT = 4173;

function startDecoyServer(port: number): Promise<Server> {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head></head><body>decoy - not the real app</body></html>');
    });
    server.on('error', rejectServer);
    server.listen(port, '127.0.0.1', () => resolveServer(server));
  });
}

function stopDecoyServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

test('#803: refuses a foreign server already bound to the preview port', async () => {
  const decoy = await startDecoyServer(PORT);
  try {
    await expect(startPreview()).rejects.toThrow(/#803/);
  } finally {
    await stopDecoyServer(decoy);
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
