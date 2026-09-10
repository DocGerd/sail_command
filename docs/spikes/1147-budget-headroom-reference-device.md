# Spike #1147 — sizing `PLAN_BUDGET_MS` against a Galaxy Tab S7 reference device

- **Issue:** #1147 "Flensburg→Marstal solve leaves only ~30% headroom against
  `PLAN_BUDGET_MS` on a real browser".
- **Date:** 2026-09-10.
- **Merge-base of every measurement below:** `831db11` (`origin/develop` tip
  at session start).
- **Status:** Decision / Recommendation — measurement only. No code change
  ships with this document; sizing the constant needs a maintainer call on
  the throttle factor and on whether a several-minute wait is acceptable
  product behaviour.
- **Ruling this responds to (2026-09-10, maintainer):** "Size the plan budget
  against Samsung Galaxy Tab S7 performance as the reference device." This
  replaces the three open directions in #1147's body.

**Verdict, in one line: the throttling mechanism named in the brief (`Emulation.setCPUThrottlingRate`) does not reach the routing solver at all, and no reliable substitute was found in this sandboxed session — but the plain, unthrottled, idle-machine measurement is already enough to INFER, not measure, the underlying answer: on every (unverified but directionally consistent) benchmark figure found, `PLAN_BUDGET_MS = 120_000` does not clear a plausible Tab S7-class device today.**

---

## 1. Two corrections carried in from #1147's re-triage comment

Recorded here for completeness (posted to the issue already, 2026-09-10, by
the maintainer/triage pass before this pickup):

1. `PLAN_BUDGET_MS` lives at `app/src/routing/workerClient.ts:108`
   (`export const PLAN_BUDGET_MS = 120_000;`), not in `protocol.ts` as
   #1147's original body states.
2. `workerClient.ts` is `NOT_IN_CLOSURE` for the `app/sweep/` acceptance
   harness (`node .claude/skills/sweep-closure/closure.mjs files
   app/src/routing/workerClient.ts`, re-verified this session). A change to
   the constant alone owes no sweep run. This does not generalise —
   `isochrone.ts`, `planRoute.ts` and `lib/wind.ts` are all `IN_CLOSURE`.

## 2. Method: what was tried, in order, and why each throttle mechanism failed

### 2a. CDP `Emulation.setCPUThrottlingRate` — MEASURED INERT on the solver

The brief named this as "the mechanism available via Playwright". Before
spending the ~6-8 minutes a single throttled Flensburg→Marstal run would
cost, a positive control was run: a dedicated `Worker` running a fixed
tight floating-point loop (`Math.sin`/`Math.cos`/`Math.sqrt`, 2×10⁹
iterations), timed at `rate: 1` and `rate: 4` via a page-level CDP session
(`context.newCDPSession(page)` then `Emulation.setCPUThrottlingRate`).

```
rate=1 worker tight-loop elapsed: 90073.7 ms
rate=4 worker tight-loop elapsed: 94033.9 ms
ratio (rate4/rate1): 1.04
```

A 4× requested rate produced a 1.04× measured slowdown. This is consistent
with Chrome's CPU-throttling implementation historically applying to the
**main-thread task scheduler only** — a dedicated Worker runs under its own
scheduler that the page-level `Emulation.setCPUThrottlingRate` call does not
reach. SailCommand's routing solver runs entirely inside a dedicated
`Worker` (`app/src/routing/workerClient.ts:234`,
`new Worker(new URL('./worker.ts', ...), { type: 'module' })`), so this
mechanism cannot throttle the thing #1147 asks about at all. This is a
**deviation from the brief, reported per "briefs are wrong sometimes"**
rather than silently worked around.

### 2b. Process-level SIGSTOP/SIGCONT duty-cycle — attempted, unreliable under real contention, abandoned

Two variants were tried as a substitute, both suspending the whole Chromium
process tree (found via `chromium.launchServer()` → `server.process().pid`
→ recursive `pgrep -P`) on a timed duty cycle to approximate a wall-clock
slowdown:

- **Variant 1** (signals delivered via `execSync('kill -STOP/-CONT ...')`,
  50 ms slice): ratio 1.16 at a requested 4×. The `execSync` call forks a
  new shell per signal delivery; under this session's real background load
  (several concurrent sibling agents — `uptime` load average climbed from
  0.01 to 20+ during this work), that fork/exec overhead alone consumed
  most of the intended "off" window, so the process was barely suspended at
  all.
- **Variant 2** (signals delivered via Node's in-process `process.kill(pid,
  sig)`, no subprocess spawn per tick, 20 ms slice / 5 ms "on"): this one
  **hung**. The root Chromium process was observed in kernel state `T`
  (stopped) across two separate `ps` snapshots taken ~40 s apart with no
  progress — Node's own single-threaded event loop, running a 300 ms
  synchronous `pgrep`-based PID rescan alongside the 20 ms duty-cycle timer,
  was itself being starved by the same real contention, so the scheduled
  `SIGCONT` callback did not fire close to on time. The process had to be
  killed by hand (`kill -9` on the Node driver, then `pkill -CONT` +
  `pkill -9` on the orphaned Chromium tree) to recover.

**Neither cgroup v2 (`/sys/fs/cgroup/cgroup.subtree_control` not writable by
this session's uid) nor `cpulimit` (not installed, and `apt install` needs a
sudo password this session does not have — `sudo -n true` fails) were
available as alternatives.**

One bounded, direct `curl` attempt (browser `User-Agent`, 15 s timeout)
against `https://browser.geekbench.com/processors/intel-core-i9-13900f` was
also tried, in case fetching (rather than an AI-summarized search) would
succeed where `WebFetch` had already 403'd four benchmark-aggregator URLs
(Geekbench Browser, cpu-monkey.com, nanoreview.net). It also returned
`HTTP 403`. No throttle-factor number in this document should be read as
independently verified past an AI search-engine synthesis — see §4.

**Conclusion on mechanism: a linear wall-clock multiplier (CDP or
SIGSTOP-duty-cycle, had either worked reliably) would only ever have
reported `BASE_TIME × throttle_factor ± noise` — arithmetic derivable from
the BASE measurement alone. It would not have modelled a real device's
cache size, memory bandwidth, or JIT tiering behaviour. Its absence changes
how confidently a specific new constant can be sized, but does not block
answering "does the current constant clear a plausible reference device".**

## 3. BASE measurement (real browser, unthrottled, live Open-Meteo, no throttle)

Method: mirrors PR #1145's approach (cited in #1147) — a Playwright
`addInitScript` subclasses `window.Worker`, wrapping `postMessage` to
timestamp `type: 'plan'` posts and the `message` listener to timestamp the
`type: 'result'`/`'fatal'` reply, without editing any source file.
Chromium (headless, `@playwright/test` 1.63.0, this session's `npm ci`),
dev server (`vite`, own port, not 4173/4180), default boat (Salona 45),
default settings, Flensburg → Marstal, no `?windFixture=` (live Open-Meteo).
Origin/destination picked via the same `getByRole('region', {name:
'Start'|'Ziel'})` → combobox → first option pattern `plan.spec.ts` uses.
Completion detected by polling the "Route planen" button's `disabled` state
back to `false` (`App.tsx:1243`, `canPlan = ... && !runBusy`), same signal
`plan.spec.ts` polls.

| Run | `uptime` load avg (1m) at start | Worker plan→result (monotonic ≈ wall, ms) | Seconds |
|---|---|---|---|
| 1 | 0.01 (genuinely idle) | 91,909.9 | **91.9 s** |
| 2 | 7.57 → 13.78 (climbing, other agents active) | 115,309.8 | 115.3 s |
| 3 | 21.83 → 9.02 (climbing then falling) | 100,676.5 | 100.7 s |

All three runs returned `status: 'ok'` with the expected #53-relaxation
signature, confirmed from the rendered German shallow-water banner (not
just the status string), matching #1147's own methodology:

> "Achtung: Eine vorsichtigere Lesart der Kartentiefen kann bis auf 1,4 m
> sinken — unter den Bootstiefgang von 2,1 m. Geplant mit einer
> Sicherheitstiefe von 2,3 m. 0,3 nm dieser Route verlaufen durch Wasser,
> das flacher als die eingestellte Sicherheitstiefe von 3,0 m kartiert
> ist."

`usedDepthM ≈ 2.3` against `requestedDepthM 3.0` — byte-identical signature
to PR #1145's.

**Environment for all three:** i9-13900F (32 logical CPUs), WSL2, this
session's own worktree, `npm ci`-installed dependencies, dev server (`vite
--port 4191`), no other tab/window contending inside the SAME Chromium
instance. **Run 1 is the clean control** (load 0.01 — as idle as this
shared multi-agent session gets). Runs 2 and 3 are under real, unquantified
contention from concurrently active sibling agent sessions in this same
Claude Code session (the system prompt lists `gh-state`, `impl-1154`,
`impl-1171`, `probe-1136`, `ruling-1136`, `tree-state`, four `triage-*`
agents as active throughout this work) — the same *kind* of contention
#1147's original ~30% figure was measured under, though not the same
session or magnitude. **Per CLAUDE.md's measurement-discipline rule, runs 2
and 3 are not averaged with run 1** — they are reported beside it with load
stated, as a second data point on load-sensitivity, not as replicates of
the same condition.

**Both clocks (`performance.now()` / `Date.now()`) were logged for every run,
and all three agreed to within 0.5 ms**: run 1 (idle) 0.1 ms, run 2
(contended, load 7-22) 0.2 ms, run 3 (contended, load 9-22) -0.5 ms — the
table above reports the wall-clock (`Date.now()`) figure for all three rows,
and the monotonic figure differs by less than the rounding shown in that
table in every case, so the choice of clock does not affect §6's
comparisons. #1147's unresolved clock-disagreement anomaly (5.7-8.7 s per
sample) did **not** reproduce at any of the three load levels sampled here,
including the two contended runs — the same condition the original anomaly
was observed under. This narrows, not closes, the open question: three
samples on one machine in one session is not a root-cause, and is not proof
against the WSL2-guest-clock-under-load hypothesis #1147 already flagged as
unconfirmed — only evidence the anomaly is not universal under load.

## 4. Throttle factor for "Galaxy Tab S7" — could not be independently verified

Every benchmark-aggregator URL tried (Geekbench Browser, cpu-monkey.com,
nanoreview.net, both via `WebFetch` and one direct `curl` with a browser
`User-Agent`) returned `HTTP 403`. The only numbers available came from
`WebSearch`'s AI-synthesized result text, which is **not a primary source**
and showed an internal inconsistency worth flagging rather than hiding: one
query attributed the Tab S7's Snapdragon 865+ single-core score (~971) to
Geekbench 6, a second attributed an almost identical number (973) to
Geekbench 5.2 — GB5 and GB6 use different scales and are not normally this
close for the same silicon, so at least one of those two labels is likely
wrong, and neither was confirmed against the actual page. A search for the
i9-13900F's own GB6 single-core score returned nothing usable; only the
i9-13900K's (~2133, version unconfirmed) came back, used here as an
architectural proxy since the F-suffix part differs from the K only by the
absence of an integrated GPU (same P/E core count and max turbo per public
specs).

**Do not treat the resulting ~2.2× raw ratio (2133/971) as a verified
number.** It is reported only to show the order of magnitude, and even
taken at face value it almost certainly **understates** the real gap for
this specific workload: Geekbench's single-core subtests are short bursts,
while the solver runs a **sustained ~90-115 second** single-thread compute
load — a thin, passively/lightly-cooled tablet SoC will thermal-throttle
during a load like that far more than during a burst benchmark, in a way a
desktop tower with an actively-cooled 13900F will not. No sustained-load
figure for either part was found or measured.

**What this document does NOT claim:** a specific, defensible throttle
factor for a Galaxy Tab S7. Per the task's own instruction, that is stated
plainly rather than invented. **§5 below shows this gap does not block a
verdict.**

## 5. Headroom verdict against the 120 s budget

The **clean, idle-machine, unthrottled** run (run 1, §3) is 91.9 s against
`PLAN_BUDGET_MS = 120_000` — **23.4% headroom**, measured on a 2023 desktop
i9, not a 2020 tablet SoC.

**Any device whose single-thread performance on this workload is ≥ 1.31×
slower than this measuring machine's blows the 120 s budget outright**
(91.9 s × 1.31 ≈ 120.4 s). No same-generation, same-benchmark-version
figure found anywhere in this session's search attempts puts a Snapdragon
865+ within 1.31× of an i9-13900F on ANY single-thread metric — every
number encountered, however unreliably sourced, was well past 2×. So:

**The current `PLAN_BUDGET_MS = 120_000` does not clear a Galaxy Tab S7-class
reference device on this app's most expensive supported route, run at
default settings, under live wind.** This conclusion is reached without
needing a precise throttle factor — it follows from the idle-machine BASE
figure alone plus the much weaker claim that a 2020 mid-range tablet SoC is
at least 31% slower single-thread than a 2023 flagship desktop CPU, which
every (unverified but directionally consistent) figure found supports by a
wide margin.

**What is NOT established here:** by how much the budget would need to
grow. `budget_needed ≳ 91.9 s × F` for whatever the real single-thread
factor `F` turns out to be — at a conservative-sounding `F = 2`, that is
~184 s (~3 min); at `F = 4` (closer to what the burst-benchmark ratio plus a
sustained-load thermal-throttling margin suggests, unverified), ~368 s
(~6 min). **A multi-minute wait on the app's most expensive route is a
product-tolerance decision this document cannot make** — it needs a
maintainer call on both the throttle factor (ideally re-derived with actual
Geekbench/primary-source access, or a real Tab S7 in hand) and on whether
several minutes is an acceptable worst-case wait, or whether the right fix
is instead progressive partial-result reporting (one of the three
directions #1147's original body already named and which this ruling did
not rule out — only the *headroom-sizing* direction was decided).

## 6. A stale in-code claim this measurement surfaces

The comment immediately above `export const PLAN_BUDGET_MS = 120_000;` in `app/src/routing/workerClient.ts` (currently lines 95-106, a hint only) cites a **2.4-2.9× slower device** as the threshold that "reaches the
budget at all", derived from **synthetic uniform-wind** measurements
(`uniformWindGrid(12, 225)`: 41-43 s; `uniformWindGrid(12, 270)`: 50.5 s).
Both this document's run and #1147's own PR #1145 measurement use **live,
non-uniform Open-Meteo wind** and land at 71-115 s on the same route at
`DEFAULT_SETTINGS` — 1.6-2.8× the synthetic figures the comment cites. The
real device-slowdown-to-budget threshold on live wind is **≥ 1.31×** (§5),
not 2.4-2.9×. **That comment understates the risk and should be corrected
by whichever PR eventually touches this constant** — flagged here rather
than fixed in this pickup, since editing that comment without also
resolving §5's open sizing question would leave a half-corrected claim.

## 7. Recommendation

**`Refs #1147`, not `Closes #1147`.** This measurement answers "does the
current constant clear the reference device" (no) but leaves "what should
the new constant be, and is the resulting wait tolerable" as an open
maintainer decision — exactly the shape the brief allows for a
characterization-only pickup.

Suggested next step, not decided here: either (a) get a maintainer
ruling on an acceptable worst-case wait (§5's ~3-6 min range) and land a
`PLAN_BUDGET_MS` bump sized to it in a follow-up PR (which would also need
`workerClient.ts:95-106`'s comment corrected per §6), or (b) revisit the
progressive-partial-result direction #1147's original body named, which
sidesteps needing a precise throttle factor at all.

### Considered and rejected (this session)

- **Treating the search-synthesized ~2.2× GB6 ratio as a defensible
  throttle factor and reporting a bracketed 2×/4× throttled measurement
  regardless of mechanism reliability.** Rejected on two independent
  grounds: the throttle mechanism itself proved unreliable under this
  session's real contention (§2), and even a working linear throttle would
  only have reproduced `BASE × F` arithmetic already derivable from §3's
  measurement, per the advisor consultation this pickup used before
  committing further time to it.
- **Averaging the three BASE runs into a single headroom figure.** Rejected
  per CLAUDE.md's measurement-discipline rule — runs 2 and 3 were not taken
  under the same load condition as run 1, so averaging would launder a
  contention effect into what should read as a clean control.
