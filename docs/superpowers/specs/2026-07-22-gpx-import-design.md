# SailCommand GPX Import — Design Addendum (#3)

**Status:** approved design direction (2026-07-22); pending implementation planning.
**Relationship:** addendum to `2026-07-14-sail-command-design.md` (the source-of-truth
design), which already carries the Garmin backlog pointer (§ "Garmin Boating route sync
(backlog, v2)", lines 166–169: *"First increment will be file-based GPX import (export
already exists); true API sync is constrained by the no-backend rule."*). This addendum
specifies that first increment. It changes no routing/solver behavior and adds no data
model — it produces a `PlanRequest` the existing plan flow already understands. Where this
document and the source spec conflict, the source spec wins on domain behavior.

## 1. Goal

Let a user bring an existing route into SailCommand from a `.gpx` file (Garmin Boating /
ActiveCaptain and other chartplotters export GPX 1.1). The imported route becomes a normal
SailCommand **planning input** — origin, destination, and any intermediate waypoints —
which the user then plans with the existing engine to get a time-optimal passage against a
fresh forecast. Export already exists (`toGpx` in `app/src/lib/gpx.ts`) and serves as the
"push" side; this addendum is the **import** counterpart.

## 2. Hard constraints (locked — do not revisit under this issue)

- **No backend, no network beyond the existing planning fetch.** Parsing is 100% client-side.
- **No service-worker or manifest changes.** Entry is a plain file-picker (see §4). The
  fragile `sw.ts` pmtiles Range route ordering (CLAUDE.md) is not touched. Web Share Target
  is explicitly out of scope for this increment (§6).
- **No IndexedDB schema change / migration.** Import yields a `PlanRequest`; the plan and its
  `windGrid`/`result` are produced by the normal flow, saved as today.
- **i18n:** every user-facing string (button, success, each error) goes through the de/en
  dictionary with `satisfies Record<MsgKey, string>` parity — both dicts, always.
- **No chart/navigation-authority language** in any copy ("Import/Planung", never
  "Navigation"). Imported geometry is a planning input, not a validated route.
- **Reuse, don't reinvent:** map to the existing `PlanRequest.viaPoints` machinery and the UI
  primitive layer (`Button`, etc.); do not add a parallel waypoint concept.

## 3. Data mapping (no new types)

A parsed GPX file maps onto the existing `PlanRequest` (`app/src/types.ts`):

```
origin        := first parsed point
destination   := last parsed point
viaPoints     := the intermediate points, in file order
originHarborId, destinationHarborId := null   (imported points are raw coords, not harbors)
departureMs, settings                := NOT set by import — user supplies via existing controls
```

This matches the shipped via-waypoint feature (source spec lines 160–165: ordered
`viaPoints`, per-segment solve, 300 m navigable snap, `snap-failed-via`). Intermediate
waypoints are therefore **honoured**, not discarded. Imported points are presented as
`PickedPoint` with `source: 'tap'` (raw coordinates); harbor-snapping is a non-goal for v1
(§6).

## 4. Entry point

A labelled control in the planner (built from the `Button` primitive) wrapping
`<input type="file" accept=".gpx,application/gpx+xml">`. Selecting a file reads it as text
(`File.text()`), parses it (§5), and — on success — prefills the planner inputs (§7).
Available offline (it is pure local file handling); only the subsequent **Plan** action needs
network, exactly as manual planning does today.

## 5. Parser (`parseGpx` in `app/src/lib/gpx.ts`)

Add `parseGpx(xml: string): ParsedGpxRoute` beside `toGpx`, using the browser `DOMParser`
(no XML dependency; DOMParser does not resolve external entities, so it is XXE-safe by
construction — do not hand-roll entity handling).

Point extraction, in priority order:
1. **`<rte>`/`<rtept>`** (a route = intended waypoints) — the primary Garmin form. Take all
   `rtept`s in document order.
2. **Fallback `<trk>`/`<trkseg>`/`<trkpt>`** — a track is a *recorded breadcrumb* (often
   hundreds of points), not intended waypoints. Use **only its first and last** trkpt
   (origin + destination); the track's shape is intentionally ignored. Surface a
   non-blocking notice that a track was reduced to its endpoints.
3. **Standalone `<wpt>`** (no rte/trk) — treat the waypoint list as ordered points.

If more than one `<rte>` is present, use the first and note that others were ignored.

**Via-count guard:** intermediate waypoints beyond a soft cap (**8**, a tunable constant)
are dropped with a non-blocking warning, because each forced via-point *constrains* the
time-optimal search (the router must pass through it). Origin and destination are always
kept.

`ParsedGpxRoute` is a plain local shape (`{ origin: LatLon; destination: LatLon; viaPoints:
LatLon[]; notices: GpxNotice[] }`) used only to hand off to the prefill step — it is **not**
persisted and **not** added to the domain types beyond this module's needs.

## 6. Validation & errors (all i18n, de+en)

Reject with a clear, specific message (never a silent no-op) when:
- the file is not well-formed XML / not GPX (DOMParser `<parsererror>`, or no `<gpx>` root);
- **no** `<rte>`, `<trk>`, or `<wpt>` yields at least two usable points (need ≥ origin+dest);
- any `lat`/`lon` is missing or non-numeric / out of WGS84 range;
- any resulting point lies **outside the app's mask data-area** (read the committed
  `MaskMeta` bounds `west/south/east/north`; the app cannot route outside its data).

Points that are inside the data-area but over land / too shallow are **not** rejected at
parse time — they surface through the existing `snap-failed-origin|destination|via` reasons
at plan time, keeping one code path for navigability.

**Non-goals for this increment:** Web Share Target / "Share to SailCommand"; harbor-snapping
of imported points; multi-day trip chaining (a GPX with many waypoints still imports as **one
passage** — chaining into overnight legs is #19's scope); GPX metadata beyond geometry
(names, symbols, times); true Garmin API/OAuth sync (constrained by the no-backend rule —
"push" stays the existing export).

## 7. Post-import behavior

Prefill, then the user plans (chosen direction): parse populates origin / destination /
via-points into the existing planner inputs and shows any `notices`; the user then sets
departure time, boat/rig, and safety depth on the current controls and presses **Plan**.
Import never guesses departure time or settings — GPX carries none, and departure time
materially changes a time-optimal wind route.

## 8. Files touched

- `app/src/lib/gpx.ts` — add `parseGpx` + local `ParsedGpxRoute`/`GpxNotice`/error types.
- `app/src/lib/gpx.parse.test.ts` (new) — unit tests (§9).
- One planner UI touch (`app/src/components/PlannerPanel.tsx`, using the `Button` primitive)
  for the import control + notice/error surfacing; wire parsed points into the existing
  origin/destination/via input state.
- `app/src/i18n/dict.de.ts`, `dict.en.ts` — new `MsgKey`s (button, success, each error,
  track-reduced notice, via-cap notice), added to **both** dicts.
- No `sw.ts`, no `vite.config.ts` manifest, no `db.ts` change.

## 9. Testing

- `gpx.parse.test.ts` cases: valid `<rte>` (origin/dest/via mapping in order); `<trk>`
  fallback reduced to endpoints; `<wpt>`-only ordered list; malformed XML → error; missing/
  non-numeric coords → error; point outside mask bounds → error; via-count over cap →
  truncation + notice; a real Garmin-style fixture.
- **Literals hand-derived from the fixture coordinates**, never copied from `parseGpx`'s own
  output (repo lesson #50 — a test that reads expectations from the function under test is a
  tautology).
- A real-browser pass (dev server + import a `.gpx`, confirm prefill + plan) closes the task,
  per the repo's UI verification lesson (#20).

## 10. Delivery

Feature branch → PR onto `develop` (gitflow-lite), `Closes #3`, self-reviewed
(`/pr-selfreview`). No release implied.
