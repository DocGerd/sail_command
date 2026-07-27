# Security Policy

## Supported versions

SailCommand is a client-only PWA with no backend and no accounts. The only
supported version is the latest deployment at
<https://docgerd.github.io/sail_command/> (built from `main`). Older
service-worker caches self-update on the next online visit.

## Security requirements — what you can and cannot expect

These are the security properties SailCommand claims. The argument for *why*
they hold — threat model, trust boundaries, secure-design and common-weakness
arguments — is the
[security assurance case](docs/security-assurance-case.md).

### What you can expect

- **No accounts and no credentials to steal.** There is no sign-up, no login,
  no password, no session, and no cookie.
- **No backend to breach.** SailCommand is a static client-only PWA. The
  project operates no server, no API, and no database; there is no central
  store of user data anywhere.
- **Your data stays on your device.** Saved plans (including the wind grid each
  was computed from), settings, and GPS positions live in your browser's
  IndexedDB / localStorage and are never uploaded.
- **No analytics, telemetry, or tracking.** None is present and none is
  planned.
- **Exactly two outbound destinations besides the site's own assets, both
  opt-in by action:**
  - **Wind forecasts** from [Open-Meteo](https://open-meteo.com/), fetched by
    the browser only when you plan a route. The request is a *fixed* grid
    covering the whole supported area — identical for every user — so it does
    not disclose where you are or where you intend to sail. No API key, no
    cookies.
  - **AIS traffic** from [aisstream.io](https://aisstream.io/), only if you
    paste your own API key. The feature is entirely inert without one: no key
    means no client and no socket at all. When enabled, your key and bounding
    boxes covering your area of interest are sent to that third party.
- **All transport is encrypted** (HTTPS / WSS) with the browser's default
  certificate verification; the app contains no verification bypass.
- **The app keeps working offline.** Only planning a *new* route needs the
  network; a failure there is reported as a failure, never worked around with
  substituted data.
- **Reproducible, reviewed releases.** Production is built only from `main`
  through protected-branch CI, with a determinism proof that fails the build on
  any byte difference.

### What you cannot expect

- **No chart authority.** SailCommand is a passage-planning aid, **not a
  navigation device**. Chart data is simplified and forecast data can be wrong;
  official charts and your plotter remain authoritative. Treat a wrong route as
  a data-quality limitation of a planning aid, not as a promise broken.
- **No protection against a compromised device or browser.** Anyone who can
  read your browser profile can read your saved plans and any AIS key you
  entered.
- **Your AIS key is only as safe as your browser profile.** It is stored as you
  entered it. Encrypting it locally would be theatre — the key needed to
  decrypt it would sit in the same storage. It is yours, it never leaves your
  device except to aisstream.io, and you can revoke it there at any time.
- **No signature verification of releases yet.** Release tags are currently
  unsigned ([#222](https://github.com/DocGerd/sail_command/issues/222)).
- **No third-party availability guarantees.** Open-Meteo, aisstream.io, and
  GitHub Pages are outside the project's control.

### In scope for a report

Anything that breaks one of the expectations above. Supply-chain reports about
bundled dependencies are explicitly in scope — see
`app/public/THIRD-PARTY-NOTICES.txt` for the inventory. Reports that a route was
inaccurate are a product-quality issue, not a vulnerability; please file those
as a normal issue.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub:
**[Report a vulnerability](https://github.com/DocGerd/sail_command/security/advisories/new)**
(Security tab → "Report a vulnerability"; private vulnerability reporting is
enabled on this repository). Do not open a public issue for anything
exploitable.

You can expect an acknowledgment within 7 days. Coordinated disclosure is
appreciated; there is no bug-bounty program.

## Vulnerability response process

What happens after a report lands. This project has a **single maintainer**
(see [GOVERNANCE.md](GOVERNANCE.md)), so these steps are sequential and depend
on one person's availability — the timelines below are honest targets, not
guarantees, and there is no on-call rotation behind them.

1. **Acknowledge — within 7 days.** The report is confirmed received in the
   private advisory thread, which stays the channel for everything that
   follows.
2. **Triage and reproduce — target 14 days.** The maintainer attempts to
   reproduce and determines whether the report describes a vulnerability, a
   product defect, or expected behavior. The outcome is stated in the thread
   either way; a report that is not a vulnerability is answered, not silently
   closed.
3. **Assess severity.** Rated with CVSS v3.1 as a shared vocabulary, weighted
   for this app's actual exposure: there is no server, so impact is normally
   bounded by what an attacker could do inside one user's browser origin.
   Severity sets the pace of the remaining steps, nothing else.
4. **Fix.** Developed on a private fork through GitHub's advisory workflow when
   the issue is exploitable and not yet public; otherwise on a normal branch
   with a neutral description. Fixes carry a regression test wherever the
   defect is testable.
5. **Release.** Merged to `develop`, then cut to `main` as a release, which
   deploys to production automatically. Because the app is a single deployed
   PWA with no supported older versions, shipping the fix is what remediates
   every user — installations self-update on their next online visit.
6. **Publish an advisory.** A GitHub Security Advisory is published for any
   issue that could affect users, with the affected versions, the fixed
   version, and a workaround where one exists.
7. **Record it.** Noted in [`CHANGELOG.md`](CHANGELOG.md) under the release
   that contains the fix, so the history is readable without the advisory
   database.
8. **Credit the reporter** by name or handle in the advisory and the changelog
   entry, unless they ask to remain anonymous. Say so in your report if you
   prefer anonymity.

If a report turns out to affect an upstream dependency rather than this
project's own code, the maintainer forwards it upstream, updates the dependency
once a fix is available, and says so in the thread.

**No vulnerability has been reported or resolved in this project to date**, so
this process has not yet been exercised in anger. It is written down so the
first time is not improvised.

## Branch protection & code review

SailCommand is solo-maintained with an agent-driven review workflow, so the
repository deliberately does **not** require a second human's approving review
on pull requests: GitHub forbids approving your own PR, so requiring approvers
(or last-push approval) would deadlock every merge. Review rigor is instead
enforced by repository rulesets applied identically to both `main` and
`develop`, backed by a per-PR review workflow:

- Pull-request-only merges — no direct pushes, no force-pushes, no branch
  deletion. *(ruleset)*
- Required status checks `app` + `e2e` under the strict up-to-date policy.
  *(ruleset)*
- Mandatory resolution of every review thread before merge. *(ruleset)*
- Stale-review dismissal on push (`dismiss_stale_reviews_on_push`, adopted
  2026-07-23): new commits invalidate earlier approvals. Reviews here are
  advisory (required count 0), so dismissal can never block a merge — it only
  keeps any recorded approval honest. *(ruleset)*
- A per-PR automated reviewer pass posts inline review threads — a workflow
  practice, not a ruleset gate; the threads it opens are then covered by the
  mandatory-resolution rule above. *(workflow)*

### OpenSSF Scorecard posture (Branch-Protection, Code-Review)

Scorecard rates this repository's *Branch-Protection* check **4/10**; that
ceiling is deliberate. Three of its remaining Warn classes are intentionally
**not** adopted in this solo-maintainer repository:

- required approving reviews ≥ 1,
- CODEOWNERS-backed review requirement,
- last-push approval (approval by someone other than the last pusher).

GitHub does not count self-approval, so with a single human maintainer each of
these would hard-block every PR on a reviewer that does not exist. The
*Code-Review* check (**0/10**) shares this disposition for the same reason: it
measures approving reviews from a second maintainer, which self-approval rules
make impossible here. The repository's actual review control is the set of
ruleset/workflow gates listed above — the mandatory agent self-review loop
with ruleset-enforced thread resolution plus the required `app` + `e2e`
checks. Future Scorecard triage should treat these findings (both checks) as
"won't fix" without re-litigating them; revisit if a second trusted maintainer
joins.
