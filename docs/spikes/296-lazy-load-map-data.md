# Spike: lazy-load map data during planning, guaranteed offline coverage for a trip

- Issue: [#296](https://github.com/DocGerd/sail_command/issues/296)
- Date: 2026-08-05
- Status: Recommendation (no implementation in this change)
- **Verdict: keep the mask, harbours, seamarks and polars monolithic and eager; split the basemap into a still-eager "core" archive plus per-region archives that are lazily fetched and explicitly pinned per plan, with a hard, network-free, byte-length-verified completeness check gating a plan's offline-ready state.**

This document answers #296's questions (the issue's own "Questions to
answer" section numbers five; §3 below splits the per-asset story's
chunking sub-question into its own section, so this document has six
top-level sections covering those five questions). It changes no code
under `app/src/` or `pipeline/`; all numbers below are measured against the
files actually committed in this worktree (branch point: `develop`@`41d94b8`).

## 0. The strongest finding first: "do nothing" is not actually safe

`app/src/sw.ts`'s basemap Range route already anticipates a file exceeding
the precache size cap:

```
// Cache miss, e.g. a file exceeding maximumFileSizeToCacheInBytes was
// dropped from the manifest at build time (the SW never runs in dev —
// devOptions is disabled).
console.warn('[sw] pmtiles precache miss, falling through to network:', request.url);
return fetch(request);
```

`app/vite.config.ts` sets `maximumFileSizeToCacheInBytes: 40 * 1024 * 1024`
(41,943,040 bytes). The basemap today is 27,201,789 bytes — comfortably
under. #296's own "why now" section states the area extension grows the
region "roughly 1.7x". If the basemap's byte size scales roughly with
covered area (a rough proxy — vector tile density also depends on feature
density, not area alone, so this is illustrative, not exact):
27,201,789 × 1.7 ≈ 46.2 MB — **over the 40 MB cap**.

Method: `27,201,789 × 1.7`, compared against the literal
`maximumFileSizeToCacheInBytes` value read from `app/vite.config.ts:390`.

If that happens, the *entire* basemap archive — not just the newly extended
region — is silently dropped from the precache manifest at build time. At
runtime, every ranged tile request then cache-misses, logs one
`console.warn` (invisible to a real user), and falls through to a plain
network `fetch()`. Offline, that fetch fails outright: the whole chart
degrades to online-only, silently, for every user, defeating the app's core
offline promise — not a partial-coverage edge case but a total regression
of a currently-working, currently-tested guarantee
(`app/e2e/offline.spec.ts`, `basemap-fallback.spec.ts`). This is the
concrete, measured reason "keep precaching everything and accept the larger
payload" is not a safe default once the area extension lands — it is not
merely a UX/size regression, it risks tripping an *already-enforced* limit
in the code exactly as written today.

(Bumping `maximumFileSizeToCacheInBytes` removes the silent-drop risk but
is not by itself a fix — see §9 "considered and rejected" item 3.)

## 1. Measured assets

Method: `stat -c%s` on each file in this worktree; `du -sb` for directory
totals.

| Asset | Path | Bytes | Human |
|---|---|---:|---|
| Basemap (PMTiles) | `app/public/data/basemap.pmtiles.png` | 27,201,789 | 25.9 MiB |
| Depth/land mask | `app/public/data/mask.bin` | 5,280,000 | 5.03 MiB |
| Mask metadata | `app/public/data/mask.meta.json` | 604 | — |
| Harbours | `app/public/data/harbors.json` | 11,947 | 11.7 KiB |
| Seamarks | `app/public/data/seamarks.json` | 343,466 | 335.4 KiB |
| Polar (genoa) | `app/public/data/polar-genoa.json` | 1,426 | — |
| Polar (fock) | `app/public/data/polar-fock.json` | 1,354 | — |
| Icons (4 files) | `app/public/icons/*` | 24,263 | 23.7 KiB |
| Sprites (v4, json+png, matched) | `app/public/basemap-assets/sprites/v4/*` | 52,154 | 50.9 KiB |
| Sprite LICENSE.txt (not matched, `.txt` not in globPatterns) | — | 1,074 | — |
| Font glyphs (768 `.pbf` files + 1 `OFL.txt` license = 769 files total, runtime-cached, `globIgnores`d) | `app/public/basemap-assets/fonts/` | 11,083,630 | 10.6 MiB |
| Brand social card (`globIgnores`d) | `app/public/brand/social-card.png` | 48,820 | 47.7 KiB |
| Test fixtures (`globIgnores`d, dev-only) | `app/public/test-fixtures/` | 581,010 | 567.4 KiB |
| Third-party notices (not matched, `.txt` not in globPatterns) | `app/public/THIRD-PARTY-NOTICES.txt` | 20,258 | 19.8 KiB |
| **Total `app/public`** | | **44,651,795** | **42.6 MiB** |

**Current precache total** (public-asset portion — see method below):
27,201,789 + 5,280,000 + 604 + 11,947 + 343,466 + 1,426 + 1,354 + 24,263 +
52,154 = **32,917,003 bytes ≈ 31.4 MiB / 32.9 MB**.

Method: sum of every `app/public/**` file whose extension matches
`globPatterns: ['**/*.{js,css,html,ico,png,svg,json,bin,pbf}']`
(`app/vite.config.ts:399`) and is **not** excluded by
`globIgnores: ['**/test-fixtures/**', '**/brand/**', '**/basemap-assets/fonts/**']`
(`:409`). This matches the code's own comment ("~33 MB expected", `:384`). It
**excludes** the compiled app shell (JS/CSS/HTML bundle emitted by `vite
build`, which this spike did not run — no code changes, no `npm ci`
required per the brief) — the real total precache is this figure plus the
app shell, which is smaller and not the subject of this spike.

The issue's own figures ("~31 MB toward the ~55 MB range", "basemap 26 MB
and mask 5.1 MB today") are consistent with the measurements above once accounting
for MB-vs-MiB rounding (25.9 MiB ≈ "26 MB"; 5.03 MiB ≈ "5.1 MB" under a
slightly different rounding convention) — narrowed to "roughly right", not
independently re-derived, since the area-extension issue itself was not
read for this spike.

## 2. Per-asset lazy-load analysis

| Asset | Needed to PLAN | Needed at TRIP TIME | Evidence |
|---|---|---|---|
| Harbours | Yes (start/end selection) | Yes (display) | Issue requirement: always eager |
| Polars | Yes (solver input) | **No** | `polarGenoa`/`polarFock`/`PolarTable` referenced only from `app/src/state/usePlanFlow.ts` and tests — no reference in `LiveView.tsx` or `DepthProfile.tsx` |
| Depth/land mask | Yes (solver hot path) | **Yes** | `app/src/components/LiveView.tsx:126` calls `useNavMask()` and runs `checkHeadingDepth` — issue #251's live depth-safety check reads `NavMask` during a trip, not just during planning; `DepthProfile.tsx:175` also constructs a `NavMask` for the depth profile |
| Seamarks | Yes (chart context while planning) | Yes (chart context underway) | `app/src/services/assets.ts:10-13` comment: "same offline-precached asset tier... plan-independent" |
| Basemap (PMTiles) | Yes (map underneath the plan) | **Yes** | `LiveView` renders the same `MapView`/`RouteLayer` stack as planning — the chart is the trip's map, not a planning-only artifact |
| Font glyphs | Yes (label text) | Yes (label text) | Already lazy — see below; degrades to a locally-drawn glyph shape on failure (`node_modules/maplibre-gl/.../glyph_manager.ts`), never a missing feature |

**Conclusion on #296's own central question (does the glyph precedent
generalise to basemap/mask): no**, and the reason is categorical, not just
a size difference. A missing glyph range degrades *invisibly and
cosmetically* — MapLibre substitutes a locally-drawn TinySDF glyph with no
change in which features render (documented in this repo's CLAUDE.md
glyph-loading bullet). A missing basemap tile or a missing mask region
degrades as a *visible gap in chart coverage or a disabled safety check* —
exactly the failure the "must never silently present partial coverage as
complete" rule exists to prevent. The glyph pattern is safe to leave
un-precached precisely because its failure mode is invisible; that
property does not transfer to basemap or mask.

**Assets that cannot be made plan-only-eager / trip-time-optional:** the
mask and the basemap. Both are read live during a trip (mask: #251's
depth-safety check in `LiveView.tsx`; basemap: the chart itself). The
invariant this violates if ignored: "everything needed for a trip is
available offline" (#296) / "planning requires network; everything else
must keep working offline" (`CLAUDE.md`).

**Assets trivially kept eager:** harbours (issue requirement, 11.9 KB),
polars (1.4+1.4 KB, plan-time only), seamarks (343 KB, already commented as
same-tier-as-harbours in `assets.ts`). Combined 358,193 bytes (method:
11,947 + 1,426 + 1,354 + 343,466) — roughly two orders of magnitude below
the basemap (method: 27,201,789 / 358,193 ≈ 76×), not three; no plausible
install-budget benefit from lazy-loading any of them, only complexity.

## 3. Chunking model

### Mask: cannot be chunked without a solver-hot-path change

`app/public/data/mask.meta.json` declares `rows: 2400, cols: 2200`;
2400 × 2200 = 5,280,000 — exactly `mask.bin`'s byte size. This confirms the
format: **one byte per cell, uncompressed, row-major, a single flat buffer
covering the declared rectangle. No internal chunking, no compression.**

`app/src/lib/mask.ts`'s `NavMask` constructor requires
`data.length === meta.rows * meta.cols` (throws otherwise) and every lookup
(`depthByte`, `walkCells`'s Amanatides–Woo grid traversal) indexes directly
into that one contiguous buffer via `row * meta.cols + col`. Splitting the
mask into geographic tiles would require `NavMask` to determine which
tile a given lat/lon (and, harder, which tile a *segment crossing a tile
boundary*) falls into, mid-traversal, in the solver's hot loop
(`app/src/routing/isochrone.ts` — CLAUDE.md: "the router reads the mask
hot"). This is a real, bounded engineering task, but it is a
**routing-behaviour change**, and CLAUDE.md's #282 rule is explicit that any
change to reachability/no-route classification needs a full
Flensburg→all-harbours regression sweep, not a labeling-only review. Given
the mask is small even after the extension (quantified in §9, item 2), this
cost is not justified by the savings.

### Basemap: natively chunkable, but not for free

PMTiles is inherently tile/range-addressable — that is the whole point of
the format (a directory of tile IDs, each independently byte-range
fetchable), and `app/src/services/basemapSource.ts` already contains the
two mechanisms this would need: a Range-request preflight
(`pmtilesRangeModeWorks`) and a whole-archive fallback fetch
(`ensureBasemapProtocolSource`'s `blob-fallback` path). Two chunking
granularities were considered:

- **Per z/x/y tile, within one archive** (the issue's literal suggestion).
  Technically possible — `sw.ts`'s Range route
  (`app/src/sw.ts:21-34`) currently only slices a Range out of an
  *already-fully-cached* response via `createPartialResponse`; serving a
  genuinely partial cache would instead mean caching each distinct Range
  request individually (the Cache API keys on the full request including
  headers, so this falls out of standard `Cache.put`/`Cache.match` with no
  format change). The hard part is not the caching mechanism — it's
  *proving completeness*: "is every tile this corridor needs, at every
  zoom level it needs, present" requires decoding PMTiles' tile-ID scheme
  and enumerating the exact set for a corridor, then verifying each one
  individually. Rejected — see §9, item 1.
- **Per named region, as separate archives** (recommended). The pipeline
  emits more than one PMTiles archive — e.g. today's committed
  54.3–55.3°N/9.4–11.0°E box stays a "core" archive, unchanged; the area
  extension ships as one or more additional, separately-named archives.
  This is a pipeline/build-time change, not a format limitation: PMTiles
  supports multiple independent archives, and MapLibre can reference
  multiple `pmtiles://` sources in one style. `sw.ts`'s
  `isBasemapArchivePath` check (`app/src/lib/basemap.ts`) generalizes
  trivially to "any archive matching the naming pattern". Completeness of
  one region reduces to a single boolean: is this ONE file (verified by
  byte length against a build-time manifest, the same shape as
  `glyph-manifest.json`'s pattern in `app/vite.config.ts`'s
  `glyphManifest()` plugin) present in a dedicated runtime cache. No tile-ID
  bookkeeping required.

## 4. Pinning model

**What defines "the trip":** the plan's route corridor plus a margin — the
same shape `app/src/lib/routeCorridor.ts` already computes for AIS
subscription boxes (`AIS_CORRIDOR_HALF_WIDTH_NM`, box-merge logic). Reusing
this avoids inventing a second corridor definition.

**What gets pinned:** any *extended-region* basemap archive whose regional
bbox intersects the plan's corridor+margin, fetched and cached **in full**
(not a tile subset of it) — accepting some over-fetch (the whole region
even if the corridor only clips its edge) as the cost of a completeness
proof that is a single boolean rather than an enumerated tile set. Mask,
harbours, seamarks, and polars need no pinning action — they are already
part of the eager core precache and cover the whole routable area
regardless of the extension (§3).

**When:** an explicit, visible user action per plan ("make this plan
available offline"), not a silent background download. A silent background
fetch is just as much an honesty problem as a silent gap — the user has no
way to know whether it finished. The pin state is persisted per-plan in
IndexedDB, next to the plan's already-stored wind grid (`Plan` record).

**How completeness is proven:** a required region counts as pinned only
when `caches.match()` against its dedicated runtime cache returns a
response whose body byte length equals the value recorded in a build-time
manifest for that region (mirroring `glyph-manifest.json`'s pattern) — a
missing or short entry is not-complete, no partial credit. This check must
be **network-free** (a pure Cache Storage read) so it works correctly even
when the app itself is opened offline — see the failure-mode analysis,
§8 Case B.

## 5. Readiness UX

A per-plan, three-state indicator, reusing the existing UI primitive layer
(`Button`/`Card`/`Chip`, `CLAUDE.md`'s primitive-layer rule):

- **Offline-ready** — every required region's byte-length check passed.
- **Downloading N of M regions** — a discrete, exactly-checkable count, not
  a smoothed time/percentage heuristic (the #340 planner-progress lesson in
  `CLAUDE.md` applies directly: a percentage here would be just as
  misleading as the old time/144h progress bar was).
- **Not offline-ready — connect to finish** — incomplete, failed, or
  evicted since last verified, with a retry action.

Per the guard-asymmetry principle already established in this repo (the
`String.replace`/CSP bullet, the `NavMask.segmentShallowestBelow` bullet):
a **wrong "ready" claim costs a user departing with a real coverage gap
they don't know about — the expensive failure direction.** A wrong "not
ready" claim only costs an unnecessary wait or retry. Every ambiguous or
timed-out state must therefore resolve to "not ready", never to "ready" by
default.

**Going offline mid-download:** the fetch simply fails (network error); the
partial response is never committed to cache (only a fully-verified fetch
is cached, per §4) — a half-downloaded archive can never be mistaken for a
complete one. The plan is not deleted; the indicator shows "Not
offline-ready" with the reason, and a retry action once back online.

## 6. Eviction

**May be dropped:** an extended-region archive with no remaining saved
plan referencing it (reference-counted, analogous in shape to the glyph
cache's version-based retirement in `app/src/lib/glyphs.ts`, but keyed on
plan references rather than a version bump) — freed proactively when the
user deletes the last referencing plan, rather than waiting on the OS.

**Must never be dropped by this app's own logic:** the eager core precache
(mask, harbours, polars, seamarks, core basemap, app shell) — unaffected by
this feature, stays under workbox's existing precache lifecycle.

**`navigator.storage.persist()` — narrowed, not closed:** already called
unconditionally in `app/src/main.tsx:14`
(`void navigator.storage?.persist?.();`), with its boolean result
discarded. Per the Storage API, this is a *request*, not a guarantee — some
browsers auto-grant it under engagement heuristics, others (notably Safari)
do not reliably honour it. It reduces the *frequency* of eviction; it
cannot be the mechanism the "guaranteed offline trip" promise rests on.
That mechanism has to be the network-free completeness re-check (§4),
re-run whenever a plan is opened, which is exactly what detects eviction
after the fact rather than assuming it never happens.

**Who decides:** the OS decides evictions of non-persisted origin data;
among the app's own choices, the plan-reference-count policy above decides
what this feature proactively deletes — never something a saved plan still
references.

## 7. Deployment scoping

Reuse the `sailcommand-glyphs-<slug>@<version>` pattern
(`app/src/lib/glyphs.ts`) exactly: a `regionCacheName(base, regionId)`
helper producing e.g. `sailcommand-region-<slug>@<version>-<regionId>`,
with the same prefix-trap defense `isRetiredGlyphCache` already implements
— matching must require the `@`-delimited deployment-scoped prefix, not a
bare `startsWith(slug)`, or production's slug (a literal prefix of UAT's
slug) would let one deployment's activate-cleanup evict the other's
regional caches on the shared `docgerd.github.io` origin. `sw.ts`'s
`activate` cleanup enumeration must filter on this same scoped prefix,
exactly as it does for glyph caches today. **A bare shared cache name (no
slug) or a cleanup matcher missing the prefix check is a defect**, called
out explicitly per the brief — this is not a hypothetical, it is the exact
shape of bug #96 fixed for the glyph cache and would recur identically
here without deliberate reuse of that pattern.

## 8. Failure-mode analysis

**Case A — pinned, goes offline mid-download.** Covered in §5: fetch fails,
no partial write, readiness stays "Not offline-ready", visible retry
action. If the user departs anyway with the core precache intact but an
extended region missing: the core region (mask, unchanged) still works;
MapLibre tile requests falling inside the missing extended region fail as
ordinary offline fetch errors — rendering as **visible blank/gray tiles**,
never a silently-complete-looking chart. This is the specific outcome the
whole design optimizes for: a visible gap the user can see is categorically
safer than a chart that looks complete and isn't, and the readiness badge
exists so the user sees this coming before departure, not during it.

**Case B — pinned and verified in a prior session, evicted since (no
`persist()` guarantee).** Re-verification on load (§4) catches this — but
only if that re-check works **without network**, because the user's next
app open might already be offline (they didn't re-check before leaving the
dock). This is why §4 specifies a pure `caches.match()` read, not a
server-verified check: it is the one design choice in this document that
must hold even with zero connectivity, and it is what makes eviction
locally detectable offline rather than only detectable the next time the
user happens to have signal.

**Case C — do nothing (status quo, area extension ships anyway).** Covered
in §0: not a graceful degradation but a silent flip of the *entire*
basemap (not just the new region) to online-only, the moment the archive
exceeds `maximumFileSizeToCacheInBytes`, with only a `console.warn` as the
signal.

## 9. Considered and rejected

1. **Per z/x/y tile lazy-caching of one monolithic basemap archive** (the
   issue's literal candidate). Rejected: proving completeness for an
   arbitrary corridor requires decoding PMTiles' tile-ID/directory format
   and enumerating exact tile IDs per zoom level, adding solver-adjacent
   bookkeeping complexity for a benefit the simpler regional-archive split
   (§3) already delivers, without a worst case that is any better — a
   corridor touching most of a region's tiles pays roughly the same bytes
   either way, for much more code.
2. **Chunk the mask the same way as the basemap** (geographic tiles +
   multi-instance `NavMask`). Rejected: the mask stays small even after a
   1.7x area growth (≈9.0 MB, method: 5,280,000 × 1.7, still far below the
   basemap), is read in the solver's hot path, and — decisively — is *also*
   read live during a trip for the #251 depth-safety check, so it can never
   be plan-only-lazy regardless of chunking scheme. The byte savings do not
   justify the #282-triggering routing-behaviour-change risk.
3. **Do nothing; keep precaching the whole growing region monolithically,
   optionally raising `maximumFileSizeToCacheInBytes`.** The issue
   explicitly allows this "if argued with measured numbers" — §0's measured
   arithmetic (27.2 MB × 1.7 ≈ 46.2 MB > 41.94 MB cap) is exactly that
   argument, and it shows the *current, already-shipped* code's fallback
   path degrades the whole basemap to online-only, silently, the moment
   this cap is crossed. Raising the cap alone removes the silent-drop
   symptom but not the underlying problem: a single ~46 MB+ resource fetched
   atomically during one SW install event is real install-time risk on slow
   or mobile connections, and it does not address the "why now" framing at
   all — it just pushes the same ceiling to the next area extension.
4. **Rely on `navigator.storage.persist()` alone; skip building an explicit
   completeness/readiness system.** Rejected: per §6, `persist()` is a
   best-effort request already called unconditionally in `main.tsx` with
   its result discarded — it cannot be the mechanism a "guaranteed offline
   trip" promise rests on, only something that lowers how often the
   re-verification path (which must exist regardless) gets exercised.
5. **Lazy-load harbours, seamarks, or polars.** Rejected per the issue's
   own framing (harbours always eager) and confirmed by measurement — all
   three combined are 358,193 bytes, roughly two orders of magnitude below
   the basemap (27,201,789 / 358,193 ≈ 76×), not three; no plausible
   benefit, only complexity and (for the mask/harbours pairing the router
   needs together) more moving parts in the solver's asset loading path for
   no size reason.

## Claim-strength note

This document's chunking and pinning recommendations for the basemap are
argued from the existing PMTiles/Range/Cache-API mechanisms already proven
correct in this codebase (#118, #96, #28) — narrowed to "this generalises",
not independently load-tested against a real, larger, extended-region
archive (which does not exist yet; the area-extension issue is out of
scope here per #296's own framing). The §0 arithmetic is a *proxy* scaling
argument (byte size scaling with area), explicitly flagged as illustrative
for the vector basemap and exact only for the mask (uncompressed,
fixed-bytes-per-cell). Treat the exact post-extension basemap byte count as
unmeasured until that pipeline change exists and is built.
