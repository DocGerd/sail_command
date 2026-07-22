# Security Policy

## Supported versions

SailCommand is a client-only PWA with no backend and no accounts. The only
supported version is the latest deployment at
<https://docgerd.github.io/sail_command/> (built from `main`). Older
service-worker caches self-update on the next online visit.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub:
**[Report a vulnerability](https://github.com/DocGerd/sail_command/security/advisories/new)**
(Security tab → "Report a vulnerability"). Do not open a public issue for
anything exploitable.

You can expect an acknowledgment within 7 days. Coordinated disclosure is
appreciated; there is no bug-bounty program.

## Scope notes

- All user data (saved plans, wind grids, settings) stays in the browser
  (IndexedDB / localStorage). The app makes exactly one class of runtime
  network request beyond same-origin asset fetches: wind forecasts from
  Open-Meteo, called directly from the browser.
- The deployed site is static (GitHub Pages). Supply-chain reports about
  bundled dependencies are in scope; see
  `app/public/THIRD-PARTY-NOTICES.txt` for the inventory.

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
- A per-PR automated reviewer pass posts inline review threads — a workflow
  practice, not a ruleset gate; the threads it opens are then covered by the
  mandatory-resolution rule above. *(workflow)*

For this reason the OpenSSF Scorecard *Branch-Protection* and *Code-Review*
findings — which assume a multi-maintainer approving-review model — are
dismissed as "won't fix"; the controls above provide equivalent review
assurance without a self-approval deadlock. This is revisited if a second
maintainer joins.
