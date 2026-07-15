import '@testing-library/jest-dom/vitest';

// jsdom has no real 2D canvas backend. Without this, every
// HTMLCanvasElement.getContext('2d') call (e.g. RouteLayer mounting inside
// App.test.tsx, which registers wind-barb icons via windBarbs.ts) logs a
// noisy "Not implemented" warning even though the calling code already
// treats a null context as the expected, handled case (registerBarbImages's
// `if (!ctx) continue;`). Stub it to return null quietly instead.
HTMLCanvasElement.prototype.getContext = (() => null) as HTMLCanvasElement['getContext'];
