# Spike #391 — a gesture begun during an in-flight easeTo/flyTo/fitBounds is silently discarded

- **Issue:** #391 (Backlog; Refs #383, PR #390)
- **Date:** 2026-09-01
- **Status:** Decision / Recommendation
- **Verdict:** **This is a genuine, reproducible upstream defect in maplibre-gl's
  own camera/handler-manager interaction, re-derived here against the exact
  `maplibre-gl@6.6.0` this repo ships. It is filed upstream (report drafted in
  §2, NOT submitted — that is the maintainer's call) and ACCEPTED, undocumented
  further beyond this spike and the existing CLAUDE.md entry, for this cut. No
  app-side mitigation is recommended: every shape considered touches the
  #203/#227 camera-mode derivation, a structurally pinned, narrowly-load-bearing
  guard, for a UX inconvenience (repeat the gesture) rather than a safety or
  data-integrity defect.**

---

## 0. Scope of this document

Per the brief: author a ready-to-file upstream report and record an
accept-or-mitigate decision. **No app code changes.** This document does not
implement anything; §4 analyses mitigation shapes only to explain why they are
declined, per CLAUDE.md's own instruction that a future reader should not have
to re-derive that risk painfully.

## 1. How every citation below was produced

Per CLAUDE.md's "never source an integer-exact claim from a summarizing fetch"
rule, every line number and code excerpt in this document was read directly
from installed TypeScript source under `maplibre-gl/src/`, never from a
paraphrased web fetch.

**Version, confirmed against the lockfile, not a warm `node_modules`:**

```
$ grep -n '"maplibre-gl"' app/package-lock.json
14:        "maplibre-gl": "^6.6.0",
$ grep -n -A3 '"node_modules/maplibre-gl":' app/package-lock.json
6510:    "node_modules/maplibre-gl": {
6511:      "version": "6.6.0",
6512:      "resolved": "https://registry.npmjs.org/maplibre-gl/-/maplibre-gl-6.6.0.tgz",
6513:      "integrity": "sha512-EQql6eZYPhbHvJpqY4AwoiuLkUfXFRBHk67S8mDtzNo1F/jAo7xAxunIzO7gJ1vwTcPMgrK9b64dqKHvnkTlDQ==",
```

This worktree had no installed `node_modules` (a fresh git worktree; `npm ci`
was not run for this docs-only task). The primary repo checkout's
`app/node_modules/maplibre-gl` (a sibling checkout of the same repository,
outside this worktree) carries `version: "6.6.0"` in its own `package.json`,
and its lockfile's `node_modules/maplibre-gl` block is **byte-identical**
(same version, same resolved URL, same integrity hash) to this worktree's own
`app/package-lock.json` entry — confirmed by a direct file diff of both
blocks, not by assumption. Byte-identity of the two lockfile entries
establishes only that both checkouts declare the same package version and
integrity hash; it does not by itself rule out the donor checkout's installed
`node_modules/maplibre-gl` carrying a local patch layered on top of an
otherwise-ordinary `npm ci`. Checked directly, in both checkouts: neither
`app/` has a `patches/` directory, a `postinstall` or `patch-package` script,
or a `patchedDependencies` entry in `package.json`, and neither
`package-lock.json` mentions `patch-package` — ruling out every *tooled*
patching mechanism available to this repo. What that check cannot rule out is
an untracked, by-hand edit to the files already on disk in the donor's
`node_modules`, which leaves no trace in either `package.json` or the
lockfile; treat that as a named, unclosed residual rather than an established
zero. All citations below were re-derived 2026-09-01 against
`maplibre-gl@6.6.0` on that basis, sourced from the donor checkout under that
qualification.

The issue's own text (filed against `6.1.0`, per its closing paragraph) said
line numbers "should be re-checked after any maplibre upgrade" — this is that
re-check, three minor versions later.

## 2. The mechanism, re-derived at 6.6.0

### 2.1 Natural ease completion calls `stop()` with no `allowGestures`

`ui/camera.ts`:

```ts
// :1238-1248
_renderFrameCallback = (): void => {
    const t = Math.min((now() - this._easeStart) / this._easeOptions.duration, 1);
    this._onEaseFrame(this._easeOptions.easing(t));

    // if _stop is called during _onEaseFrame from _fireMoveEvents we should avoid a new _requestRenderFrame, checking it by ensuring _easeFrameId was not deleted
    if (t < 1 && this._easeFrameId) {
        this._easeFrameId = this._requestRenderFrame(this._renderFrameCallback);
    } else {
        this.stop();
    }
};
```

At `t >= 1` (the ease's natural completion), `this.stop()` is called with
**zero arguments** — `allowGestures` is `undefined`.

```ts
// :1193-1216
stop(allowGestures?: boolean): this {
    return this._stop(allowGestures);
}

_stop(allowGestures?: boolean, easeId?: string): this {
    if (this._easeFrameId) {
        this._cancelRenderFrame(this._easeFrameId);
        delete this._easeFrameId;
        delete this._onEaseFrame;
    }

    if (this._onEaseEnd) {
        const onEaseEnd = this._onEaseEnd;
        delete this._onEaseEnd;
        onEaseEnd.call(this, easeId);
    }
    if (!allowGestures) {
        this._stopHandlers();
    }
    return this;
}
```

`!allowGestures` is `true` whenever `allowGestures` is `undefined` — i.e. on
**every** natural ease completion — so `_stopHandlers()` fires unconditionally
on this path. This is identical, byte-for-byte, to `camera.ts:1246` as cited
by #383/#390 against 6.1.0: this region of the file has not moved across
three minor versions.

### 2.2 `_stopHandlers` is wired to disarm every handler unconditionally

`ui/map.ts`, in the `Camera` constructor call inside `Map`'s own constructor:

```ts
// :769-772
requestRenderFrame: (callback) => this._requestRenderFrame(callback),
cancelRenderFrame: (id) => this._cancelRenderFrame(id),
transformCameraUpdate: resolvedOptions.transformCameraUpdate,
stopHandlers: () => this._handlers?.stop(false),
```

`stopHandlers` always calls `HandlerManager.stop` with the literal `false`
(`allowEndAnimation`), regardless of what triggered the stop.

`ui/handler_manager.ts`:

```ts
// :353-363
stop(allowEndAnimation: boolean): void {
    // do nothing if this method was triggered by a gesture update
    if (this._updatingCamera) return;

    for (const {handler} of this._handlers) {
        handler.reset();
    }
    this._inertia.clear();
    this._fireEvents({}, {}, allowEndAnimation);
    this._changes = [];
}
```

The only guard against firing is `this._updatingCamera`, which is `true`
**only** while `HandlerManager.handleEvent` (the real user-input dispatch
path, `handler_manager.ts:408-486`) is on the call stack — it is set `true`
at `:415` and reset `false` at `:477`, bracketing a single DOM-event
dispatch. The ease's own `_renderFrameCallback` above reaches `Camera.stop()`
via `_requestRenderFrame`/`_renderTaskQueue` (`ui/map.ts:4221-4224`,
`requestRenderFrame: (callback) => this._requestRenderFrame(callback)`) — a
plain `requestAnimationFrame`-driven render-task callback, entirely outside
`handleEvent`. So at the moment the ease's own completion fires
`_stopHandlers()`, `_updatingCamera` is `false`, the guard does not fire, and
`handler.reset()` runs unconditionally for **every** registered handler —
including one mid-gesture from an unrelated, still-active `mousedown`.

The deliberate protection this mechanism is supposed to have is visible a few
lines above, in `handleEvent` itself:

```ts
// :408-477 (excerpt)
handleEvent = (e: Event, eventName?: keyof Handler): void => {
    if (e.type === 'blur') {
        this.stop(true);
        return;
    }
    this._updatingCamera = true;
    ...
    if (Object.keys(activeHandlers).length || hasChange(mergedHandlerResult)) {
        this._camera.stop(true);
    }
    this._updatingCamera = false;
    ...
```

Here, `this._camera.stop(true)` is called **with** `allowGestures: true`
while a real gesture event is on the call stack (`_updatingCamera` is `true`)
— so `_stop`'s `if (!allowGestures)` is `false` and `_stopHandlers()` is
skipped, correctly leaving a live drag's handler state untouched. This is the
mechanism `allowGestures` exists for. The natural-ease-completion path in
§2.1 is the one call site that does not pass it.

### 2.3 The disarmed handler drops every subsequent input event, not just the first

`ui/handler/mouse.ts` wires the mouse-rotate handler's DOM events onto the
shared `DragHandler` (`handler.mousedown = handler.dragStart;
handler.mousemoveWindow = handler.dragMove;`, `:28-29`). `ui/handler/drag_handler.ts`:

```ts
// :101-106
reset(e?: E): void {
    this._active = false;
    this._moved = false;
    delete this._lastPoint;
    this._moveStateManager.endMove(e);
}
```

```ts
// :131-149 (dragMove)
dragMove(e: E, point: Point | Point[]): T | void {
    if (!this.isEnabled()) return;
    const lastPoint = this._lastPoint;
    if (!lastPoint) return;
    ...
```

After `reset()` deletes `_lastPoint`, `dragMove`'s `if (!lastPoint) return;`
guard fires on line 134 for **every** subsequent `mousemove`, with no way for
the handler to re-arm itself except a fresh `mousedown` (`dragStart`, which
also early-returns while a button is still held: `if (!this.isEnabled() ||
this._lastPoint) return;`, `:119` — irrelevant here since `_lastPoint` is
already gone, but confirming there is no other re-arm path). This
byte-for-byte reproduces #383's measured "max |bearing| across the entire
gesture = 0" — the camera genuinely receives zero drag deltas for the whole
remainder of that mouse-down, not merely a truncated one.

`handler_manager.ts:308` confirms the rotate handler's registered name for
anyone reproducing this: `this._add('mouseRotate', mouseRotate, ['mousePitch']);`.

### 2.4 Line-number drift from the issue's own 6.1.0 citations

| Site | Issue's 6.1.0 citation | Re-derived at 6.6.0 | Moved? |
|---|---|---|---|
| `camera.ts` bare `this.stop()` | `:1246` | `:1246` | No — file byte-region stable |
| `camera.ts` `_stop`'s `allowGestures` check | `:1213` (as `_stopHandlers()` call site) | `:1212-1213` | No |
| `map.ts` `stopHandlers:` wiring | `:1` off, cited as `map.ts:771` | `:772` | +1 |
| `handler_manager.ts` `reset()` loop | `:342-349` | `:353-363` | +11 |

This is exactly the kind of drift CLAUDE.md's citation-anchoring rule warns
about (line numbers move even when the surrounding logic does not) and is why
this section anchors every citation to a **statement or method name**, not
only a bare number.

## 3. Ready-to-file upstream report (drafted here — NOT submitted)

The following is written to be pasted directly into a new maplibre-gl issue.
Filing it is a decision for the maintainer, not this task; nothing was posted
to any repository outside `DocGerd/sail_command`.

> ---
>
> **Title:** A gesture (drag-rotate, drag-pan) begun during an in-flight
> `easeTo`/`flyTo`/`fitBounds` is silently discarded
>
> **maplibre-gl version:** 6.6.0
>
> **Steps to reproduce:**
> 1. Start any camera animation with a non-trivial duration (e.g.
>    `map.easeTo({ bearing: 0, duration: 600 })`).
>  2. Before that ease completes, begin a right-button drag (or any gesture
>     handled by `mouseRotate`/`mousePan`/etc.) — i.e. fire `mousedown`.
> 3. Wait until the ease's `duration` elapses while continuing to fire
>    `mousemove` events with the button held.
> 4. Observe: every `mousemove` after the ease's natural completion produces
>    zero camera movement. No `rotate`/`rotatestart`/`drag` event fires. The
>    only way to recover is to release and re-press the mouse button to start
>    a fresh gesture.
>
> **Expected:** A gesture already in progress when an animation ends should
> continue to be tracked normally — the same protection `allowGestures: true`
> already gives a gesture that is *itself* what stops the animation (see
> `HandlerManager.handleEvent`, `handler_manager.ts:474`,
> `this._camera.stop(true)`).
>
> **Actual:** `Camera._renderFrameCallback` (`camera.ts:1246`) calls
> `this.stop()` with no arguments on natural ease completion. `Camera._stop`
> (`camera.ts:1197-1216`) treats a missing `allowGestures` as falsy and calls
> `this._stopHandlers()` unconditionally (`camera.ts:1212-1213`). `Map`'s
> constructor wires that to `this._handlers?.stop(false)`
> (`map.ts:772`), and `HandlerManager.stop` (`handler_manager.ts:353-363`)
> calls `handler.reset()` on **every** registered handler whenever
> `_updatingCamera` is falsy — which it always is on this path, since the
> completion runs from a `requestAnimationFrame`-driven render-task callback
> (`map.ts:4221-4224`), never from `HandlerManager.handleEvent`
> (`handler_manager.ts:408-486`, the only place that sets `_updatingCamera =
> true`). For a drag handler built on `DragHandler`
> (`ui/handler/drag_handler.ts`), `reset()` (`:101-106`) deletes `_lastPoint`,
> and `dragMove` (`:131-149`) unconditionally returns early once `_lastPoint`
> is gone (`:134`), so every subsequent `mousemove` for the remainder of that
> gesture is silently dropped.
>
> **Suggested fix:** `_renderFrameCallback`'s natural-completion branch
> (`camera.ts:1246`) should call `this.stop(true)` instead of `this.stop()`,
> mirroring the `allowGestures: true` already used at the interrupt path
> (`handler_manager.ts:474`) — a camera animation ending on its own should not
> be treated differently from a camera animation stopped by an active
> gesture, with respect to whether OTHER, unrelated handlers get reset.
>
> **Impact:** any application using `easeTo`/`flyTo`/`fitBounds` with a
> non-zero duration can silently drop a user gesture that overlaps the tail
> of that animation. We observed this via an e2e test's compass control
> (right-drag begun during a still-running "return to north" ease), but the
> mechanism is general — not specific to any control we wrote.
>
> ---

## 4. Accept-or-mitigate decision

**Decision: ACCEPT.** File upstream (§3, pending maintainer action); do not
attempt an app-side workaround at this time.

### 4.1 Why not mitigate

Every app-side mitigation shape this spike considered (§5) requires touching
one of:

- gating gesture handlers during a commanded ease (there is no public
  maplibre API to suspend/resume `HandlerManager` selectively — it would mean
  monkey-patching or forking `_handlers`), or
- shortening/removing the compass's 600 ms return-to-north ease, which
  changes user-visible motion for a defect whose real fix is upstream, or
- adding new camera-animation call sites (a retry-the-ease pattern), which
  are exactly what `app/src/test/cameraAnimationCallSites.test.ts` exists to
  gate — a structural guard that fails loudly if a new camera-animating call
  site appears outside its allowlist.

All three intersect the #203/#227 camera-mode derivation
(`CompassControl.tsx`'s `onMoveEnd` guard) documented at length in this
repo's own CLAUDE.md: a **two-term** derivation
(`e.originalEvent !== undefined && commandedBearingRef.current !== null &&
!bearingReached(...)`) replacing maplibre v5's removed `map.isEasing()`,
where **both terms are individually load-bearing** — a one-term version was
*measured*, not assumed, to regress three existing tests, because two
distinct scenarios (an aborted ease that must demote, and a foreign ease
still live that must not) are bit-identical in any predicate over fewer than
both terms. That guard's soundness depends on a specific, carefully-derived
property of maplibre's own `_stop`/`_afterEase` sequencing (documented in
CLAUDE.md's Domain-rules section, with its own symbol-anchored citations)
that this spike did not need to re-verify, only to recognise as adjacent:
changing *when* or *how* `_stopHandlers()`/`reset()` fire, from app code,
risks disturbing the exact ordering that guard relies on, for a payoff that
is a UX inconvenience (the user repeats the gesture) rather than a safety or
correctness defect. This repo's own working-style rule that "the CORRECTION
is the highest-risk moment, not the original" applies here in its purest
form: any patch would sit directly beside the single most fragile,
most-already-regressed piece of camera-state logic in this codebase, for a
benefit an upstream one-line fix (§3's suggested fix) would obsolete outright
if merged.

### 4.2 Severity assessment supporting ACCEPT over MITIGATE

- **User-visible cost is low and self-correcting.** The failure mode is "a
  drag that starts during an already-brief animation does nothing; drag
  again." It does not corrupt state, does not silently apply a wrong route,
  and does not persist across the gesture that follows.
- **The only currently-reachable trigger in this app is the compass's 600 ms
  return-to-north ease** (per CLAUDE.md's own residual-scope note under the
  #203/#227 bullet, and per `cameraAnimationCallSites.test.ts`'s allowlist,
  which this spike did not modify and did not need to re-enumerate). A 600 ms
  window is short relative to the time it takes a user to notice, release,
  and re-initiate a rotate-drag.
- **The existing e2e mitigation already fully contains the symptom for CI.**
  #383/PR #390 added an at-rest settle gate to
  `rotateThenTapCompassHome` in `app/e2e/compass.spec.ts` so the test suite
  never begins a drag during a live ease. That is a test-side fix for a
  test-triggerable instance of a general defect — it does not claim to fix
  the defect for real users, and this spike does not change that framing.

### 4.3 What this decision does NOT do

- It does not close #391 — the defect is real, reproducible, and still live
  for real users on every `easeTo`/`flyTo`/`fitBounds` in this app.
- It does not supersede the existing CLAUDE.md entry describing this defect
  under the #203/#227 bullet (the "SECOND RESIDUAL" paragraph) — that entry
  remains accurate and this spike adds a re-derivation at the currently
  pinned version plus a ready-to-file report, nothing more.
- It does not preclude filing the upstream report in §3 — that action is
  explicitly left to the maintainer, per the task brief.

## 5. Considered and rejected

| Option | Why it lost |
|---|---|
| **Gate gesture handlers during a commanded ease** (suspend `HandlerManager` dispatch while `CompassControl` has an ease in flight) | No public maplibre API exists to suspend/resume handler dispatch selectively; would require forking or monkey-patching `_handlers`/`HandlerManager` internals, which are not part of maplibre's public surface and would need re-verification on every maplibre upgrade — a much larger maintenance burden than the defect itself. |
| **Shorten or remove the compass's 600 ms return-to-north ease** | Changes real, currently-shipped, deliberately-chosen camera motion (a UX property) to work around an upstream library defect whose actual fix is a one-line change (§3) the maintainers could make trivially. Narrows the reachable window without closing it — a gesture could still begin inside *any* nonzero-duration ease. |
| **Add a client-side "was my drag swallowed? retry the gesture programmatically" recovery** | Requires a NEW camera-animation-adjacent call site and new bearing-tracking state, both landing squarely inside the #203/#227 camera-mode derivation's fragile territory; `cameraAnimationCallSites.test.ts` would need widening for a defect that is not this app's to fix. Also cannot distinguish "gesture genuinely produced zero delta" (a real, if oddly-shaped, drag) from "gesture was swallowed" without re-implementing maplibre's own handler-reset detection from the outside. |
| **Patch the installed maplibre-gl copy directly** (a local patch-package-style fork) | Silently diverges from the declared `^6.6.0` dependency, is invisible to `npm audit`/Dependabot, and must be manually re-applied on every version bump — the `node_modules`-vs-lockfile trap this repo has already been bitten by twice (documented under "Never source an integer-exact claim…" in CLAUDE.md), self-inflicted this time. |
| **File upstream AND ship an app-side mitigation now, in parallel** | Rejected on cost/benefit: §4.1/§4.2 already establish the defect as low-severity and narrowly reachable; paying the #203/#227 risk for a UX inconvenience is not justified while the upstream fix (§3) is cheap and the correct place to fix a defect entirely inside maplibre's own camera/handler-manager interaction. |

## 6. Invariants checked against this recommendation

- **No app code changed.** This spike is documentation only; `git diff --stat
  origin/develop..HEAD` shows exactly one new file.
- **#203/#227 camera-mode derivation left untouched.** Nothing here modifies
  `CompassControl.tsx`, `cameraAnimationCallSites.test.ts`, or any camera-easing
  call site.
- **No routing, mask, or `#282`-governed behaviour is touched** — this defect
  and its analysis are confined to map-chrome camera/gesture interaction.
- **Citation discipline honoured**: every line number above was re-derived
  from installed `maplibre-gl/src/` source at the version this repo's
  lockfile pins as of 2026-09-01, confirmed by a byte-identical
  `package-lock.json` block comparison rather than assumed from a possibly
  stale `node_modules`, and anchored to symbols/statements per CLAUDE.md's
  citation-anchoring rule.
