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
- **Signature verification only from `v0.8.0` onward.** Release tags starting
  at `v0.8.0` are cryptographically signed and independently verifiable
  ([#322](https://github.com/DocGerd/sail_command/issues/322)); `v0.1.0`
  through `v0.7.0` remain permanently unsigned — see
  [Verifying a release](#verifying-a-release) below for how to check one and
  why the earlier tags can't be retrofitted.
- **No third-party availability guarantees.** Open-Meteo, aisstream.io, and
  GitHub Pages are outside the project's control.

### In scope for a report

Anything that breaks one of the expectations above. Supply-chain reports about
bundled dependencies are explicitly in scope — see
`app/public/THIRD-PARTY-NOTICES.txt` for the inventory. Reports that a route was
inaccurate are a product-quality issue, not a vulnerability; please file those
as a normal issue.

## Verifying a release

Release tags from `v0.8.0` onward are **cryptographically signed**
([#322](https://github.com/DocGerd/sail_command/issues/322); the
verification process and docs below originally shipped, ahead of signing
itself, under [#222](https://github.com/DocGerd/sail_command/issues/222)).
`v0.1.0` through `v0.7.0` carry no signature, so `git verify-tag` / `git tag
-v` **fail** against them (exit 1) rather than succeed — the message differs
by tag kind: annotated-but-unsigned tags (`v0.1.0`, `v0.5.0`, `v0.7.0`) report
`error: no signature found`, while the lightweight tags — the majority of
that earlier set — report `error: ... cannot verify a non-tag object of type
commit`, because a lightweight tag is a bare ref that cannot carry a
signature at all. Both outcomes are expected for those versions, not a sign
of tampering.

The Silver `signed_releases` criterion requires **both** cryptographic
signing **and** a documented process for obtaining the public keys and
verifying signatures — they are conjuncts, not alternatives. The second
conjunct is met today: the process is documented below and the maintainer's
signing key is registered and retrievable at the endpoint named below (query
it yourself — `gh api users/DocGerd/ssh_signing_keys` or the plain URL — it
is not a promise). The first conjunct — an actual signed tag — has been met
since `v0.8.0` shipped on 2026-08-03; **both** conjuncts, together, are what
satisfy the criterion, not the tag alone.

**Live, as of `v0.8.0`:** release tags are signed with the maintainer's SSH
signing key (`gpg.format = ssh` — GitHub's lowest-friction signing option,
requiring no GPG toolchain):

- **The public key is registered** at GitHub's dedicated SSH *signing*-key
  endpoint, `https://api.github.com/users/DocGerd/ssh_signing_keys` (also
  browsable as JSON in any browser) — **not** `https://github.com/<user>.keys`,
  which serves *authentication* keys from a **separate registry** that does
  not back the "Verified" badge on a signed tag/commit. If a tag ever
  verifies locally (`git tag -v` reports `Good signature`) but GitHub shows
  it as **Unverified**, that is a registration gap — either on the
  signing-key registry above (e.g. after a key rotation, or for a
  successor's own key before they've registered it), **or on the tagger
  email** (whatever `user.email` was active when the tag was created must
  itself be registered on the signer's GitHub account, independent of the
  key) — not evidence of a bad signature either way. This is not a
  hypothetical: it is exactly what happened to the `v0.8.0` tag itself (see
  the `v0.8.1` CHANGELOG entry). See `CONTRIBUTING.md`'s "Tagger identity"
  section for the full three-way breakdown (key registration, email
  registration, email privacy) and how to tell them apart. The key's raw
  fingerprint is not pinned in this document — it can be rotated, and a
  fingerprint frozen into a versioned doc would go stale silently; the
  live registry above is the authoritative source, and `GOVERNANCE.md`'s
  succession table separately records the fingerprint currently in use for
  custody-tracking purposes.
- Verify a tag locally with either of the equivalent commands:

  ```bash
  git verify-tag vX.Y.Z
  # or
  git tag -v vX.Y.Z
  ```

  Both require a local `gpg.ssh.allowedSignersFile`, pointing at a file
  mapping an identity to a public key (see `git help gpg-sign`) — without
  it, git has no way to resolve the key material behind the tag's signature,
  even though the tag itself carries one.

  **Complete third-party recipe** (proven end to end against this repo, with
  no local signing config of any kind — only the public endpoint above):

  ```bash
  # 1. Fetch the registered public key(s) — no auth required, this is public data.
  gh api users/DocGerd/ssh_signing_keys --jq '.[].key'
  # or: curl -s https://api.github.com/users/DocGerd/ssh_signing_keys | jq -r '.[].key'

  # 2. Build a local allowed_signers file: "<identity> <key-type> <key-material>",
  #    one line per key. The identity is a free-form label — it does NOT need to
  #    match the tag's own tagger email for verification to succeed (see the note
  #    below); using it anyway is good practice so the printed "Good signature
  #    for <identity>" line is meaningful to you.
  echo "release-signing $(gh api users/DocGerd/ssh_signing_keys --jq '.[0].key')" > /tmp/sailcommand-allowed-signers

  # 3. Verify.
  git -c gpg.ssh.allowedSignersFile=/tmp/sailcommand-allowed-signers tag -v vX.Y.Z
  ```

  Reading the output — five shapes, only one of which is a real problem,
  and the first two look deceptively similar (both start with the word
  "Good"):

  - **`Good "git" signature FOR <identity> with ED25519 key SHA256:...`**,
    exit 0 → verified. The `<identity>` is whatever label your file used
    (step 2) — it is cosmetic, not a security check; only the key material
    had to match.
  - **`Good "git" signature WITH ED25519 key SHA256:...`** (no `for
    <identity>` clause) **followed by `No principal matched.`**, exit 1 →
    NOT verified, but also not tampering: your `allowed_signers` file has no
    entry whose KEY matches the one that produced the signature (a missing
    file, an empty file, or the wrong key — never a mismatched identity
    label on an otherwise-correct key; see the note above). `git` resolves
    this by running `ssh-keygen -Y find-principals` to discover which of
    your file's entries matches the signature's key *first*, then verifies
    against that entry, so there is never a case where the right key with a
    "wrong" label fails this way. Fix the FILE (re-fetch step 1), not the
    identity string.
  - **`error: no signature found`**, exit 1 → the tag is *annotated* but was
    never signed — not tampering, it simply predates signing. Three of the
    ten pre-`v0.8.0` tags are this shape: `v0.1.0`, `v0.5.0`, `v0.7.0`.
  - **`error: <tag>: cannot verify a non-tag object of type commit.`**,
    exit 1 → the tag is *lightweight* — a bare ref that cannot carry a
    signature at all, so there is nothing for `git tag -v` to check. Also
    not tampering, for the same reason: it predates signing. The other
    seven of those ten pre-`v0.8.0` tags are this shape: `v0.1.1`, `v0.1.2`,
    `v0.2.0`, `v0.3.0`, `v0.4.0`, `v0.5.1`, `v0.6.0`.
  - **`Could not verify signature.`** followed by a line naming your
    `allowed_signers` file and a line number (e.g. `<file>:1: key is not
    permitted for use in signature namespace "git"`), exit 1 → also NOT
    tampering: a malformed *option* on that line in your own file (for
    example a stray `namespaces="ssh"` restricting the key to the wrong
    namespace) rather than a missing/wrong key. This looks like the bad-news
    case below — it names a signature-verification failure, not merely an
    unmatched principal — but it isn't one: it's the same class of problem
    as the *No principal matched.* bullet above, a broken local file, just
    surfaced through a different `ssh-keygen` error path. Fix the FILE's
    option syntax, not the tag.

  An outright signature-verification-FAILURE message (not merely an
  unmatched principal) is the one case that is actually bad news: it means
  the data doesn't match what was signed. Treat that as tampering and
  stop — unless the message names your `allowed_signers` file and a line
  number, which is a problem with your file, not the tag.

  This file is a **local, per-verifier** artifact — it is not, and does not
  need to be, committed to this repository. See
  [`CONTRIBUTING.md`](CONTRIBUTING.md#release-tag-signing-live-starting-v080-322)
  for the maintainer's own one-time local setup (a different, machine-local
  config from the third-party recipe above).
- GitHub's own "Verified" badge on the tag's commit and on the Release page
  is a second, independent verification channel that needs no local
  configuration at all — the fastest check for most people, and it **shows
  correctly from `v0.8.1` onward**. That is a rule covering every signed tag
  from `v0.8.1` on, not a list of the ones checked so far — check any tag
  yourself rather than trusting an enumeration in this file:

  ```bash
  gh api repos/DocGerd/sail_command/git/tags/$(git rev-parse refs/tags/vX.Y.Z) \
    --jq .verification
  ```

  A tag that shows the badge reports `"verified": true, "reason": "valid"`.
  Exercised against real release tags, not just the throwaway probe tag the
  fix was originally proven against: `v0.12.0` and `v0.12.1` each returned
  `verified: true, reason: "valid"` when checked on 2026-08-20.
  The v0.8.0 tag is a documented exception: it was signed under an email
  address not
  registered on the maintainer's GitHub account, so GitHub shows it
  Unverified (`reason: "no_user"`) despite a cryptographically good
  signature — an attribution gap, not a signature problem. `git tag -v` /
  `git verify-tag` verification above is unaffected and works for v0.8.0 the
  same as for any other signed tag; only the badge channel is affected, and
  only for that one tag. See the [v0.8.1 CHANGELOG entry](CHANGELOG.md) and
  `CONTRIBUTING.md`'s "Tagger identity" section for the fix.

Signing is **not retroactive**: `v0.1.0` through `v0.7.0` are never re-signed
or re-tagged, and this is permanent, not a bootstrap gap that closes later.
Moving an existing tag would break the deploy identity scheme this project
relies on, which keys production bytes to `(main SHA, git-describe version)`
— see `CLAUDE.md`.

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

**No vulnerability has been reported through this channel, and none has been
found in SailCommand's own code, to date**, so this process has not yet been
exercised in anger. The `### Security` changelog entries naming an advisory
identifier — GHSA-v2hh-gcrm-f6hx (`fast-uri`, #90/#91) and
GHSA-mh99-v99m-4gvg (`brace-expansion`, #281) — were Dependabot findings in
transitive dependencies, handled by the upstream path described just above,
not reports through this process. It is written down so the
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
