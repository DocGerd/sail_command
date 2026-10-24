# ADR-0003: Open Alssund with a charted-channel override

## Status

Accepted — 2026-10-24. Ruling recorded on
[#1875](https://github.com/DocGerd/sail_command/issues/1875#issuecomment-6389673404).

## Context

A plan from Als Fjord to Sønderborg went around Als (#1875). Alssund is OSM
water and the EMODnet DTM has a deep channel through it, but that channel is
one source pixel wide and joins its neighbours only diagonally. Where
bilinear and max-resampled depths disagree by more than `TOLERANCE_M`,
`build_mask.py`'s blend keeps the conservative max reading, so the channel
cells read 0 m or a few decimetres and four barriers close the sound at
every catalogue gate.

## Decision

Raise the mask along the Sønderborg fairway to a depth taken from a cited
nautical source, through a hand-authored `pipeline/charted-channels.json`
that `build_mask.py` reads. The override:

- only raises, never lowers;
- touches only centreline cells inside the source's own extent;
- fails the build if any centreline cell is OSM land, which means the
  centreline is wrong.

The Alssund entry takes 6.0 m from Den danske Havnelods' Sønderborg Havn
harbour plan. The page's depth section defers to that plan, so the figure is
the plan's 6 m contour, read off the image; the entry records how.

## Consequences

- Every edit to `charted-channels.json` changes `mask.bin` and owes the #282
  sweep.
- An overridden cell's depth comes from a chart, not from the DTM.
  `mask.meta.json` still names only EMODnet and OSM.
- `verify_mask.py` now fails if Sønderborg cannot reach Als Fjord inside
  9.55-9.86 E at any catalogue gate, so the sound cannot close again
  silently.
- The mask does not model the bridge's opening times or closures.

## Considered and rejected

From the measurements on #1875:

- **Raising `TOLERANCE_M`.** It opens the sound at 3.0 m only from 12.14 m,
  which makes 4,751 cells navigable below the 2.1 m draft.
- **A share-threshold max.** It leaves the southern barrier closed.
- **Diagonal bridging.** It asserts depth at a corner the DTM reads as
  about 0 m.

## Revisiting this

Revisit if a finer bathymetry source resolves the channel, or if a second
override is proposed: each one is a hand-maintained depth that no rebuild
re-checks against its source.
