# Next passage from a planned route — design (#19 slice 1)

Status: maintainer-approved scope decisions 2026-10-17 (v0.55.0 cycle). Umbrella: #19 (multi-day
trips). This addendum is slice 1 only; the trip store, timeline and arrival windows are #1708,
designed in `2026-10-28-multi-day-trips-design.md`.

## Intent

Aboard EASY GO!, tied up in the evening, the sailor plans tomorrow's passage. Today that means
re-entering the start harbour and a departure time by hand, and planning is impossible without a
connection. Slice 1 makes the next passage one tap away from any planned route, and lets it be
planned offline from the forecast already stored with that route.

## Decided (maintainer)

- One tap on a planned route seeds a NEW plan: start = that route's destination; the user picks the
  destination and may edit the departure.
- The action is available on every planned route, not gated on the ETA having passed (the app has
  no "arrived" state).
- Label: DE „Nächste Passage planen", EN "Plan next passage". "Etappe" already means a route leg
  and „ab hier" means "from the GPS fix" in this app.
- Departure default: the first local 10:00 strictly after both the source route's ETA and now
  (ETA 00:30 → 10:00 that morning; a long-past ETA → the next future 10:00). Editable.
- Forecast: online → fetch fresh as today. Offline → reuse the source route's stored wind grid if it
  reaches the departure; otherwise the existing offline behaviour (no plan). "Offline" includes a
  browser that reports online but whose forecast fetch fails for a network reason (harbour Wi-Fi
  without internet): a seeded run then falls back to the stored grid under the same conditions.
- While a seed that can be planned offline is active, the offline banner is qualified:
  „Offline — nur die nächste Passage mit gespeicherter Vorhersage planbar" / "Offline — only the
  next passage can be planned, from the stored forecast". Otherwise it is unchanged.
- Lean slice: no in-place undo; the seeded form is edited back by hand.

## Spec amendment: narrow offline-planning exception

The 2026-07-14 design (§2 "Offline scope", §4 "Offline / Open-Meteo unreachable") and the UI
addendum §3.5 say planning requires internet. Amended: offline planning is allowed ONLY for a next
passage seeded by this action, ONLY while the seeded start is unchanged, and ONLY when the source
route's stored grid reaches the chosen departure. Every other offline plan attempt stays disabled
with today's message. The reused grid keeps its original fetch time, so the existing stale-forecast
warning (fetch → departure gap > 12 h) applies by its own rule; the plannable offline guidance line
names the source route and that fetch time.

## Constraints

- No `app/src/types.ts` hunk and no `app/src/lib/wind.ts` edit (both are in the #282 sweep
  closure); no Settings field, no new IndexedDB store, no `DB_VERSION` bump. Seed state is
  ephemeral UI state and is never persisted.
- The new plan is minted by the existing plan → save path with a fresh id; the source plan is
  never modified.
- UI primitives and `--sc-*` tokens only; de/en strings through the dictionaries.
- Design floor is tablet ≥ 820 CSS px (narrow branch at 820 portrait, wide ≥ 1024).

## Behaviour

1. **Sites.** A `Button variant="secondary"` in both result cards: the Plan tab's compact result
   card next to „Details ansehen", and the Routes tab's full result card in its own card-level row
   outside the per-rig tab panel, shown whenever either rig has a route (GPX export stays where it
   is). A muted line under it previews the seed:
   „Start {Hafen} · Abfahrt {Tag} {Zeit}" / "Start {harbour} · Departure {day} {time}", linked by
   `aria-describedby`. Disabled while a plan run is busy and while the harbour list is empty (a
   non-empty list also means the routing assets loaded).
2. **Seed.** Start = the source route's destination as a picked point (harbour id kept when the
   harbour exists); destination cleared; via points and segment modes cleared; tap-to-pick target
   cleared; departure per the rule above. The current plan stays the active plan (map and Live
   guidance unchanged).
3. **Focus.** The destination harbour picker gets focus. From the Routes tab the action switches to
   the Plan tab first. „Route planen" stays disabled with the existing missing-destination reason
   until a destination is picked.
4. **Seed state.** Ephemeral `{ sourcePlanId, origin, departureMs }`; `departureMs` is the seeded
   departure, compared at save time to detect a hand edit (#1708). Cleared when the start is
   edited or a different plan becomes active. The existing "result is stale" chip keeps its current
   rule (it fires once a destination is picked).
5. **Offline.** The plan action is enabled offline only when seed state is set, the start is
   unchanged and the stored grid's last time ≥ departure. The run then uses that grid and skips the
   online check and the fetch; online, a seeded run whose fetch fails for a network reason retries
   once with that grid under the same conditions. A departure past the forecast window gets the
   existing horizon messages. The ETA overrunning the grid is the solver's existing
   beyond-horizon result. Guidance copy (non-alert): „Offline — nutzt die gespeicherte Vorhersage
   von „{Name}" (abgerufen {Zeit})." When the grid is too short: „Offline — die gespeicherte
   Vorhersage reicht nur bis {Zeit}; für diese Abfahrt ist eine Verbindung nötig." English mirrors
   both.

## Non-goals

Trip record linking passages, layover setting, timeline, arrival windows, undo, a saved-plans-list
row action, a Live-view entry point, chaining across more than one stored forecast. The trip
record, layover, timeline, arrival windows and the saved-plans-list row action are now covered by
`2026-10-28-multi-day-trips-design.md` (#1708); undo and the Live-view entry point are split to
their own issues there.

## Builder's calls

- Helper names and placement (e.g. a next-passage departure helper beside `departureSeedMs` in
  `lib/planForm.ts`, `lib/trip.ts` if a home for seed logic is wanted).
- The departure is seeded from the recommended rig's ETA (`recommendedResult`), not the displayed
  rig's, so it matches the trip layover rule (`2026-10-28-multi-day-trips-design.md`, maintainer
  ruling 2026-10-28 on #1708).
- Exact grid-reach check and where it lives, as long as it reads the grid's own times.
- Tests: unit for the departure rule (incl. DST and after-midnight ETA), the seed, the offline
  gate both ways; e2e at `tabletPortrait` and `desktopHd` for seed + focus, and an offline case
  where the grid reaches and one where it does not. Existing `offline.spec.ts` behaviour (no seed)
  must stay unchanged.
