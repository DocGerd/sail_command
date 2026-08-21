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

## Two decision-record locations — read both

This repo also has `docs/spikes/`, which predates this directory and holds
one investigation-and-decision document per issue that was investigated but
not built (or built after a design detour), named `<issue>-<slug>.md`. An
ADR here is not a replacement for a spike: a spike is an *investigation* that
ends in a recommendation; an ADR is the record of a *ruling* already made.
**#644 tracks consolidating the two locations** — until that lands, check
both directories before assuming a decision hasn't been recorded anywhere.
