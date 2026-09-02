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

Current release: **v0.19.0**. See [`CHANGELOG.md`](CHANGELOG.md) for what has
shipped.

## Now — v0.19.0

The `v0.19.0` cut (2026-09-02) completed the
[`v0.19.0` milestone](https://github.com/DocGerd/sail_command/milestones),
six issues in total. Keyboard equivalents for two map-only interactions
carried the visible surface, both from #714's keyboard-equivalents spike
(`docs/spikes/714-keyboard-map-equivalents.md`): a latitude/longitude
coordinate-entry row in the planner panel's via section places a via point
and, from an already-placed point's own "Edit coordinates" button,
repositions it — a second producer of the same point the map tap already
produces, applied on the next "Plan route" press like every other form edit
([#829](https://github.com/DocGerd/sail_command/issues/829)); and a
collapsed "Seamarks in view" / "Schifffahrtszeichen im Kartenausschnitt"
list on the Plan tab lists the seamarks inside the current map view, nearest
the map centre first and capped at 50, each row a button that opens that
mark's own popup on the map — sourced from the shipped seamark data and the
map's bounds, mirroring the map's own seamark layer toggle and display tier
([#830](https://github.com/DocGerd/sail_command/issues/830)). The results
panel gained an advisory line when the active rig's route passes closer than
300 m to a cardinal or isolated-danger mark, stating how many; it is
presentation only — the router still does not use marks, and the copy says
so and refuses to name a side to pass
([#615](https://github.com/DocGerd/sail_command/issues/615); the routing-input
half of that finding stays open as
[#495](https://github.com/DocGerd/sail_command/issues/495)). Two fixes
closed gaps left by `v0.18.0`'s own features: the #652 known-disconnected
disclosure now stays on a selected origin or destination instead of
vanishing at the moment it matters, and a failed plan against such a harbour
names that same limit in place of the generic no-route message
([#834](https://github.com/DocGerd/sail_command/issues/834)); and the
depth-hatch legend no longer describes the hatch while the hatch is switched
off, on both of #813's complementary legend surfaces
([#839](https://github.com/DocGerd/sail_command/issues/839)).

The remaining issue in the milestone carries no user-visible surface and is
covered under "Development workflow" below.

## Next — v0.20.0

The [`v0.20.0` milestone](https://github.com/DocGerd/sail_command/milestones)
holds fifteen issues. The largest group is waypoint handling on the map: a
buoy or other seamark as a route waypoint
([#845](https://github.com/DocGerd/sail_command/issues/845)), renameable
waypoints instead of bare coordinates
([#846](https://github.com/DocGerd/sail_command/issues/846)), persisted
named user waypoints selectable directly on the map
([#848](https://github.com/DocGerd/sail_command/issues/848)), and a reliable
way to cancel a waypoint being created
([#844](https://github.com/DocGerd/sail_command/issues/844)). The third
gap #714's spike found — a keyboard equivalent for identifying an AIS
vessel — carries over from `v0.19.0`'s original scope
([#831](https://github.com/DocGerd/sail_command/issues/831)). Two routing
features are scheduled: comparing a few candidate
departure times, ranked by passage time and how little motoring each needs
([#356](https://github.com/DocGerd/sail_command/issues/356)), and a
mainsail-reef suggestion per leg
([#325](https://github.com/DocGerd/sail_command/issues/325)). The rest is
tooling and documentation hygiene: three residuals of the #803 e2e
build-identity check — a stale service worker on a reused origin can still
serve a foreign cached build
([#832](https://github.com/DocGerd/sail_command/issues/832)), and the probes
are blind to the `globIgnores` subtrees
([#833](https://github.com/DocGerd/sail_command/issues/833)) and to
extensions outside `globPatterns`
([#854](https://github.com/DocGerd/sail_command/issues/854)); nothing couples
the shipped `knownDisconnected` key to its TypeScript field
([#835](https://github.com/DocGerd/sail_command/issues/835)); a `ViaMarkers`
test header stating a measured falsehood
([#838](https://github.com/DocGerd/sail_command/issues/838)); and three
stale-prose corrections — a `DataLayers` comment
([#842](https://github.com/DocGerd/sail_command/issues/842)), a
`dict.en.ts` line-number citation
([#805](https://github.com/DocGerd/sail_command/issues/805)) and three
`CLAUDE.md` wording defects
([#865](https://github.com/DocGerd/sail_command/issues/865)).

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

The largest open product questions. Both sit in `Backlog` — accepted in
principle, not scheduled into a release:

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

### Development workflow

Not user-visible, but it is where a meaningful share of the effort goes and it
sets the pace of everything above.

The `v0.19.0` cut addressed one further item in this area, with no
user-visible surface, plus a spike whose issue then left the milestone
rather than closing. Both real-mask regression harnesses —
`app/sweep/` and `realmask.repro.test.ts` — planned exclusively for the
Salona 45, so a per-boat depth-gate or boat-keyed polar-lookup regression on
any other catalogue boat was invisible to both; the sweep now carries two
Salona 44 arms (eleven arms × 33 harbours = 363 plans, the nine pre-existing
arms byte-unchanged) and the real-mask file two Salona 44 cases, each with a
same-request Salona 45 companion plan whose duration must differ
([#653](https://github.com/DocGerd/sail_command/issues/653)). And the
motor↔sail mode-churn question — a mode change costs the isochrone cost
model nothing, so a narrow-water plan can churn motor → short sail → motor
unpenalised — was investigated as a spike rather than fixed: seven candidate
solver changes were each measured with one committed driver over six
real-mask routes on both rigs, none removes the churn on the worst route
without paying a cost the maintainer had already rejected for headings under
#264, and the recommendation is to defer; #354 itself moved from this
milestone to `Backlog` on 2026-09-02 under that "spike doc + defer" ruling,
so it stays open
([#354](https://github.com/DocGerd/sail_command/issues/354),
`docs/spikes/354-mode-churn.md`).

The `v0.18.0` cut addressed seven further items in this area, none with a
user-visible surface. Two are process spikes, recorded here because neither
changed product code. A bounded-slice investigation into #391 — a
maplibre-gl defect where a natural ease's own completion disarms an
in-flight gesture mid-drag, first found and worked around test-side at
#383/#390 — re-derives the mechanism against `maplibre-gl@6.6.0`, drafts a
ready-to-file upstream bug report, and rules
to ACCEPT the defect rather than mitigate it app-side, since every
considered mitigation sits adjacent to the narrowly load-bearing #203/#227
camera-mode derivation for a UX inconvenience rather than a safety defect;
#391 closed with that decision recorded, the defect itself stays live for
users as the accepted state, and the drafted upstream report is left for the
maintainer to file at their discretion
([#391](https://github.com/DocGerd/sail_command/issues/391),
`docs/spikes/391-maplibre-gesture-during-ease.md`). A design spike into the
map's pointer-only interactions with no keyboard equivalent recommended the
coordinate-entry and seamarks-in-view designs that shipped in `v0.19.0`
(see "Now" above), and surfaced a third gap — AIS vessel identification —
found while scoping the issue rather than already in it; all three
recommendations were filed as issues rather than implemented in the spike,
per the issue's own definition of done (a spike, not an epic), and the
third now sits in `v0.20.0` (see "Next" above)
([#714](https://github.com/DocGerd/sail_command/issues/714),
`docs/spikes/714-keyboard-map-equivalents.md`). Guard integrity:
`app/e2e/helpers.ts`'s `startPreview()` used to accept any 200 answering its
readiness poll on port 4173, with no check that the responder was this
run's own `vite preview` serving this run's own `dist/` — a foreign or
stale build could silently substitute for the one under test, producing
either a false red or a false green with nothing downstream able to tell
the two apart; it now byte-compares the served `index.html` and `sw.js`
against this run's own build and fails closed on any mismatch, though a
foreign build differing only in the subtrees the service worker's precache
manifest excludes is a named residual, since tracked as #833 alongside two
sibling residuals (#832, #854) in `v0.20.0`
([#803](https://github.com/DocGerd/sail_command/issues/803)). `ViaMarkers`
was executed by nothing in the suite — its only importer mocks
`maplibre-gl`'s `Marker` as a no-op and every reaching test passed an empty
via-point list — and now has real jsdom coverage of its construction
coordinates, its markers' accessibility contract, and both `snapBack`
branches ([#470](https://github.com/DocGerd/sail_command/issues/470)). And
three tooling additions continue the thread `v0.17.0` opened: a
`claim-auditor` subagent audits the PROSE of a change set — comments,
JSDoc, `CLAUDE.md`, specs, PR bodies, commit messages — for `CLAUDE.md`'s
own documented prose-rot classes, running alongside `sail-reviewer` rather
than in place of it ([#726](https://github.com/DocGerd/sail_command/issues/726));
a `sweep-closure` skill mechanically answers "does this diff owe an
`app/sweep/` #282 acceptance sweep", from the sweep's real import graph
unioned with its non-import inputs (data files, pipeline generators) — a
mechanical alternative to the hand-maintained prose path list `CLAUDE.md`
carries, which its own text warns is unsafe
([#729](https://github.com/DocGerd/sail_command/issues/729)); and a
`/release-cycle` command composes the existing release skills into one
six-phase wrapper for a whole cycle — state discovery, approval-gated
milestone re-triage, implementing the milestone, the cut, the `CLAUDE.md`
revision, and housekeeping — with two human gates, milestone approval
before any `gh` mutation and a local-run approval before the release PR
([#816](https://github.com/DocGerd/sail_command/issues/816)).

The `v0.17.0` cut settled eleven further items in this area, none with a
user-visible surface. Two of them are spikes that close as recommendations
rather than code. A demo mode for the Live view is declined in its
user-facing production form: the "let me see what Live does" audience is
served instead by a scripted Live screenshot built from tooling that already
exists, and #143's "must not ship as a user-facing production feature"
constraint survives the investigation unamended, with a UAT-only interactive
variant admissible only under four stated preconditions
([#749](https://github.com/DocGerd/sail_command/issues/749),
`docs/spikes/749-live-view-demo-mode.md`). The Boat tab's conflation of boat
selection, boat-scoped settings and global app settings resolves as: keep one
tab and move the genuinely device-scoped content into an explicitly labelled
group inside it, so the tab's name becomes true rather than renaming the tab
to fit its contents. That spike's separate ruling — that an account
credential and a vessel identifier belong neither in one card nor in one
store — is what sent #746's per-boat MMSI to the Boat surface
([#742](https://github.com/DocGerd/sail_command/issues/742),
`docs/spikes/742-boat-tab-scope-separation.md`).

Three guards are new or repaired. `artifact-guard.sh`'s `--selftest` could
not distinguish its subject exiting 0 with no output from a legitimate
empty-stdout allow, which left every want-allow row after that point
vacuous; a canary now feeds a known-ask payload through the script before the
battery starts and aborts with one diagnosis if it comes back anything else
([#424](https://github.com/DocGerd/sail_command/issues/424)). A new
`closing-keyword-guard.sh` PreToolUse nudge matches CLAUDE.md's validated
closing-keyword pattern against `git commit` and `gh pr create`, so a stray
`Closes #N` in a commit subject or a PR body is flagged before it silently
closes an issue on merge; it fails open, never blocking, per the
guard-asymmetry rule for a nudge
([#727](https://github.com/DocGerd/sail_command/issues/727)). A new
`ruff-on-pipeline-edit.sh` PostToolUse nudge runs `ruff check` and `ruff
format --check` against an edited `pipeline/**/*.py` file through
`pipeline/.venv`, mirroring the existing eslint hook and degrading quietly
when that venv is absent
([#728](https://github.com/DocGerd/sail_command/issues/728)). And a
fail-closed vitest guard rejects a `changelog.d/` fragment whose body opens
with a markdown heading: the loader accepts such a fragment and joins its
lines, so the heading markup ships into the About dialog's pending-changes
preview instead of being rejected
([#730](https://github.com/DocGerd/sail_command/issues/730)).

`app/sweep/` sat outside both lint scopes, so dead code there was invisible
to everything but CodeQL; ESLint now parses it, and the `lint` script covers
`src`, `e2e` and `sweep`
([#602](https://github.com/DocGerd/sail_command/issues/602)).
`App.test.tsx` still had one GPX-import site ungated against the pending
passive-effect race #631/#660 closed at its siblings — latent rather than
observed — and it is now gated the same way, with two prose defects in the
gating helper's own mechanism comment corrected
([#668](https://github.com/DocGerd/sail_command/issues/668)). The shallow-water
warning is extracted out of `RouteSummary.tsx` into its own
`ShallowWarning.tsx`, with no behaviour change
([#463](https://github.com/DocGerd/sail_command/issues/463)). And two
comments that claimed a uniqueness they do not have are corrected: `plan.ts`
called `formatDriftMin` *the* repo's single-unit-discarding formatter when
`formatHeading` is a second one
([#775](https://github.com/DocGerd/sail_command/issues/775)), and
`sweepArms.ts` named a `findRelaxedDepthM` and a `usedDepthM === null` path
that `v0.12.0`'s per-cell relaxation replaced with a whole-result null from
`findRelaxedGate`
([#527](https://github.com/DocGerd/sail_command/issues/527)).

The `v0.16.0` cut fixed nine further items in this area, none with a
user-visible surface. Two frozen-coordinate hit-tests that PR #419 had
deliberately left out of its #412 fix wave — flagged rather than asserted
safe, beside the six it did convert — now re-sample their geometry inside
the poll like those siblings
([#422](https://github.com/DocGerd/sail_command/issues/422)).
`withinMask` existed as three byte-identical private copies — in
`headingDepth.ts`, `routeProfile.ts` and `shallowExposure.ts` — of a bounds
convention `NavMask.cellOf` already computes one layer down; all three are
now lifted onto `NavMask` itself
([#517](https://github.com/DocGerd/sail_command/issues/517)). Five test
keepers touched by PR #538 pinned a wording or a literal value rather than
the property they were named for, so none would have fired when it mattered;
each now asserts that property itself
([#548](https://github.com/DocGerd/sail_command/issues/548)). The
per-plan worker polar map is now built with `Object.create(null)` and read
with `Object.hasOwn`, so a prototype-chain lookup can no longer return an
inherited table and skip a fail-closed guard — defence in depth against a
residual the analysis that correctly dismissed a CodeQL alert as a false
positive had surfaced, not a live bug
([#601](https://github.com/DocGerd/sail_command/issues/601)). Two
independent artifacts each carried a stale claim about the #376 e2e
idle-gate audit after it had closed — one asserting a sibling spec probably
shared the fixed race when that spec has never contained the construct at
all, the other still calling the question unconfirmed — and both are
corrected ([#618](https://github.com/DocGerd/sail_command/issues/618)).
`mask.test.ts`'s `onLand` snap test probed a point that is actually water,
roughly 305 m from the cell centre its own comment named rather than the
32 m claimed, so its assertions were satisfied before the snap path ran at
all; it now probes a real land point and asserts that point is un-navigable
first, so the path under test is actually entered
([#622](https://github.com/DocGerd/sail_command/issues/622)). Four
`maplibre-gl` source-comment line-number citations, stale independently of
PR #671's version bump, are corrected
([#674](https://github.com/DocGerd/sail_command/issues/674)).
`boat-selection.png` — the one README screenshot with no generator, so the
only one whose language, framing and freshness nothing enforced — is now
emitted by `docs/screenshots/capture.mjs` alongside the other two
([#716](https://github.com/DocGerd/sail_command/issues/716)). And the README
screenshot pair, whose differing aspect ratios (1280x1000 against 1280x800)
left the two-column table visibly misaligned, is now stacked vertically with
a caption each rather than re-cropped
([#743](https://github.com/DocGerd/sail_command/issues/743)).

The `v0.15.0` cut fixed two further items in this area, neither with a
user-visible surface. `pipeline/verify_mask.py`'s five safety-critical bare
`assert` statements — mask-grid bounds, the per-boat gate-derivation
cross-check, decimetre-quantisation drift, connectivity-seed navigability,
and harbor `approachNote` completeness — could be silently stripped by
`python -O`/`PYTHONOPTIMIZE=1`; each is now an explicit `if <condition>:
raise AssertionError(...)` check (the condition differs per site — `if not
(...)`, `!=`, `>=`, `== 0`, `not in`) that survives optimisation, with a
mutant reproducing the exact original hazard on a reverted single check
([#613](https://github.com/DocGerd/sail_command/issues/613)).
`.github/scripts/check-no-home-paths.sh` scanned tracked file *content* via
`grep`, which follows a symlink to its target's content rather than reading
the link's own stored target path — so a committed symlink whose target
string named a home directory was invisible to the guard; it now also
scans every tracked symlink's `readlink` target against the same pattern
classes ([#479](https://github.com/DocGerd/sail_command/issues/479)).

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
cut, since grown to 363 plans across eleven arms, with a required BASE
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
defect itself was tracked separately and later accepted rather than
mitigated at the `v0.18.0` cut (see that cut's paragraph above)
([#383](https://github.com/DocGerd/sail_command/issues/383), underlying
defect [#391](https://github.com/DocGerd/sail_command/issues/391)); and an
e2e regression pin for the #205 narrow-width overlap fix
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

- Wind barbs along the route at passage time — at each position, the wind
  expected when the boat will actually be there — as a second sampling mode
  beside today's single-slider-hour field
  ([#293](https://github.com/DocGerd/sail_command/issues/293)).
- The five harbors that remain disconnected from the routable mask
  ([#9](https://github.com/DocGerd/sail_command/issues/9)). This one is
  **blocked on physics, not effort**: at the mask's ~46 m cell size the
  channels involved are sub-cell, and reconnecting them would mean fabricating
  depth data. The issue was closed on 2026-09-02 as blocked on external data
  once its user-facing residual had shipped as #652 in `v0.18.0`; the finding
  itself stays pinned in code (`pipeline/verify_mask.py`'s
  `KNOWN_DISCONNECTED` allowlist and its app-side twin in the required `app`
  CI job) and is revisited only if hi-res bathymetry becomes available.
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
