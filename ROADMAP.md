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

Current release: **v0.14.0**. See [`CHANGELOG.md`](CHANGELOG.md) for what has
shipped.

## Now — v0.14.0

The `v0.14.0` cut (2026-08-25) closed the
[`v0.14.0` milestone](https://github.com/DocGerd/sail_command/milestones)
along the three threads this file named as "Next" at the last release, plus
one item that wasn't. Stored-record hardening: a saved plan whose
`viaPoints` were corrupted used to throw on load rather than only on the
Routes tab, and now shows as unable to open instead of crashing
([#654](https://github.com/DocGerd/sail_command/issues/654)); an
unvalidated stored rig-comparison verdict no longer renders a blank
recommendation chip, showing the honest "no faster rig claimed" message
instead ([#661](https://github.com/DocGerd/sail_command/issues/661)); a
plan-form edit made while a restored plan is still loading harbor data no
longer gets silently reverted
([#660](https://github.com/DocGerd/sail_command/issues/660)); a plan saved
by a newer app version now discloses retention the same way the
already-handled damaged-record case does
([#561](https://github.com/DocGerd/sail_command/issues/561)); and a saved
plan whose routing outcome can no longer be read now tells you to plan
again, instead of generic retry copy that could never help on that screen
([#662](https://github.com/DocGerd/sail_command/issues/662)). Depth
disclosure: the per-leg cautious chip and shallow-water map casing, which
had mounted only on routes the #53 relaxation branch actually touched, now
also appear on an ordinary, non-relaxed route whose more cautious depth
reading falls below the safety depth
([#651](https://github.com/DocGerd/sail_command/issues/651)). Copy and
layout residue: mixed decimal conventions in one German sentence are fixed
([#596](https://github.com/DocGerd/sail_command/issues/596)); the catalogue
provenance notes' English-under-German rendering was reviewed and
documented as intentional rather than a bug
([#607](https://github.com/DocGerd/sail_command/issues/607)); the
map-overlay time-slider cluster is now collapsible behind one "Display
options" control instead of always obstructing the map
([#628](https://github.com/DocGerd/sail_command/issues/628)); and the
rig-tie message now names the boat's own sails instead of a hardcoded
"Genoa and Fock" ([#578](https://github.com/DocGerd/sail_command/issues/578)).
The item that wasn't on last release's "Next" list: cable and pipeline
seamarks now show at the default "Standard" display tier instead of only at
"All" ([#521](https://github.com/DocGerd/sail_command/issues/521)), and one
of the four #232 map-chrome residuals — an overlapping seamark tap
anchoring its popover on the wrong mark — is fixed alongside it; the other
three remain open, one split out as its own issue
([#682](https://github.com/DocGerd/sail_command/issues/682)), the rest
still under [#232](https://github.com/DocGerd/sail_command/issues/232),
both rolled to `v0.15.0`.

The remaining issues in the milestone carry no user-visible surface and are
covered under "Development workflow" below.

## Next — v0.15.0

The [`v0.15.0` milestone](https://github.com/DocGerd/sail_command/milestones)
holds eight issues, four of them seamark/depth-overlay follow-on from this
cut. Three residuals remain from #200's original four map-chrome findings
after `v0.14.0` fixed popup anchoring: hazard marks can still paint under
routine marks at z≥12, now split into its own issue
([#682](https://github.com/DocGerd/sail_command/issues/682)), with
cross-tile ordering and unpinned tap wiring still tracked under
[#232](https://github.com/DocGerd/sail_command/issues/232). #521's move of
cable/pipeline marks to the Standard tier left the "All" seamark-display
radio a no-op against today's shipped data — the underlying mechanism is
kept for a future category rather than deleted, but the control itself
needs a decision
([#686](https://github.com/DocGerd/sail_command/issues/686)). The depth
overlay carries an open tension: the navigability hatch still renders as
hard-edged, aliased mask-cell squares at close zoom
([#648](https://github.com/DocGerd/sail_command/issues/648)), while a
separate maintainer call proposes removing the hatch overlay entirely and
keeping only the base depth-colour ramp
([#681](https://github.com/DocGerd/sail_command/issues/681)) — #648 may
turn out moot depending on how that is resolved. Two further threads: a
narrow-fairway routing issue distinct from the already-decided #264 heading
weave — a tack/gybe costs 45 s in the isochrone cost, but a motor↔sail mode
change costs nothing, so a plan can alternate motor → short sail → motor
with no penalty at all
([#354](https://github.com/DocGerd/sail_command/issues/354)); and an
advisory, non-routing, non-chart-authority seamark-proximity warning,
following up on a #495 finding that a route can pass close to an unnamed
cardinal mark
([#615](https://github.com/DocGerd/sail_command/issues/615)). Continued
progress toward the OpenSSF Silver badge rounds out the milestone
([#667](https://github.com/DocGerd/sail_command/issues/667)).

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

The largest open product questions. Both are parked in `Icebox` rather
than `Backlog` — accepted in principle, not scheduled:

- Currents, tides, and sea state (waves) in the isochrone cost
  ([#18](https://github.com/DocGerd/sail_command/issues/18)) — a design spec
  already exists at
  `docs/superpowers/specs/2026-07-22-waves-routing-design.md`. This is the
  single biggest change to routing accuracy the project could make, and also
  the biggest: it touches the data pipeline, the solver, and the UI.
- Multi-day trip planning with overnight stops and arrival-window checks
  ([#19](https://github.com/DocGerd/sail_command/issues/19)), which is bounded
  by the ~6-day forecast horizon.

Investigated and **declined** as a routing input in `v0.9.0`: honouring
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
sets the pace of everything above.

The `v0.14.0` cut closed two further items in this area, neither with a
user-visible surface. A departure `datetime-local` month-segment blanking
report was confirmed real on the reported Chromium build — but only
reachable when the 6-day forecast window straddles a month boundary,
roughly the last week of every month — while its second claim, that the
emptied value then stays "swallowed," was refuted: React's own
controlled-input restore rewrites the DOM node back to the last-rendered
value synchronously before paint, measured outcome-identical with and
without the production resync line, in both Chromium and WebKit. Narrowed
to defensive no-op code with no product change and no changelog entry
([#643](https://github.com/DocGerd/sail_command/issues/643)). And the
README coverage-badge question left open since `v0.13.0` was closed as
already answered: the Codecov badge and a SHA-pinned `codecov-action`
nightly run landed, taking the badge row to five, and the resulting set was
confirmed as the one wanted, with no further badges needed
([#346](https://github.com/DocGerd/sail_command/issues/346)).

The `v0.13.1` cut settled four items in this area, none with a user-visible
surface. `SECURITY.md` stated its OpenSSF Scorecard *Branch-Protection*
rating as a bare number with no date and no run reference — a figure that
decays silently every time the checks or the repository's posture move — and
now states it as a dated past-tense measurement with the run named
([#579](https://github.com/DocGerd/sail_command/issues/579)). A
low-frequency `App.test.tsx` flake, isolated while triaging a CI failure on
an unrelated PR, was root-caused not to the wall-clock dependence the issue
first proposed — that explanation was measured and refuted — but to a
scheduler race: `App.tsx`'s plan-form sync effect writes the departure back
from the plan in a passive-effect flush that can land after the commit
re-enabling the Plan button, so a test gating on that button could edit the
form before the still-pending effect overwrote it. Reproduced naturally at
one failure in 25 full-file runs under 48-way CPU contention, and closed
test-side by draining React's pending passive effects at every site
carrying that shape; the underlying product race is untouched and tracked
separately ([#631](https://github.com/DocGerd/sail_command/issues/631),
[#660](https://github.com/DocGerd/sail_command/issues/660)). And the same PR
that fixed #638's depth-hatch legend chrome also settled that legend's
reachability gate, whose `44px` threshold an earlier, superseded fix attempt
would have made stale: the number now lives behind a named constant with a
CSS/TS drift test pinning it against `app.css`, rather than a bare literal
([#641](https://github.com/DocGerd/sail_command/issues/641)). And a reported
departure-picker minute→hour carry was investigated and closed `won't fix`
in favour of keeping the native control — the remaining behaviour is
Android's own `TimePickerSpinnerDelegate` carry, and a `datetime-local`
input's `shadowRoot` and `selectionStart` are both `null`, so page JavaScript
cannot tell which segment has focus. Recorded as the project's first
decision record, `docs/adr/0001-keep-native-datetime-input.md` (#642).

The `v0.13.0` cut fixed three items in this area, none with a user-visible
surface. `ci.yml`'s `e2e` job carried no `timeout-minutes` at all, so a
wedged `playwright install` could burn hours while the job still looked
healthy; it is now capped at 30 minutes, sized against re-measured real runs
([#605](https://github.com/DocGerd/sail_command/issues/605)). No assertion
caught a leg below the requested depth gate, and the routing property suite
never exercised the depth-relaxation path at all; both now assert against the
gate ([#494](https://github.com/DocGerd/sail_command/issues/494)). And a
`DepthProfile` test comment named a figure its own fixture never produces;
the comment now matches its fixture
([#520](https://github.com/DocGerd/sail_command/issues/520)).

The `v0.12.1` cut fixed twelve items in this area, none with a
user-visible surface. Six were documentation, fixture and tooling upkeep:
prose and citation residue from the multi-boat branch
([#552](https://github.com/DocGerd/sail_command/issues/552));
`CLAUDE.md`'s CI timing figures, re-measured at 1161 s against a
documented 515–535 s — mostly suite growth rather than a slower runner,
so the file now carries the test count beside the `npm run test` figures
([#556](https://github.com/DocGerd/sail_command/issues/556)); a
`BoatPicker` test fixture that derived from `BOATS[0]`, an index
dependency on catalogue order rather than a named boat
([#569](https://github.com/DocGerd/sail_command/issues/569)); the docs
screenshot capture script's dedicated wind fixture, retuned after its rig
margin collapsed below the tie band, which would have left the captured
image with no ★ at all
([#577](https://github.com/DocGerd/sail_command/issues/577)); the vitest
sequencer's `SLOW_TEST_FILES_FIRST` list, ordered against its own
"slowest first" comment
([#581](https://github.com/DocGerd/sail_command/issues/581)); and the
drifted space/no-space label taxonomy, de-duplicated
([#401](https://github.com/DocGerd/sail_command/issues/401)). The
remaining six were guard-integrity fixes:
`app/sweep/canonicalize.test.mjs` ran in no automated suite, so the guard
it provides for a Critical-severity regression could never fire on its
own, and now runs as a step in the required `app` job
([#537](https://github.com/DocGerd/sail_command/issues/537)); an
`artifact-guard` read-only exemption let a whitespace-split quoted `sed`
script through, and the defence it relied on was GNU-sed-specific
([#535](https://github.com/DocGerd/sail_command/issues/535)); CodeQL's
query-suite choice was settled on `security-and-quality`
([#534](https://github.com/DocGerd/sail_command/issues/534)); the
`relaxedDepth` 1e-9 nudge's stated justification was false, and the test
pinning it could not fail
([#531](https://github.com/DocGerd/sail_command/issues/531)); the i18n
dictionaries enforced key parity but not placeholder parity, so a
`{dist}`-shaped typo could ship silently in one language
([#524](https://github.com/DocGerd/sail_command/issues/524)); and
`segmentMinDepthInfoM`'s `completed &&` conjunct was unexercised —
deleting it left the suite green
([#519](https://github.com/DocGerd/sail_command/issues/519)).

The `v0.12.0` cut fixed fourteen items in this area. Six were guards that
could be merged past. `eslint` never covered `app/e2e/**` — the script was
`eslint src`, so the Playwright specs that are the only functional
assurance for the service worker and the routing worker went unlinted
([#420](https://github.com/DocGerd/sail_command/issues/420)); the mask
connectivity flood fill, which is the acceptance criterion for a new
boat's derived depth gate, ran only in the advisory `Mask integrity`
workflow, and is now additionally a vitest test inside the required `app`
job ([#550](https://github.com/DocGerd/sail_command/issues/550)); a
dev-dependency advisory in `nanoid` via `vite`→`postcss` was cleared
([#533](https://github.com/DocGerd/sail_command/issues/533)); the
`artifact-guard` hook stopped asking on provably read-only commands
carrying an inert redirect
([#560](https://github.com/DocGerd/sail_command/issues/560));
`THIRD-PARTY-NOTICES.txt` was missing `workbox-strategies`
([#466](https://github.com/DocGerd/sail_command/issues/466)); and six
measured `CLAUDE.md` accuracy defects found by the #444 spike were
corrected ([#467](https://github.com/DocGerd/sail_command/issues/467)).
Four documentation issues against the #452 spike write-up closed alongside
them ([#501](https://github.com/DocGerd/sail_command/issues/501),
[#502](https://github.com/DocGerd/sail_command/issues/502),
[#503](https://github.com/DocGerd/sail_command/issues/503),
[#515](https://github.com/DocGerd/sail_command/issues/515)), as did a
correction to user-facing copy that promised integrity and fields the app
cannot verify ([#547](https://github.com/DocGerd/sail_command/issues/547))
and the README hero screenshot showing a mostly-motor route
([#459](https://github.com/DocGerd/sail_command/issues/459)).
Two process spikes also closed in `v0.12.0`, recorded here because neither
changed product code: whether the architecture still fits, which found
that it does and declined every structural candidate except an
incremental `AppShell` extraction
([#446](https://github.com/DocGerd/sail_command/issues/446),
`docs/spikes/446-architecture-fit.md`); and a review of `CLAUDE.md` and
this project's Claude Code automation, which recommended moving knowledge
into directory-scoped memory files rather than shortening the file, and
left the automation almost entirely alone
([#444](https://github.com/DocGerd/sail_command/issues/444),
`docs/spikes/444-claude-md-and-automation.md`) — the six accuracy defects
it measured are the #467 correction above.

The `v0.11.0` cut fixed three items in
this area: the no-route `reason` control-input coupling, previously only
narrowed by PR #411, now fully decoupled behind a committed `app/sweep/`
acceptance harness — 198 plans across six arms and 33 harbours at that
cut, since grown to 297 plans across nine arms, with a required BASE
double-run control — so a future classification change has
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
  A `v0.9.0` spike ([#245](https://github.com/DocGerd/sail_command/issues/245),
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
- **No open-ended or unbounded map-area expansion.** The committed mask,
  harbor list, and basemap are built for the Flensburg Fjord / Danish South
  Sea area (54.3–55.3°N, 9.4–11.0°E); growing that footprint is a real
  data-pipeline and app-size cost, not a toggle. A specific, bounded
  extension is already triaged and open in `Backlog`
  ([#295](https://github.com/DocGerd/sail_command/issues/295)) — this bullet
  declines an unscoped "just cover more area" request, not that one.
- **No paid tiers, sponsorship flows, or commercial offering.**

## How this roadmap is kept honest

Reviewed and updated at every release cut, alongside `README.md`,
`CHANGELOG.md`, and `GOVERNANCE.md`. If you find a statement here that no longer
matches the issue tracker, that is a bug worth filing — a roadmap that quietly
rots is worse than not having one.
