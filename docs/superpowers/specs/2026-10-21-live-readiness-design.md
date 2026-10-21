# Live readiness for a first sail (v0.58.0)

Status: approved (maintainer, 2026-10-21, planning session for the v0.58.0 Live goal).
Addendum to `2026-07-30-live-heading-depth-honesty-design.md` (#251) and the Live sections of `2026-07-14-sail-command-design.md`. Where this addendum and those specs disagree, this one governs Live only.

## Source of the rulings

Every ruling below was given by the maintainer in the 2026-10-21 planning session and is recorded verbatim as an issue comment. Those comments are the authority; this document restates them for design use.

| Lane | Issue | Ruling comment |
|---|---|---|
| L1 AIS key leak | #1799 | [comment](https://github.com/DocGerd/sail_command/issues/1799#issuecomment-6321269631) |
| L2 GPS core | #1800 | [comment](https://github.com/DocGerd/sail_command/issues/1800#issuecomment-6321269943) |
| L4 Wake lock | #1801 | [comment](https://github.com/DocGerd/sail_command/issues/1801#issuecomment-6321270261) |
| L3a Live card states | #1802 | [comment](https://github.com/DocGerd/sail_command/issues/1802#issuecomment-6321270648) |
| L3b Readouts | #1803 | [comment](https://github.com/DocGerd/sail_command/issues/1803#issuecomment-6321270995) |
| L5 AIS robustness | #1804 | [comment](https://github.com/DocGerd/sail_command/issues/1804#issuecomment-6321271416) |
| L6 Live e2e | #1805 | [comment](https://github.com/DocGerd/sail_command/issues/1805#issuecomment-6321271800) |
| L8 On-water protocol | #1808 | [comment](https://github.com/DocGerd/sail_command/issues/1808#issuecomment-6321272111) |

## Target device

An Android tablet with built-in GPS, running the app in Chrome or as the installed PWA. The ≥820 CSS px band is first-class (both layout branches).

## GPS state model (L2)

- One shared GPS source feeds both the Live readout and the ownship marker. Today they run two independent `watchPosition` subscriptions.
- State is a pure function of fix age plus a denied flag: `waiting` (no fix yet), `fresh`, `stale` (no new fix for 10 s), `lost` (30 s), `denied`.
- A fix is *new* only if `pos.timestamp` advanced past the last accepted fix. Age then runs on the receipt clock from the last new fix, so a constant device-clock offset cannot pin a healthy stream at stale or lost.
- TIMEOUT and POSITION_UNAVAILABLE never change state on their own and never clear the watch. Only PERMISSION_DENIED is terminal. `mapErrorKind` splits TIMEOUT from `unavailable`.
- `watchPosition` gets a `timeout` so a stall surfaces; the watch re-arms on `visibilitychange` to visible and on `pageshow`.
- Reroute is gated on a fresh fix with accuracy ≤ 100 m. The thresholds (10 s, 30 s, 100 m) are tunable with evidence.
- GPS starts only on a user tap (#113). This is unchanged.

## Live card (L3a, L3b)

- **Stale:** a "stale, Ns old" badge; values dimmed, including Heading to steer and its depth/land caution.
- **Lost:** "GPS signal lost". ETA, SOG, COG, XTE and Heading to steer are hidden; the last fix time and position are shown; reroute is disabled with a reason that shows the current accuracy or fix age and the threshold.
- **Waiting / denied / lost** show every time they occur, not once ever. Denied has recovery copy distinct from transient loss.
- **Boat marker:** auto-shown while Live tracking runs, whatever `showOwnship` says; the stored setting is never written. When lost, the marker takes a stale style; a confident marker is never drawn at an old position.
- **Resume:** after reload, crash, app kill or leaving the Live tab, Live shows a prominent "Tracking stopped — Resume" banner. The "was tracking" flag is localStorage, not a `Settings` field.
- **Handover:** the orphaned `live.handover` copy (#1721) is shown when the active plan is a handover plan.
- **Readouts (L3b):** distance to go (leg and route), leg N of M, cross-track error (side and distance to the active leg). Headings are labelled true ("°T"). The active leg gets hysteresis. XTE is information only: no copy tells the user where to steer. The "Heading to steer" label itself is out of scope.

## Screen Wake Lock (L4)

- Held by default while tracking, with a visible indicator and a Live toggle to release it; the toggle is persisted in localStorage.
- Re-acquired on `visibilitychange` to visible; released on stop or on leaving Live.
- The indicator follows the sentinel's `release` event, not the `request()` promise alone.
- Where the API is unsupported, Live says so.

## AIS (L1, L5)

- The AIS key never leaves the device except to aisstream.io (`SECURITY.md`). It is stripped from `request.settings` at the single persistence point (`services/db.ts :: savePlan`) and on export. Stored plans that already contain a key are left as-is; scrubbing them is a follow-up.
- Class B reports are subscribed only after their message names are verified against aisstream.io's documentation; unverified means skipped and filed.
- An inbound-silence watchdog and a "connected, no traffic" state distinguish a quiet sea from a dead socket.

## Constraints

- No `DB_VERSION` bump: prod and `/uat/` share one IndexedDB.
- No edits to #282 sweep-closure files (`types.ts`, `lib/geo.ts`, `test/setup.ts`, `routing/`), so no sweep is owed.
- No backend.

## Out of scope

CPA/TCPA, the "Heading to steer" label, `--sc-*` token changes, scrubbing already-stored keys.
