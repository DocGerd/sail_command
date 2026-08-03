# Roadmap

**Intent, not commitment.** This roadmap describes where SailCommand is headed
over roughly the next year (written 2026-07-27, so through mid-2027). It is a
statement of direction for users and prospective contributors, not a schedule
and not a promise. Items will move, slip, and get dropped — that is expected and
allowed. Nothing here creates an obligation on the maintainer, and dates are
deliberately absent because a single-maintainer hobby project cannot honor them
(see [`GOVERNANCE.md`](GOVERNANCE.md)).

The authoritative, always-current view is the
[issue tracker](https://github.com/DocGerd/sail_command/issues) and its
milestones. This file is the human-readable summary of that state, refreshed at
each release cut.

Current release: **v0.7.0**. See [`CHANGELOG.md`](CHANGELOG.md) for what has
shipped.

## Now — v0.8.0

The next feature release. Its **product** scope is not yet decided — the
`v0.8.0` milestone held one item,
[#322](https://github.com/DocGerd/sail_command/issues/322) (key custody,
GitHub registration, and the signed-tag runbook change), now closed: the
signing mechanism, verification docs, and one-time maintainer setup all
landed ahead of the cut itself, in `SECURITY.md` and `CONTRIBUTING.md`.
Further scope will be drawn from the themes below as work is triaged into
it, the same way v0.7.0's was. Release tags start being cryptographically
signed at `v0.8.0` itself (**tags through `v0.7.0` remain permanently
unsigned**) — the `v0.8.0` tag is what actually exercises the mechanism for
the first time and is expected to be the first tag showing GitHub's
"Verified" badge. The
[milestone](https://github.com/DocGerd/sail_command/milestone/8) is the
current list; this paragraph describes the intent behind it.

## Themes for the next year

Grouped by theme rather than by date. Ordering within a theme is not a
commitment either.

### Supply-chain and project-hygiene hardening

The project holds the [OpenSSF Best Practices](https://www.bestpractices.dev/projects/13749)
*passing* badge and is working toward *Silver*. A 2026-07 audit produced a
concrete, bounded set of gaps, most of which are documents or config rather than
product work. Done: governance, roles, Code of Conduct, this roadmap, a
security assurance case
([#217](https://github.com/DocGerd/sail_command/issues/217),
[#218](https://github.com/DocGerd/sail_command/issues/218),
[#219](https://github.com/DocGerd/sail_command/issues/219),
[#224](https://github.com/DocGerd/sail_command/issues/224)), a
Content-Security-Policy for the app shell
([#223](https://github.com/DocGerd/sail_command/issues/223)), and named
coding standards with automated Python lint/format enforcement for
`pipeline/` ([#220](https://github.com/DocGerd/sail_command/issues/220)).
Remaining:

- A statement-coverage gate: the measurement itself landed at 93.92%
  ([#221](https://github.com/DocGerd/sail_command/issues/221), closed), but
  wiring it into CI and picking a threshold is tracked separately
  ([#319](https://github.com/DocGerd/sail_command/issues/319)).
- Release tags: the verification docs and process shipped
  ([#222](https://github.com/DocGerd/sail_command/issues/222), closed), and
  the signing mechanism itself has now also landed
  ([#322](https://github.com/DocGerd/sail_command/issues/322), closed — see
  "Now" above), including a registered public signing key. The
  `signed_releases` criterion is a conjunction (signing **and** a documented
  key-obtaining process — see `SECURITY.md`); the second conjunct is already
  true today, and the criterion is fully met once the `v0.8.0` tag actually
  ships as the first signed release — both conjuncts together, not the tag
  alone.
- Tracking the remaining self-resolving OpenSSF Scorecard findings
  ([#72](https://github.com/DocGerd/sail_command/issues/72)).

One Silver criterion — `access_continuity` — cannot be closed by any change in
this repository. It requires a second person with standing release rights. See
[`GOVERNANCE.md`](GOVERNANCE.md#continuity-and-succession).

### Routing depth

The largest open product questions, all accepted into the backlog but none
scheduled:

- Currents, tides, and sea state (waves) in the isochrone cost
  ([#18](https://github.com/DocGerd/sail_command/issues/18)) — a design spec
  already exists at
  `docs/superpowers/specs/2026-07-22-waves-routing-design.md`. This is the
  single biggest change to routing accuracy the project could make, and also
  the biggest: it touches the data pipeline, the solver, and the UI.
- Multi-day trip planning with overnight stops and arrival-window checks
  ([#19](https://github.com/DocGerd/sail_command/issues/19)), which is bounded
  by the ~6-day forecast horizon.
- Multiple boat types with per-boat foresail inventories
  ([#54](https://github.com/DocGerd/sail_command/issues/54)) — today the app is
  hard-wired to one Salona 45 polar pair.

Note the tension with "Out of scope (v1)" in [`README.md`](README.md): currents,
tides, waves, and multi-day passages were excluded from v1 and remain excluded
from the shipped app. Their presence here means the exclusion is being
revisited, not that it has been lifted.

### Live view and on-board use

- A live-view simulator that replays or synthesizes a voyage, so GPS/AIS
  behavior can be tested without sailing
  ([#143](https://github.com/DocGerd/sail_command/issues/143)). This is the
  prerequisite for confidently changing anything in the Live view.
- Remaining map-chrome and small-screen issues beyond v0.6.0
  ([#231](https://github.com/DocGerd/sail_command/issues/231),
  [#232](https://github.com/DocGerd/sail_command/issues/232)).

### Development workflow

Not user-visible, but it is where a meaningful share of the effort goes and it
sets the pace of everything above: a conflict-free changelog workflow for
parallel pull requests
([#189](https://github.com/DocGerd/sail_command/issues/189)) and remaining
agent-workflow guardrails
([#211](https://github.com/DocGerd/sail_command/issues/211),
[#178](https://github.com/DocGerd/sail_command/issues/178),
[#235](https://github.com/DocGerd/sail_command/issues/235)). A
worktree-cleanup skill, deduplicating the graphify guidance to a single home,
and tag → GitHub Release automation from `CHANGELOG.md` shipped this cut
([#179](https://github.com/DocGerd/sail_command/issues/179),
[#183](https://github.com/DocGerd/sail_command/issues/183),
[#175](https://github.com/DocGerd/sail_command/issues/175)). Grouped
Dependabot updates and path→area PR labeling shipped in v0.6.0
([#174](https://github.com/DocGerd/sail_command/issues/174),
[#173](https://github.com/DocGerd/sail_command/issues/173)).

### Deferred (Icebox)

Parked deliberately, not stale — revisited opportunistically, and plausibly
never done:

- The five harbors that remain disconnected from the routable mask
  ([#9](https://github.com/DocGerd/sail_command/issues/9)). This one is
  **blocked on physics, not effort**: at the mask's ~46 m cell size the
  channels involved are sub-cell, and reconnecting them would mean fabricating
  depth data. It stays open only in case hi-res bathymetry becomes available.

## What the project does not intend to do

These are standing decisions, not gaps waiting to be filled. A pull request
implementing one of them will be declined on principle
([`GOVERNANCE.md`](GOVERNANCE.md#decisions-that-are-not-open-for-negotiation)).

- **No backend, ever.** No server, no proxy, no API of our own, no database.
  The wind forecast is fetched by the browser directly from Open-Meteo.
- **No accounts, no login, no user data collection.** Nothing to sign up for,
  nothing to breach. No analytics, telemetry, or tracking is present or planned.
- **Not a navigation device, and no ENC chart data.** SailCommand will not
  become a chartplotter, will not claim chart authority, and will not ship or
  integrate official electronic navigational charts. Official charts and your
  plotter remain authoritative.
- **No route sharing or collaboration features.** Plans stay on the device that
  created them. Export to GPX for a chartplotter is the intended interchange
  path.
- **No native iOS/Android applications.** SailCommand is an installable PWA;
  that is the whole delivery model.
- **No expansion beyond the Flensburg Fjord / Danish South Sea area
  (54.3–55.3°N, 9.4–11.0°E) within this horizon.** The committed mask, harbor
  list, and basemap are all built for that box. Widening it is a data-pipeline
  and app-size question that is not being worked on.
- **No paid tiers, sponsorship flows, or commercial offering.**

## How this roadmap is kept honest

Reviewed and updated at every release cut, alongside `README.md`,
`CHANGELOG.md`, and `GOVERNANCE.md`. If you find a statement here that no longer
matches the issue tracker, that is a bug worth filing — a roadmap that quietly
rots is worse than not having one.
