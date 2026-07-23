// #107: build-time environment flag, replaced by the `define` entry in
// vite.config.ts — `true` only in a UAT deploy build (SC_DEPLOY_ENV=uat,
// the same switch #96's subPathMeta uses). Always gate UAT-only UI at the
// IMPORT SITE on this constant, via the fold-exact `__SC_UAT__ ? … :
// t('app.title')` ternary in App.tsx's h1 title slot (see the comment there
// — a `__SC_UAT__ && <UatBadge />` child gate instead leaves a minified `!1`
// residue), so a production build dead-code-eliminates the whole module
// graph behind it — the prod bundle must stay byte-identical to a pre-change
// build (#96 guarantee, re-verified in #107). Vitest resolves the same vite
// config, so
// the constant is defined (`false`) in unit tests too (pinned in
// UatBadge.test.tsx).
declare const __SC_UAT__: boolean;

// #125: build-time app version, replaced by the `define` entry in
// vite.config.ts — `git describe --tags --always` output in a build (package
// version if git is unavailable), the literal 'dev' under the dev server and
// Vitest (both resolve the config with command 'serve'). Baked into the
// bundle so the About dialog can identify a stale-service-worker install;
// never fetch it at runtime. Plain string interpolation — the fold-exact
// ternary rule above is specific to the UAT gate and does not apply here.
declare const __SC_APP_VERSION__: string;
