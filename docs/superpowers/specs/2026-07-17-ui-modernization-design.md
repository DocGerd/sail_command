# SailCommand UI/UX Modernization — Design Addendum (#64)

**Status:** approved design direction (2026-07-17); pending implementation planning.
**Relationship:** addendum to `2026-07-14-sail-command-design.md` (the source-of-truth
design). This document does not change any behavior defined there; it re-skins and
re-organizes the existing UI. Where the two conflict on presentation, this addendum wins;
on domain behavior (routing, sampling, persistence, offline), the source spec wins.

## 1. Goal

Bring the SailCommand UI to a modern, considered, "state-of-the-art" standard **within the
locked #34 identity** — improving layout, information hierarchy, the planning flow, results
presentation, and interaction polish, without touching the visual identity or any domain
behavior.

Chosen direction (from a three-option visual comparison): **Focused Refit** — keep the
Plan / Routes / Live shell and both existing layouts (wide side-panel, narrow bottom-sheet),
and upgrade every piece in place. Rejected: *Results-forward* (panel becomes a dashboard —
larger IA change and test churn) and *Map-first* (full-bleed map + floating glass panel —
largest rework and most risk to the shipped layouts). Individual ideas from those may be
folded in where cheap (e.g. the Ergebnis card borrows the results-forward summary emphasis).

## 2. Hard constraints (locked — do not revisit under this issue)

These come from the #34 identity (`docs/brand/identity-rationale.md`) and CLAUDE.md and are
**not** in scope to change:

- **Palette:** the `--sc-*` tokens in `app/src/app.css` (Azure accent `#2c6cb0` / `#5e9be0`,
  paper/ink neutrals, banner semantics, brand navy). Light **and** dark modes.
- **UI typography = `system-ui`.** No webfonts in the UI (brand font lives only inside SVG
  artwork as paths).
- **Map semantics = Okabe-Ito**, decoupled from the UI accent: starboard `#009e73`, port
  `#d55e00`, motor `#5b5b5b` dashed, via `#cc79a7`, shallow `#e69f00`, position halo
  `#ffd400`, boat-blue `#0072b2`, wind barbs ink `#1a1a1a`. Untouched.
- **No chart/navigation authority language** in any copy ("Planung/planning", never
  "Navigation").
- **i18n:** every user-facing string goes through the de/en dictionary with
  `satisfies Record<MsgKey, string>` parity — both dicts, always.
- **Two sampling clocks stay separate:** map barbs sample the plan grid at the SLIDER hour;
  the depth profile samples each instant's own hour. Visual changes must not unify them.
- **Both layouts preserved:** wide (`>=1024px`) two-column side-panel and narrow bottom-sheet
  (the primary on-boat, cockpit-portrait mode). Touch targets stay `>=44px` for gloved use.
- **No backend, offline-first:** only planning needs network; everything else keeps working
  offline. No new runtime network dependency.

## 3. Design decisions

### 3.1 Harbor picker — searchable combobox (replaces the inline mega-list)

**Problem (current):** the Start and Ziel sections each render the *entire* ~35-harbor list
inline, as buttons with multi-line depth captions — the same list twice — so the panel is an
enormous scroll and the relationship between the search box, the list, and the current
selection is unclear.

**Design:** a single searchable **combobox** per endpoint.

- A text field ("Hafen suchen…") that, on focus/typing, opens a compact popup listing
  **at most ~8 rows** (the list scrolls); no more always-rendered full list.
- Match: case/diacritic-insensitive substring on the harbor name (Danish/German names, e.g.
  "Ærøskøbing", "Årösund"). Ranking: exact prefix first, then substring.
- Each row: harbor name (primary) + its depth caveat (secondary, muted, single line,
  ellipsized). The full caveat shows on the selected endpoint row.
- **Empty-query state:** show recently used harbors first (persisted, small LRU), then the
  rest alphabetically — so the common round-trip harbors are one tap away.
- **Keyboard + ARIA:** proper `combobox`/`listbox`/`option` roles, `aria-activedescendant`,
  ↑/↓ to move, Enter to select, Esc to close; visible focus ring. Fully operable by keyboard
  and screen reader.
- **"Auf Karte wählen"** (map-pick) remains as the alternate selection method, unchanged in
  behavior.
- **Selected state:** the combobox collapses to a clean **endpoint row** — pin (starboard
  green for Start, accent for Ziel) · name · caveat · a *Ändern* (Change) affordance that
  reopens the combobox.

This removes the single largest source of clutter and is the highest-value change.

### 3.2 Component system on the locked tokens

Introduce a small set of reusable primitives, all styled through the existing `--sc-*`
tokens (no new palette). This replaces the current default-styled controls and gives the
panel real hierarchy.

- **Card** — a bordered/elevated surface grouping one concern; header with an uppercase,
  letter-spaced, muted section label.
- **Field** — label + control + optional help text (reuses the existing `.options-field`
  idea), consistent spacing.
- **Button hierarchy** — `primary` (accent fill, for "Route planen"), `secondary` (outline),
  `ghost` (dashed/quiet, for "+ Wegpunkt", "Ändern"). One primary action visible at a time.
- **Chip** — small pill for the faster-rig badge and status markers.
- **Disclosure** — a labeled expandable row (used for advanced options and the legs table),
  with a chevron that flips on open and a `>=44px` touch target.
- **Focus/hover/pressed:** finally consume the reserved `--sc-accent-strong` token for
  hover/pressed states, and give every interactive element a visible accent focus ring.
- **Rhythm:** 8-pt spacing scale, consistent radii, `text-wrap: balance` on headings,
  `tabular-nums` wherever figures align (result stats, legs table).

The planner content regroups into three cards: **Reise** (Start / Ziel / Wegpunkte),
**Ergebnis** (results, post-plan), and **Erweitert** (advanced options).

### 3.3 Advanced options — progressive disclosure

The six advanced numeric inputs (safety depth, motor speed, motor threshold, tack/gybe
penalty, power factor, motor-enabled) move behind an **"Erweitert"** disclosure that shows a
one-line summary of the current values when collapsed (e.g. "Sicherheitstiefe 3 m · Motor an
· Wende­strafe 45 s"). Defaults are unchanged. The two most-frequently-changed inputs —
**departure time** and **safety depth** — stay visible in a compact row above the disclosure,
because they materially change the result. "Route planen" stays reachable at the panel
bottom (sticky) so it is never below a long scroll.

### 3.4 Results elevation — the Ergebnis card

**Problem (current):** after planning, the numbers that matter (arrival, distance, faster
rig, sail/motor split) are not surfaced — the input form stays in view while the route is
only on the map.

**Design:** a prominent **Ergebnis card** appears after a successful plan, containing:

- **Arrival**, **distance**, **duration**, **average speed** as a stat grid (`tabular-nums`).
- A **faster-rig chip** (genoa vs. fock — both are computed and user-visible per the source
  spec; the recommended/faster one is chipped, the other reachable).
- A **sail/motor split bar** visualizing the motor-leg proportion (motor legs are first-class
  per the source spec).
- The existing **shallow-water warning** banner (#53) when the relaxed-solve/shallow flag is
  set — reused verbatim, same `#e69f00` family.
- The **DepthProfile** (#45) and **RouteLegend** get the card treatment for consistency; the
  **legs table** stays available inside a disclosure. The strong map visualization is kept
  as-is (it is already good — colored legs, barbs, depth tint, time slider, collapsible
  legend).

### 3.5 States & motion

- **Empty / first-run:** a short onboarding line in the panel ("Wähle Start und Ziel, um eine
  Route zu planen") instead of a bare form; the primary button reads disabled-with-reason.
- **Loading:** a skeleton on the Ergebnis card while the worker solves (the router runs twice
  — genoa and fock). Planning requires network, so this is also where a first-run
  network-needed hint lives.
- **Error:** clear, actionable inline messaging distinguishing *offline / no network*,
  *no route found within constraints*, and *unexpected failure* — no silent failures, no
  apologetic vagueness; each says what happened and the next step.
- **Motion:** tasteful only — card expand/collapse, Ergebnis fade-in on plan completion,
  focus transitions. Everything gated on `prefers-reduced-motion: reduce`. No ambient or
  decorative animation (it would read as templated).

## 4. Phasing

Each phase is an independent PR to `develop` (gitflow-lite), with e2e canvas baselines
re-settled per phase (two-consecutive-byte-equal frames; no fixed `waitForTimeout` as a sync
wait). Phases are ordered so each ships value and de-risks the next.

1. **Primitives + card restructure** — introduce Card/Field/Button/Chip/Disclosure and
   regroup the existing planner content into cards. *No behavior change*; pure presentation.
   Establishes the system the later phases build on.
2. **Harbor combobox** — replace the inline mega-list with the searchable combobox
   (§3.1). The biggest UX win and the largest DOM reduction.
3. **Advanced disclosure + Ergebnis card** — progressive disclosure (§3.3) and results
   elevation (§3.4).
4. **States + motion** — empty/loading/error states and the motion polish (§3.5).

## 5. Testing & verification

- **Unit (Vitest):** the combobox (filtering/ranking, keyboard, ARIA, recent-LRU), the
  Ergebnis card (stat formatting, rig selection, split proportion), disclosure state,
  persistence of recents. Pin literal expected values derived by hand — never assert values
  read back from the component under test (repo lesson #50).
- **i18n:** every new key in both de/en dicts (parity enforced by `satisfies`).
- **E2E (Playwright):** default-on overlays already covered (#63); add coverage for
  plan-then-see-Ergebnis, combobox select, and the empty/error states. Re-settle canvas
  baselines per phase.
- **Real-browser pass** each phase (dev server + Playwright), per the repo's hard-won lesson
  that synthetic checks miss product issues; wide **and** narrow layouts.
- **Implementation must run through the `frontend-design` skill / DesignSync** for
  component-level visual polish, per #64.

## 6. Non-goals

- No change to the visual identity, palette, typography, or map semantics (§2).
- No change to routing, sampling, persistence, offline behavior, or the worker protocol.
- No new IA (tabs stay Plan / Routes / Live); no map-first / floating-panel restructure.
- No new runtime network dependency; no backend.

## 7. Open questions

None blocking. Two deferred, decidable during implementation: (a) whether recent-harbors
persistence reuses the `usePersistedToggle`/`storage.ts` pattern (#63) or a small dedicated
store; (b) whether the legs table lives inside the Ergebnis card disclosure or remains a
separate section — decide when the Ergebnis card is built.
