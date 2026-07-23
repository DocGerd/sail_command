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
