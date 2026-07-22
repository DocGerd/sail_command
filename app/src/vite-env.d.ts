// #107: build-time environment flag, replaced by the `define` entry in
// vite.config.ts — `true` only in a UAT deploy build (SC_DEPLOY_ENV=uat,
// the same switch #96's subPathMeta uses). Always gate UAT-only UI at the
// IMPORT SITE on this constant (`__SC_UAT__ && <UatBadge />` in App.tsx) so
// a production build dead-code-eliminates the whole module graph behind it —
// the prod bundle must stay byte-identical to a pre-change build (#96
// guarantee, re-verified in #107). Vitest resolves the same vite config, so
// the constant is defined (`false`) in unit tests too (pinned in
// UatBadge.test.tsx).
declare const __SC_UAT__: boolean;
