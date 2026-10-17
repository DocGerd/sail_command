# Next Passage (#19 slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tap on any planned route seeds a new plan from its destination, and that seed can be planned offline from the source route's stored forecast.

**Architecture:** Pure seed/gate helpers in `lib/planForm.ts`. `usePlanFlow.run()` gains an optional fallback grid: it is used when the browser is offline, or when the fetch fails for a network reason, as long as the grid reaches the departure. App owns ephemeral seed state. Validity is derived (same plan id, unmoved start), never stored. App feeds one shared `NextPassageAction` component to both result cards, the offline gate, the qualified banner and a guidance line.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`), React 19, Vitest + RTL (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-17-next-passage-design.md` (binding). Issue #1707 (umbrella #19).

## Global Constraints

- **Sweep closure is untouchable.** Run `node .claude/skills/sweep-closure/closure.mjs closure` to list it. No edit to `app/src/types.ts`, `app/src/lib/wind.ts`, `app/src/data/boats.ts`, `app/src/routing/**`, `app/src/test/{fixtures,setup,timeouts}.ts`, `app/sweep/**`, `app/public/data/**` or `pipeline/**`. New test fixtures live in the test file that uses them.
- No Settings field, no new IndexedDB store, no `DB_VERSION` bump. Seed state is never persisted.
- The source plan is never modified. The new plan comes only from `usePlanFlow.run()` with a fresh id. The seed holds `cloneWindGrid(plan.windGrid)` (`state/reroute.ts`), so `fetchedAtMs` carries over and the stale-forecast warning fires by its own rule.
- UI uses the `Button`/`Card` primitives and `--sc-*` tokens only. The one new CSS rule is in Task 3. Before editing `app.css`, read the headers of `app.css.test.ts` and `chipShallowFill.test.ts`. No new class may start with `.chip-`.
- Every string goes through both `dict.de.ts` and `dict.en.ts`, with identical `{placeholders}` (`i18nPlaceholderParity.test.ts`). DE inner quotes are „…“ (U+201E/U+201C, as in existing values). EN inner quotes are ASCII `"…"`.
- New button labels: DE `Nächste Passage planen`, EN `Plan next passage`. Playwright `getByRole` name matching is substring and case-insensitive. Task 6 re-runs the collision grep in both languages.
- e2e viewports come from `STANDARD_VIEWPORTS` (`tabletPortrait`, `desktopHd`). No `waitForTimeout`; gate on polled state. Use `startPreview(page)`, never the bare form. Run at most one e2e at a time. Restore `app/public/test-fixtures/wind-sw12.json` after any e2e run (`git restore`).
- Vitest files never hardcode `timeout`/`testTimeout`. Import from `app/src/test/timeouts.ts` if one is needed (`timeoutGuard.test.ts`).
- react-hooks 7 `recommended-latest`: no `Date.now()` in a render body (snapshot it with `useState(() => Date.now())`), and no ref reads during render.
- `exactOptionalPropertyTypes`: omit an optional key; never pass `undefined` (spread `...(x ? { k: x } : {})`).
- Comments are minimal: write a comment only for a non-obvious *why*. No dates, durations or measured figures in comments.
- Append new tests as new `describe` blocks at the END of existing test files. Other lanes edit these files in parallel.
- Implementers run FILTERED tests only (`npm --prefix app run test -- <file-or-filter>`), never the full suite. Before each commit run `npm --prefix app run typecheck` and `npm --prefix app run lint`.
- Commits: stage explicit paths. Write the message (subject, `Refs #1707`, the session attribution trailer) to a uniquely named file with the Write tool, then `git commit -F <file>`. Use no closing keyword in any commit. The PR body carries `Closes #1707`.
- `changelog.d/1707.added.md`: one top-level bullet ending `(#1707).`

## Review Focus

1. **Harbour list not loaded yet** (cold boot, slow asset fetch). Seeding then would turn the start into a coordinate and drop its harbour id, so the action stays disabled until harbours load. Pinned in Task 4.
2. **A plan run already in flight.** The run's completion sync would overwrite the seed, so the action is disabled while `runBusy`. Pinned in Task 4.
3. **Harbour Wi-Fi without internet.** The browser reports online, but the fetch fails at the network level, so the run falls back to the stored grid. A rate-limit, HTTP or malformed failure must NOT silently plan on the old grid. Pinned in Task 2.
4. **Departure edited past the stored grid's end while offline.** The plan button stays disabled, the banner reverts to the plain one, and the too-short line names the grid's end. Pinned in Task 5 and Task 6.
5. **Start edited, or a different plan made active, after seeding while offline.** The exception ends and today's offline message returns. Pinned in Task 1 (other plan id) and Task 5 (start edit).

---

### Task 1: Seed and gate helpers

**Files:**
- Modify: `app/src/lib/planForm.ts` (append after `departureSeedMs`)
- Modify: `app/src/lib/format.ts` (append after `formatTime`)
- Test: `app/src/lib/planForm.test.ts` (append), `app/src/lib/planForm.dst.test.ts` (create), `app/src/lib/format.test.ts` (append)

**Interfaces:**
- Produces (in `planForm.ts`):
  - `nextPassageDepartureMs(etaMs: number, nowMs: number): number`
  - `seedNextPassage(plan: Plan, rig: SailId | null, harbors: Harbor[], lang: Lang, nowMs: number): { origin: PickedPoint; departureMs: number } | null`
  - `windGridReaches(grid: WindGrid, departureMs: number): boolean`
  - `interface NextPassageSeedState { sourcePlanId: string; sourceName: string; origin: PickedPoint; windGrid: WindGrid }`
  - `activeNextPassageSeed(seed: NextPassageSeedState | null, activePlanId: string | null, origin: PickedPoint | null): NextPassageSeedState | null`
  - `type NextPassageOffline = { kind: 'stored'; sourceName: string; fetchedAtMs: number } | { kind: 'too-short'; untilMs: number }`
  - `nextPassageOffline(online: boolean, seed: NextPassageSeedState | null, departureMs: number): NextPassageOffline | null`
- Produces (in `format.ts`): `formatWeekdayTime(ms: number, lang: Lang): string`, rendered as `Sa 10:00` / `Sat 10:00`.

- [ ] **Step 1: Write the failing tests.** In `planForm.test.ts`, local-time constructors keep the rows TZ-agnostic. `makePlan()` already has destination Marstal, a genoa result and a null fock.

```ts
const at = (d: number, h: number, mi = 0) => new Date(2026, 9, d, h, mi).getTime();
const withGenoaEta = (etaMs: number): Plan => {
  const p = makePlan();
  return { ...p, result: { ...p.result, sails: p.result.sails.map((s) =>
    s.result ? { ...s, result: { ...s.result, etaMs } } : s) } };
};

describe('#1707 nextPassageDepartureMs', () => {
  it('an ETA just after midnight departs 10:00 that morning', () =>
    expect(nextPassageDepartureMs(at(17, 0, 30), at(16, 20))).toBe(at(17, 10)));
  it('an evening ETA departs 10:00 the next morning', () =>
    expect(nextPassageDepartureMs(at(17, 17), at(17, 12))).toBe(at(18, 10)));
  it('is strictly after: exactly 10:00 rolls to the next day', () => {
    expect(nextPassageDepartureMs(at(17, 10), at(17, 6))).toBe(at(18, 10));
    expect(nextPassageDepartureMs(at(17, 10) - 1, at(17, 6))).toBe(at(17, 10));
  });
  it('a long-past ETA departs at the next future 10:00', () => {
    expect(nextPassageDepartureMs(at(14, 15), at(17, 8))).toBe(at(17, 10));
    expect(nextPassageDepartureMs(at(14, 15), at(17, 11))).toBe(at(18, 10));
  });
});

describe('#1707 seedNextPassage', () => {
  it('starts at the destination harbour, after the displayed rig ETA', () =>
    expect(seedNextPassage(withGenoaEta(at(17, 17)), 'genoa', HARBORS, 'de', at(17, 12))).toEqual({
      origin: { source: 'harbor', point: MARSTAL.snap, harborId: 'marstal', label: 'Marstal' },
      departureMs: at(18, 10),
    }));
  it("falls back to the other rig's ETA when the displayed rig has no route", () =>
    expect(seedNextPassage(withGenoaEta(at(17, 17)), 'fock', HARBORS, 'de', at(17, 12))?.departureMs)
      .toBe(at(18, 10)));
  it('falls back to a tap point when the harbour is not in the list', () =>
    expect(seedNextPassage(makePlan(), 'genoa', [], 'de', at(17, 12))?.origin).toEqual({
      source: 'tap', point: ORIGINAL_REQUEST.destination, label: formatLatLon(ORIGINAL_REQUEST.destination) }));
  it('returns null when no rig has a route', () => {
    const p = makePlan();
    const none = { ...p, result: { ...p.result, sails: p.result.sails.map((s) => ({ ...s, result: null })) } };
    expect(seedNextPassage(none, 'genoa', HARBORS, 'de', at(17, 12))).toBeNull();
  });
});

describe('#1707 next-passage seed gate', () => {
  const grid = uniformWindGrid(12, 225, { t0Ms: at(17, 0), hours: 48 }); // last hour = at(18, 23)
  const marstal: PickedPoint = { source: 'harbor', point: MARSTAL.snap, harborId: 'marstal', label: 'Marstal' };
  const seed: NextPassageSeedState = { sourcePlanId: 'plan-1', sourceName: 'Flensburg → Marstal', origin: marstal, windGrid: grid };
  it('is active only for its own plan and an unmoved start', () => {
    expect(activeNextPassageSeed(seed, 'plan-1', { ...marstal })).toBe(seed);
    expect(activeNextPassageSeed(seed, 'plan-2', marstal)).toBeNull();
    expect(activeNextPassageSeed(seed, null, marstal)).toBeNull();
    expect(activeNextPassageSeed(seed, 'plan-1', { source: 'tap', point: FLENSBURG.snap, label: 'x' })).toBeNull();
    expect(activeNextPassageSeed(null, 'plan-1', marstal)).toBeNull();
  });
  it('reaches a departure up to and including its last hour', () => {
    expect(windGridReaches(grid, at(18, 23))).toBe(true);
    expect(windGridReaches(grid, at(18, 23) + 1)).toBe(false);
    expect(windGridReaches({ ...grid, timesMs: [] }, at(17, 0))).toBe(false);
  });
  it('offline with a reaching grid names the source and its fetch time', () =>
    expect(nextPassageOffline(false, seed, at(18, 10))).toEqual({ kind: 'stored', sourceName: 'Flensburg → Marstal', fetchedAtMs: at(17, 0) }));
  it('offline with a short grid reports its last hour', () =>
    expect(nextPassageOffline(false, seed, at(19, 10))).toEqual({ kind: 'too-short', untilMs: at(18, 23) }));
  it('online, or without a seed, there is no offline state', () => {
    expect(nextPassageOffline(true, seed, at(18, 10))).toBeNull();
    expect(nextPassageOffline(false, null, at(18, 10))).toBeNull();
  });
});
```

Create `planForm.dst.test.ts`. Its first lines copy `PlannerPanel.dst.test.tsx`'s `process.env.TZ = 'Europe/Berlin'` pin and its verification throw. Then:

```ts
it('spring-forward: an ETA at 00:30 on 2026-03-29 departs 10:00 CEST that morning', () => {
  const eta = new Date(2026, 2, 29, 0, 30).getTime();
  const dep = nextPassageDepartureMs(eta, eta - 3_600_000);
  expect(new Date(dep).getHours()).toBe(10);
  expect((dep - eta) / 3_600_000).toBe(8.5);
});
it('fall-back: an ETA at 23:30 on 2026-10-24 departs 10:00 CET on the 25th', () => {
  const eta = new Date(2026, 9, 24, 23, 30).getTime();
  const dep = nextPassageDepartureMs(eta, eta - 3_600_000);
  expect([new Date(dep).getDate(), new Date(dep).getHours()]).toEqual([25, 10]);
  expect((dep - eta) / 3_600_000).toBe(11.5);
});
```

In `format.test.ts` (already pinned to Europe/Berlin):

```ts
it('#1707: formatWeekdayTime pairs the short weekday with the 24 h time', () => {
  const sat10 = new Date(2026, 9, 17, 10, 0).getTime();
  expect(formatWeekdayTime(sat10, 'de')).toBe('Sa 10:00');
  expect(formatWeekdayTime(sat10, 'en')).toBe('Sat 10:00');
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npm --prefix app run test -- src/lib/planForm src/lib/format.test.ts`. Expected: FAIL, the new exports are missing.
- [ ] **Step 3: Implement.** For `nextPassageDepartureMs`, use local calendar math on `new Date(max(eta, now))`: `setHours(10, 0, 0, 0)`; if the result is `<=` the base, `setDate(+1)` and then `setHours(10, 0, 0, 0)`. Never add `86_400_000`. `seedNextPassage` takes the ETA from `activeRigResult(plan, rig)`, falling back to the first `plan.result.sails` entry with a result. It takes the origin from `pickedPointsOfPlan(plan, harbors, lang).destination`. `windGridReaches` is `timesMs.length > 0 && timesMs[timesMs.length - 1] >= departureMs`. `activeNextPassageSeed` uses `pickedPointMoved`. `formatWeekdayTime` uses the same weekday + `formatTime` shape as `formatSliderTime`'s tier 2. Do not change `formatSliderTime`.
- [ ] **Step 4: Run the tests and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** `app/src/lib/{planForm,format}.ts` and the three test files. Subject: `feat(next-passage): seed and offline-gate helpers`.

### Task 2: Stored-grid fallback in `usePlanFlow.run()`

**Files:**
- Modify: `app/src/state/usePlanFlow.ts` (`RunOptions`, `run()`)
- Test: `app/src/state/usePlanFlow.test.tsx` (append)

**Interfaces:**
- Consumes: `windGridReaches` (Task 1).
- Produces: `RunOptions.storedWindGrid?: WindGrid`. It is a fallback, never an override.

- [ ] **Step 1: Write the failing tests** in `describe('#1707 stored-grid fallback')`. Reuse `fakeWorker`, `REQ`, `OK_RESULT`, `findPosted` and `ASSETS_FIXTURE` with `loadRoutingAssets` spied.

```ts
const reaching = () => uniformWindGrid(12, 0, { t0Ms: REQ.departureMs - 3_600_000, hours: 48 });
const tooShort = () => uniformWindGrid(12, 0, { t0Ms: REQ.departureMs - 10 * 3_600_000, hours: 2 });

it('offline: plans on the stored grid without fetching, saved under a fresh id', ...);
// onLine=false; run(REQ, 'Next', { storedWindGrid: stored })
// expect(fetchWind).not.toHaveBeenCalled(); expect(findPosted(w.posted, 'plan').windGrid).toBe(stored)
// after result: savedPlan.windGrid toBe stored; savedPlan.id is a string; planning { phase: 'idle' }
it('offline: a stored grid that ends before the departure is refused with error.offline', ...);
// fetchWind not called; no 'plan' posted; planning { phase: 'error', messageKey: 'error.offline' }
it('online: a network-failed fetch falls back to the stored grid', ...);
// fetchWind.mockRejectedValue(new OpenMeteoError('offline', 'network failure'))
// expect(fetchWind).toHaveBeenCalledTimes(1); expect(findPosted(w.posted, 'plan').windGrid).toBe(stored)
it.each<[OpenMeteoErrorKind, MsgKey]>([
  ['rate-limited', 'error.rateLimited'], ['http', 'error.windService'], ['malformed', 'error.windService'],
])('online: a %s failure does not fall back', ...);
// planning { phase: 'error', messageKey }; no 'plan' posted
it('online: a network-failed fetch with a too-short stored grid keeps error.offline', ...);
it('online: a successful fetch wins over the stored grid', ...); // planMsg.windGrid toBe the fetched grid
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npm --prefix app run test -- src/state/usePlanFlow.test.tsx`. Expected: the new rows FAIL. The offline row gets `error.offline`; the online rows get the mapped error.
- [ ] **Step 3: Implement.** In `run()`, compute `stored = opts.storedWindGrid` only if `windGridReaches(it, req.departureMs)`, otherwise `null`.
  - The `!navigator.onLine` gate refuses only when `stored === null`.
  - Offline with `stored`: skip `fetchWind`, but still `transition({ phase: 'fetching-wind' })`. The re-entry guard and `runBusy` depend on a non-idle phase.
  - Online: on a rejection where `err instanceof OpenMeteoError && err.kind === 'offline' && stored`, use `stored`. Every other rejection keeps `mapWindError`. `openMeteo.ts` also maps exhausted 5xx retries to `'offline'`; that counts as a network reason here.
  - The rest of `run()` (dedupe, cancel checkpoints, save, `setPlan`) is unchanged.
- [ ] **Step 4: Run the tests and confirm they pass.** Same command. Expected: PASS, including every pre-existing row (the offline guard row is unchanged).
- [ ] **Step 5: Commit** `usePlanFlow.ts` and its test. Subject: `feat(next-passage): stored-grid fallback in run()`.

### Task 3: `NextPassageAction` in both result cards

**Files:**
- Create: `app/src/components/NextPassageAction.tsx`, `app/src/components/NextPassageAction.test.tsx`
- Modify: `app/src/components/PlannerPanel.tsx` (prop and compact-card render), `app/src/components/RouteSummary.tsx` (prop and card-level row), `app/src/app.css` (one rule after `.planner-result-details`), `app/src/i18n/dict.{de,en}.ts`
- Test: `app/src/components/{PlannerPanel,RouteSummary}.test.tsx` (append; extend `Overrides` and `renderSummary` with the new optional prop)

**Interfaces:**
- Consumes: `seedNextPassage`, `formatWeekdayTime` (Task 1).
- Produces:
  - `interface NextPassageProps { harbors: Harbor[]; disabled: boolean; onNextPassage: () => void }`
  - `default function NextPassageAction(props: NextPassageProps & { plan: Plan; rig: SailId | null }): JSX.Element | null`
  - `PlannerPanelProps.nextPassage?: NextPassageProps`, `RouteSummaryProps.nextPassage?: NextPassageProps`
  - Dict keys `planner.nextPassage.action` (DE `Nächste Passage planen` / EN `Plan next passage`) and `planner.nextPassage.preview` (DE `Start {harbor} · Abfahrt {departure}` / EN `Start {harbor} · Departure {departure}`)

- [ ] **Step 1: Write the failing tests.** `NextPassageAction.test.tsx` sets `vi.useFakeTimers({ toFake: ['Date'] })` and `vi.setSystemTime(new Date(2026, 9, 17, 12, 0))`. It sets `sc-lang` to `en` and builds a local plan with destination Marstal and a genoa `etaMs` of `new Date(2026, 9, 17, 17, 0)`.

```ts
it('labels the button and describes it with the seed preview', () => {
  // render with harbors [MARSTAL], disabled false
  expect(screen.getByRole('button', { name: 'Plan next passage' }))
    .toHaveAccessibleDescription('Start Marstal · Departure Sun 10:00');
});
it('honours disabled and reports a click otherwise', ...); // disabled -> toBeDisabled(); enabled click -> onNextPassage once
it('renders nothing for a plan with no routed rig', ...);  // container.firstChild is null
```

`RouteSummary.test.tsx`:

```ts
it('#1707: places the next-passage action outside the rig tabpanel', () => {
  renderSummary({ nextPassage: { harbors: [], disabled: false, onNextPassage: vi.fn() } });
  expect(screen.getByRole('tabpanel')).not.toContainElement(
    screen.getByRole('button', { name: 'Plan next passage' }));
});
it('#1707: offers it on a rig tab whose own rig found no route', ...); // setSail(plan, 'fock', { result: null }), rig 'fock'
it('#1707: omits it without the prop', ...);
```

`PlannerPanel.test.tsx`: `it('#1707: the compact result card offers the action and reports a click')`. It uses `renderPanel({ plan: makePlan(), rig: 'genoa', nextPassage: { harbors: HARBORS, disabled: false, onNextPassage } })`, clicks `getByRole('button', { name: 'Plan next passage' })`, and expects `onNextPassage` called once.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npm --prefix app run test -- NextPassageAction RouteSummary.test PlannerPanel.test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `NextPassageAction` snapshots `const [nowMs] = useState(() => Date.now())` and returns `null` when `seedNextPassage` returns `null`.
  - It renders `<div className="next-passage">`. Inside: a `Button variant="secondary"` with `aria-describedby` pointing at a `<p className="planner-guidance" id={useId()}>`, which holds the preview with `departure` set to `formatWeekdayTime(seed.departureMs, lang)`. The preview may lag only if the card stays mounted across a 10:00 boundary; the click recomputes the seed (Task 4).
  - CSS: `.next-passage { display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem; }`.
  - PlannerPanel renders it inside the compact card's `summary &&` fragment, directly after the Details button.
  - RouteSummary renders it after the tabpanel `</div>` and before `</Card>`. GPX export stays where it is.
- [ ] **Step 4: Run the tests and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** the listed files. Subject: `feat(next-passage): action and preview in both result cards`.

### Task 4: Seed state, handler and focus

**Files:**
- Modify: `app/src/App.tsx` (state next to `tapTarget`, handler next to `handlePlan`, props at the `<PlannerPanel>` and `<RouteSummary>` mounts), `app/src/components/PlannerPanel.tsx` (focus props and effect)
- Test: `app/src/components/PlannerPanel.test.tsx`, `app/src/App.test.tsx` (append `describe('#1707 next passage')`)

**Interfaces:**
- Consumes: `seedNextPassage`, `NextPassageSeedState`, `activeNextPassageSeed` (Task 1); `NextPassageProps` (Task 3); `cloneWindGrid` (`state/reroute.ts`).
- Produces:
  - `PlannerPanelProps.pendingDestinationFocus?: boolean` and `onDestinationFocused?: () => void`
  - In App: `nextPassageSeed` state (`NextPassageSeedState | null`), `pendingDestinationFocus` state (`boolean`, cleared by `onDestinationFocused`), and `activeSeed = activeNextPassageSeed(nextPassageSeed, plan?.id ?? null, origin)`, which Task 5 consumes

- [ ] **Step 1: Write the failing tests.**

PlannerPanel:

```ts
it('#1707: a pending destination focus lands on the Destination combobox and is reported', () => {
  const onDestinationFocused = vi.fn();
  renderPanel({ origin: harborToPickedPoint(HARBORS[0], 'en'), destination: null, pendingDestinationFocus: true, onDestinationFocused });
  expect(document.activeElement).toBe(
    within(screen.getByRole('region', { name: 'Destination' })).getByRole('combobox'));
  expect(onDestinationFocused).toHaveBeenCalled();
});
it('#1707: nothing moves focus while no focus is pending', ...); // activeElement is document.body
```

`App.test.tsx`: a local helper saves a source plan through `db.savePlan` and loads it via Routes → plan row (the #551 rows' pattern). The plan has origin `FLENSBURG.snap`/`'flensburg'`, destination `RELABEL_HARBOR.snap`/`'relabel-town'`, `okPlanResult(33)`, windGrid `uniformWindGrid(10, 250, { t0Ms: Date.now() - 3_600_000, hours })`, and an optional `viaPoints`. Rows:

```ts
it('Routes card: seeds start = destination harbour, clears destination, switches to Plan, focuses Ziel', ...);
// tab de['nav.plan'] aria-selected 'true'; Start region shows 'Relabelburg';
// document.activeElement === within(Ziel region).getByRole('combobox');
// getByLabelText(de['planner.departure.label']) value matches /T10:00$/;
// 'Route planen' disabled; getByText(de['planner.disabled.pickEndpoints'])
it('Plan card: same seed; the source plan stays active and is not modified', ...);
// Ziel combobox focused; Routes tab still shows formatNm(33, 'de'); db.listPlans() length 1, toEqual the saved source
it('clears via points and segment modes', ...); // source viaPoints [VIA_A] -> container.querySelectorAll('.planner-via-row').length === 0
it('is disabled while a plan run is in flight', ...); // Plan tab, click 'Route planen' (routingMock pending) -> action disabled
it('is disabled until the harbour list has loaded', ...); // pending harborsPromise fetch override (existing pattern) -> disabled; resolve -> enabled
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npm --prefix app run test -- App.test -t 1707` and `npm --prefix app run test -- PlannerPanel.test -t 1707`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `handleNextPassage()`: return when `!plan`. Call `seedNextPassage(plan, rig, harbors, lang, Date.now())` and return on `null`. Then: `setOrigin(seed.origin)`, `setDestination(null)`, `setDraftViaPoints([])`, `setDraftSegmentModes(emptySegmentModes(0))`, `setTapTarget(null)`, `setDepartureMs(seed.departureMs)`, `setNextPassageSeed({ sourcePlanId: plan.id, sourceName: plan.name, origin: seed.origin, windGrid: cloneWindGrid(plan.windGrid) })`, `setPendingDestinationFocus(true)`. Never `setPlan`.
  - The Routes site's `onNextPassage` calls `handleNextPassage()` and then `handleTabChange('plan')`.
  - Both sites get `{ harbors, disabled: runBusy || harbors.length === 0, onNextPassage }`.
  - PlannerPanel puts a ref on the destination `<section>`. A `useEffect` keyed on `[pendingDestinationFocus, onDestinationFocused]` focuses that section's `input[role="combobox"]` and calls `onDestinationFocused()`. App passes `() => setPendingDestinationFocus(false)`. This is one mechanism for both sites; it works when the picker is already open, and it needs no change to HarborPicker's mount-only `autoFocus`.
- [ ] **Step 4: Run the tests and confirm they pass.** Same commands. Expected: PASS.
- [ ] **Step 5: Commit** `App.tsx`, `PlannerPanel.tsx` and the two test files. Subject: `feat(next-passage): seed the planner form and focus the destination`.

### Task 5: Offline gate, qualified banner, guidance line

**Files:**
- Modify: `app/src/App.tsx` (`canPlan`, `planDisabledReason`, `handlePlan`, the `banner.offline` Banner), `app/src/components/PlannerPanel.tsx` (guidance prop), `app/src/i18n/dict.{de,en}.ts`
- Test: `app/src/App.test.tsx` (extend `#1707 next passage`), `app/src/components/PlannerPanel.test.tsx`

**Interfaces:**
- Consumes: `activeSeed` (Task 4); `nextPassageOffline` (Task 1); `formatWeekdayTime` (Task 1); `RunOptions.storedWindGrid` (Task 2).
- Produces:
  - `PlannerPanelProps.nextPassageGuidance?: string | null`, rendered as `<p className="planner-guidance">` (no role) inside `.planner-actions`, after the reason/onboarding slot
  - Dict keys, verbatim:
    - `banner.offlineNextPassage`: DE `Offline — nur die nächste Passage mit gespeicherter Vorhersage planbar` / EN `Offline — only the next passage can be planned, from the stored forecast`
    - `planner.nextPassage.offlineStored`: DE `Offline — nutzt die gespeicherte Vorhersage von „{name}“ (abgerufen {fetched}).` / EN `Offline — uses the stored forecast from "{name}" (fetched {fetched}).`
    - `planner.nextPassage.offlineTooShort`: DE `Offline — die gespeicherte Vorhersage reicht nur bis {until}; für diese Abfahrt ist eine Verbindung nötig.` / EN `Offline — the stored forecast only reaches {until}; this departure needs a connection.`

- [ ] **Step 1: Write the failing tests.** Offline rows use `vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)` plus `fireEvent(window, new Event('offline'))`. Pick the destination through the Ziel combobox: `fireEvent.change` plus `harborOptionName(FLENSBURG.names.de)`.

```ts
it('offline, reaching grid: qualified banner, plan enabled once a destination is picked, stored grid used', ...);
// hours: 8 * 24. getByText(de['banner.offlineNextPassage']);
// getByText(de['planner.nextPassage.offlineStored'] with name 'Flensburg → Relabelburg', fetched formatWeekdayTime(t0, 'de'));
// 'Route planen' enabled; vi.mocked(fetchWindGrid).mockClear(); click; expect(fetchWindGrid).not.toHaveBeenCalled();
// routingMock.calls.length === 1; resolve okPlanResult(12) -> db.listPlans() has 2;
// new plan id !== source id, windGrid.fetchedAtMs === t0; source record unchanged;
// then getByText(de['banner.offline']) (the seed ended with the new active plan)
it('offline, grid ending before the departure: disabled with today\'s message and the too-short line', ...);
// windGrid t0Ms: Date.now() - 48 * 3_600_000, hours: 24 (last hour = now - 25 h, past any seeded departure);
// getByText(de['banner.offline']); 'Route planen' disabled;
// getByText(de['error.offline']); getByText(de['planner.nextPassage.offlineTooShort'] with until formatWeekdayTime(last, 'de'))
it('offline, the start edited after seeding: today\'s offline behaviour returns', ...);
// Start "Ändern" -> pick Flensburg; pick destination; disabled; de['error.offline']; de['banner.offline']
it('online, a network-failed fetch falls back to the stored grid', ...);
// vi.mocked(fetchWindGrid).mockRejectedValueOnce(new OpenMeteoError('offline', 'network failure'));
// click -> routingMock.calls.length === 1 -> resolve -> saved plan windGrid.fetchedAtMs === t0
it('offline without a seed: unchanged', ...); // loaded plan, Plan tab: disabled, de['error.offline'], de['banner.offline'], no guidance line
```

PlannerPanel: `it('#1707: renders the next-passage guidance as a non-alert line')`. It asserts the text is present and that `closest('[role="alert"]')` is `null`.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npm --prefix app run test -- App.test -t 1707` and `npm --prefix app run test -- PlannerPanel.test -t 1707`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `const offlineSeed = nextPassageOffline(online, activeSeed, departureMs)` and `const seedPlannableOffline = offlineSeed?.kind === 'stored'`.
  - `canPlan` takes `(online || seedPlannableOffline)`.
  - `planDisabledReason` is `t('error.offline')` when `!online && !seedPlannableOffline`. Otherwise it keeps the existing endpoint branch (a missing destination reads `pickEndpoints`).
  - The guidance string comes from `offlineSeed`. Format `{fetched}` and `{until}` with `formatWeekdayTime`; `null` when there is no `offlineSeed`.
  - The banner keeps the same `<Banner kind="warning">`, with its key swapped on `seedPlannableOffline`. The banner count does not change (#1405 guards).
  - `handlePlan` passes `activeSeed ? { storedWindGrid: activeSeed.windGrid } : {}` to `run()`, online too. Add `activeSeed` to its deps.
- [ ] **Step 4: Run the tests and confirm they pass.** Same commands, plus `npm --prefix app run test -- i18n`. Expected: PASS.
- [ ] **Step 5: Commit** the listed files. Subject: `feat(next-passage): offline planning from the stored forecast`.

### Task 6: e2e, changelog, closure check

**Files:**
- Create: `app/e2e/next-passage.spec.ts`, `changelog.d/1707.added.md`

**Interfaces:**
- Consumes: the UI from Tasks 3–5. `startPreview` and `STANDARD_VIEWPORTS` come from `./helpers`.

- [ ] **Step 1: Write the spec.** This is a new file, deliberately separate from `plan.spec.ts` and `offline.spec.ts`. Each test calls `startPreview(page)`, goes to `?windFixture=test-fixtures/wind-sw12.json`, then plans Langballigau → Sønderborg on the Planen tab. That plan's name is `Langballigau → Sonderburg`; Sønderborg shows under its DE exonym. Then it waits for `Route planen` `toBeEnabled({ timeout: 60_000 })`.
  - `goOffline`: `context.setOffline(true)`, then a `page.evaluate` that defines `navigator.onLine` as `false` and dispatches `offline`. A reload would drop the ephemeral seed. The claim under test is "no forecast fetch is attempted", proven by a `page.on('request')` counter for `wind-sw12.json` that is armed at `goOffline`.

```ts
for (const name of ['tabletPortrait', 'desktopHd'] as const) {
  test(`#1707 seeds the next passage from both cards at ${name}`, async ({ page }) => {
    // setViewportSize(STANDARD_VIEWPORTS[name]); plan source; Plan card: click 'Nächste Passage planen'
    // expect(start.locator('.endpoint-name')).toHaveText('Sonderburg'); expect(ziel.getByRole('combobox')).toBeFocused()
    // expect(page.getByLabel('Abfahrt')).toHaveValue(/T10:00$/); 'Route planen' disabled; getByText('Start und Ziel wählen.')
    // Routen tab: click 'Nächste Passage planen' -> getByRole('tab', { name: 'Planen' }) aria-selected 'true'; Ziel combobox focused
  });
}
test('#1707 offline: plans the next passage from the stored forecast', ...);
// viewport desktopHd; seed; goOffline; getByText('Offline — nur die nächste Passage mit gespeicherter Vorhersage planbar');
// getByText(/^Offline — nutzt die gespeicherte Vorhersage von „Langballigau → Sonderburg“/);
// pick Ziel 'Langballigau'; click 'Route planen';
// expect(getByText('Offline — Planung deaktiviert. Gespeicherte Routen bleiben verfügbar.')).toBeVisible({ timeout: 60_000 })
//   (the seed ended, so the run is done). Wait for this BEFORE switching tabs: PlansList reads IndexedDB once at mount.
// Then Routen tab: .plans-list-row toHaveCount(2, { timeout: 60_000 }); expect(windRequests).toBe(0)
test('#1707 offline: a stored forecast too short for the departure keeps planning disabled', ...);
// seed; goOffline; pick Ziel; fill 'Abfahrt' with the input's own `max` attribute (mount now + 144 h > fixture end at start + 143 h);
// getByText(/^Offline — die gespeicherte Vorhersage reicht nur bis /); plain offline banner; 'Route planen' disabled;
// getByText('Windvorhersagedienst nicht erreichbar. Internetverbindung prüfen und erneut versuchen.')
```

- [ ] **Step 2: Run the new spec.** Run `npm --prefix app run e2e -- next-passage.spec.ts --no-deps`. Expected: 4 passed. Then run `npm --prefix app run e2e -- offline.spec.ts plan.spec.ts --no-deps`. Expected: all pass, unchanged. Then `git restore app/public/test-fixtures/wind-sw12.json`.
- [ ] **Step 3: Check label collisions in both languages.** Run `git grep -nE "getByRole\('button', \{ name: ['/][^'/]*(Plan|planen|Passage|passage|Nächste|next)" -- app/e2e` and `git grep -n "sc-lang" -- app/e2e`. Expected: no existing name is a substring of `Nächste Passage planen` or `Plan next passage`, and neither new label contains an existing name. `Route planen` and `Plan route` are not substrings, and the `Planen`/`Plan` tabs have role `tab`. Also run `git grep -n "getByText(/Offline\|getByText('Offline" -- app/e2e`. Expected: only `offline.spec.ts`'s exact plain-banner string, which no new string contains.
- [ ] **Step 4: Write the changelog fragment.** `changelog.d/1707.added.md`, one line:
  `- Plan the next passage from any planned route in one tap: it starts at that route's destination and departs at the next 10:00, and offline it can be planned from the route's stored forecast (#1707).`
- [ ] **Step 5: Run the final checks.** `npm --prefix app run typecheck`, `npm --prefix app run lint`, and `node .claude/skills/sweep-closure/closure.mjs diff $(git merge-base origin/develop HEAD) HEAD`. Expected: typecheck and lint clean; the closure verdict is NOT OWED, with no file under the closure list or its three path prefixes.
- [ ] **Step 6: Commit** the spec and the fragment. Subject: `test(next-passage): e2e for seed, focus and offline planning`.

## Spec decisions recorded here

- **Start unchanged.** Seed state adds `origin` to the spec's `{ sourcePlanId, sourceName, windGrid }`. "Start unchanged" and "a different plan is active" are derived (`activeNextPassageSeed`), not cleared by each writer. Editing the start away and back re-activates the seed, which is still "the seeded start unchanged".
- **Too-short grid.** The disabled reason stays today's `error.offline` (the alert). The too-short copy is the separate non-alert guidance line, per "every other offline plan attempt stays disabled with today's message" and "Guidance copy (non-alert)".
- **Guidance placeholders.** "Always names the source route and fetch time" applies to the plannable line. The too-short line uses the spec's verbatim copy, which names the grid's end. `{Tag} {Zeit}` renders through one `{departure}` placeholder with `formatWeekdayTime`, so the output is identical.
- **Network reason** means `OpenMeteoError.kind === 'offline'`. That kind includes exhausted 5xx retries.
- **Qualified banner.** It shows only while the seed is plannable at the current departure (the grid reaches it).
