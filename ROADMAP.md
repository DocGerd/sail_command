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

Current release: **v0.11.0**. See [`CHANGELOG.md`](CHANGELOG.md) for what has
shipped.

## Now — v0.11.0

The `v0.11.0` cut (2026-08-08) closed out all 9 issues held in the
[`v0.11.0` milestone](https://github.com/DocGerd/sail_command/milestones):
re-planning from the Plan view now prefills the form from the currently
displayed route and flags it as outdated once an input changes, rather
than re-entering harbours/waypoints from scratch
([#301](https://github.com/DocGerd/sail_command/issues/301)); the
top-left map-chrome column now compacts into a row on short landscape
phones, so the nautical scale bar is no longer suppressed on every tab
there ([#231](https://github.com/DocGerd/sail_command/issues/231)); the
About button's icon no longer bets on font coverage — a bare U+24D8
glyph that measured as tofu on some Linux font sets is now an inline SVG
([#427](https://github.com/DocGerd/sail_command/issues/427)); the solver
now carries a wall-clock budget and reports a timeout honestly instead
of the same generic "unexpected failure" message
([#432](https://github.com/DocGerd/sail_command/issues/432)); and a
route-planning failure shows a distinct message per cause instead of one
identical banner for seven unrelated failure modes
([#433](https://github.com/DocGerd/sail_command/issues/433)). Three
further issues closed with no user-visible surface — the no-route
`reason` control-input coupling, now fully decoupled behind a committed
acceptance harness rather than merely narrowed; a logging/diagnostics
spike; and an `artifact-guard` hook fix
([#282](https://github.com/DocGerd/sail_command/issues/282),
[#435](https://github.com/DocGerd/sail_command/issues/435),
[#437](https://github.com/DocGerd/sail_command/issues/437)) — covered
under "Development workflow" below.
[#379](https://github.com/DocGerd/sail_command/issues/379) also closed
this cut, but its full scope (duration, distance, course/heading per
leg) had already shipped in `v0.10.0`; it stayed open only
administratively and carries no new changes here.

## Next — v0.12.0

Tracked by the
[`v0.12.0` milestone](https://github.com/DocGerd/sail_command/milestones)
with seven issues: two SAFETY-labeled depth-mask defects — the mask
overstating depth by up to 2.0 m on 48% of water cells with no warning
at all ([#455](https://github.com/DocGerd/sail_command/issues/455)), and
depth relaxation lowering the safety gate for the whole route rather
than just the constrained segment, with the warning not on the first
surface a user sees
([#452](https://github.com/DocGerd/sail_command/issues/452)); two
process spikes — whether the architecture still fits (layering,
`App.tsx` concentration, prose-only invariants, the MapLibre call-site
surface) ([#446](https://github.com/DocGerd/sail_command/issues/446))
and a CLAUDE.md improvement run alongside an assessment of what Claude
Code automation this project should adopt
([#444](https://github.com/DocGerd/sail_command/issues/444)); a seamark
symbol-size control plus a display-category policy for which marks to
omit ([#353](https://github.com/DocGerd/sail_command/issues/353)); a
settings menu separating static boat/skipper preferences from per-route
plan inputs ([#299](https://github.com/DocGerd/sail_command/issues/299));
and multiple boat types with per-boat foresail inventories, moved up
from the "Routing depth" theme below
([#54](https://github.com/DocGerd/sail_command/issues/54)).

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

The largest open product questions, all accepted into the backlog:

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
  hard-wired to one Salona 45 polar pair. Now scheduled for `v0.12.0` (see
  "Next" above).

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
- Remaining map-chrome issues beyond v0.6.0
  ([#232](https://github.com/DocGerd/sail_command/issues/232)).

### Development workflow

Not user-visible, but it is where a meaningful share of the effort goes and it
sets the pace of everything above. The `v0.11.0` cut fixed three items in
this area: the no-route `reason` control-input coupling, previously only
narrowed by PR #411, now fully decoupled behind a committed `app/sweep/`
acceptance harness — 198 plans across six arms and 33 harbours, with a
required BASE double-run control — so a future classification change has
something real to compare against
([#282](https://github.com/DocGerd/sail_command/issues/282)); a spike into
how logging and diagnostics should work across this backend-less, offline
PWA's three execution contexts (main thread, worker, service worker),
recommending an in-memory ring buffer mirrored to a capped `sessionStorage`
key with a copy/download pair in the About dialog — not yet implemented
([#435](https://github.com/DocGerd/sail_command/issues/435)); and a second
maintainer ruling narrowing the `artifact-guard` hook's over-firing on
provably read-only pipelines, adding `tail` to its read-only-verb allowlist
after measuring the guard's actual false-positive rate against real
observed commands
([#437](https://github.com/DocGerd/sail_command/issues/437)).

The `v0.10.0` cut fixed eight items in
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
