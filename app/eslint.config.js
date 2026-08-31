import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { globalIgnores } from 'eslint/config';

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  // #602: `app/sweep/**` is the #282 acceptance harness — Node-side tooling
  // that runs under plain Node or vitest's own `sweep/vitest.config.ts`,
  // never in the browser bundle. Its `.ts` files (sweepArms.ts, armNames.ts,
  // arm-*.test.ts) already match the `**/*.{ts,tsx}` block above; this block
  // adds the two `.mjs` scripts (compare.mjs, tripRate.mjs — plain Node ESM,
  // not a Vite/browser module) with `globals.node` instead of
  // `globals.browser`, since they read `process.argv`/call `process.exit`
  // directly. Before this block, ESLint's flat-config default (no rules for
  // a file matching no `files` glob) meant these two files were parsed by
  // NOTHING — CodeQL was the only reader (alert #19, fixed in `d7daaa9`,
  // found only because a scheduled non-diff-scoped run happened to look).
  {
    files: ['sweep/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // canonicalize.mjs deliberately destructures fields ONLY to omit them
      // from a `...rest` spread (e.g. `const { genoa, fock, sails: _sails,
      // ...rest } = plan`) — the destructured names are never read, by
      // design, and the file already marks that with a leading underscore
      // on two of them (`_sails`, `_rr`). Base `no-unused-vars` doesn't know
      // that convention on its own; `ignoreRestSiblings` is ESLint's own
      // named option for precisely this "destructure to exclude from rest"
      // shape, so this fixes real lint errors without renaming anything or
      // touching canonicalize.mjs's behaviour at all.
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
]);
