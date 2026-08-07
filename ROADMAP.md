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

Current release: **v0.9.0**. See [`CHANGELOG.md`](CHANGELOG.md) for what has
shipped.

## Now — v0.10.0

The `v0.10.0` cut (2026-08-07) closed out all 9 issues held in the
[`v0.10.0` milestone](https://github.com/DocGerd/sail_command/milestones):
the resizable desktop left panel, so the route legs table is no longer
cramped against a fixed-width column
([#355](https://github.com/DocGerd/sail_command/issues/355)); a Duration
column added to that table, and a correction of its "Heading" column label
to "COG" (the value shown was always course over ground — this app has no
leeway model, so it never computed true heading); the same issue's
remaining distance-column scope carries into v0.11.0 below
([#379](https://github.com/DocGerd/sail_command/issues/379)); and eight
tooling/process items — two deploy-reliability fixes, an e2e hardening
fix, two further artifact-guard fixes, and three documentation
corrections
([#415](https://github.com/DocGerd/sail_command/issues/415),
[#398](https://github.com/DocGerd/sail_command/issues/398),
[#412](https://github.com/DocGerd/sail_command/issues/412),
[#405](https://github.com/DocGerd/sail_command/issues/405),
[#404](https://github.com/DocGerd/sail_command/issues/404),
[#393](https://github.com/DocGerd/sail_command/issues/393),
[#365](https://github.com/DocGerd/sail_command/issues/365),
[#341](https://github.com/DocGerd/sail_command/issues/341)) covered under
"Development workflow" below.

## Next — v0.11.0

Tracked by the
[`v0.11.0` milestone](https://github.com/DocGerd/sail_command/milestones)
with five issues: the remaining scope of
[#379](https://github.com/DocGerd/sail_command/issues/379) — a per-leg
distance column, having already shipped duration and the corrected
course-over-ground label above;
[#282](https://github.com/DocGerd/sail_command/issues/282) — the reopened
no-route `reason` control-input coupling (PR #411 narrowed it but did not
close it; see `CLAUDE.md`'s Domain-rules section for the full history);
[#301](https://github.com/DocGerd/sail_command/issues/301) — re-plan from
the Plan view, prefilling the form from the displayed route instead of
re-entering harbours/waypoints;
[#231](https://github.com/DocGerd/sail_command/issues/231) — compacting the
top-left map-chrome column on short landscape viewports; and
[#427](https://github.com/DocGerd/sail_command/issues/427) — the About
button's `ⓘ` label glyph renders as tofu on at least one measured platform,
with no font fallback and coverage on real user platforms unmeasured.

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
([#223](https://github.com/DocGerd/sail_command/issues/223)), named
coding standards with automated Python lint/format enforcement for
`pipeline/` ([#220](https://github.com/DocGerd/sail_command/issues/220)),
release-tag signing with documented verification
([#222](https://github.com/DocGerd/sail_command/issues/222),
[#322](https://github.com/DocGerd/sail_command/issues/322), including a
registered public signing key), and a statement-coverage gate: the 93.92%
measurement ([#221](https://github.com/DocGerd/sail_command/issues/221)) is
now wired into CI as an 80% floor
([#319](https://github.com/DocGerd/sail_command/issues/319),
[#342](https://github.com/DocGerd/sail_command/issues/342)) — checked
nightly rather than per-PR, since the fully v8-instrumented suite is far
slower than the plain one; see `docs/security-assurance-case.md` §7 for the
accepted gap that cadence leaves open. The `signed_releases` criterion — a
conjunction of cryptographic signing **and** a documented key-obtaining
process (see `SECURITY.md`) — is now fully met: `v0.8.0` shipped as the
first signed tag, and `v0.8.1` has followed it, so both conjuncts
are proven on real releases, not just the mechanism. (The `v0.8.0` tag
itself still shows GitHub's "Verified" badge as `no_user` rather than
verified — a tagger-identity attribution gap fixed going forward from
`v0.8.1`, not a signature problem; see the `v0.8.1` CHANGELOG entry. The
OpenSSF criterion cares about the signing mechanism and its documentation,
not that badge.) Remaining:

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

Investigated and **declined** as a routing input this cut: honouring
buoyed fairways ([#244](https://github.com/DocGerd/sail_command/issues/244))
— the in-region OSM fairway data turned out to carry no width/depth/draft
tags and is over half canoe-scheme geometry, so a naive nearest-fairway
lookup would route a real boat down a paddling track; see
`docs/spikes/244-buoyed-fairways.md` for the full evidence and the
considered-and-rejected alternatives; the spike's own recommendation — ship
the mandatory-class objects as an advisory display overlay instead — is not
scheduled.

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
sets the pace of everything above. The `v0.10.0` cut fixed eight items in
this area: two deploy-reliability fixes — a retry for the Pages `deploy`
job's `deployment_queued`/`deployment_in_progress` timeout wedge (upstream
`actions/deploy-pages` was hanging on its own default poll ceiling), and a
version-aware smoke probe that turns a tag-push deploy silently
no-opping — when the merge-push run already deployed the identical commit
SHA — into a hard job failure instead of a false `success`
([#415](https://github.com/DocGerd/sail_command/issues/415),
[#398](https://github.com/DocGerd/sail_command/issues/398)); an e2e
hardening fix closing a stale-geometry gap in the #368 banner-clearance
guards, where a coordinate frozen before the `ResizeObserver`-driven CSS
push settled could pass even with a real interception live
([#412](https://github.com/DocGerd/sail_command/issues/412)); two further
artifact-guard fixes — a read-only-exemption path where the Edit/Write arm
left `docs/superpowers/plans/` with no ask-gate at all, and a selftest that
had been exercising a second, drifted copy of the production Bash
predicate rather than the real one
([#405](https://github.com/DocGerd/sail_command/issues/405),
[#404](https://github.com/DocGerd/sail_command/issues/404)); and three
documentation corrections — `pipeline/README.md`'s wrong mask cell size,
two residual inconsistencies the release runbook was left with after the
v0.8.1 correction, and `CLAUDE.md`'s unmeasured "6-10x CI slowdown" claim
replaced with the measured ratios
([#393](https://github.com/DocGerd/sail_command/issues/393),
[#365](https://github.com/DocGerd/sail_command/issues/365),
[#341](https://github.com/DocGerd/sail_command/issues/341)).

The v0.9.0 cut fixed four items in this
area: a stale-`node_modules` maplibre-gl citation in `CLAUDE.md` that had
already caused one wrong line-number claim
([#392](https://github.com/DocGerd/sail_command/issues/392)); the
artifact-guard Bash hook's read-only exemption, now conjunctive (exact verb
AND no write-capable construct anywhere) instead of the bare path-presence
match that had been prompting on plain `stat` calls
([#388](https://github.com/DocGerd/sail_command/issues/388)); a
`compass.spec.ts` e2e flake root-caused to a real MapLibre defect — a bare
`this.stop()` at ease completion disarms an in-flight drag gesture entirely
— and closed test-side with an at-rest settle gate; the underlying MapLibre
defect itself remains open, tracked separately
([#383](https://github.com/DocGerd/sail_command/issues/383), underlying
defect [#391](https://github.com/DocGerd/sail_command/issues/391) in
`Backlog`); and an e2e regression pin for the #205 narrow-width overlap fix
([#277](https://github.com/DocGerd/sail_command/issues/277)).

The v0.8.0 cut closed out the items carried as "remaining" since the one
before it: the conflict-free changelog-fragment mechanism itself
([#189](https://github.com/DocGerd/sail_command/issues/189)) and the
agent-workflow guardrails alongside it — orchestrator-first enforcement,
a batch review-thread resolver, and the invocation-vs-mention hook-guard fix
([#211](https://github.com/DocGerd/sail_command/issues/211),
[#178](https://github.com/DocGerd/sail_command/issues/178),
[#235](https://github.com/DocGerd/sail_command/issues/235)). Three further
tooling-hardening items shipped alongside them: CI now runs every hook's own
`--selftest` suite, with `.github/scripts/classify-docs-only.sh` extracted
into a standalone script backed by a 34-case harness and pinned case counts
across all four pre-existing hooks, so a broken guard can no longer ship
green ([#334](https://github.com/DocGerd/sail_command/issues/334)); the
docs-only e2e-skip classify step, which gates `ci.yml`'s four expensive e2e
steps so a docs-only PR reports in seconds instead of paying a full run
([#327](https://github.com/DocGerd/sail_command/issues/327)); and the
notices-nudge hook now also catches `npm audit fix`/`npm dedupe`, which
previously rewrote `package-lock.json` silently without tripping it
([#313](https://github.com/DocGerd/sail_command/issues/313)). Centralizing
coverage-aware test timeouts and wiring the coverage measurement into CI are
covered under "Supply-chain" above, not repeated here
([#342](https://github.com/DocGerd/sail_command/issues/342),
[#319](https://github.com/DocGerd/sail_command/issues/319)) — the two
follow-ups it left open never got triaged into v0.9.0 or v0.10.0 either,
and remain open, untriaged, in `Backlog`
([#357](https://github.com/DocGerd/sail_command/issues/357),
[#359](https://github.com/DocGerd/sail_command/issues/359)). A
worktree-cleanup skill, deduplicating the graphify guidance to a single home,
and tag → GitHub Release automation from `CHANGELOG.md` shipped in v0.7.0
([#179](https://github.com/DocGerd/sail_command/issues/179),
[#183](https://github.com/DocGerd/sail_command/issues/183),
[#175](https://github.com/DocGerd/sail_command/issues/175)). Grouped
Dependabot updates and path→area PR labeling shipped in v0.6.0
([#174](https://github.com/DocGerd/sail_command/issues/174),
[#173](https://github.com/DocGerd/sail_command/issues/173)).

A spike into lazy-loading map data for offline coverage during multi-day
trips landed as a recommendation only, with nothing implemented yet
([#296](https://github.com/DocGerd/sail_command/issues/296),
`docs/spikes/296-lazy-load-map-data.md`): keep the mask, harbours, seamarks,
and polars monolithic and eager, but split the basemap into an eager "core"
archive plus per-region archives fetched and pinned per plan, gated by a
network-free, byte-length-verified completeness check.

### Deferred (Icebox)

Parked deliberately, not stale — revisited opportunistically, and plausibly
never done:

- The five harbors that remain disconnected from the routable mask
  ([#9](https://github.com/DocGerd/sail_command/issues/9)). This one is
  **blocked on physics, not effort**: at the mask's ~46 m cell size the
  channels involved are sub-cell, and reconnecting them would mean fabricating
  depth data. It stays open only in case hi-res bathymetry becomes available.
  A spike this cut ([#245](https://github.com/DocGerd/sail_command/issues/245),
  `docs/spikes/245-depth-mask-resolution.md`) confirmed this by rebuilding
  the mask end-to-end at 23 m and 12 m: none of the five reconnect at either
  resolution, while `aabenraa` disconnects at both (it passes today only on
  `3.0 ≥ 3.0` at the default gate) and `augustenborg` additionally at 12 m,
  at its 2.8 m exception gate — so refining the grid is a measured regression
  at today's gates, not merely an untried option.

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
