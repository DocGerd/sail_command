# Spike: the Boat tab conflates boat selection, boat-scoped settings and global app settings

- Issue: [#742](https://github.com/DocGerd/sail_command/issues/742)
- Date: 2026-08-31
- Status: Recommendation (no implementation in this change; #742's own definition
  of done makes the restructure a follow-up issue)
- **Verdict, question 3 first because it GATES #746: NO — the AIS API key and
  the own MMSI do not belong in the same card, and they do not belong in the
  same STORE either. The key is an account credential, device-scoped and
  boat-independent; the MMSI identifies a vessel and must follow the boat.
  #746 should therefore land its per-boat MMSI on the BOAT surface, not in the
  Live & AIS card — and both fields should leave `Settings` entirely, because
  `PlanRequest.settings` snapshots the whole record by value into every saved
  plan while nothing under `app/src/routing/` reads either one.**
- **Verdict, the rest: keep ONE tab. Move the genuinely non-boat content into
  an explicitly device-scoped group INSIDE it, so the tab's name becomes true
  instead of renaming the tab to fit its contents. Do not make
  `motorSpeedKn`/`maneuverPenaltyS` per-boat overrides — spec §F.2 and
  `boats.ts`'s own "Deliberately NOT per-boat" note already rule on that, and
  the restructure's job is to make the existing truth visible, not to change
  the data model.** Full decomposition in §6.

---

## 0. Method, and what this document is allowed to claim

Every claim below names the FILE and the SYMBOL it was read from, re-read from
the working tree at `develop`@`2082281` on 2026-08-31. Nothing is stated from
memory; where the issue text and the code disagree, §1.6 says so, including two
places where the issue's premise does not hold.

Nothing here was measured in a browser. The one place where that matters — the
fifth-tab fit — is marked UNMEASURED in §4 and turned into a task rather than
an assertion.

This document does not write or amend a spec. §9 states exactly which parts of
the recommendation would need a spec amendment before implementation.

---

## 1. What the Boat tab actually renders, read from the code

### 1.1 The five cards

`app/src/App.tsx` renders `{tab === 'boat' && <SettingsPanel value={settings}
onChange={setSettings} boatId={boatId} onBoatIdChange={setBoatId}
titleRef={boatSettingsHeadingRef} />}`. `app/src/components/SettingsPanel.tsx`
returns a `div.settings-panel` containing, in source order:

| # | Surface | Controls | Genuinely scoped to |
|---|---|---|---|
| 1 | `<BoatPicker>` — its own `Card`, title `boat.section.title` ("Boat selection" / "Bootsauswahl") | one native radio group over `BOATS` | the boat (selection) |
| 2 | `Card` `settings.section.boatSafety` ("Boat & safety") | `safetyDepthField` (per boat), `DEPTH_COMFORT_MARGIN_FIELD`, `MANEUVER_PENALTY_FIELD`, `PERFORMANCE_FACTOR_FIELD` | mixed — see §3 |
| 3 | `Card` `settings.section.propulsion` ("Propulsion") | `motorEnabled` checkbox, `MOTOR_SPEED_FIELD`, `MOTOR_THRESHOLD_FIELD`, `SAIL_PREFERENCE_FIELD` | mixed — see §3 |
| 4 | `Card` `settings.section.liveAis` ("Live & AIS") | `showOwnship` checkbox, `aisApiKey` text input, `ownMmsi` text input + `role="alert"` invalid message | mixed — §2 |
| 5 | `Card` `settings.section.mapDisplay` ("Map display") | seamark-size `Slider` + `<output>`, seamark display-tier radiogroup | the app/device |

Two structural facts about that list that any restructure has to work with:

- **`Card` hardcodes its title as an `<h2>`.** `app/src/components/Card.tsx`
  renders `<h2 className="sc-card-title">` and its docstring states the intended
  outline: "app `<h1>` → card `<h2>` → endpoint `<h3>`". There is no
  heading-level prop. So introducing a real GROUP heading above these cards
  needs a primitive-layer change, not just JSX (§6.3).
- **Three controls in this panel bypass the primitive layer, and no primitive
  covers them.** `motorEnabled` and `showOwnship` are hand-rolled
  `div.options-field` + `<label>` + `<input type="checkbox">` + `p.options-help`;
  the seamark display tier is a hand-rolled `div[role="radiogroup"]` of
  `<label><input type="radio">`. `app/src/components/` contains `Button`,
  `Card`, `Chip`, `Disclosure`, `Field`, `NumberInput`, `Skeleton`, `Slider` —
  and no `Checkbox` or `RadioGroup`. This is not a defect to fix in passing; it
  is a cost any regrouping pays, because moving those controls means re-writing
  them by hand.

### 1.2 THREE persistence classes, not two — and the criterion that separates them

#742 says "the two persistence layers disagree" (boat id in localStorage,
everything else in IndexedDB). Read against the code there are three, and the
third is already inside this very panel:

| Class | Store | Members read from the code |
|---|---|---|
| A. `Settings` | IndexedDB, via `useSettings()` (`app/src/state/AppState.tsx`) | the eleven fields of `Settings` (`app/src/types.ts`) |
| B. localStorage, via `lib/storage.ts`'s `safeGetItem`/`safeSetItem` | localStorage | `sc-boat-id` (`lib/usePersistedBoatId.ts`), `sc-seamark-size-scale` and `sc-seamark-display-tier` (`usePersistedNumber`, read in `SettingsPanel.tsx` AND in `DataLayers.tsx`), the panel width (#355), `sc-lang` (`i18n/index.tsx`), `sc-session` (`lib/sessionSnapshot.ts`), `sc-gps-hint-shown` (`lib/gpsHint.ts`), the map-overlay toggles (`usePersistedToggle`) |
| C. Derived, not persisted at all | — | everything computed from A and B |

The criterion that separates A from B is already written down, in
`lib/usePersistedBoatId.ts`'s own docstring:

> Deliberately NOT a `Settings` field: `Settings` round-trips through IndexedDB
> and is snapshotted BY VALUE into every `PlanRequest` (spec I.3).

That is confirmed by the type: `PlanRequest` (`app/src/types.ts`) carries
`settings: Settings`. **So the question "which store does a per-boat setting
belong in?" has a principled answer already in the repo: does this value belong
in the DESCRIPTION OF A COMPUTED PLAN? If yes, `Settings`. If no,
localStorage.** §2.3 and §6.2 apply it.

`SettingsPanel.tsx` states class B's own rationale for the seamark controls in
the same terms: they are "map CHROME, not a domain `Settings` field — same
localStorage/usePersistedNumber contract as #355's panel width, deliberately
NOT threaded through `value`/`onChange` (those round-trip through IndexedDB
with the rest of `Settings`…)".

### 1.3 The partition #742 asks for already exists in code — for a different purpose

`app/src/lib/planForm.ts` declares
`ROUTING_RELEVANT_SETTINGS_KEYS` as a `const satisfies readonly (keyof
Settings)[]` with exactly eight members: `safetyDepthM`, `depthComfortMarginM`,
`motorSpeedKn`, `motorThresholdKn`, `sailPreferenceKn`, `maneuverPenaltyS`,
`performanceFactor`, `motorEnabled`. Its comment says why the other three are
absent:

> `showOwnship`/`aisApiKey`/`ownMmsi` are DELIBERATELY excluded — zero
> references anywhere under `app/src/routing/` — so pasting an AIS key or
> toggling the ownship marker never marks a displayed route stale.

That list exists to drive the cross-tab staleness banner, not to organise a UI.
But it is a code-enforced, already-reviewed partition of `Settings` into
"describes a route computation" (8) and "does not" (3), and **the three it
excludes are exactly the three the UI groups under "Live & AIS"**. A
restructure should align with it rather than invent a second partition that can
drift from it.

### 1.4 What the multi-boat spec already rules about per-boat scope

`docs/superpowers/specs/2026-08-10-multi-boat-design.md` settles most of
question 2 and must not be silently re-decided:

- **§F.2** lists, under "Deliberately NOT per-boat, and why — write this into
  the type's comment so nobody 'completes' it later":
  `motorThresholdKn` ("a seaworthiness floor, a statement about *water* …, not
  about the hull"); `depthComfortMarginM`, `sailPreferenceKn`,
  `performanceFactor`, `motorEnabled` ("user preferences, not boat
  properties", with `performanceFactor` explicitly named "the closest call" and
  still left global); and displacement, omitted rather than stored unused.
  `app/src/data/boats.ts` carries that list, PARAPHRASED, as a comment above
  the layering note — same three bullets, same membership, condensed wording
  ("a seaworthiness floor about WATER, not the hull" against the spec's "a
  seaworthiness floor, a statement about *water* (steerage in a seaway), not
  about the hull"). Two things follow for a restructure: the membership is
  what is authoritative and it matches, and the comment sits at MODULE level
  rather than on `BoatDef` itself, where §F.2's "write this into the type's
  comment" asks for it.
- **§F.2's record** makes `motorSpeedKn` and `maneuverPenaltyS` *per-boat
  DEFAULTS* for the corresponding `Settings` fields — "still user-tunable" in
  the spec's own summary table — not per-boat values.
- **§C.7** opens "`Settings` is a single global persisted record", and rules
  that a boat switch clamps `safetyDepthM` UP only, persists it, and tells the
  user. Never down.
- The addendum's own **Out of scope** line reads: "The settings/planner UI
  surface (separate workstream — this addendum specifies only what that UI must
  be able to *express*…)". **So #742's restructure is explicitly not covered by
  that spec, and does not need to amend it** — unless it changes what the data
  model expresses (§9).

### 1.5 What is wired, and what is written but never called

Read directly, because the difference decides §3:

- `app/src/lib/boatSettings.ts` :: `clampSettingsToBoat(s, b)` — **WIRED**.
  `BoatPicker.tsx`'s `handleSelect` calls it on every boat switch and derives
  its clamp notice from the returned `clamped` flag. Governs `safetyDepthM`
  alone.
- `app/src/lib/boatSettings.ts` :: `settingsDefaultsForBoat(b)` — returns
  `Pick<Settings, 'safetyDepthM' | 'motorSpeedKn' | 'maneuverPenaltyS'>` and
  has **NO production call site**. `app/src/lib/boatSettings.test.ts` says so in
  its own comment: "`settingsDefaultsForBoat` has no production call site yet".
- `BoatPicker.tsx`'s `handleSelect` closes with an explicit refusal, quoted
  because §3 turns on it:

  > Deliberately NOT applying `settingsDefaultsForBoat`'s other two fields
  > (`motorSpeedKn`, `maneuverPenaltyS`): spec C.7 governs `safetyDepthM`
  > alone, and those two are values the user may have tuned for their own crew.
  > Overwriting them on a boat switch would be clamping a preference, which is
  > the direction the spec forbids for the one field it does cover.

So the "the data model and the UI already disagree" that #742 identifies is
real, but it is a KNOWN, DELIBERATE state with a written reason — not an
oversight waiting to be tidied.

### 1.6 Two places where #742's premise does not hold, and one it does not mention

- **"a user looking for the boat has to scroll past four cards of unrelated
  configuration" — NOT TRUE against the current code.** `BoatPicker` is the
  FIRST child of `SettingsPanel`'s returned `div`, above "Boat & safety", with
  a comment saying it "sits ABOVE 'Boat & safety' deliberately — every field in
  that card is scoped to the selected boat …, so choosing the boat is the
  parent act and reading it second would invert the dependency." The ordering
  half of the complaint is already addressed; only the NAMING half stands.
- **"the two persistence layers" — there are three classes, and the third is
  in this panel** (§1.2). The Map Display card is already localStorage, not
  `Settings`, so a proposal that moves it "out of Settings" is proposing
  something that has already happened.
- **Not mentioned by the issue, and directly in its scope:
  `ais.status.off` points the user at a surface that does not exist.** The
  string is `'AIS off — add a key in Options'` (EN, capital O) and `'AIS aus —
  Schlüssel in den Optionen eingeben'` (DE). No tab and no card heading in the
  app is called that: the tab is `nav.boat` ("Boat" / "Boot"), and the card
  headings are `boat.section.title`, `settings.section.boatSafety`,
  `…propulsion`, `…liveAis`, `…mapDisplay`. `SettingsPanel.tsx`'s own header
  records that `OptionsPanel.tsx`'s default export was "deleted in the #486 fix
  wave … gone entirely". Besides `ais.status.off` itself, the phrase "in den
  Optionen" appears in `dict.de.ts` on exactly two other keys —
  `error.noRoute.calmMotorOff` and `about.caveats.polars` (measured
  2026-08-31 by `grep -n "in den Optionen" app/src/i18n/dict.de.ts`, which
  returns three hits, the third being `ais.status.off`). Their English
  counterparts both use a lowercase common-noun "options", so
  `ais.status.off` is the only string that names a nonexistent surface in
  both languages. `planner.import.success` is NOT one of them: it reads
  "Abfahrt und Optionen wählen", a different construction. **This is the
  discoverability defect #742 is about, in the copy rather than in the
  layout** — and it is evidence that renaming the tab is not the only lever.
  **Filed separately as #804**, so it is not work this restructure owns.

---

## 2. QUESTION 3, answered explicitly: does the AIS key belong with the MMSI?

**No.** They differ on every axis that should decide grouping, and the answer
gates where #746 lands.

### 2.1 The two fields have different scopes, lifetimes and futures

| | `aisApiKey` | `ownMmsi` |
|---|---|---|
| What it identifies | an aisstream.io ACCOUNT | a VESSEL |
| Cardinality | one per user/device | one per boat, once #746 lands |
| Behaviour on a boat switch | must not change | must change |
| Transmitted? | yes — `aisStream.ts` sends it in `buildSubscription(this.apiKey, …)` | never; `types.ts` says it "only ever filters the display — never sent", and `useAisTraffic.ts` uses it via `mergeAisMessage(…, ownMmsiRef.current)` |
| Validation | none | `isValidMmsi` (`app/src/lib/mmsi.ts`), exactly nine digits, with a `role="alert"` error |
| Failure if wrong | AIS does not connect — visible, self-announcing (`ais.status.keyError`) | the WRONG target is suppressed, or the right one is not — silent, and it is exactly the defect #746 exists to fix |

That last row is the decisive one. A shared card invites the reading that these
are two halves of one credential, which is precisely the mistake #746 documents
in the data model ("`ownMmsi` is stored once, globally, for the whole app — but
an MMSI identifies a **vessel**").

### 2.2 The shipped copy already fuses them, and splitting them splits the copy

`options.ais.help` — rendered as the AIS-key `Field`'s help text, and pointed at
by the key input's `aria-describedby="settings-ais-help"` — reads, in English:
"Your key and MMSI stay on this device; the key is sent only to aisstream.io as
part of the subscription, and the MMSI is used only to filter your own vessel
out of the display and is never transmitted."

One string, both fields, both languages. Splitting the fields therefore splits
this string into two, in `dict.de.ts` and `dict.en.ts`, and each half must keep
the sentence that is true of its own field. This is a small task with a real
trap: the transmitted/not-transmitted distinction is the sentence that must
survive intact on BOTH sides, and it is the sentence most likely to be
compressed away when a paragraph is halved.

### 2.3 Where #746's per-boat MMSI should land — the recommendation this spike owes it

1. **Surface: the boat group, not the Live & AIS card.** Concretely, a card
   whose title names vessel identity, rendered immediately after `BoatPicker`,
   inside the "this boat" group of §6.1. A field that must follow the boat
   belongs next to the control that changes the boat.
2. **Store: localStorage, one key per boat, not a record on `Settings`.**
   Two reasons, both from §1.2's criterion:
   - An MMSI does not describe a route computation and is not read anywhere
     under `app/src/routing/` (`ROUTING_RELEVANT_SETTINGS_KEYS` already
     excludes it, §1.3), so it fails the "belongs in the description of a
     computed plan" test. Leaving it in `Settings` copies it by value into
     every saved plan's `PlanRequest.settings`.
   - **One key per boat (`sc-own-mmsi-<boatId>`, read through
     `safeGetItem`) dissolves the hazard #746 itself warns about** — its own
     text says "do not use `in` for membership and do not read the map with
     bare bracket access on a stored key … This repo has already shipped that
     exact defect (#614/PR #656)". A keyed record needs `Object.hasOwn`
     discipline forever; a per-boat key needs no lookup table at all, so the
     `Object.prototype` fall-open class cannot arise. Prefer removing the
     hazard to guarding it. (Cost, stated: stale keys accumulate for boats that
     leave the catalogue. `usePersistedBoatId` already sets the precedent of
     leaving a stale entry untouched, deliberately, and gives its reason.)
3. **Migration of the one existing global value: DROP it, and declare the
   breaking change in `CHANGELOG.md`.** `docs/adr/0002-pre-1.0-db-migration-low-priority.md`
   offers exactly this branch. #746 floats the alternative — bind the existing
   value to the currently-selected boat on first read — and it should be
   REJECTED on the guard-asymmetry rule: an MMSI is a filter that SUPPRESSES a
   target, so binding it to the wrong boat suppresses the wrong vessel
   silently, which is the failure #746 exists to remove. Dropping it shows all
   traffic including the user's own vessel — visible, self-correcting, and one
   text field to re-enter.
4. **The key stays where it is scoped**: device-level, on the Live & AIS card
   (renamed per §6.1), and it should ALSO leave `Settings` for the same
   snapshot reason — see §6.2, which states the bounded, non-alarming version
   of that argument.

---

## 3. Question 2: which settings are genuinely per-boat?

### 3.1 The answer is already written; this spike confirms it rather than re-deciding it

Per §1.4, spec §F.2 plus `boats.ts`'s own comment give the partition, and
`lib/boatSettings.ts` :: `settingsDefaultsForBoat` encodes it as a type:
`safetyDepthM`, `motorSpeedKn`, `maneuverPenaltyS` are the three `Settings`
fields with a natural per-boat DEFAULT. `BoatDef` (`app/src/data/boats.ts`)
carries exactly `id`, `name`, `draftM`, `draftProvenance`, `motorSpeedKn`,
`maneuverPenaltyS`, `sails` — nothing else.

Per-boat DERIVATIONS (not stored fields) already exist and are safety-critical:
`app/src/lib/boatDepth.ts` :: `defaultSafetyDepthM(b)` =
`ceilToDecimetre(b.draftM + MASK_TOLERANCE_M)`, `minSafetyDepthM(b)` =
`ceilToDecimetre(b.draftM + 0.1)` (the safety-depth field's own `min`, via
`safetyDepthFieldFor(boat)`), and `relaxationFloorM(b)` =
`ceilToDecimetre(b.draftM)`. `relaxationFloorM`'s docstring calls leaving it as
a module constant "THE SINGLE MOST DANGEROUS SHORTCUT IN THIS FEATURE". Nothing
in a UI restructure may make it easier to apply one boat's gate to another
hull — #742's own constraint, and it is enforced today by the `min`/`max` of
the rendered field following `safetyDepthFieldFor(boat)`.

### 3.2 Should they "default from `BoatDef` and be overridable"? — NO, not as an override map

#742 asks this directly. Recommend against, for three reasons read from the
code:

1. **A per-boat override map is a `Settings` shape change**, and `Settings` is
   snapshotted by value into every `PlanRequest`. Spec §C.7 opens by calling
   `Settings` "a single global persisted record"; turning three of its fields
   into per-boat maps changes what a saved plan's `settings` snapshot means and
   is a spec-level change (§9), not a UI restructure.
2. **Two of the three deliberately are NOT applied on a boat switch**, with the
   reason recorded in `BoatPicker.tsx`'s `handleSelect` (quoted in §1.5):
   overwriting a tuned `motorSpeedKn` would be "clamping a preference, which is
   the direction the spec forbids". An override map does not remove that
   problem; it multiplies the places where it can be got wrong.
3. **The visible defect is that the relationship is invisible, not that it is
   absent.** `safetyDepthM`'s bounds DO follow the boat (`safetyDepthFieldFor`),
   and the help string already interpolates the per-boat `{min}`/`{max}` via
   `formatDepthM`. `motorSpeedKn`/`maneuverPenaltyS` have per-boat defaults the
   user can no longer see once they have edited anything.

**Recommended instead: give `settingsDefaultsForBoat` its first production call
site as an explicit, user-initiated "Reset to this boat's defaults" action**
(a `Button` primitive, in the boat group). That surfaces the per-boat defaults,
is never a silent overwrite, and therefore never clamps a preference. It also
retires a written oddity — a spec-mandated helper with no caller — instead of
building around it.

---

## 4. Question 1: separate tabs, or one tab with clearer grouping?

### 4.1 What a fifth tab would actually cost

- **Layout.** `app.css`'s `.app-tabs button { flex: 1 }` plus the global
  `button { min-width: 44px }` floor. #299's guard
  (`app/e2e/layout.spec.ts`, "the four-tab strip fits without horizontal
  overflow") asserts `tablist.scrollWidth - tablist.clientWidth <= 0` at
  `EDGE_VIEWPORTS.wrapForcing280` (280px) and `deepPortrait320` (320px), and
  its header records the measurement that made it a real guard: mutating
  `nav.boat` to `'Bootseinstellungen'` (18 chars) produced overflow of `93` at
  280px and `83` at 320px, while four `boundingBox()`-only checks all still
  passed.

  What that licenses, and what it does not: 5 × 44px = 220px < 280px, so the
  `min-width` floor alone is not the binding constraint at the narrowest edge
  viewport. Whether five real LABELS fit is **UNMEASURED** — and label extent
  is exactly the axis the #299 mutation showed is decisive. The guard is the
  instrument; run it with five tabs before adopting one.
- **Persisted state.** The `Tab` union lives in `app/src/lib/sessionSnapshot.ts`
  (`export type Tab = 'plan' | 'routes' | 'live' | 'boat'`), with `isTab()` and
  a documented restore POLICY in `readSessionSnapshot()` that coerces a
  persisted `'boat'` back to `'plan'` so "a sailor reopening the PWA on deck
  must land on a content tab, not the boat/skipper settings form." A fifth tab
  touches the union, the type guard, and that policy — and a settings-shaped
  fifth tab inherits the same never-restore-into rule.
- **The existing deep link.** `App.tsx` :: `handleOpenBoatSettings` switches to
  `'boat'` and then focuses `boatSettingsHeadingRef`, which `SettingsPanel`
  forwards onto the `settings.section.boatSafety` `Card`'s `titleRef` with
  `titleTabIndex={-1}` — the "Boat & safety" heading, reached from
  `PlannerPanel`'s inline safety-depth field. That is the SECOND `Card` in the
  rendered tree, not the first: `BoatPicker` renders its own `Card` (title
  `boat.section.title`) and is `SettingsPanel`'s first child, as §1.1's table
  says. A split has to decide which tab that jump lands on and retarget the
  ref; it must keep landing on the safety-depth field's own group, not on the
  boat picker.

### 4.2 Recommendation: ONE tab

Keep four tabs. Restructure inside the one, and let the contents earn the name
rather than renaming the tab to fit the contents:

- The complaint's ordering half is already false (§1.6) — the picker leads.
- The naming half is real, and has a cheaper first fix than a tab: the tab
  contains device-scoped cards that do not belong to a boat. Move those into an
  explicitly device-scoped group (§6.1) and the label "Boat" describes the
  tab's leading, primary content honestly.
- `nav.boat` = "Boot"/"Boat" was chosen at #299 specifically for the tab-strip
  margin, per that guard's own header. Any rename spends that margin, so a
  rename is a MEASURED decision, not a copy edit. §8 lists it as its own
  checklist item with the guard named.
- Fix `ais.status.off` (§1.6) regardless of the tab decision. A string that
  sends the user to "Options" when no such surface exists is a discoverability
  defect that survives every layout choice.

---

## 5. Question 4: does anything belong in the About dialog or a separate preferences surface?

**Not the About dialog.** `app/src/components/AboutDialog.tsx` renders a
version line, a changelog `Disclosure`, a caveats `<section>`, a sources
`Disclosure` and a close `Button` — **zero interactive settings**. It is a
focus-trapped modal (its own comment describes the trap and enumerates
`summary` among the focusables). Persistent configuration inside a modal is
worse for the cockpit use case this app is built for, and it would give the
dialog a second, unrelated job.

**Not a separate preferences surface either**, since that is a fifth tab by
another name (§4).

Worth recording as the actual precedent: **the app already hosts one global
preference outside any settings surface** — the language toggle, rendered in
`App.tsx`'s `div.app-header-actions` with `aria-label={t('nav.langToggle')}`,
persisted as `sc-lang` through `safeSetItem` (`app/src/i18n/index.tsx`). So the
established home for a truly global, one-tap preference is the HEADER. Nothing
currently in the Boat tab is one-tap and global in that sense — the closest,
`showOwnship`, triggers the geolocation permission flow (`types.ts`: "default
OFF/opt-in (enabling it triggers the geolocation permission flow)"), which is
not a header-toggle-shaped act.

---

## 6. RECOMMENDATION — the decomposition

### 6.1 One tab, two named groups, seven surfaces

Tab id `'boat'` unchanged; label unchanged pending the measurement in §8.

**Group A — "This boat"** (new group heading; per-boat scope)

| Surface | Controls | Change from today |
|---|---|---|
| A1 `BoatPicker` (`boat.section.title`) | boat radio group, provenance chips, keel disclosure | none |
| A2 Vessel identity (NEW card) | own MMSI, per boat, `isValidMmsi` + `role="alert"` preserved | **#746 lands here** — moved out of Live & AIS (§2.3) |
| A3 Boat & safety (`settings.section.boatSafety`) | safety depth (per-boat bounds), depth comfort margin, maneuver penalty, performance factor, **+ "Reset to this boat's defaults" `Button`** | one added control (§3.2); `titleRef` stays on this card (§4.1) |
| A4 Propulsion (`settings.section.propulsion`) | motor enabled, motor speed, motor threshold, sail preference | none |

**Group B — "This device"** (new group heading; device/app scope)

| Surface | Controls | Change from today |
|---|---|---|
| B1 Live & AIS (`settings.section.liveAis`) | show-my-position toggle, AIS API key | MMSI removed; `options.ais.help` split (§2.2) |
| B2 Map display (`settings.section.mapDisplay`) | seamark size, seamark display tier | none |

Nothing moves to another tab, to the header, or to About. The only control that
changes surface is the MMSI, and the only new control is the reset action.

Note honestly what group B still contains that is not purely device-scoped:
`showOwnship` is about the display of the user's own position, which is closer
to "this boat" than the AIS key is. It is placed in B because it is a
**display** preference of this installation, not a property of the vessel, and
because splitting it into its own card to make that argument would add a
surface for one checkbox. If a reviewer disagrees, the alternative is A5, not a
third group.

### 6.2 The storage move that should ride along

Apply §1.2's criterion and `ROUTING_RELEVANT_SETTINGS_KEYS` (§1.3): the three
`Settings` fields that are NOT routing-relevant — `showOwnship`, `aisApiKey`,
`ownMmsi` — should leave `Settings` for localStorage via `lib/storage.ts`, the
same contract `sc-boat-id` and the seamark controls already use.

Stated precisely, without over-claiming: `PlanRequest.settings` is a by-value
snapshot, so today an aisstream.io API key is copied into every saved plan
record in IndexedDB even though nothing under `app/src/routing/` reads it.
**There is no file-export leak today** — `app/src/lib/gpx.ts` :: `toGpx` emits
only route geometry, per-leg descriptions and the plan name, and a grep of
`JSON.stringify` under `app/src` (2026-08-31) finds no `Plan` serializer at
all. `Plan`'s own docstring in `app/src/types.ts` says why one does not exist
yet — "Structured-clone-safe (IndexedDB, postMessage) but NOT JSON-safe:
windGrid carries Float32Array fields. File import/export … needs a dedicated
serializer — never `JSON.stringify(plan)`" — which also means the day someone
writes that serializer is the day this becomes an export question. The
argument today is duplication of a credential across N durable records with
zero readers, not an existing exfiltration path, and it should be made in
those terms.

This is a stored-record shape change. Per
`docs/adr/0002-pre-1.0-db-migration-low-priority.md`, do not build migration
machinery: for `showOwnship` and `aisApiKey`, absent = today's default
(`false` / feature off), which fails closed in both cases; for `ownMmsi`, drop
and declare the breaking change (§2.3 item 3).

### 6.3 The primitive-layer work this needs

- **`Card` needs an optional heading level** (or a small `CardGroup`), because
  its title is a hardcoded `<h2>` and its docstring pins the outline `h1 → h2 →
  h3` (§1.1). Group headings at `<h2>` with cards demoted to `<h3>` is the
  correct outline; hand-rolling a heading beside the primitives is not, per the
  UI modernization addendum §3.2's reuse rule.
- **No `Checkbox` or `RadioGroup` primitive exists** (§1.1). The two checkboxes
  and the seamark radiogroup stay hand-rolled unless the follow-up chooses to
  add one — a decision worth making explicitly rather than by default, since
  `#705` already closed the analogous gap for `Button`.

---

## 7. Considered and rejected

Recorded so a declined option cannot quietly return as a fresh idea.

**R1 — Split into a fifth "Settings" tab. REJECTED.** §4.1: the fifth tab's fit
at 280/320px is unmeasured and label extent is the decisive axis; it touches the
persisted `Tab` union, `isTab`, and `readSessionSnapshot`'s never-restore-into-
settings policy; and it forces a decision about which tab
`handleOpenBoatSettings` lands on. All of that to solve a naming problem that
§6.1 solves by moving two cards into a labelled group. Not rejected on
principle — rejected as the more expensive of two fixes for the same complaint,
and reopenable if the §8 measurement shows five labels fit AND the grouped
single tab is tried and found insufficient.

**R2 — Rename the tab to "Settings"/"Einstellungen" as the primary fix.
REJECTED as an unmeasured change to a measured constraint.** "Boot"/"Boat"
(4 chars) was chosen at #299 for exactly this margin, and #299's own guard
records that an 18-character label overflowed by 93px at 280px. A rename may
well be fine — it is not fine to adopt without running that guard, and it is
not the cheapest fix available (§4.2).

**R3 — Per-boat override maps for `motorSpeedKn`/`maneuverPenaltyS`/
`depthComfortMarginM`. REJECTED.** §3.2: it is a `Settings` shape change,
`Settings` is snapshotted into every plan, spec §C.7 calls it "a single global
persisted record", and `BoatPicker.tsx`'s `handleSelect` already records why
those two are deliberately not overwritten on a switch. The visible problem is
that the per-boat defaults are invisible, which an explicit reset action fixes
without touching the model.

**R4 — Applying `settingsDefaultsForBoat` automatically on a boat switch.
REJECTED, and it is the tempting one.** It looks like completing an unfinished
feature (a spec-mandated helper with no caller). It would silently overwrite
`motorSpeedKn` and `maneuverPenaltyS` — values `BoatPicker.tsx` states may have
been "tuned for their own crew" — and doing so on ARROW-KEY TRANSIT is worse
than on landing: that same function's comment records that "Native radios select
on arrow-key focus, so arrowing THROUGH a deeper boat clamps up and persists on
the way past". A silent preference overwrite with that trigger is not
acceptable; an explicit button is (§3.2).

**R5 — Moving the AIS key or the MMSI to the About dialog. REJECTED.** §5:
About holds zero interactive settings and is a focus-trapped modal. Putting a
credential behind a focus trap in a cockpit app is worse than the status quo.

**R6 — Keeping the MMSI in the Live & AIS card and making it per-boat there.
REJECTED — this is the specific option #746 defers to this spike.** §2.1: a
field whose correct value changes on every boat switch, sitting in a card whose
other field must NOT change on a boat switch, teaches the wrong model and puts
the boat-dependent control furthest from the boat control. It also leaves the
fused `options.ais.help` string in place, which is where the conflation is most
visible to a user (§2.2).

**R7 — `ownMmsiByBoatId?: Record<string, string>` on `Settings`, the shape
#746 itself floats. REJECTED on two independent grounds.** It keeps a
non-routing value inside the record snapshotted into every plan (§6.2); and it
creates an object-literal lookup table keyed by stored input, i.e. the exact
`Object.prototype` fall-open shape #746's own text warns about and that this
repo has already shipped once (#614). One localStorage key per boat has neither
property. If a keyed record is nevertheless chosen, `Object.hasOwn` is
mandatory and a test must cover a stored key named after an `Object.prototype`
member, derived from `Object.getOwnPropertyNames(Object.prototype)` rather than
hand-written.

**R8 — Moving the Map display card out of this tab onto the map chrome.
REJECTED for now.** It is superficially attractive (`DataLayers.tsx` already
reads the same two localStorage keys, so the values are already live on the
map). But `app.css`'s own tier commentary records that `.map-stack-tl` bounds
its cluster's height and lets only `.data-layer-controls` shrink, with
`.compass-control` held at `flex-shrink: 0` — adding a slider plus a
three-option radiogroup to that cluster is a real narrow-viewport layout risk
for no gain over §6.1's group B. Reopenable with a measurement across
`STANDARD_VIEWPORTS` + `EDGE_VIEWPORTS`.

---

## 8. What the follow-up implementation issue must contain

#742's definition of done makes implementation a separate issue. That issue
should carry, at minimum:

1. **Scope**: the §6.1 decomposition, named surface by surface, with the
   explicit statement that no control moves to another tab, the header, or
   About.
2. **The #746 dependency, in the right direction.** #746's implementation
   location is decided by §2.3 (boat group, one localStorage key per boat,
   drop-and-declare rather than bind-on-read). Either #746 is done first and
   this issue places its field, or this issue creates the Vessel identity card
   and #746 fills it — pick one and say which; do not leave both waiting.
3. **The i18n work, enumerated**: new keys for the two group headings and the
   Vessel identity card title and the reset button, plus the SPLIT of
   `options.ais.help` into a key-only half and an MMSI half — **every key in
   BOTH `dict.de.ts` and `dict.en.ts`**, which `satisfies Record<MsgKey,
   string>` enforces. The `ais.status.off` wording and its "in den Optionen"
   neighbours are **#804's** scope, not this issue's (§1.6) — coordinate on
   naming rather than re-deciding it here, since whatever surface name #804
   lands on is the one this restructure has to keep true.
4. **The `Card` heading-level change** (§6.3), or an explicit decision to use a
   different grouping device, with the `h1 → h2 → h3` outline stated as the
   acceptance criterion.
5. **The storage move** (§6.2) as its own reviewable step, with the pre-1.0
   ruling's branch named per field and each absent-value default written into
   the reading code's own comment.
6. **The tab-label decision as a MEASURED item**: run
   `app/e2e/layout.spec.ts`'s `#299` guard with each candidate label and report
   `scrollWidth - clientWidth` at `wrapForcing280` and `deepPortrait320`.
   Adopt only a label that measures `<= 0` at both.
7. **Verification across `STANDARD_VIEWPORTS` AND `EDGE_VIEWPORTS`**
   (`app/e2e/helpers.ts`) — #742's own constraint. The 1024px wide-layout
   breakpoint (`lib/useWideLayout.ts`) changes this panel's geometry, so a
   single-viewport pass is not evidence.
8. **A safety regression check that the per-boat depth coupling is intact**:
   the rendered safety-depth field's `min`/`max` must still come from
   `safetyDepthFieldFor(boat)`, and `clampSettingsToBoat` must still fire on
   every boat switch with its notice. #742's own constraint says no regrouping
   may make it easier to apply one boat's gate to another hull.
9. **A note that `settingsDefaultsForBoat` gains its first production call
   site**, so `app/src/lib/boatSettings.test.ts`'s comment ("has no production
   call site yet") is updated in the same PR rather than left to rot.
10. **Labels**: `type: chore`, `priority: medium`. There is deliberately no
    `area:` member that fits UI-structure work — #610 (open, Backlog) records
    that gap; leave `area:` unset rather than forcing a wrong one.

---

## 9. Does anything here need a real spec amendment?

**No, for §6.1 and §6.3.** The multi-boat addendum's Out of scope line puts the
settings UI surface in a separate workstream (§1.4), and the UI modernization
addendum §3.2 governs how to build it, not what it contains. Regrouping cards,
adding a heading level to `Card`, and adding an explicit reset action change
nothing a spec asserts.

**Yes, if §6.2's storage move is adopted.** Removing `showOwnship`, `aisApiKey`
and `ownMmsi` from `Settings` changes what `PlanRequest.settings` contains,
which spec §I.3 and §C.7 both speak to ("`Settings` is a single global
persisted record"). It is also a stored-record change with a declared breaking
change attached. That is a main-session act; **this document does not make it,
and no implementation should proceed on the strength of this paragraph alone.**

**Yes, if R3 or R7 is adopted against this recommendation** — any per-boat map
on `Settings` is a data-model change §F.2 speaks to directly.

---

## 10. What this document does not establish

- Whether a five-tab strip fits at 280px and 320px (§4.1). UNMEASURED; §8 item
  6 names the instrument.
- Whether users actually fail to find settings under "Boat". No user research
  exists here; the naming argument rests on `ais.status.off` naming a surface
  that does not exist (§1.6), which is a defect in the artifact, not an
  inference about people.
- Anything about rendered geometry. Nothing here was measured in a browser; the
  #299 figures quoted in §4.1 are read from that guard's own header comment,
  where they were measured for that guard, and are not re-derived here.
- Whether `showOwnship` belongs in group A or group B (§6.1 states the
  argument and names the alternative rather than claiming the question is
  settled).
