# Spike: logging and diagnostics in a backend-less, offline-capable PWA with three execution contexts

- Issue: [#435](https://github.com/DocGerd/sail_command/issues/435)
- Date: 2026-08-07
- Status: Recommendation (no implementation in this change)
- **Verdict: build a bounded in-memory ring buffer written only by app code, with no live log view and no persistence — its single user-facing surface is a "copy / download diagnostics" pair in the About dialog — and pay for it with exactly one worker-protocol type change (`fatal` gains an optional `stack`) plus a typed `RoutingError` on the client, so the same discriminator that makes the log useful is the one #433 uses to make the banner accurate.**

This document answers all 13 questions in #435's "Questions to answer"
section, under its own three headings (How / Where applicable / What to
do). It changes no code under `app/src/`, `app/vite.config.ts` or
`pipeline/`.

Everything below is measured against this worktree at branch point
`develop`@`3979bae` — the same commit #435's own baseline names, so the
re-verification in §0 is a true replication rather than a comparison
across moving code.

---

## 0. Re-verification of #435's measured baseline — one real error found

#435 asks that every factual claim carry a `file:line` or command output.
Its own baseline was re-run rather than copied. Method, verbatim:

```
cd app/src
grep -rnoE 'console\.[a-z]+\(' . --include='*.ts' --include='*.tsx' | grep -vE '\.test\.(ts|tsx):'
grep -rnoE 'console\.[a-z]+[^(a-z]' . --include='*.ts' --include='*.tsx' | grep -vE '\.test\.(ts|tsx):'
```

### Confirmed exactly as stated

| Claim | Result |
|---|---|
| 17 direct `console.*` invocations | 17 — `wc -l` on the first command |
| 4 bare callback references | `App.tsx:312`, `DataLayers.tsx:247`, `DepthProfile.tsx:177`, `PlansList.tsx:74` |
| 4 comment mentions that log nothing | `routeCorridor.ts:85` (inside the JSDoc at `:78-88`), `main.tsx:24` (inside the comment at `:22-26`), `swRecovery.ts:26`, `AppState.tsx:34` |
| 21 real sites across 14 non-test files | 17 + 4; 11 files carry an invocation, 3 more carry only a bare reference |
| By location: root 2 · `components/` 9 across 5 files · `services/` 4 · `state/` 5 · `lib/` 1 · **`routing/` 0** | 2 + 9 + 4 + 5 + 1 = 21 |
| Every site is `error` or `warn`; zero `log`/`info`/`debug` | confirmed — the second command returns only `.error`/`.warn` forms |
| No React error boundary | `grep -rnE 'componentDidCatch\|getDerivedStateFromError\|ErrorBoundary'` → **0** |
| No `unhandledrejection` / `window.onerror` listener | 1 grep hit, and it is a **comment** at `ReloadPrompt.tsx:28` — no listener exists. The claim is correct; the grep is not self-evidently so |
| No `logger`/`telemetry`/`sentry`/`reportError` | **0** non-test hits |
| No dev/prod gate | every `import.meta.env` hit in `src` is `BASE_URL` (9 sites: `sw.ts:73`, `lib/glyphs.ts:79`, `AboutDialog.tsx:46`, `MapView.tsx:82,83,223`, `assets.ts:22`, `glyphWarmup.ts:71,126`) |
| Only query param read is `?windFixture=` | `usePlanFlow.ts:193` is the only `URLSearchParams`/`location.search` read in the app; `openMeteo.ts:38` constructs one, does not read one |
| `WorkerResponse` is a closed union; `fatal` is `{ type: 'fatal'; id: string \| null; message: string }` | `protocol.ts:15-22`; the `fatal` arm is `:22` |
| `usePlanFlow.ts` has five bare `} catch {` | `:133`, `:143`, `:228`, `:238`, `:264` |
| `error.internal` produced at `usePlanFlow.ts:48, :204, :243, :265` | confirmed |
| CSP `connect-src 'self' https://api.open-meteo.com wss://stream.aisstream.io` | `app/vite.config.ts:161`, inside `cspMeta()`'s `directives` array |
| IndexedDB: two stores, schema version 1 | stores typed at `db.ts:4-7`; `openDB<SailDB>('sailcommand', 1, …)` and both `createObjectStore` calls at `db.ts:12-17` |

### WRONG — the planning-flow error does not render where #435 says it does

> #435: *"It renders at `components/RouteSummary.tsx:154` as a single
> `<p role="alert">` holding one generic translated string: no detail, no
> stack, nothing copyable, and byte-identical across every distinct
> cause."*

`RouteSummary.tsx:154` is real and is one generic `<p role="alert">`:

```
<p role="alert">{t(reason ? NO_ROUTE_MESSAGE_KEY[reason] : 'error.internal')}</p>
```

— but it is a **different surface**. It renders when an already-loaded
plan has no `result`/`summary` for the selected rig (`RouteSummary.tsx:153`,
`{!result || !summary ? …}`); its `error.internal` is the fallback for a
missing `reason`, and it is never reached by `usePlanFlow`'s
`PlanningState`.

The planning-flow error — the one every `error.internal` in
`usePlanFlow.ts:204/:243/:265` and every `mapWindError` fallthrough at
`:48` actually produces — renders at **`App.tsx:806-823`**, as a
`<Banner>`:

```
{planning.phase === 'error' && (
  <Banner
    kind={planErrorBannerKind(planning.messageKey)}
    action={ planErrorGroup(planning.messageKey) === 'network' && … }
  >
    {t(planning.messageKey)}
  </Banner>
)}
```

Why this matters, and it is not a nitpick:

1. **The banner is already structured.** `planErrorGroup`
   (`App.tsx:112-116`) classifies into `network` / `noRoute` /
   `unexpected`, `planErrorBannerKind` (`:121-123`) picks the paint, and
   `:809-819` attaches a "Try again" action to network errors only. #433
   does not need to invent a presentation layer — it needs to add a cause
   dimension to one that exists. Aiming #433 at `RouteSummary.tsx` would
   have been the wrong file.
2. **The banner is NOT byte-identical across every cause** — it is
   byte-identical across the causes that collapse onto `error.internal`.
   `error.offline` / `error.rateLimited` / `error.windService` /
   `error.noRoute.*` each render distinct text and a different banner
   kind. The defect is narrower and more precisely locatable than the
   issue states.
3. `App.tsx:797-805`'s own comment already declares this "the SINGLE
   alert surface for plan errors (PlannerPanel no longer renders an
   inline duplicate)" — so the correct target was documented in-code the
   whole time.

### Imprecise, worth correcting but not wrong

- #435 cites `workerClient.ts:48-49` for "turns `onerror` /
  `onmessageerror` into a plain `Error`". `onerror` is `:48`;
  `onmessageerror` spans `:49-50`. Both do exactly what the issue says.
- #435 cites `db.ts:4-7` for "schema version 1". `:4-7` is the `SailDB`
  type; the version literal and both `createObjectStore` calls are at
  `:12-17`.

Everything else in #435's "Measured current state" reproduced.

---

# Part A — How

## Q1. Who is the audience?

**Both, with a maintainer at a desk as the READER and a user on deck as
the COURIER. The user never reads the log; they must be able to produce
and send it.** That split, rather than "maintainer" or "user", is what
decides every answer below.

Evidence that a user-facing channel is mandatory rather than a nicety:
`AppState.tsx:33-34`'s own comment states the design intent —

```
// a dismissible banner (App.tsx) rather than just the existing
// console.error, which a user never sees.
```

— and #435 records the operational half: an installed PWA on a phone has
no address bar and, on iOS, effectively no reachable devtools.

Two consequences that fall straight out:

- **Content is written for the maintainer.** Stack traces, cause codes,
  timestamps, `__SC_APP_VERSION__`. No translation — the log is not UI
  copy and must not go through the i18n dictionary. (The *button* that
  exports it does, per the repo's i18n rule.)
- **Retrieval must be operable by the courier.** No devtools, no address
  bar, offline. That kills `?debug=` before Q6 is even reached.

## Q2. Is there a runtime log buffer, and where does it live?

**A bounded in-memory ring buffer in a module-scope singleton
(`app/src/lib/diagnostics.ts`). No IndexedDB. No persistence of any
kind.**

Capacity: 200 records. This is a **judgement call, not a measurement**,
and is recorded as one so a later reader does not mistake it for a
derived constant (the `PANEL_MAP_RESERVE_PX` precedent, `lib/panelWidth.ts`).
The reasoning: at the levels Q8 specifies, one plan attempt produces on
the order of ten records (start, two rig switches, any #53 probe phase,
end), so 200 covers roughly twenty attempts — comfortably more than the
session in which a user notices a failure and opens About. At an
estimated ~200 bytes per record that is ~40 KB resident, which is
noise against the ~33 MB precache and ~11 MB glyph cache `main.tsx:9-14`
already budgets for.

**Why not IndexedDB**, engaging #435's three sub-questions directly:

- *Schema-version story*: `db.ts:12` opens `'sailcommand'` at version
  **1** with exactly two stores created in one `upgrade` (`:13-17`). A log
  store is a version bump — and the bump runs for every existing user on
  their next load, on the database that holds their saved plans. That is
  a real migration risk taken for a diagnostics feature.
- *Rotation and size policy*: a persisted log needs a trim pass, and the
  trim pass needs its own failure handling, and that failure handling
  needs somewhere to log to. The in-memory ring has no such recursion —
  eviction is the data structure.
- *Quota eviction*: this is the decisive one, in the opposite direction
  from the obvious. `main.tsx:14` calls `navigator.storage?.persist?.()`
  and discards the result; per the Storage API that is a *request*, not a
  guarantee. So a persisted log competes for the same quota as the saved
  plans and the ~33 MB precache — and the failure mode is that a
  diagnostics feature contributes to evicting the offline chart. Trading
  the product's core promise for a log is not a trade worth making.

Two further reasons that are not about storage mechanics at all:

- **The interesting failures are in-session.** #433's incident is a user
  looking at a banner. The buffer is read out *before* any reload, so
  persistence buys nothing there. The one case persistence genuinely wins
  is a full tab crash — real, but rare, and not what was reported.
- **A persisted log is a privacy artifact that outlives the session.**
  It would carry GPS positions (Q7) at rest, on a possibly-shared device,
  with no user action having created it. In-memory data dies with the tab.

**What would change this answer:** a reported failure class that kills the
page itself (tab OOM, an iOS background eviction mid-passage). If that
arrives, revisit — and revisit it as a *separate*, opt-in, capped store,
not as a widening of this buffer.

## Q3. Does `protocol.ts`'s closed union grow a diagnostics message type?

**No new message type. Widen the existing `fatal` arm by one optional
field. The worker gets no separate channel and stays otherwise mute.**

Today (`protocol.ts:22`):

```
| { type: 'fatal'; id: string | null; message: string };
```

Recommended:

```
| { type: 'fatal'; id: string | null; message: string; stack?: string };
```

populated at `protocol.ts:62-66`, which already has the `Error` in hand:

```
message: err instanceof Error ? err.message : String(err),
```

— so `stack: err instanceof Error ? err.stack : undefined` is a
one-expression addition at a site that is already doing the narrowing.
(`exactOptionalPropertyTypes` is on, so an absent stack must omit the key
rather than set `undefined` — the same shape `workerClient.ts:129-135`
already handles for `onProgress`/`onProbe`.)

Argued against the type safety the closed union buys:

- **Exhaustiveness survives.** Widening one arm changes no `switch`.
  `workerClient.ts:53-71`'s `handle` keeps its exact structure. Adding a
  `log` arm would instead force a new branch there whose only job is to
  forward strings — a channel the client must maintain forever for a
  payload it cannot type.
- **#435's own framing forces a type change either way**: the stack is
  discarded *by the type*, not by a careless call site. Given a type
  change is unavoidable, the smallest one that carries the missing
  information is the right size.
- **A general diagnostics channel invites hot-path chatter.**
  `isochrone.ts`'s ring loop is the app's hot path. The worker already
  has a throttled progress channel — `workerClient.ts:55-61` drops
  anything closer than 100 ms per `${id}:${rig}` — precisely because an
  unthrottled per-ring message across `postMessage` is a performance
  problem. A `log` message type would be that channel again, unthrottled,
  with no natural rate bound.

**`BroadcastChannel` / a dedicated `MessagePort`: rejected.** Both add a
second lifetime to create, tear down, and get wrong, alongside the one
`RoutingClient` already manages (`workerClient.ts:141-145`'s `dispose`).
In exchange they would carry, in practice, one message per failed solve —
which the widened `fatal` already carries, on a channel that is already
correct about ordering and already tied to the pending-promise map via
`settle()` (`:78-85`).

**What the worker must NOT gain:** any `console.*` call. `routing/` has
zero today (§0) and should keep zero. See Q8 and Q10.

## Q4. Does the service worker get a channel back to the page?

**No. `sw.ts` is unchanged by this recommendation. The page records
service-worker STATE instead of receiving service-worker LOGS.**

Four reasons, in descending weight:

1. **The channel is lossy exactly where it would matter.** #435 states
   the constraint correctly: an SW outlives the page and may have no
   client attached when it has something to say. Install and activate —
   the two moments most worth a log — are precisely the moments a client
   may not exist. A channel that drops the interesting cases is worse
   than none, because its silence reads as health.
2. **There is one log site to carry.** `sw.ts:31` is the SW's only
   `console.*` call in the entire file. Building a message channel,
   a page-side listener, and a lifecycle for both, to relay one warning,
   is not proportionate.
3. **That one site already has real assurance.**
   `e2e/basemap-fallback.spec.ts:76-77` installs a console listener and
   `:125` asserts `consoleMessages.some((m) => m.includes('[#118]'))` is
   `true`; `e2e/offline.spec.ts:134-136` asserts the offline reload
   produces **zero** console errors. Those are stronger checks than a
   relayed buffer would provide, and they already exist.
4. **`sw.ts` is ~0% unit-covered by design** (CLAUDE.md), so any change
   there is paid for in new e2e. Spending that budget on one message is
   the wrong allocation — see Q10.

**What the page should record instead**, because it answers the question
triage actually asks:

- `navigator.serviceWorker.controller !== null` at capture time — i.e.
  *was the SW controlling this page?* This is what separates a genuine
  regression from the stale-installed-SW false alarm that CLAUDE.md's
  UAT triage rule exists for, and it is a page-side fact.
- `ReloadPrompt.tsx:33`'s `onRegisterError` — registration failure,
  already logged, currently only to the console.

## Q5. What levels exist, and what is the default in production?

**Three: `error`, `warn`, `event`. All on, always, in production. No
`debug` level.**

- `error` and `warn` are what the code already uses and nothing else —
  §0 confirms zero `log`/`info`/`debug` in `app/src`. Adopting exactly
  the existing two costs no reclassification of the 21 existing sites.
- `event` is genuinely new and earns its place: it carries non-failure
  lifecycle facts a triage needs and an error record cannot supply — plan
  started, which rig, plan ended, SW controlling, `navigator.onLine`. In
  #433's incident, "which rig was it on when it stopped" was unavailable
  and would have been decisive; that is an `event`, not an error.

**No `debug`, and #435 asks the right question about it** ("what turns it
on and what it costs when off"). The honest answer is that a `debug`
level needs a gate, the gate needs a flag, the flag needs a surface, and
the surface is unreachable on the target device (Q1/Q6) — and even
switched off it costs argument evaluation at every call site. Against
that: the motivating incident needed exactly **one** discarded `Error`
(`usePlanFlow.ts:228`). Building a verbosity system for a need that has
never been demonstrated is the wrong direction; if a future incident
needs deeper detail, add the specific record at the specific site.

The reason "all on in production" is safe rather than reckless is Q8: no
recommended site sits in a hot path or on a per-second source. Verbosity
control is unnecessary because volume is bounded by construction, not by
a switch.

## Q6. How does a user get the log out?

**A "copy diagnostics" button AND a "download diagnostics" button, both
in the About dialog (`AboutDialog.tsx`), both offline, neither requiring
devtools.** The export is plain, human-readable text.

- **Home is the About dialog.** It already exists, already opens offline,
  already displays build identity (`AboutDialog.tsx:5,115` read
  `__SC_APP_VERSION__`) — which is the first thing any report needs and
  the thing users most reliably get wrong. Putting diagnostics next to
  the version number means one place to point a reporter at.
- **Two buttons, not one — and the download is not a nicety.**
  `navigator.clipboard` has **zero** uses in `app/src` today (grep) and
  is unavailable in insecure contexts and unreliable on some iOS PWA
  paths. The download is the fallback that makes the feature reachable
  on the exact device class this is for. The mechanism already exists in
  this codebase: `RouteSummary.tsx:64-67`'s GPX export builds a Blob,
  `URL.createObjectURL`s it and sets `a.download` — a proven, fully
  offline pattern to reuse rather than invent.
- **Plain text, deliberately.** Q7 makes the user the last redaction
  gate, and a user can only be a gate over something they can read. An
  opaque JSON blob or a base64 bundle forfeits that.
- **The banner points at it.** #433's banner (`App.tsx:806-823`) should
  name where diagnostics live, since the moment the user has evidence is
  the moment the banner is up. The banner does not itself export.

**Rejected: `?debug=`.** #435 names the constraint that kills it — an
installed PWA has no address bar, so a query parameter is unreachable for
precisely the reporter this exists for. It would also be the second query
param the app reads, after `?windFixture=` (`usePlanFlow.ts:193`), which
is an e2e-only hook.

**Rejected: a hidden gesture.** Undiscoverable, and it cannot be written
into a bug-report template without ceasing to be hidden.

## Q7. What must be redacted?

Stated as a rule, with the enforcement mechanism, not as an aspiration.

**Rule 1 — secrets and personal identifiers are excluded by ALLOWLIST,
never by deletion from a spread.** A single `loggableSettings()` helper
constructs the projection field by field. A deny-list (`const { aisApiKey,
...rest } = settings`) fails **open** the next time a field is added to
`Settings` — it silently starts logging it. An allowlist fails **closed**:
a new field is absent from the export until someone deliberately adds it.
This is the repo's guard-asymmetry rule (CLAUDE.md), and a leaked API key
is unambiguously the expensive direction.

**Rule 2 — two fields never appear, at any level.** Both are optional
fields on `Settings` (`types.ts:63-64`):

- `aisApiKey` — the BYOK secret.
- `ownMmsi` — the reporter's own vessel identity.

`types.ts:56-62`'s own comment promises both are "device-local (IndexedDB
settings), never transmitted anywhere except (the key) inside aisstream's
subscription message". **A diagnostics export is the first thing in this
app that would carry `Settings` off the device**, so that comment becomes
false unless the allowlist excludes both. `ownMmsi` matters as much as
the key here: it identifies the boat, and the log will already carry
where the boat is.

**Rule 3 — positions are coarsened, not removed.** GPS fixes, origin,
destination and via points round to **3 decimal places** (~110 m at this
latitude). That is enough to identify the region, the harbour pair and
the mask cell class — which is what makes a routing report reproducible —
and not enough to constitute a track. Removing positions entirely would
make a route report useless; #433's incident was route-specific.

**Rule 4 — harbour identifiers stay verbatim.** They are curated public
names from a committed asset (`app/public/data/harbors.json`), they are
the route, and a report without them cannot be reproduced.

**Rule 5 — never log a whole `Plan` or a `WindGrid`.** `Plan` carries
Float32Array wind grids (CLAUDE.md: structured-clone-safe but not
JSON-safe) and full route geometry. Log the plan `id`, `name`, the
coarsened endpoints and the `recommended` rig — never the record.

**Rule 6 — the user sees the text before sending it.** Guaranteed by Q6's
plain-text-in-a-visible-surface requirement. This is a backstop for the
first five rules, not a substitute: a reporter cannot be expected to spot
a leaked key, but they can be expected to notice a position they do not
want to share.

One thing that does **not** need redacting, contrary to the natural
assumption: the Open-Meteo request URL. `openMeteo.ts:35-49`'s `buildUrl()`
composes `latitude`/`longitude` from the module-level `LATS`/`LONS`
constants declared at `openMeteo.ts:5-6` (the fixed 11 × 17 regional
grid) — not from the user's route or position. It is user-independent
and therefore invariant, which is also why there is no reason to log it.

---

# Part B — Where applicable

## Q8. The explicit table

Three execution contexts × seven subsystems. **Cells that should stay
silent are named, not omitted** — "log everywhere" is not a design, and
neither is a table that only lists the yes rows.

| Subsystem | Context | Log? | Level | Why |
|---|---|---|---|---|
| Routing solver | Main window (`usePlanFlow.ts`, `workerClient.ts`) | **Yes** | `event` + `error` | The whole point. `event` on plan start / rig switch / plan end; `error` on every failure path (`:204`, `:228`, `:264`). The rig-switch record is what tells a maintainer how far a timed-out solve got — the fact #432 needs and cannot get today |
| Routing solver | Web Worker (`worker.ts`, `protocol.ts`, `planRoute.ts`, `isochrone.ts`) | **NO — deliberately silent** | — | `isochrone.ts`'s ring loop is the hot path; any per-candidate or per-ring record is a performance bug. The throttled `progress` channel (`workerClient.ts:55-61`, ≤1 per 100 ms per rig) already carries the only per-ring fact worth having. The single change here is a TYPE change (`fatal.stack`, Q3), not a log site |
| Routing solver | Service worker | n/a | — | The solver does not run there |
| Wind fetch | Main window (`services/openMeteo.ts`, `usePlanFlow.ts:195-200`) | **Yes** | `warn` / `error` | `warn` for a classified `OpenMeteoError` (kind already typed, `openMeteo.ts:16-24`); `error` for the unclassified fallthrough at `usePlanFlow.ts:48` — #433's seventh cause, and the one whose very existence is invisible today. Log the error kind and the elapsed time, not the response body |
| Wind fetch | Web Worker | n/a | — | The worker never fetches; wind arrives inside the `plan` message (`protocol.ts:13`) |
| Wind fetch | Service worker | **NO — structurally silent** | — | The SW must never cache or touch the Open-Meteo origin (CLAUDE.md); `sw.ts:42-46`'s scoping comment exists to guarantee that. There is no SW-side wind event to log, and creating one would be a defect |
| IndexedDB persistence | Main window (`services/db.ts`) | **Yes** | `error` | Two sites that must stay distinguishable: `db.ts:68`'s per-plan corrupt-record skip in `listPlans` (already logs — route it to the buffer, keep the message), and `savePlan` failure (`db.ts:44-46`, caught at `usePlanFlow.ts:264`), which is #433's cause 6 — reports failure when routing *succeeded*. Never log the `Plan` value (Rule 5) |
| IndexedDB persistence | Web Worker | n/a | — | The worker has no DB access; it receives assets by message (`protocol.ts:5-13`) |
| IndexedDB persistence | Service worker | n/a | — | `sw.ts` does not touch IndexedDB |
| Map / style lifecycle | Main window (`MapView.tsx`, `lib/styleReload.ts`) | **Yes, but only the two existing sites** | `error` | `MapView.tsx:348` (MapLibre `error` event, app-owned handler) and `:372` (basemap transport / map init failed). **Do NOT add per-`styledata` or per-layer-add records**: `installStyleSetup` re-runs on every `styledata` for every layer component (CLAUDE.md), so such a record fires on every style reload — high frequency, near-zero triage value, and it would evict the plan records |
| Map / style lifecycle | Web Worker | **NO** | — | The MapLibre worker is a third-party worker this app does not own or instrument (see Q9) |
| Map / style lifecycle | Service worker | n/a | — | — |
| SW cache routes | Main window (`ReloadPrompt.tsx`, `services/swRecovery.ts`) | **Yes — SW *state*, not SW logs** | `event` / `error` | `event`: `navigator.serviceWorker.controller` present/absent at capture time — the single fact that separates a real regression from the stale-SW false alarm (CLAUDE.md's UAT triage rule). `error`: `ReloadPrompt.tsx:33`'s `onRegisterError` |
| SW cache routes | Web Worker | n/a | — | — |
| SW cache routes | Service worker (`sw.ts`) | **NO — unchanged** | — | Q4. `sw.ts:31`'s existing `console.warn` stays byte-for-byte; it is asserted by `e2e/basemap-fallback.spec.ts:125`, and `sw.ts` is ~0%-unit-covered by design |
| AIS | Main window (`services/aisStream.ts`, `state/useAisTraffic.ts`) | **Yes — state TRANSITIONS only** | `event` / `warn` | `event` on connection open/close; `warn` on the terminal `keyError`. **Never per message.** AIS is a per-second source published at ≤1 Hz (`useAisTraffic.ts:128-141`, the `setInterval(…, 1000)` tick); a per-message record is a performance bug. **The API key and `ownMmsi` never appear** (Q7 Rules 1-2) |
| AIS | Web Worker | n/a | — | — |
| AIS | Service worker | n/a | — | AIS is a WebSocket; the SW never sees it |
| GPS | Main window (`state/useOwnshipGps.ts`, `services/geolocation.ts`) | **Yes — permission/error transitions only** | `event` / `warn` | `event` on watch start/stop; `warn` on a `GeolocationPositionError`. **Never per fix.** `useOwnshipGps.ts:35-41` subscribes `watchPosition` straight into `setRawFix`, so fixes arrive at roughly 1 Hz — a per-fix record fills the 200-entry buffer in under four minutes. The sharp cost is not CPU: it is that the buffer would have **evicted the plan-failure records it exists to hold**. Positions coarsened per Rule 3 |
| GPS | Web Worker | n/a | — | — |
| GPS | Service worker | n/a | — | — |

The recurring principle across the silent rows: **a record earns its
place by being unavailable elsewhere and bounded in volume.** Per-ring
solver state fails the first test (the `progress` channel has it);
per-fix GPS and per-message AIS fail the second, and failing the second
actively destroys the records that pass the first.

## Q9. Noise we do not originate

**Classify by construction: the buffer records only what app code
explicitly hands it. No `console` monkey-patch, no global console hook.
Third-party output is therefore neither suppressed nor captured — it is
simply out of scope, and #288 stays where it is.**

- **#288 is the worked example.** `sc-maneuver-labels`
  (`RouteLayer.tsx:321-333`, verified in this worktree: it sets
  `'text-field'` at `:327` and no `'text-font'`) requests MapLibre's
  default fontstack, which this app does not ship, and silently renders
  via TinySDF. The only signal is MapLibre's own `console.warn` matching
  `"Unable to load glyph range"` — emitted by library code, not app code.
  (CLAUDE.md documents that warning and its `glyph_manager.ts` line
  against `maplibre-gl@6.1.0`; `app/package-lock.json` pins 6.1.0, but
  `node_modules` is **not installed in this worktree**, so that line
  number was deliberately **not** re-derived here rather than
  re-asserted from memory.) It never enters the buffer, and that is the
  correct outcome: it is a known, tracked, currently-unactionable
  condition, and shipping it into every user's export would train a
  maintainer to skim past exactly the file they need to read.

- **Monkey-patching `console` is rejected specifically, on a
  repo-specific ground beyond the general distaste**: three existing e2e
  assertions read the *real* console —
  `e2e/basemap-fallback.spec.ts:76-77,125-126`,
  `e2e/labels.spec.ts:333-337`, `e2e/offline.spec.ts:134-136`. Two of
  those are among the only functional assurance `sw.ts` has. A
  diagnostics feature must not perturb the observation channel that the
  app's least-covered file depends on.

- **One third-party signal IS captured, deliberately, and it is not a
  console hook**: `MapView.tsx:347-348` is an *app-owned* MapLibre
  `error` handler. That handler should also write to the buffer. The
  distinction is the design rule — app code observing a third-party
  *event* is in scope; intercepting a third-party *console call* is not.

- **A global `window.onerror` / `unhandledrejection` listener is
  recommended but deferred** (Q13, step 4). It is the only thing that
  would catch a React render crash today, since there is **no error
  boundary anywhere** (§0: 0 hits). It is deferred because it is a new
  capture surface with its own noise profile, and because the better
  answer for React specifically is an error boundary — a different piece
  of work with its own render-behaviour risk. Neither belongs in the
  minimum.

## Q10. Do the ~0%-covered files change?

**Neither `sw.ts` nor `routing/worker.ts` changes. That is a designed
property of this recommendation, not a coincidence.**

- **`sw.ts`: no change** (Q4). Its one log site and its existing e2e
  assurance stay exactly as they are.
- **`routing/worker.ts`: no change.** The whole file is four lines:

  ```
  import { createHandler, type WorkerRequest } from './protocol';
  const handler = createHandler((m) => self.postMessage(m));
  self.onmessage = (e: MessageEvent<WorkerRequest>) => handler(e.data);
  ```

  It is a bare adapter; all logic lives in `protocol.ts`, which **is**
  unit-covered. Q3's `fatal.stack` widening lands in `protocol.ts:15-22`
  and `:60-72` — inside the covered module, on the covered side of the
  boundary.

So the answer to "name the e2e assurance that would cover it" is that no
such assurance is needed, because the change is placed where unit tests
already reach. Stating what the *existing* e2e would cover if a change
were forced there anyway, for completeness: `e2e/offline.spec.ts`'s
console-error-free offline reload and `e2e/basemap-fallback.spec.ts`'s
`[#118]` presence assertion.

**One NEW e2e assertion this recommendation does need**, and it is the
redaction rule, not the logging: set an AIS key in Options
(`OptionsPanel.tsx:203-211`), plan or open About, export diagnostics, and
assert the key string is **absent** from the exported text. This is
reachable today with the existing harness, it is the highest-consequence
property in the whole design (Q7), and it is exactly the kind of check a
unit test can pass while the real assembled export leaks — because the
export is assembled from several sources and only the browser sees the
whole of it.

Deliberately **not** recommended, per the "what class of failure can this
method not detect" rule: an e2e test that forces a worker OOM or a
specific `fatal` and asserts the export names it. #433's own text records
that a Chromium worker killed for memory frequently does not fire
`onerror` — so the failure mode most worth proving is one no Playwright
construction in this suite can reliably produce, and a test written to
"prove" it would pass for the wrong reason.

---

# Part C — What to do

## Q11. Recommendation

Build, in this order (sizes in Q13):

1. **`app/src/lib/diagnostics.ts`** — a module-scope ring buffer,
   capacity 200, three levels (`error`/`warn`/`event`), a `record()`
   entry point taking a level, a short stable code, and a typed payload,
   and a `formatDiagnostics()` producing plain text. Redaction lives here
   and only here, as an allowlist (Q7 Rule 1), so there is exactly one
   place to audit.
2. **Bind the discarded errors.** `usePlanFlow.ts:133`, `:143`, `:228`,
   `:238`, `:264` become `catch (err)` and hand `err` to `record()`.
   `replan.ts:206` and `reroute.ts:213` likewise — both currently
   evaluate `err instanceof ReplanError ? err.messageKey : 'error.internal'`
   and then drop `err` on the non-`ReplanError` branch, which is the
   branch that matters.
3. **`AboutDialog.tsx`** — "copy diagnostics" + "download diagnostics",
   the latter reusing `RouteSummary.tsx:64-67`'s Blob pattern. i18n keys
   in **both** `dict.de.ts` and `dict.en.ts` (`satisfies Record<MsgKey,
   string>` enforces parity).
4. **`protocol.ts`** — `fatal` gains `stack?: string` (Q3).
5. **`workerClient.ts`** — a typed `RoutingError` (Q12), replacing the
   bare `new Error(...)` at `:48`, `:49-50`, `:67`, `:69`, `:116`,
   `:127`, `:143`.
6. **Q8's `event`-level instrumentation** at the yes rows.

### Considered and rejected

1. **Do nothing.** Rejected on measured evidence, not preference: the
   incident in #433 (production v0.10.0, 2026-08-07) could not be
   root-caused, and 21 log sites exist that no user can reach.
   Sharper than "we lack logs": the app's silence is *load-bearing in the
   wrong direction* — CLAUDE.md instructs maintainers never to ask a
   reporter to check the console, because an empty console is designed
   behaviour rather than evidence. So today a maintainer cannot even
   distinguish "nothing happened" from "everything happened silently",
   and doing nothing preserves that.

2. **Console-only plus a documented dev workflow** (add `console.error`
   at the discarding catches; write the retrieval steps into
   `CONTRIBUTING.md`). This is #433's own suggested direction and it is
   the closest call in this document — it is genuinely cheap and it would
   have solved the motivating incident *for a maintainer at a desk*.
   Rejected because it does not solve it for the reporter, who is the
   person who has the failure: an installed PWA on a phone has no address
   bar and, on iOS, effectively no reachable devtools (#435). A
   documented workflow that the only witness cannot execute is not a
   workflow. It also cannot carry cross-cutting context — "was the SW
   controlling", "which rig", "how long" — that is only available by
   accumulating records over a session. **Partially adopted**: steps 1-2
   above *are* that cheap fix, plus a destination the reporter can reach.

3. **An in-memory ring buffer surfaced in the UI as a live log view.**
   Stated precisely because the recommendation is an in-memory ring
   buffer and it would be dishonest to file the whole option under
   "rejected": what is rejected is the **live viewer** — a scrolling
   console panel in the app. Rejected because it is UI surface, and
   therefore i18n surface, layout surface, and z-index surface (CLAUDE.md
   documents a declared stacking-tier order and four cascading
   regressions from getting it wrong) — all for a view whose audience
   (Q1) is not the person holding the phone. The export button is the
   same buffer with none of that cost. It also invites the log to become
   user-facing copy, which would drag it into the i18n dictionary and
   destroy its value as a maintainer artifact.

4. **A persisted IndexedDB log.** Rejected on the three grounds in Q2:
   it is a schema bump on a version-1 database (`db.ts:12`) holding the
   user's saved plans; it competes for quota with the ~33 MB precache and
   ~11 MB glyph cache that `main.tsx:9-14` already budgets for, under a
   `persist()` request whose result is explicitly discarded at
   `main.tsx:14` and which the Storage API does not guarantee — so the
   worst case is a diagnostics feature contributing to the eviction of
   the offline chart; and it creates an at-rest privacy artifact carrying
   coarsened GPS positions that outlives the session on a possibly-shared
   device. The one thing it buys over the in-memory buffer — surviving a
   full tab crash — is not the reported failure mode. Named
   reconsideration trigger in Q2.

5. **A third-party error reporter (Sentry or equivalent).** Rejected
   twice over, and the record matters so it cannot return as a fresh
   idea:
   - **The product rule forbids it.** CLAUDE.md: "Open-Meteo is called
     directly from the browser … There is deliberately **no backend** —
     do not introduce one." A reporter is a backend, whether or not this
     project operates it.
   - **The CSP forbids it mechanically.** `app/vite.config.ts:161` ships
     `connect-src 'self' https://api.open-meteo.com wss://stream.aisstream.io`.
     Any reporter origin needs a `connect-src` entry, and
     `e2e/csp.spec.ts` asserts that **all** non-`example.com` violations
     stay empty across the whole page lifetime — deliberately not an
     allowlist of expected ones (CLAUDE.md) — so the attempt fails a
     required check rather than degrading quietly.
   - **And it would not even work where it is needed.** The reporter is
     on a boat. Off-device reporting requires connectivity; the app's own
     rule is that everything except planning must work offline. A
     diagnostics mechanism that only functions when the user has signal
     contradicts the product.

## Q12. Relationship to #433 and #432

### #433 — split cleanly in two; this spike subsumes exactly one half

#433 contains two separable defects:

- **(a) The `Error` is discarded.** `usePlanFlow.ts:228` and its four
  siblings are bare `} catch {` with no binding, so the object is
  unreachable by construction — including the detail `protocol.ts:60-66`
  forwarded across the worker boundary for exactly this purpose.
- **(b) Seven unrelated causes render one banner with one piece of
  advice that is wrong for most of them.**

**This spike SUBSUMES (a) entirely.** Capturing a discarded error is what
the buffer is for, and it is the identical edit (step 2 of Q11). #433
should not implement its own capture mechanism.

**This spike does NOT subsume (b).** A log the user never reads cannot
make a banner more accurate. (b) needs a cause discriminator that reaches
the UI, and the choice of copy per cause is a product decision this
document has no opinion on.

**They meet at exactly one artefact: the discriminator.** The value that
makes the banner accurate is the value the log should record. Implement
it **once**.

#### Concretely, for #433 to implement against

**Mechanism** — a typed error class on the client, mirroring two
precedents that already exist in this codebase rather than inventing a
third pattern:

- `OpenMeteoError` (`openMeteo.ts:16-24`): `readonly kind`, plus the
  Error's own message.
- `ReplanError` (`replan.ts:50-58`): `readonly messageKey: MsgKey`, plus
  the Error's own message — and its comment at `:46-49` already states
  the caveat that applies here too ("NOT structured-clone-safe … never
  let this cross a postMessage/IndexedDB boundary").

**File** — `app/src/routing/workerClient.ts`, alongside `RoutingClient`,
which is where every one of these failures is actually constructed.

**Shape**:

```
export type RoutingFailureKind =
  | 'timeout'        // workerClient.ts:127  'routing timed out'
  | 'worker-fatal'   // :67 / :69 — protocol.ts forwarded a real throw (+stack)
  | 'worker-error'   // :48  worker.onerror
  | 'messageerror'   // :49-50 worker.onmessageerror
  | 'disposed';      // :116 / :143

export class RoutingError extends Error {
  readonly kind: RoutingFailureKind;
  constructor(kind: RoutingFailureKind, message: string) { … }
}
```

plus, at the presentation boundary in `usePlanFlow.ts`, a
`Record<RoutingFailureKind | 'worker-init' | 'persist-failed' |
'wind-unclassified', MsgKey>` — the remaining three causes originate
outside `workerClient.ts` (`usePlanFlow.ts:203-205`, `:264`, `:48`
respectively) and are classified there.

**Why a typed error and not string matching**, which is the trap here:
today `'routing timed out'` (`workerClient.ts:127`) and a worker's own
forwarded text (`new Error(msg.message)`, `:67`/`:69`) are separated only
by the *content of a message string*. Matching on it would make a
user-adjacent label a control input — the exact coupling this repo
already paid for once and only partially unwound in #282/#411. That
precedent also gives the placement rule to follow: `SolveFailureCause` is
deliberately kept **out of `types.ts`** so it cannot leak into UI code,
with the public label derived at a presentation boundary via
`NO_ROUTE_LABEL_OF_CAUSE`. `RoutingFailureKind` should follow the same
rule — internal to the routing/state layer, never in `types.ts`.

**Also required for #433, and it is the one change on the worker side:**
`protocol.ts:22` gains `stack?: string` (Q3), populated at `:62-66`.
Without it, cause 5 (a real throw inside `planRoute()`) still arrives
stripped of the only detail that identifies it.

**Where #433's UI change lands** — and §0 matters here: **`App.tsx:806-823`,
not `RouteSummary.tsx:154`.** `planErrorGroup` (`App.tsx:112-116`) gains
the new keys, `planErrorBannerKind` (`:121-123`) keeps its paint rule, and
the `action` at `:809-819` becomes per-cause rather than per-group,
because CLAUDE.md is explicit that the advice splits **per path, not per
group**: "try again" hands the user a genuinely fresh worker
(`usePlanFlow.ts:241-242`) and so helps `onerror`/`onmessageerror`; a
wind-fetch blip is helped by re-fetching and never touches the worker
(`:195-199` returns at `:199`, before `ensureClient()` at `:202`); the
120 s timeout and a deterministic `planRoute()` throw are both
input-deterministic and a retry cannot help either. One new i18n key per
cause, in **both** dictionaries.

**Independent of this spike, entirely #433's own:** the key names, the
German and English copy, and which action each cause offers.

### #432 — subsumed: nothing. Shared with #433: one cause. Contributed: one measurement.

- **Subsumed by this spike: nothing.** #432's substance is three
  engineering facts — a fixed, un-scaled `DEFAULT_PLAN_TIMEOUT_MS =
  120_000` (`workerClient.ts:16`); `isochrone.ts` having no wall-clock
  budget at all; and `replan.ts:110-113` / `reroute.ts:113` rejecting
  **without** disposing, so a timeout reached via replan or reroute
  genuinely leaves the worker running. None of those is a logging
  problem and none is improved by a log.
- **Shared with #433, not with this spike: the `'timeout'` cause.**
  #432's user-facing half — "a timeout is reported as *unexpected* and
  advised to reload" — is precisely #433's cause 4. If #433 lands the
  discriminator above, that half of #432 is complete as a side effect.
  **State this explicitly in both issues so neither re-implements it.**
  #432 then reduces to its two real open questions: should the budget
  scale with the device, and should `isochrone.ts` acquire a wall-clock
  budget.
- **Contributed by this spike to #432, and genuinely additive:** a
  timing record. If `record()` stamps `plan-start`, each rig switch and
  `plan-end`, a timed-out report carries how far the solve got and on
  which rig. CLAUDE.md deliberately quotes **no** magnitude for
  Flensburg→Marstal's cost, on the grounds that "any figure has to carry
  its method and environment, and a Node/vitest number cannot be compared
  to a browser worker's budget". A timestamped record from the failing
  browser is exactly the measurement that constraint asks for and that no
  current mechanism can produce.

## Q13. Sequencing and size

### The minimum that makes "a bug happened and nothing was visible" go away

**Steps 1 + 2 + 3 of Q11, shipped together: the ring buffer, the five
bound catches, and the About-dialog export.** Roughly one new ~120-line
module, seven one-line catch edits, one dialog section, four i18n keys.

**Why the minimum is not smaller, against #433's own suggestion.** #433
proposes "a single `console.error` at `usePlanFlow.ts:228`" as the
cheapest fix with the largest payoff, and for a maintainer at a desk that
is true. It is not the minimum *here* because the console is unreachable
for the reporter who has the failure (Q1), and because CLAUDE.md
instructs maintainers never to send a reporter to the console in the
first place. A recorder with no retrieval surface reproduces the current
situation with extra steps. **Record it AND make it retrievable, or the
complaint is not addressed.**

### Order

1. **Recorder + bound catches + export** — the minimum above. Ships
   alone, is valuable alone: it turns #433's motivating incident into a
   readable `Error: routing timed out` with a stack and a session
   timeline.
2. **Typed `RoutingError` + `fatal.stack` + per-cause banner** — this is
   #433. Depends on step 1 only for the recorder to hand causes to; the
   banner half is independent.
3. **Q8's `event`-level instrumentation** — SW-controlling state, online
   state, plan lifecycle, AIS/GPS transitions. Broadest diff, smallest
   per-site risk, easiest to review incrementally.
4. **Global `unhandledrejection` / `window.onerror` → recorder**, and —
   separately, and it is a different piece of work — a React error
   boundary. Explicitly out of the minimum: the first is a new capture
   surface with its own noise profile; the second changes render
   behaviour, and there is no boundary anywhere today (§0) so it has no
   precedent in this codebase to follow.

**Why step 1 before step 2, which is not arbitrary:** step 2 without step
1 produces better banner *text* and still no artefact a remote maintainer
can read — the reporter would be able to say "it said timeout" and
nothing more. Step 1 without step 2 already resolves #433's motivating
incident, because the raw `Error` message plus stack plus the rig
timeline names the cause even before the banner learns to. The dependency
runs one way only.

---

## Recommended follow-up issues

Not filed under this spike, per its brief — listed for the orchestrator
to file after review:

1. **Diagnostics recorder + About-dialog export** (the Q13 minimum,
   steps 1-3 of Q11). Includes the e2e redaction assertion from Q10.
   Blocks nothing; unblocks #433's capture half.
2. **Q8 `event`-level instrumentation** (Q13 step 3).
3. **Global `unhandledrejection`/`onerror` capture** (Q13 step 4a).
4. **React error boundary** (Q13 step 4b) — currently zero across
   `app/src`; a render crash today produces a blank page and no record.
5. **Correct #435's body** (or note it in the closing comment): the
   planning-flow error renders at `App.tsx:806-823`, not
   `RouteSummary.tsx:154` (§0). Worth doing because #433 is implemented
   next and an issue text is not ground truth for states it does not
   describe (CLAUDE.md).

## Claim-strength note

Everything in §0 and every `file:line` in Parts A-C was read from this
worktree at `develop`@`3979bae`. Three things are deliberately **not**
claimed:

- **The `maplibre-gl` glyph-warning line number was not re-derived.**
  `app/package-lock.json` pins 6.1.0, but `node_modules` is not installed
  in this worktree, so Q9 cites CLAUDE.md's finding and says so rather
  than repeating a number it could not check against the installed
  artefact.
- **The 200-record capacity and the 3-decimal position rounding are
  judgement calls**, labelled as such at both sites. Neither is derived
  from a measurement, and neither should be cited later as if it were.
- **No claim is made that this design would have diagnosed the 2026-08-07
  incident**, only that it would have preserved the `Error` that
  incident's own issue (#433) identifies as sufficient. Which of the
  seven causes fired remains unknown and is not knowable retrospectively.
