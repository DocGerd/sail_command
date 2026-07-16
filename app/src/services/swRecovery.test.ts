import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// swRecovery keeps its "map errored while uncontrolled" flag and its
// armed-once guard at module scope, so every test re-imports a fresh module
// instance (vi.resetModules + dynamic import) instead of sharing state.

class FakeSwContainer extends EventTarget {
  controller: object | null = null;
}

function stubSw(controlled: boolean): FakeSwContainer {
  const sw = new FakeSwContainer();
  if (controlled) sw.controller = {};
  vi.stubGlobal('navigator', { serviceWorker: sw });
  return sw;
}

async function loadModule() {
  vi.resetModules();
  return await import('./swRecovery');
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('initSwRecovery (#27 one-shot recovery)', () => {
  it('reloads exactly once when MapLibre errored while uncontrolled and the SW then claims', async () => {
    const sw = stubSw(false);
    const { initSwRecovery, noteMapError } = await loadModule();
    const reload = vi.fn();

    initSwRecovery(reload);
    noteMapError(); // tile error while navigator.serviceWorker.controller === null
    sw.controller = {}; // SW claims…
    sw.dispatchEvent(new Event('controllerchange')); // …and the page learns of it

    expect(reload).toHaveBeenCalledTimes(1);
    // Guard is set BEFORE reloading so the next page load can never loop.
    expect(sessionStorage.getItem('sailcommand-sw-recovery-reloaded')).toBe('1');

    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never fires when the page was already controlled at load', async () => {
    const sw = stubSw(true);
    const { initSwRecovery, noteMapError } = await loadModule();
    const reload = vi.fn();

    initSwRecovery(reload);
    noteMapError(); // controlled-page errors are not the #27 failure mode
    sw.dispatchEvent(new Event('controllerchange')); // e.g. a SKIP_WAITING update

    expect(reload).not.toHaveBeenCalled();
  });

  it('disarms for good after an error-free first controllerchange', async () => {
    const sw = stubSw(false);
    const { initSwRecovery, noteMapError } = await loadModule();
    const reload = vi.fn();

    initSwRecovery(reload);
    sw.dispatchEvent(new Event('controllerchange')); // clean claim, nothing to recover

    expect(reload).not.toHaveBeenCalled();

    // Later errors + another controllerchange must not resurrect it: the
    // recovery only ever targets the FIRST claim.
    sw.controller = null;
    noteMapError();
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('records nothing for errors that happen after the SW took control', async () => {
    const sw = stubSw(false);
    const { initSwRecovery, noteMapError } = await loadModule();
    const reload = vi.fn();

    initSwRecovery(reload);
    sw.controller = {}; // claim happened before any error…
    noteMapError(); // …so this error is SW-served territory, not #27's
    sw.dispatchEvent(new Event('controllerchange'));

    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload again when the sessionStorage guard is already set', async () => {
    sessionStorage.setItem('sailcommand-sw-recovery-reloaded', '1');
    const sw = stubSw(false);
    const { initSwRecovery, noteMapError } = await loadModule();
    const reload = vi.fn();

    initSwRecovery(reload);
    noteMapError();
    sw.dispatchEvent(new Event('controllerchange'));

    expect(reload).not.toHaveBeenCalled();
  });

  it('never reloads when sessionStorage is unavailable (no working loop guard)', async () => {
    const sw = stubSw(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const { initSwRecovery, noteMapError } = await loadModule();
    const reload = vi.fn();

    initSwRecovery(reload);
    noteMapError();
    sw.dispatchEvent(new Event('controllerchange'));

    expect(reload).not.toHaveBeenCalled();
  });

  it('arming is idempotent — a second init never adds a second listener', async () => {
    const sw = stubSw(false);
    const { initSwRecovery, noteMapError } = await loadModule();
    const reload = vi.fn();

    initSwRecovery(reload);
    initSwRecovery(reload);
    noteMapError();
    sw.dispatchEvent(new Event('controllerchange'));

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
