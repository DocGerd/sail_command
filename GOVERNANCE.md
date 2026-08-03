# Governance

This document describes how SailCommand is governed: who decides, how a change
gets accepted, what each role is responsible for, and what would happen to the
project if the current maintainer stopped.

It is written to describe the project **as it actually is today**, including the
parts that are uncomfortable. Where the project falls short of a good practice,
this document says so rather than describing an aspiration.

Related documents — this file deliberately does not repeat them:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to work on the code (ground rules,
  commands, labels, milestones).
- [`SECURITY.md`](SECURITY.md) — reporting, response, security requirements, and
  the branch-protection / code-review posture.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — behavioral standards and
  enforcement.
- [`ROADMAP.md`](ROADMAP.md) — what the project intends to do and not do.

## Governance model: single maintainer

SailCommand is a **single-maintainer project** (sometimes called BDFL). There is
no steering committee, no vote, and no formal consensus process, because there
is exactly one person with commit rights.

**The maintainer makes all final decisions.** In practice most decisions are
uncontroversial: an issue is filed, discussed in the issue thread, and resolved
by a pull request. Where opinions differ, the maintainer decides and records the
reasoning in the issue or in the pull request that implements it.

This is a deliberate choice, not an accident of neglect: the project is small,
domain-specific (one boat class, one sailing area), and has had no external code
contributors to date. A heavier model would be ceremony without a constituency.
If that changes — see [Growing the project](#growing-the-project) below — this
document changes with it.

### Decisions that are not open for negotiation

A handful of constraints are treated as project invariants rather than
preferences. A proposal that violates one of them will be declined regardless of
implementation quality:

- **No backend.** The app is client-only. Features requiring a server (proxies,
  token exchange, databases, accounts) are out of scope.
- **Offline first.** Planning a route needs the network for the wind fetch;
  everything else must keep working offline. A feature that silently assumes
  connectivity is a bug.
- **Not a navigation device.** SailCommand is a passage-planning aid. No
  user-facing copy, and no feature, may claim chart authority.
- **The design spec is the source of truth.**
  `docs/superpowers/specs/2026-07-14-sail-command-design.md` (plus its
  addenda) governs design-level decisions. A change that deviates from it
  updates the spec first, in a separate discussion.

### Dispute resolution

1. Discuss in the issue. Most disagreements come from an unstated constraint,
   which surfaces once both sides are written down.
2. If it remains unresolved, the maintainer decides and states why in the issue.
   That decision is final for this repository.
3. The project is Apache-2.0 licensed. Anyone who disagrees with a decision may
   fork; that is an explicitly acceptable outcome, not a failure state.

## Roles and responsibilities

| Role | Who holds it | Authority |
|---|---|---|
| **Maintainer** | Patrick Kuhn ([@DocGerd](https://github.com/DocGerd)) | Everything: merge, release, deploy, repo settings |
| **Contributor** | Anyone who files an issue or opens a pull request | Propose; no merge rights |
| **Automated agents** | Claude Code agents run by the maintainer | Draft and review; no independent authority |
| **Dependabot** | GitHub bot | Opens dependency PRs; no merge rights |

### Maintainer

Currently the only role with any rights over the repository, held by one person.
[`.github/CODEOWNERS`](.github/CODEOWNERS) names `@DocGerd` as the owner of the
whole tree, with explicit entries for the routing engine, the service worker,
the data pipeline, and the CI/CD workflows.

Responsibilities:

- **Triage** — label and milestone every incoming issue (taxonomy in
  [`CONTRIBUTING.md`](CONTRIBUTING.md#labels--milestones)), and answer or close
  it honestly rather than letting it rot.
- **Review and merge** — every pull request, including their own, is reviewed
  before merge; review threads must be resolved (enforced by ruleset).
- **Release cuts** — decide when `develop` becomes a release, run the
  `develop` → `main` pull request, tag `main`, and verify the deploy.
- **Deployment operation** — GitHub Pages, the `github-pages` environment policy,
  and the post-deploy CDN smoke probe.
- **Security response** — receive reports, triage, fix, and publish advisories
  (process in [`SECURITY.md`](SECURITY.md#vulnerability-response-process)).
- **Dependency hygiene** — review Dependabot PRs, keep the third-party notices
  file current, keep GitHub Actions SHA-pinned.
- **Documentation currency** — refresh `README.md`, `CHANGELOG.md`,
  `ROADMAP.md`, and this file at each release cut.

### Contributor

Anyone who files an issue or opens a pull request. Contributors are welcome, and
review capacity is limited — see [`CONTRIBUTING.md`](CONTRIBUTING.md). A
contributor is expected to follow the ground rules there, the
[Code of Conduct](CODE_OF_CONDUCT.md), and the invariants above. Contributors
have no merge rights and no repository settings access.

### Automated agents

Development on this project is largely agent-driven: the maintainer runs Claude
Code agents that implement changes and perform per-PR review passes. This is
unusual enough to state plainly, because it affects how the review evidence on a
pull request should be read.

- Agents have **no independent authority**. They open branches and pull requests
  and post review threads; they never decide what ships.
- The maintainer is **accountable for every merge**, agent-authored or not. An
  agent review is a review aid, not a second human's approval, and is never
  presented as one.
- Merges into `main` (i.e. releases, which deploy straight to production) are
  performed by the maintainer personally, after a local visual check of the
  built state.

### Dependabot

Opens grouped weekly dependency pull requests across five ecosystems
([`.github/dependabot.yml`](.github/dependabot.yml)) plus security updates. Its
pull requests go through the same required checks as any other; nothing merges
automatically.

## How a change gets accepted

1. **An issue exists.** Behavior changes start from an issue so the intent is
   recorded and labeled. Small chores may skip this.
2. **Branch off `develop`.** `develop` is the protected default branch where
   work accumulates; feature pull requests target `develop`, never `main`.
3. **Open a pull request** using
   [the template](.github/PULL_REQUEST_TEMPLATE.md), referencing the issue with
   `Closes #<n>`.
4. **Required checks must pass**: `app` (lint → typecheck → unit/property tests →
   build → third-party-notices drift guard) and `e2e` (Playwright, including a
   true offline reload). Both are required by the `protect-main` ruleset under a
   strict up-to-date policy, on `develop` as well as `main`.
5. **Review threads must be resolved.** The ruleset blocks merge while any
   thread is open. Approving reviews are *not* required — with a single human
   maintainer, GitHub's ban on self-approval would deadlock every merge. The
   full rationale, including the deliberate OpenSSF Scorecard trade-off, is in
   [`SECURITY.md`](SECURITY.md#branch-protection--code-review); it is not
   repeated here.
6. **Merge commit only.** Squash and rebase merges are disabled by the ruleset.
   Force pushes and branch deletion are blocked on both protected branches.

## Releases

A release is a pull request from `develop` to `main`, merged as a merge commit,
then tagged `vX.Y.Z` on `main`. `main` holds released state only.

- Production (<https://docgerd.github.io/sail_command/>) is built from `main`
  and deploys on every push to `main` and on every release tag.
- UAT (<https://docgerd.github.io/sail_command/uat/>) is built from `develop`
  and redeploys on every push to `develop`. It is `noindex`ed, deliberately
  labeled as unreleased, and is not chart-authoritative.
- After the tag deploy is verified green, `main` is back-merged into `develop`
  via a topic branch so `develop` stays ahead.
- The tag push also creates the GitHub Release itself: `release.yml`
  extracts the matching `## [X.Y.Z]` section from `CHANGELOG.md` and runs
  `gh release create` automatically — the maintainer no longer creates the
  Release object by hand ([#175](https://github.com/DocGerd/sail_command/issues/175)).

**Only the maintainer cuts releases.** Because there is no staging step between
merging to `main` and the bytes going live, a release is gated on a human
walkthrough of the locally built app, not on green CI alone.

## Contribution licensing — no DCO or CLA (deliberate)

**Decision: SailCommand does not require a Developer Certificate of Origin
sign-off (`git commit -s`) or a Contributor License Agreement.** The OpenSSF
Best Practices `dco` criterion is a SHOULD, and this is the recorded rationale
for not implementing it (tracked as
[#224](https://github.com/DocGerd/sail_command/issues/224)).

Reasoning:

- **The inbound licensing term already exists.** The project is
  [Apache-2.0](LICENSE), whose §5 ("Submission of Contributions") states that
  any contribution intentionally submitted for inclusion in the work is
  submitted under the terms of that same license unless the contributor
  explicitly states otherwise. Opening a pull request against this repository is
  such a submission. Inbound equals outbound, by the license the project already
  ships.
- **There is nothing a sign-off would add here.** Every human-authored commit to
  date — 400+ of them — comes from the single maintainer, who is also the
  copyright holder (the only other author is `dependabot[bot]`). A solo
  maintainer certifying their own authorship to themselves conveys no
  information Apache-2.0 §5 does not already carry.
- **An unenforced requirement would be a false claim.** No commit in this
  repository's history carries a `Signed-off-by:` trailer and no CI check
  verifies one. Documenting a sign-off requirement without wiring up
  enforcement would put a statement in the repository that the repository
  itself contradicts — the failure mode this project most wants to avoid in its
  documentation.

**When this would be revisited** (any one of these is enough to reopen the
decision):

- the first substantial code contribution from someone other than the
  maintainer,
- a second maintainer joining,
- a downstream redistributor asking for provenance stronger than Apache-2.0 §5.

Adopting a DCO at that point is cheap: a `CONTRIBUTING.md` section, a pull
request template line, and the GitHub DCO check app. It is intentionally not
being adopted before there is anyone to certify.

## Continuity and succession

### The bus factor is 1

`git shortlog -sne --all` shows exactly one human contributor across the
project's entire history — Patrick Kuhn, under two identities — plus
`dependabot[bot]`. One person holds every capability the project needs:
repository admin, the ability to accept a pull request, the ability to cut a
release, and control of the GitHub Pages deployment.

**If that person became unavailable, the project would stop.** Nobody else could
merge a fix, publish a release, or deploy. This is stated plainly because a
governance document that implies otherwise would be worse than none: any
prospective user should factor a bus factor of 1 into their decision to depend
on this project.

The mitigating facts are real but limited: the project is Apache-2.0 licensed,
the entire build is reproducible from the repository (CI even proves the
production build is byte-deterministic), there is no server to keep running, no
database to migrate, and no user account data held anywhere but on users' own
devices. A fork could carry the project forward without any cooperation from the
current maintainer. **Existing installations keep working offline indefinitely**
— an abandoned SailCommand degrades to a static app with an ageing wind source,
not to an outage.

### OpenSSF `access_continuity` is NOT met

The OpenSSF Best Practices Silver criterion `access_continuity` requires that
the project be able to create and close issues, accept proposed changes, and
release software within a week of losing any one individual. **This project does
not meet that criterion today**, and this section does not close it. Meeting it
requires granting a second trusted person standing rights (or configuring
GitHub's account-successor mechanism) — a real-world decision by the maintainer,
not a documentation change.

What follows is the prerequisite groundwork: the inventory a successor would
need. It is deliberately not written as if it were the answer.

### What a successor would need

| Capability | Where it lives | Notes |
|---|---|---|
| Repository admin | GitHub `DocGerd/sail_command` | Includes the `protect-main` ruleset and the ability to merge |
| GitHub Pages | Repository → Settings → Pages | Serves both production and `/uat/` from one deployment artifact |
| `github-pages` environment policy | Repository → Settings → Environments | Branch entries `main`, `develop`; tag entry `v*`. A deploy from an unlisted ref is rejected |
| Release tagging | Git push rights on `main` | A `v[0-9]*` tag push is what publishes the clean version string |
| OpenSSF Best Practices badge entry | [Project 13749](https://www.bestpractices.dev/projects/13749) | Tied to the maintainer's login; a successor needs to be added as an additional badge editor |
| GitHub Actions secrets | None held | Deploys use the Pages OIDC flow; there is nothing to hand over |
| Signing keys | Maintainer's SSH key (`~/.ssh/id_ed25519`), registered on GitHub as Signing Key id `1088697` ("SailCommand release signing (id_ed25519)"), fingerprint `SHA256:TIoKycz7HSEZF70gp+bJA6dLxK4dhUYWbSkRX+nN8ts` — also independently confirmable live at `https://api.github.com/users/DocGerd/ssh_signing_keys`, so this row is a custody pointer, not the source of truth (the key can rotate; check the endpoint) | Release tags are signed from `v0.8.0` onward ([#322](https://github.com/DocGerd/sail_command/issues/322)); a successor needs custody of the private key plus their own key registered as a Signing Key at `github.com/settings/ssh/new` to keep signing releases going. Tags through `v0.7.0` stay unsigned regardless — see [`SECURITY.md`](SECURITY.md#verifying-a-release) |

Two things genuinely simplify succession here, and are worth stating because
they are the usual hard parts: **there is no DNS to transfer** (the site lives on
a `github.io` sub-path) and **nothing is published to npm or any other package
registry**. A successor needs GitHub access and nothing else.

Anyone forking without the maintainer's cooperation needs none of the above —
only the repository contents, which are public and complete. `pipeline/` can
regenerate every committed data asset from public sources.

## Growing the project

The single-maintainer model is a consequence of there being one maintainer, not
a preference for exclusivity. A contributor with a sustained track record of
merged changes may be invited to become a second maintainer; that would be
announced in this file and in `CHANGELOG.md`, and would immediately trigger
revisiting three things recorded elsewhere as single-maintainer trade-offs: the
approving-review requirement and Scorecard disposition in
[`SECURITY.md`](SECURITY.md#openssf-scorecard-posture-branch-protection-code-review),
the DCO decision above, and `access_continuity`.

## Changing this document

Changes to governance go through the same pull-request process as code, and are
reviewed by the maintainer. This document is re-read at each release cut as part
of the documentation sweep.
