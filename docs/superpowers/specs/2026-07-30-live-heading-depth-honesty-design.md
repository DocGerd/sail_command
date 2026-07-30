# Live heading-to-steer depth honesty (#251)

Status: approved (2026-07-30). Addendum to
`docs/superpowers/specs/2026-07-14-sail-command-design.md`; that document remains
the source of truth for anything this one does not state.

## 1. Problem

`headingToSteerDeg` (`app/src/lib/live.ts:45`) returns
`initialBearingDeg(p, legs[i].end)` — a great-circle bearing from the current fix
to the active leg's end waypoint. It is a **bearing**, not a course that has been
checked against the depth mask, and the Live view presents it without saying so.

This is inherent to bearing-to-waypoint semantics; a chartplotter behaves the
same way. It is not a regression, and no change introduced it.

It matters here because SailCommand plans for a 2.1 m-draft boat in shallow
Danish waters, and the whole purpose of a dogleg is to route around a shoal. A
bearing straight to the next waypoint can cut exactly that corner.

### Measurement

Taken during the #243 / PR #246 investigation, using the real committed mask and
the real solver. On a ±0.25 nm grid around the Sønderborg dogleg — 9,961 probe
positions, every one of them itself navigable at the 3.0 m default safety depth —
the straight line from the fix to the active waypoint crosses water shallower
than 3.0 m at **1,393 positions = 13.98 %**. Zero land crossings.

### Rejected before this design

A forward-biased tie-break in `activeLegIndex` was evaluated and rejected on
measurement: it relocates the leg-selection boundary rather than removing it
(monotone across EPS 1e-4…1e-2 nm, no plateau), and it steers across sub-safety
water at 264 additional grid positions, worst case **0.1 m** minimum clearance
versus 10.9 m under the current rule at the same fix. Perpendicular-passed and
arrival-radius waypoint advance were also rejected: neither touches this case.

**This design changes no routing behaviour and no leg-selection behaviour.**

## 2. Decision

The heading-to-steer readout gains a **depth-check state** with three values:

| State | Meaning | Presentation |
| --- | --- | --- |
| `clear` | Probe ran; the bearing line does not cross sub-safety water | Unchanged from today |
| `caution` | Probe ran; the line crosses water shallower than the safety depth | Caution styling + a note naming the measured shallowest depth |
| `unavailable` | The probe could **not** run | Muted "Depth not checked" note |

`unavailable` exists because a detect-and-flag design makes the *absence* of a
warning mean "checked, and clear". Without a distinct third state, a failed or
unloaded mask would look identical to all-clear — a safety affordance whose
broken state is indistinguishable from its healthy state.

## 3. Architecture

### 3.1 New module — `app/src/lib/headingDepth.ts`

A new module rather than an addition to `live.ts`. `live.ts` is 91 lines of pure
geometry with no asset dependencies; this concern needs `NavMask`. Separating
them keeps `live.ts` pure and gives the new logic its own test surface.

```ts
export type HeadingDepthCheck =
  | { state: 'clear' }
  | { state: 'caution'; shallowestM: number }
  | { state: 'unavailable' }

export function checkHeadingDepth(
  mask: NavMask | null,
  legs: Leg[],
  legIndex: number,
  p: LatLon,
  safetyDepthM: number,
): HeadingDepthCheck
```

Behaviour:

- `mask === null` → `unavailable`.
- Otherwise probe the segment `p → legs[legIndex].end` with
  `segmentShallowestBelow` at `safetyDepthM`.
- Nothing below the threshold → `clear`.
- Something below → `caution` with that depth.
- **Out-of-coverage must yield `unavailable`, never `clear`.** The implementer
  must verify how `segmentShallowestBelow` and the underlying `walkCells`
  behave for cells outside the mask bounds and adapt accordingly. Do not assume
  out-of-bounds reads as deep water.

The threshold is the user's own safety depth — the **same gate**
`route.shallow.banner` uses. The two warnings therefore cannot contradict each
other, and neither requires regenerating data (navigability is decided at query
time).

### 3.2 Asymmetric hysteresis

CLAUDE.md: *"Design a guard around its ASYMMETRY … when a guard's two failure
modes cost very different amounts, make OVER-firing the default."* A missed
shallow warning costs more than a redundant one.

- `caution` engages on the **first** fix that detects it — no delay.
- `caution` clears only after the check has returned `clear` continuously for
  `HEADING_DEPTH_CLEAR_MS = 5000` (a named constant, ≈ 5 fixes; GPS noise and
  the `activeLegIndex` argmin flip both operate at ~1 Hz).
- **`unavailable` does not count as clear.** While a caution is held, an
  `unavailable` result neither advances nor resets the clear-timer, and the
  displayed state stays `caution`. "We can no longer check" is not evidence that
  the hazard is gone, and letting it time out a caution would make an asset
  failure silently cancel a warning.
- Outside a held caution, `unavailable` is a capability state, not a hazard
  state, and flips freely with no hysteresis.
- The hysteresis is on the **state**, not on a particular waypoint. A change of
  `legIndex` re-probes immediately; if the new probe is `clear`, the clear-timer
  starts from that fix. A held caution continues to display the **last measured**
  `shallowestM`, which is the value that justified it.
- The hysteresis resets on a `[plan.id, rig]` change, matching the #158
  convention, so a caution from a superseded route cannot survive a reroute.

### 3.3 Mask acquisition and cost

The Live view obtains the mask the same way `RouteLayer` and `DepthProfile`
already do: `await loadRoutingAssets()` (`app/src/services/assets.ts`, a
fetch-once module-cached singleton), then
`new NavMask(meta, new Uint8Array(buffer))`. This does not involve the routing
Web Worker.

Until the asset resolves, the state is `unavailable`.

Cost is one bounded `walkCells` traversal per fix (Amanatides–Woo, bounded by
`rows + cols + 4`). That qualifies as the cheap idempotent consumer CLAUDE.md
permits for GPS-derived per-fix signals. The result is additionally memoised on
`(plan.id, rig, legIndex, fix cell, safetyDepthM)` so a stationary or slow-moving
boat does not re-walk the same segment every second. `plan.id` and `rig` are part
of the key deliberately: `legIndex` alone does not identify a waypoint, so a
reroute that keeps the same index while moving `legs[legIndex].end` would
otherwise serve a stale result from the previous route.

### 3.4 Rendering — `app/src/components/LiveView.tsx`

Rendered inside the existing `.live-view-hts` block.

- `caution`: a modifier class on the readout plus a sibling note element naming
  the measured depth.
- `unavailable`: a muted note element.
- `clear`: no note; markup identical to today.

**No ARIA live region.** This is a deliberate accessibility decision, not an
oversight. The readout updates at roughly 1 Hz, so `role="alert"` or
`aria-live` would re-announce on every fix — hostile to screen-reader users and
far worse than silence. Meaning is carried by **text plus icon plus colour**;
colour is never the sole signal (WCAG 1.4.1). Screen-reader users encounter the
note when navigating the readout, as they do the rest of the Live view.

Two consequences worth stating explicitly:

- The displayed depth rounds to 0.1 m, so the note text does not churn at fix
  rate.
- The existing `live.spec.ts` assertion that `[role="alert"]` count is **0**
  after a successful reroute stays valid **by construction**, because this
  design adds no alert role. That assertion is doing useful work and must not be
  weakened.

Colour reuses the safety-depth warning family (`#E69F00`) that
`.shallow-warning` already uses, so the two depth warnings look like one system.
As a targeted improvement to the code being touched, that family is factored
into `--sc-depth-warning-*` tokens in `app/src/app.css`; `.shallow-warning`
currently hardcodes the values and bypasses the token layer, and is updated to
consume the new tokens rather than leaving a third copy behind.

### 3.5 i18n

Two new key pairs, added to **both** dictionaries under the existing
`satisfies Record<MsgKey, string>` parity check:

| Key | EN | DE |
| --- | --- | --- |
| `live.hts.depthCaution` | `Bearing crosses {depth} m — shallower than your safety depth ({safety} m)` | `Peilung kreuzt {depth} m — flacher als deine Sicherheitstiefe ({safety} m)` |
| `live.hts.depthUnchecked` | `Depth not checked` | `Tiefe nicht geprüft` |

The voice matches the existing `route.shallow.banner`. The copy must never
assert that anything is safe or verified — no "safe" / "sicher" — consistent
with the standing rule that the app is a passage-planning aid and must not claim
chart authority.

## 4. Error handling

- `loadRoutingAssets()` rejects → state is `unavailable`; log once; never throw
  and never surface a crash into the Live view.
- No fix, or `legIndex === null` → the readout is already hidden by the existing
  `steerable` gate, so no probe runs.
- Fix or waypoint outside mask coverage → `unavailable` (see §3.1).
- A probe must never be able to make the Live view render nothing: any
  unexpected failure degrades to `unavailable`, which is a rendered state.

## 5. Testing

`app/src/lib/headingDepth.test.ts`, against a synthetic mask:

- `clear`, `caution`, and `unavailable` paths.
- The threshold boundary: exactly at the safety depth, and just below it.
- Out-of-coverage yields `unavailable`, not `clear`.
- `mask === null` yields `unavailable`.

Expected depths are **hand-derived from the synthetic mask, never copied from
the function's own output** — an expectation derived from the code under test
always passes, and this repo has been bitten by that.

Hysteresis tests: engages on the first detecting fix; holds through a single
clear fix; clears only after the full window; resets on a `plan.id` change.

`app/src/components/LiveView.test.tsx`: RTL cases rendering all three states,
plus an explicit assertion that no element with `role="alert"` is added.

`app/e2e/live.spec.ts`: must stay green unchanged. **No new e2e case** unless
the fixture deterministically drives one of the states — a probabilistic e2e
assertion is worse than none, and RTL is the honest level for this logic.

Not touched: `realmask.repro.test.ts`, the routing property suite.

## 6. Out of scope

- Any change to `activeLegIndex`, `headingToSteerDeg`, or the router.
- Auto-rerouting, or any suggested alternative heading, when caution is active.
- Extending the check to COG/SOG, the next-event readout, or the map.
- Reconsidering what the Live view displays (bearing-to-waypoint versus
  cross-track error). That is a larger product question and is not opened here.

## 7. Changelog

This changes user-visible behaviour, so the implementing PR adds a
`CHANGELOG.md` `[Unreleased]` entry per the #131 ritual. As a solo PR it may
carry its own atomic entry.
