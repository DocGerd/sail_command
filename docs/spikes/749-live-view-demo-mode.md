# Spike: a demo mode for the Live view — user-facing, UAT-only, or declined?

- Issue: [#749](https://github.com/DocGerd/sail_command/issues/749)
- Date: 2026-08-31
- Status: Recommendation (no implementation in this change; no production code touched)
- **Verdict: DECLINE the user-facing production demo mode. Serve the "let me
  see what Live does" audience with a scripted Live SCREENSHOT produced by the
  tooling that already exists (`docs/screenshots/capture.mjs` plus the
  geolocation emulation `app/e2e/live.spec.ts` already uses), and leave the
  developer/reviewer harness where it already is — #143, whose "must not ship
  as a user-facing production feature" constraint SURVIVES this spike
  unamended. If a UAT-only interactive demo is nevertheless wanted, it is
  admissible only under the four preconditions in §7.2, one of which (the
  plan-store write path) is not a copy change but a code change.**

Filename note: #749's Deliverable section asks for
`docs/spikes/<this-issue>-live-demo-mode.md`; this file is
`749-live-view-demo-mode.md`. Same `<issue>-<slug>.md` convention, different
slug — the deviation is recorded here so a reader searching for the issue's
literal filename knows where it went.

---

## 0. Method, and what this document is allowed to claim

Every claim below names the FILE and the SYMBOL it was read from. Everything
was re-read from the working tree at `develop`@`2082281` on 2026-08-31; nothing
is stated from memory, and nothing is carried over from the issue text without
being checked against the code first. Where the issue text and the code
disagree, §1.6 says so.

Three things this document deliberately does NOT do:

- It does not write a spec. A spike is evidence for a decision; promoting one
  to a spec is a main-session act. §10 says what a spec amendment would have to
  cover if a UAT demo is ever approved.
- It does not edit #143. §9 states the recommended edit for a maintainer to
  apply.
- It measures nothing in a browser. Claims that would need one are named
  UNMEASURED where they appear (§2.3, §6.2, §7.1) rather than asserted.

---

## 1. What already exists — read, not assumed

### 1.1 There are TWO GPS consumers, and production injects neither

`app/src/services/geolocation.ts` exports exactly one wrapper,
`watchPosition(onFix, onError)`, over `navigator.geolocation.watchPosition`.
Two call sites import it, both aliasing it locally to `realWatchPosition`:

| Consumer | Injection seam | What `App.tsx` actually passes |
|---|---|---|
| `app/src/components/LiveView.tsx` :: `LiveViewProps.watchPosition?: typeof realWatchPosition`, defaulted in the destructuring (`watchPosition = realWatchPosition`) | prop | NOTHING — `App.tsx`'s `<LiveView …>` passes only `panelSlot` and `reroute` |
| `app/src/state/useOwnshipGps.ts` :: second parameter, `watchPosition: typeof realWatchPosition = realWatchPosition` | function parameter | NOTHING — `App.tsx` calls `useOwnshipGps(settings.showOwnship)` with one argument |

So both seams exist, both default to the real wrapper, and **neither is wired
to anything in production today**. Their only non-default callers are unit
tests (`LiveView.test.tsx` passes `watchPosition={wp}`).

This matters more than it looks. `OwnshipMarker` is mounted unconditionally in
`App.tsx` — the comment directly above that JSX says it "Renders in ANY
tab/plan state, Live View included; LiveView itself no longer renders a marker
… so this is the single place BoatMarker ever renders". Its fix comes from
`useOwnshipGps`, gated only on `settings.showOwnship`. **A demo that injects
LiveView's seam alone puts a synthetic boat in the Live readout while the map's
only boat marker keeps showing the user's REAL position** — two positions, one
map, disagreeing. Injecting both instead means the synthetic position escapes
the Live tab entirely, since that marker is not tab-gated. There is no third
option: cover both seams or neither.

### 1.2 What `app/e2e/live.spec.ts` can and cannot simulate

Read in full. It drives `test.use({ permissions: ['geolocation'], geolocation:
FIX_ORIGIN })` plus `context.setGeolocation(…)` through the REAL
`services/geolocation.ts` path — its own header says "no injected
watchPosition, unlike the jsdom component tests".

**CAN simulate:**

- Position, deterministically, at three hand-picked waypoints
  (`FIX_ORIGIN`, `FIX_FJORD_MOUTH`, `FIX_OFF_SOENDERBORG`), each documented in
  that file as snap-verified against the real committed mask.
- Wind, deterministically, via `?windFixture=test-fixtures/wind-sw12.json`.
- The whole downstream chain for real: the heading-to-steer readout, leg
  advance, the reroute lifecycle against the real solver/mask/polars, and the
  rerouted plan appearing as a second row in the Routes list.

**CANNOT simulate — and this is the load-bearing half:**

- **Course and speed over ground.** The spec's own comment says so: "Chromium's
  emulated position carries no heading/speed -> the wrapper maps both to null
  -> the readout shows the en-dash placeholders", and it then asserts
  `cogSogValues.nth(0)` and `.nth(1)` are both `'—'`. Each `FIX_*` literal in
  that file carries only `latitude`, `longitude`, `accuracy`. So the harness
  cannot show a MOVING boat's COG/SOG at all — exactly the two numbers a "see
  Live working" demo exists to show.
- **Motion.** `context.setGeolocation` is a teleport between discrete points.
  There is no trajectory, no fix rate, no jitter — the three things #143's
  "track playback … with plausible COG/SOG jitter" asks for.
- **AIS.** Its header states the network-free invariant outright: "no
  `aisApiKey` is ever set, so mounting the Live tab opens ZERO sockets (#25
  BYOK)." No AIS target is ever rendered by this spec.
- **Anything a human can reach.** Geolocation emulation is a test-runner (CDP)
  capability. It is not an app-level hook and does not exist in a browser
  someone is holding.

The gap between this harness and a demo is therefore precisely: COG/SOG,
continuous motion, AIS, and reachability by a non-Playwright user.

### 1.3 AIS is inert without a key, and the "injectable socket factory" is not reachable from the UI

`app/src/state/useAisTraffic.ts` :: the connection-lifecycle `useEffect` opens
with `if (apiKey === undefined || apiKey.length === 0 || !online || !visible ||
bboxes === null || bboxes.length === 0) { … return; }`, and only past that
guard does it call `createClient(apiKey, …)`. Its `defaultCreateClient` is
`new AisStreamClient(apiKey, callbacks, { socketFactory: browserAisSocket })`.

Two consequences that #749's and #143's own text both understate:

1. **The `deps.createClient` seam cannot be reached from the rendered tree.**
   `app/src/components/AisTraffic.tsx` calls `useAisTraffic({ apiKey, ownMmsi,
   bboxes, corridorBoxes, online, visible })` with **no second argument**, and
   its own props are exactly `{ apiKey, ownMmsi, plan, rig, activeLegIndex }` —
   there is no `createClient` prop to thread. #143's "the AIS client already has
   an injectable socket factory by design" is true of `AisStreamClient`'s
   constructor and false of the path a demo would have to travel: today only
   `useAisTraffic`'s own unit tests pass `deps`.
2. **A synthetic AIS feed cannot ride that seam without faking a key.** The
   guard is on `apiKey`, not on `createClient`. To construct any client at all
   the demo must supply a non-empty `apiKey` — and `useAisTraffic`'s derived
   `status` starts `!keyValid ? 'off' : …`, so the moment a fake key exists the
   status chip stops saying "off" and starts saying "connecting" or "live".
   **The demo would have to make the app claim a live AIS connection it does not
   have** — the same class of fabrication §2 is about, applied to a status
   indicator instead of to a position.

The CSP is a further boundary, not a way round it: `app/vite.config.ts` sets
`connect-src 'self' https://api.open-meteo.com wss://stream.aisstream.io`. A
same-origin static fixture (the `?windFixture=` shape) is allowed; a socket to
anywhere else is not.

### 1.4 The one query-parameter escape hatch that exists

`app/src/state/usePlanFlow.ts` reads
`new URLSearchParams(location.search).get('windFixture')` inside its `run()`
and passes it to `fetchWind`. It is read fresh per solve and stored nowhere. A
grep of `URLSearchParams` under `app/src` excluding tests (2026-08-31) returns
exactly this site plus `app/src/services/openMeteo.ts`, which builds its own
outbound request query — so `?windFixture=` is the sole precedent for a
URL-activated behaviour change.

### 1.5 The UAT-only pattern, and the constraint nobody expects

`app/src/vite-env.d.ts` declares `__SC_UAT__`; `app/vite.config.ts`'s `define`
sets it to `JSON.stringify(isUat)`. The gate in `app/src/App.tsx` is a
fold-exact ternary in the `h1` title slot, with its own comment recording the
measurement: an `{__SC_UAT__ && <UatBadge />}` sibling "minifies to a `!1`
residue (measured: 3-byte bundle drift)". `app/src/components/UatBadge.dict.ts`
keeps its one key's de/en pair out of the main dictionaries for the same
reason, while still holding the `satisfies` parity convention locally.

The constraint that decides §6 is in `UatBadge.tsx`'s own docstring:

> No dedicated CSS either — the shared `.chip` pill is the entire visual (a
> UAT-only rule in app.css would change the production stylesheet);
> `.uat-badge` is an unstyled hook for tests/browser passes.

`app/src/main.tsx` imports `./app.css` unconditionally. There is one global
stylesheet, in every build. **So the existing UAT-only pattern buys a component
and a dictionary for free, and buys no new pixels at all.**

### 1.6 Where the issue text and the code disagree

Recorded so a later reader does not have to re-derive it:

- #749's seam table gives the GPS production default as `realWatchPosition`.
  The EXPORT is `watchPosition` (`app/src/services/geolocation.ts`);
  `realWatchPosition` is the local alias both import sites give it. Harmless,
  but a grep for the export name will not find it.
- "AIS: `useAisTraffic` accepts an optional `createClient`" is correct about the
  hook and incomplete about the app — see §1.3(1).
- Both issues describe the GPS seam in the singular. There are two (§1.1).

---

## 2. Question 2 first: the safety framing, which is what sinks the user-facing variant

#749 says to answer this one first because it is the question most likely to
sink the idea. It does.

### 2.1 A demo GPS fix reaches a durable write

`LiveView.tsx` renders a reroute action labelled `t('live.reroute.action')` =
"Replan route from here" (`app/src/i18n/dict.en.ts`). `App.tsx` wires its
`onReroute` to `handleLiveReroute`, and `app/src/state/reroute.ts` imports
`savePlan` from `../services/db`, builds a request with `origin: { ...fixPoint
}` and `originHarborId: null`, and persists it. `live.spec.ts` asserts exactly
this: after one reroute, `.plans-list-row` has **count 2**, one of them matching
`'(ab Position neu geplant)'`.

The only mark that plan carries is its NAME — `t('live.reroute.name')` =
`'{name} (replanned from position)'`. Nothing in `Plan`, `PlanRequest` or
`BoatSnapshot` (`app/src/types.ts`) records where the position came from.

**So a demo mode that feeds a synthetic fix into `LiveView` lets a user
manufacture a saved plan whose origin is fabricated, sitting in
`PlansList.tsx`'s list next to real ones, with no field that distinguishes them
and no field that could.** It survives the demo being switched off, survives a
reload, and survives reinstalling the PWA (IndexedDB, `app/src/services/db.ts`).
That is strictly worse than a fabricated position on screen, which at least
disappears when the demo does.

Fixing it is a code change, not a copy change, and neither available shape is
free: disable the reroute action while the demo feed is live (a behaviour
difference between the gated build and production, inside `LiveView`), or add a
provenance field to the persisted `Plan` and render it in `PlansList` (a
stored-record schema change — §5.3 for how the pre-1.0 ruling applies).

### 2.2 "Unmistakable" and "the map still looks like the real thing" are in tension with the UAT byte-identity rule

#749 asks whether it can be guaranteed that a demo is unmistakably not real
"while the map still looks like the real thing". Under the existing UAT pattern
the honest answer is: **not with new pixels.** §1.5's constraint means a
UAT-gated demo indicator may reuse existing classes (`.chip`, as `UatBadge`
does) but may not add a rule to `app.css` without changing production's
stylesheet bytes. A "DEMO" chip in the header is reachable; a full-width
persistent overlay banner, a tinted map, or a watermark is not — not without
either shipping that CSS to production or first measuring a mechanism this repo
has never measured (§6.2).

That is a real narrowing of the safety instrument, and it is why §7 does not
recommend the interactive variant as the primary answer.

### 2.3 What a fabricated ownship actually shows

The Live readout is not decoration. `LiveView.tsx` renders heading-to-steer
(`live.hts.label` = "HTS") together with depth and land cautions
(`live.hts.depthCaution`, `live.hts.landCaution` = "Bearing crosses charted
land", `live.hts.depthUnchecked`) computed against the real committed mask. A
demo therefore renders REAL hazard assessments of a FAKE position.

The app's safety framing is carried per-string — `live.gpsHint` ends "this is a
passage-planning aid, not a navigation device" and `live.reroute.hint` ends "A
planning aid, not navigation guidance" — but every one of those strings is
about the APP, not about the position's authenticity, and not one of them
becomes false in a demo. **The existing copy does not cover this hazard and
would read as reassurance while the position is invented.**

UNMEASURED: whether a reader actually mistakes a demo readout for a live one.
No user research exists in this repo and none was done here; the argument above
is structural (what the artifacts are), not empirical (what people conclude).

---

## 3. Question 1: audience — three audiences want three different things

| Audience | What they need | Cheapest thing that satisfies it |
|---|---|---|
| Prospective skipper / README reader | to SEE the Live readout once | a screenshot — §7.1 |
| Reviewer / maintainer at a desk | to EXERCISE Live while changing it | #143's harness, dev- or UAT-gated |
| Regression testing | determinism, in CI | `app/e2e/live.spec.ts`, which already exists (§1.2) |

These are not one feature. Only the first is what #749 calls a "demo mode", it
is the only one that would have to ship to production, and it is also the one
satisfied by an artifact that costs zero bundle bytes and carries zero
fabricated-navigation risk. That asymmetry is the whole recommendation.

`README.md` today references three images —
`docs/screenshots/start-view.png`, `docs/screenshots/plan-route.png` and
`docs/screenshots/boat-selection.png` — and **none of the Live view**. The demo
audience is currently served by nothing at all, which is the real gap #749
identifies. It is a docs gap, not an app gap.

---

## 4. Question 3: scope of the fake

Ranked by blast radius, smallest first, with what each row breaks read from the
code.

| Layer | Reachable today? | Blast radius |
|---|---|---|
| Wind | yes, already shipped | `?windFixture=` (§1.4). Read per solve, persisted nowhere. Already the input to every planning e2e spec and to `capture.mjs`'s docs fixture. |
| GPS | yes, via two seams | Must cover BOTH (§1.1) or the map shows two boats. Reaches the durable plan store through reroute (§2.1). |
| AIS | no, not without faking a key | Requires a non-empty `apiKey`, which flips the status chip off `'off'` (§1.3). Widens the fake from a position to a CONNECTION STATE. |

**Recommendation on scope: GPS only, and only if §7.2's preconditions hold.**
Synthetic AIS is rejected outright (§8, R4) — not because it is hard, but
because the only way in makes the app assert a network state that is false.

---

## 5. Question 4: activation and exit

### 5.1 A query parameter cannot be left on; a stored flag can

`app/vite.config.ts`'s PWA `manifest` sets `start_url: '.'`. An installed PWA
therefore launches at the base path with no query string, so a `?demo=…`
activation **cannot survive an installed relaunch, by construction** — which is
exactly the guarantee #749's question 4 asks for. It does survive a reload of a
URL that still carries the parameter, and it survives being bookmarked or
pasted; those are the residuals, and they are visible in the address bar.

The opposite shape has a shipped cautionary precedent.
`app/src/lib/gpsHint.ts` :: `claimGpsHintOnce()` writes `sc-gps-hint-shown` =
`'1'` through `safeSetItem`, and its own comment says the hint is marked shown
"forever". No in-app control clears it. A localStorage demo flag would inherit
exactly that lifetime: it survives reloads, service-worker updates and PWA
relaunches, with nothing in the UI to turn it off if the toggle that set it is
later hidden or removed.

**So activation must be the query parameter, never `lib/storage.ts`.**

### 5.2 The service-worker question, answered narrowly

#749's question 4 asks specifically about surviving a service-worker reload.
With a query-parameter activation the answer does not depend on the service
worker's routing at all, which is why this section is short: the activation
state is held in the URL, not in anything the app or the worker stores. Two
verified facts settle it — `app/src/state/usePlanFlow.ts` re-reads
`location.search` on every solve rather than caching it (§1.4), and no
persistence call anywhere would be involved (§5.1's rule). Whatever
`app/src/sw.ts` serves for a navigation, the query string the app reads is the
one in the address bar.

So the service worker is neither an escape route from an active demo nor a way
to get stuck in one. It becomes relevant only under R5's rejected
localStorage shape, where the flag outlives every reload the worker mediates.

### 5.3 If provenance is added to stored plans (§2.1), the pre-1.0 ruling applies

`docs/adr/0002-pre-1.0-db-migration-low-priority.md` is the standing ruling:
before v1.0.0, do not build IndexedDB migration machinery. A `Plan`-level
provenance field must therefore be readable with an ABSENT value on every
existing record. Absent = "real" is the correct default here — every record
written before the field existed was real — which makes this the rare case
where the safe default is also the permissive one. Say that explicitly in the
field's own comment, or the next reader will "fix" it the other way.

---

## 6. Question 5: prod bundle cost

### 6.1 What the existing pattern guarantees, and what it does not

A `__SC_UAT__` fold-exact ternary at the import site drops the JSX call, the
import, and the whole module graph behind it (`App.tsx`'s own comment, and
`UatBadge.dict.ts`'s). The required evidence is a prod double-build versus base
`diff -r`, byte-identical — and **that check is not CI-gated**. It is a manual
step that whoever adds a gate has to perform and report in the PR.

### 6.2 The CSS question is open and must not be assumed

UNMEASURED, and named as such: whether a stylesheet imported from a module that
`__SC_UAT__` dead-code-eliminates is elided from the production CSS bundle.
What IS certain is narrower — `app.css` is imported unconditionally from
`main.tsx`, so a rule added THERE ships in every build. Whether a separate CSS
file imported only from a gated component would be tree-shaken out of the
production stylesheet has not been measured in this repo, and `UatBadge`
deliberately avoided finding out by adding no CSS at all.

**Anyone proposing a UAT-only demo with its own styling owes that measurement
first** (build prod at base and at HEAD, `diff -r`), because a negative result
there means the safety indicator and the byte-identity guarantee cannot both be
satisfied — which invalidates the shape rather than costing it a round.

---

## 7. RECOMMENDATION

### 7.1 Primary — DECLINE the user-facing demo; close the real gap with a screenshot

1. **Decline** a demo mode shipped to production for end users. The decisive
   reason is §2.1 — a fabricated fix reaches a durable, indistinguishable plan
   record — reinforced by §2.2 (the strongest "this is not real" indicator
   available under the existing UAT pattern is a chip) and §1.3 (any AIS layer
   makes the app assert a connection state that is false).
2. **Add a Live-view screenshot to `README.md`**, produced by extending
   `docs/screenshots/capture.mjs`. That script already runs Playwright in
   LIBRARY mode (`chromium.launch()` — its own comment names the mode and the
   30 s actionability default that comes with it) and already parameterises its
   target through `SC_SCREENSHOT_URL`. `live.spec.ts` demonstrates the whole
   flow — plan a route, switch to Live, toggle tracking on, get a readout —
   under emulated geolocation.

   Stated as a task, not as a finding: `capture.mjs` currently creates its page
   with `browser.newPage({ viewport })`, i.e. an implicit context, whereas
   geolocation emulation is a BrowserContext capability, so this needs an
   explicit `browser.newContext({ permissions, geolocation })`. Whether that
   composes with the script's existing `setViewportSize` pattern is UNMEASURED
   and is the first thing a follow-up should check.

   Note what such a screenshot honestly can and cannot show: per §1.2, COG and
   SOG will render as `—`, because Chromium's emulated position carries
   neither. A capture must not be framed to hide that — the same rule that
   governs the existing docs images, whose freshness-and-representativeness
   history is recorded at #459/#716.
3. **Keep #143 as the developer harness**, constraint intact (§9).

### 7.2 Conditional — if a UAT-only interactive demo is wanted anyway

Admissible, but only with all four preconditions. Any one of them missing makes
it the declined variant wearing a different label:

1. **Both GPS seams driven from one source, or neither** (§1.1). A
   LiveView-only injection is a defect, not a smaller feature.
2. **No path from the demo feed to `savePlan`** (§2.1). Either the reroute
   action is inert while the feed is live, or `Plan` carries provenance that
   `PlansList` renders. Choose one and say which; do not ship neither.
3. **Activation by query parameter only** (§5.1), never `lib/storage.ts`.
   `start_url: '.'` is then the exit guarantee.
4. **GPS only** (§4). No synthetic AIS, and no synthetic connection status.

Plus the standing evidence requirement: a prod double-build `diff -r`
byte-identity check reported in the PR (§6.1) and, if any styling is added, the
CSS measurement in §6.2 performed FIRST.

---

## 8. Considered and rejected

Recorded so a declined option cannot quietly return as a fresh idea.

**R1 — A user-facing demo mode shipped to production. REJECTED.** §2.1 is the
reason, and it is structural rather than a matter of copy: the reroute action
persists a plan built from the current fix, `state/reroute.ts` writes it through
`savePlan`, and the only distinguishing mark is a name suffix that says nothing
about authenticity. A demo that cannot write to the plan store is not the
feature that was asked for — it would omit the reroute, one of Live's two
interactive behaviours — while a demo that can write to it manufactures durable
records indistinguishable from real ones. Sufficient on its own under the
existing UAT pattern, secondarily: §2.2, where the loudest available "not real"
indicator is a chip.

**R2 — Building the demo as a further increment of #143. REJECTED as a
re-labelling.** #143's constraint ("Must not ship as a user-facing production
feature") is what #749 exists to test, and this spike's answer is that the
constraint is CORRECT and stands. Building a user-facing demo under #143's
number would overturn a written constraint via an increment — the exact move
#749's own "Do not silently build a user-facing feature under #143's number"
forbids.

**R3 — Extending `app/e2e/live.spec.ts` to serve the demo audience. REJECTED as
a category error.** Geolocation emulation is a test-runner (CDP) capability
(§1.2); it is unreachable from a browser a human is holding, so no amount of
extension turns that spec into something a prospective skipper can run. That
spec should be extended for TEST reasons on their own merits — which is #143's
business and its own, not #749's.

**R4 — Synthetic AIS targets, in any variant. REJECTED.** The `apiKey` guard in
`useAisTraffic.ts` is what makes AIS inert without a key, and it is what
`live.spec.ts` relies on for the network-free invariant. Reaching a synthetic
feed requires a non-empty key, which flips the derived `status` off `'off'`, so
the demo would have to make a status chip claim a live connection that does not
exist (§1.3). Weakening that guard to admit an injected client without a key is
worse still: it turns a single, easily-audited condition into a conditional one,
inside the module whose inertness the whole network-free e2e suite depends on.

**R5 — A persisted (localStorage) demo toggle. REJECTED.** §5.1: the shipped
`sc-gps-hint-shown` precedent shows what a stored flag with no in-app clear
looks like — permanent. A demo flag with that lifetime fails #749's own question
4 ("what guarantees it cannot be left on"), and it would survive the one event
that should reset everything, a fresh PWA launch.

**R6 — Reusing `?windFixture=`'s mechanism to also carry a GPS track. REJECTED
as scope creep onto a load-bearing test hook.** `?windFixture=` is read by
exactly one site (`usePlanFlow.ts`) and is the sole deterministic wind input for
every planning e2e spec and for `capture.mjs`'s docs fixture. Overloading it
with a second, differently-shaped payload puts a demo feature in the dependency
path of the whole deterministic-test story. A separate parameter costs nothing.

**R7 — Threading `watchPosition`/`createClient` through `App.tsx` so production
code carries the injection points. REJECTED.** The seams already exist at the
two hooks/components (§1.1, §1.3); routing them through `App.tsx` would put
demo-shaped plumbing into the production module graph in order to serve a
feature that, per R1, is not shipping to production. If the §7.2 variant is ever
approved, the gate belongs at ONE fold-exact import site — the `UatBadge` shape
— not as props on the real components.

---

## 9. Relation to #143, and the recommended edit (NOT applied here)

#143 (open as of 2026-08-31, milestone Backlog, labels `type: feature`,
`priority: medium`, `area: tooling`) proposes track playback, scripted
scenarios, play/pause controls, and "later, once #25 lands: synthetic AIS
vessels through the same harness".

**#749's answer neither subsumes nor supersedes #143.** They serve different
audiences (§3): #143 is the developer/reviewer harness; #749 asked about an
end-user demo. The relation is that #749 RESOLVES the contradiction #143's own
constraint created — in #143's favour.

Recommended edits for a maintainer to apply to #143 (this spike does not touch
it):

1. Record that #749 tested the "must not ship as a user-facing production
   feature" constraint and that it STANDS, linking this document, so the
   constraint is not re-litigated as a fresh idea.
2. Correct the AIS sentence. "The AIS client already has an injectable socket
   factory by design" is true of `AisStreamClient`'s constructor and misleading
   about the reachable path: `AisTraffic.tsx` passes no `deps` to
   `useAisTraffic`, and the client is constructed only past a non-empty `apiKey`
   guard (§1.3). Planning from that sentence under-estimates the work and
   mis-scopes the risk.
3. Note that the GPS seam is TWO seams (§1.1), and that a harness covering only
   `LiveView` leaves `OwnshipMarker` on the real position.
4. Apply §7.2's preconditions 1 and 2 to the harness as well. Both are about
   what a synthetic fix can REACH, which does not depend on who the audience is.

`docs/adr/README.md` records that #644 tracks consolidating `docs/spikes/` and
`docs/adr/`; until that lands, both directories must be checked before assuming
a decision is unrecorded. This document lives in `docs/spikes/` because it is an
investigation ending in a recommendation, not a maintainer ruling already made.

---

## 10. Does anything here need a real spec amendment?

**Not for the recommendation in §7.1.** A README screenshot and a `capture.mjs`
extension touch no spec: that script is explicitly manual and not CI-gated, and
no file under `docs/superpowers/specs/` mentions a demo or a simulator at all
(grepped 2026-08-31, case-insensitive, for `demo` and `simulat` over
`docs/superpowers/specs/*.md`: zero hits).

**Yes, for §7.2's precondition 2 if the provenance route is chosen.** Adding a
field to the persisted `Plan` changes a stored-record shape and the guarantees
around what a saved plan asserts. That is a spec-level change and a main-session
act; this document does not make it, and no implementation should proceed on the
strength of this paragraph alone.

**Yes, for any weakening of the AIS key guard** (R4).
`docs/superpowers/specs/2026-07-23-ais-traffic-overlay-design.md` states the
invariant directly — "Live-tab-only, BYOK-inert (no key → zero sockets)", and
again in its acceptance list, "No key → zero sockets; offline e2e untouched" —
so changing it is not an implementation detail.

---

## 11. What this document does not establish

- That a demo mode would in fact mislead a real user (§2.3). The case against is
  structural, not empirical.
- That a Live screenshot is producible without changing `capture.mjs`. §7.1
  item 2 names the explicit-context change as a task and its composition with
  the viewport pattern as UNMEASURED.
- Whether a gated component's own CSS file is elided from the production
  stylesheet (§6.2). That measurement is a precondition for the §7.2 variant,
  not an output of this spike.
- Anything requiring a browser. Every statement above is read from a committed
  artifact and cites it.
