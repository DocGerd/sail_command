# Investigation spikes

This directory holds one investigation-and-decision document per issue that
was investigated before (or instead of) being built, named
`<issue>-<slug>.md`. Each records a verdict plus an explicit
considered-and-rejected section, so a declined option cannot quietly come
back as a fresh idea. Deliberately NOT under `docs/superpowers/specs/`: that
path is guarded by a main-session ask-gate hook, and a subagent writing there
would slip a spec edit past the gate — a spike doc is evidence for a
decision, never a spec.

## Spike vs. ADR — read both directories

[`docs/adr/`](../adr/README.md) holds this repo's Architecture Decision
Records: numbered, and each one records a *ruling* already made, usually
without the investigative apparatus behind it. This directory holds
*investigations* — evidence, often with measurements that stay citable, that
end in a recommendation. Several spikes here carry both: an investigation
whose own recommendation the maintainer then accepted as the ruling. That
overlap is not a defect to clean up — #644 (2026-09-09) settled the
convention above rather than merging the two directories or retroactively
reclassifying existing documents; it governs where a NEW document goes.
Check `docs/adr/README.md`'s index too — a decision may be recorded there
instead of here.

## Index

- [243-depth-comfort-margin.md](243-depth-comfort-margin.md) — #243: routing
  crosses shallow water when a deeper route was free.
- [244-buoyed-fairways.md](244-buoyed-fairways.md) — #244: when must routing
  honour buoyed fairways? (declined; paired with #245)
- [245-depth-mask-resolution.md](245-depth-mask-resolution.md) — #245:
  depth-mask resolution vs. payload (grid refinement declined; paired with
  #244)
- [296-lazy-load-map-data.md](296-lazy-load-map-data.md) — lazy-load map
  data during planning, with guaranteed offline trip coverage
- [354-mode-churn.md](354-mode-churn.md) — #354: motor↔sail mode churn costs
  the solver nothing (deferred to Backlog, 2026-09-02; supporting artifacts
  in `354-mode-churn/`)
- [391-maplibre-gesture-during-ease.md](391-maplibre-gesture-during-ease.md)
  — #391: a gesture begun during an in-flight MapLibre ease is silently
  discarded (accepted, not fixed)
- [435-pwa-logging-diagnostics.md](435-pwa-logging-diagnostics.md) —
  logging and diagnostics in a backend-less, offline-capable PWA with three
  execution contexts
- [444-claude-md-and-automation.md](444-claude-md-and-automation.md) — is
  `CLAUDE.md` still serving its purpose at its size, and is the accumulated
  Claude Code automation the right set?
- [446-architecture-fit.md](446-architecture-fit.md) — does the architecture
  still fit? — layering, `App.tsx` concentration, prose-only invariants
- [452-local-depth-relaxation.md](452-local-depth-relaxation.md) — #452:
  local depth-gate relaxation design
- [452-p3-implementation-record.md](452-p3-implementation-record.md) — #452
  P3: approach-scoped depth relaxation, as implemented
- [455-depth-mask-optimism.md](455-depth-mask-optimism.md) — #455: the
  depth mask reads deeper than its own conservative option
- [615-seamark-proximity.md](615-seamark-proximity.md) — #615: advisory
  seamark-proximity notice (#495 option 2, shipped MVP)
- [702-sticky-cta-narrow.md](702-sticky-cta-narrow.md) — #702: sticky
  "Route planen" CTA on narrow viewports (superseded 2026-09-01 by PR #800 /
  attempt 4)
- [714-keyboard-map-equivalents.md](714-keyboard-map-equivalents.md) —
  #714: keyboard equivalents for map-only interactions
- [742-boat-tab-scope-separation.md](742-boat-tab-scope-separation.md) —
  the Boat tab conflates boat selection, boat-scoped settings and global
  app settings
- [744-safety-depth-field-row.md](744-safety-depth-field-row.md) — #744:
  safety-depth field row — orphaned unit wrap and label baseline mismatch
- [749-live-view-demo-mode.md](749-live-view-demo-mode.md) — a demo mode
  for the Live view — user-facing, UAT-only, or declined?
- [847-weave-eta-cost.md](847-weave-eta-cost.md) — #847: slight course
  corrections every 2-3 minutes — ETA cost measurement
- [1022-whole-journey-ux.md](1022-whole-journey-ux.md) — #1022: the whole
  client journey, as a design exercise (reference screenshots in
  `1022-whole-journey-ux/`)
- [1025-claude-md-split.md](1025-claude-md-split.md) — #1025: what belongs
  in tracked `CLAUDE.md` vs. the maintainer's own setup (folds in #471)
- [1092-claude-md-lazy-loading.md](1092-claude-md-lazy-loading.md) —
  #1092: would splitting `CLAUDE.md` into lazily-loaded files pay?
- [1163-295-coverage-scoping.md](1163-295-coverage-scoping.md) — #1163:
  scoping the #295 coverage extension (Kolding/Middelfart/Fehmarn) — coupled
  sites, payload, wind-lattice safety, Great Belt, #1164 dependency

Two entries carry a same-named subdirectory of supporting artifacts rather
than being self-contained: `1022-whole-journey-ux/` (reference screenshots)
and `354-mode-churn/` (the reproduction test file and its measured output).
