# Architecture Decision Records

This directory holds SailCommand's ADRs — short records of a maintainer
decision that is settled and worth keeping, so it doesn't get silently
re-litigated by a future session that never saw the original evidence.

## Filename convention

`NNNN-slug.md`, numbered sequentially starting at `0001`. The number is
permanent once assigned; a superseding decision gets its own new number
rather than reusing or renumbering the old one.

## Status vocabulary

- **Proposed** — written but not yet ruled on.
- **Accepted** — the maintainer's ruling; in effect.
- **Superseded** — replaced by a later ADR, which is named in this one's
  `## Revisiting this` section (or a note added at the top pointing to the
  successor).

## Index

- [0001-keep-native-datetime-input.md](0001-keep-native-datetime-input.md) —
  Keep the native `datetime-local` input for departure entry.
- [0002-pre-1.0-db-migration-low-priority.md](0002-pre-1.0-db-migration-low-priority.md) —
  Pre-1.0.0, local-DB migration is low priority.

This index lists ADRs only — see "Two decision-record locations" below for
`docs/spikes/`.

## Two decision-record locations — read both

This repo also has [`docs/spikes/`](../spikes/README.md), which predates this
directory and holds one investigation-and-decision document per issue that
was investigated before (or instead of) being built, named
`<issue>-<slug>.md`. **#644 (2026-09-09) settled the convention between the
two rather than merging them: a spike is an *investigation* — evidence,
often with measurements that stay citable, that ends in a recommendation; an
ADR is the record of a *ruling* already made**, usually without the
investigative apparatus behind it. Several existing spikes are genuinely
both — an investigation whose own recommendation the maintainer then
accepted as the ruling — and that overlap was left as-is: the distinction
governs where a NEW document goes, not a retroactive split of the 22 spikes
already on record. No existing document moved. Check both directories before
assuming a decision hasn't been recorded anywhere; `docs/spikes/README.md`
indexes the spike side.
