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

The ruling's wording is "only on cells that OSM land does not cover"; the
extent limit and failing on a land cell are this ADR's refinements of it.

The Alssund entry takes 6.0 m from Den danske Havnelods' Sønderborg Havn
harbour plan. The page's depth section defers to that plan, so the figure is
the plan's 6 m contour, read off the image; the entry records how.

## Consequences

- Editing a depth, a centreline or a `sourceExtent` in `charted-channels.json`
  changes `mask.bin` once rebuilt and owes the #282 sweep; `closure.mjs`
  reports any edit to the file as owed.
- An overridden cell's depth comes from a chart, not from the DTM, so the
  `TOLERANCE_M` bound between the shipped and the cautious DTM reading (#455),
  and the cautious lower bound built on it (#493), do not hold on those cells.
  `mask.meta.json` credits the Havnelods plan in its `sources`.
- `verify_mask.py` now fails if, at any catalogue gate, Sønderborg cannot
  reach Als Fjord inside 9.55-9.86 E. It runs in the advisory
  `Mask integrity` job, not a required check.
- The mask does not model the bridge's opening times or closures.
- Plans leaving Sønderborg northwards can still go around Als (#1879).
- Sønderborg's approach note now states the bridge's announced closure. #1880
  removes that dated clause; #1881 is a route-level bridge notice.

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
