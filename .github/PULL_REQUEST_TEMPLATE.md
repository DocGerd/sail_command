<!--
  SailCommand PR checklist — mirrors the merge ritual in CLAUDE.md.
  Feature PRs target `develop`, never `main`.
-->

## Summary

<!-- What does this PR change, and why? Keep it short. -->

Closes #

## Checklist

- [ ] **Closes an issue** — the `Closes #<n>` line above references every issue this resolves.
- [ ] **CHANGELOG** — added an `[Unreleased]` entry if this changes user-visible behavior (Keep a Changelog 1.1).
- [ ] **i18n** — every new UI string added to BOTH the `de` and `en` dicts (key parity is type-enforced).
- [ ] **Lint & typecheck** — `npm --prefix app run lint` and `npm --prefix app run typecheck` pass.
- [ ] **Tests** — `npm --prefix app run test` passes (plus `e2e` where behavior, map rendering, or offline/PWA flows changed); new or changed behavior has tests.
- [ ] **Self-review** — ran the per-PR reviewer pass and resolved every inline review thread.
- [ ] **Spec** — this PR does NOT silently deviate from `docs/superpowers/specs/`; if it intentionally touches a spec, note it below.

## Verification evidence

<!--
  Paste summarized command output (lint / typecheck / test) and, for
  UI / routing / PWA changes, a note on the real-browser or e2e pass.
  Claims without evidence do not count as done.
-->

## Spec touched?

<!-- If this changes design-level behavior, link the spec section and say what changed. Otherwise: "none". -->
