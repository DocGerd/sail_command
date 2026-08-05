# Spike #245 — depth-mask resolution vs. payload

- **Issue:** #245 (paired with #244)
- **Date:** 2026-08-05
- **Status:** Decision / Recommendation
- **Verdict:** **46 m is source-limited, not choice-limited. Uniform refinement
  buys no information and is a measurable regression against today's
  connectivity gate: at 23 m and 12 m it reconnects none of the five #9
  harbours, and — at the default 3.0 m gate — disconnects `aabenraa` (and, at
  its 2.8 m exception gate, `augustenborg` at 12 m), failing `verify_mask.py`.
  Bytes were never the constraint. Do not change the grid.**

> Companion: [`244-buoyed-fairways.md`](./244-buoyed-fairways.md). The two spikes
> are alternative answers to the same question — how to represent a corridor the
> 46 m raster cannot resolve — and were decided together.

---

## 0. How to reproduce every number in this document

Every measurement below comes from files already on disk (the gitignored
`pipeline/data-src/` cache and the committed `app/public/data/`), read with
`pipeline/.venv`. No figure in this document is sourced from a summarising web
fetch.

The load-bearing fidelity control: a scratch script that re-implements
`build_mask.py`'s exact `max`/`bilinear`/`TOLERANCE_M = 2.0` blend at
2200 × 2400 reproduces the committed `app/public/data/mask.bin`
**byte-identical — 0 differing bytes of 5,280,000**. Everything this document
claims about other resolutions was produced by the same code path with only
`COLS`/`ROWS` changed, so the comparison is like-for-like rather than a
re-derivation that could drift toward its own conclusion.

---

## 1. Premise check — three of the issue's stated facts are wrong

The issue's "Measured starting point" table is mostly right, but three entries
do not survive contact with the file.

### 1.1 The source is anisotropic; "~115 m" is only its north–south dimension

`pipeline/data-src/emodnet_dtm.tif`, read directly:

| Property | Measured value |
|---|---|
| Grid | 1536 × 960 = 1,474,560 cells |
| CRS / dtype | EPSG:4326, float32, 1 band |
| Resolution | 0.0010416666666666667° = **1/960° = 3.75″** in *both* axes |
| Cell size at lat 54.8 | **66.99 m E–W × 115.96 m N–S** |
| NoData / NaN cells | **0 of 1,474,560** |

Method — the metre figures are derived, not asserted:

```
m_per_deg_lon = 111412.84·cos(φ) − 93.5·cos(3φ)          = 64,312.0 m at φ = 54.8°
m_per_deg_lat = 111132.92 − 559.82·cos(2φ) + 1.175·cos(4φ) = 111,319.8 m at φ = 54.8°
cell_x = (1/960)° × 64,312.0  = 66.99 m
cell_y = (1/960)° × 111,319.8 = 115.96 m
```

`1/960° = 1/16 arc-minute`, which is EMODnet DTM's published native grid step —
so the WCS returned the coverage **at native resolution**, not resampled. The
`~115 m` figure in `build_mask.py`'s comment and in #245 is the **latitude**
dimension only. In longitude the source is **67 m**, nearly twice as fine.

This matters for reading the rest of the spike correctly, but it does **not**
rescue refinement: the destination grid is finer than the source in *both* axes
(46.8 m E–W, 46.4 m N–S), so every destination cell is still interpolated.

### 1.2 The oversampling ratio is 3.58× by area, not ~6×

| Axis | Source step | Dest step | Ratio |
|---|---|---|---|
| Longitude | 1/960° | 1.6°/2200 | 2200/1536 = **1.4323×** |
| Latitude | 1/960° | 1.0°/2400 | 2400/960 = **2.5×** |
| Area | 1,474,560 cells | 5,280,000 cells | **3.5807×** |

#245 states "roughly 2.5× linearly (~6× by area)". The 2.5× is the latitude
figure only, and 2.5² = 6.25 is not the area ratio because the two axes
oversample differently. The correct area figure is **3.58×**.

The issue's *conclusion* from that number survives — the grid does oversample
its source in both axes, so uniform refinement adds no information — but the
number itself should be cited as 3.58×, not ~6×.

### 1.3 "Unsurveyed" is an empty category in this bbox

#245's Q5 is built on byte 0 conflating *land* with *unsurveyed*. Measured:

- Source NaN cells in the tif: **0 of 1,474,560**.
- Post-reprojection unknown (`~known`) cells: **0** at 46 m, 23 m *and* 12 m.

So in this bbox byte 0 is **land-or-drying only**. The land/unknown conflation
is real in the *encoding* but has **zero instances in the shipped data**.
Distinguishing them would change no cell today. This is a narrowing, not a
closure: it holds for this bbox and this source, and would need re-checking if
the bbox grew or the source changed.

### 1.4 What the issue got exactly right

The gzip figure. `gzip -9` (GNU gzip CLI) on the committed `mask.bin` gives
**1,346,789 B**, matching #245 to the byte. (Python's `zlib` at level 9 gives
1,338,880 B — a 7,909 B implementation difference, not a discrepancy in the
asset. Cite the CLI figure.)

---

## 2. The decisive experiment — refinement measured, not predicted

Ratios are an argument. Connectivity is evidence. The same build logic was run
at three resolutions and each result put through `verify_mask.py`'s
4-connectivity flood fill from the same open-water seed, at each harbour's own
gate depth (including `CONNECTIVITY_EXCEPTIONS_M`).

| Grid | Cells | `mask.bin` bytes | #9 harbours reconnected | Harbours **newly disconnected** |
|---|---|---|---|---|
| 46 m — 2200 × 2400 (shipped) | 5,280,000 | 5,280,000 | — (baseline: 0 of 5) | none |
| 23 m — 4400 × 4800 | 21,120,000 | 21,120,000 | **0 of 5** | **`aabenraa`** |
| 12 m — 8800 × 9600 | 84,480,000 | 84,480,000 | **0 of 5** | **`aabenraa`, `augustenborg`** |

Two findings, and the second is the one that decides the spike.

### 2.1 Refinement reconnects nothing

Not one of `arnis`, `kappeln`, `maasholm`, `dyvig`, `graasten` reconnects at
23 m or at 12 m. #9's recorded finding — that these need *hi-res bathymetry*,
not a finer grid over the same source — is confirmed by direct measurement at
two finer resolutions.

`graasten` deserves a separate note because its `KNOWN_DISCONNECTED` reason is
*not* bathymetric ("Egernsund bascule bridge deck land-rasterized"). Land-mask
rasterization genuinely *can* improve with cell size even when bathymetry
cannot, so this was the one harbour where refinement had a mechanism available
to it. It still does not reconnect at 12 m — the OSM land polygon itself covers
the channel there, so this is a land-*data* limit, not a rasterization-
resolution limit. Refinement's one plausible mechanism was tested and did not
fire.

### 2.2 Refinement disconnects harbours that pass today — at their current gates

| Harbour | Gate | Snap-cell depth @46 m | @23 m | @12 m |
|---|---|---|---|---|
| `aabenraa` | 3.0 m (default) | **3.0 m** (byte 30) | 2.9 m (byte 29) | 2.8 m (byte 28) |
| `augustenborg` | 2.8 m (exception) | **2.8 m** (byte 28) | 2.8 m (byte 28) | 2.6 m (byte 26) |

This is **not** a channel pinching shut. The flood fill reports the harbour's
own component size as **0 cells** — the snap cell is itself below its gate, so
it is not navigable at all, and never enters the labelling. The 1500 m
neighbourhood around each snap is essentially unchanged across resolutions
(`aabenraa`: 65.7% → 65.2% → 65.3% land, 6.4% below-gate at all three), which
rules out a broad depth shift.

The mechanism: **both harbours sit exactly on their gate at 46 m.** A coarser
cell averages over a larger footprint and borrows depth from neighbouring
deeper water; a finer cell stops borrowing and the value falls a decimetre or
two. `aabenraa` passes today on `3.0 ≥ 3.0` — a single decimetre with no
margin, and that decimetre is a smoothing artifact of the cell size rather
than a measurement at the snap point.

**The disconnection is gate-conditional, and the gate is a user setting.**
`aabenraa` reads **2.9 m** at 23 m, so it stays connected at any user
`safetyDepthM ≤ 2.9`; it disconnects at the 3.0 m default. Navigability is
decided at query time, so "disconnects harbours that pass today" is a claim
about the *default* setting and about `verify_mask.py`'s gate, not a universal
one. This repo already treats the sibling case as correct data behaviour
rather than a bug (Flensburg→Marstal routes only at safety depth ≤ 2.3 m), so
the qualifier is load-bearing.

Three consequences worth separating by strength:

- **Unconditional, and enough to decide this spike on its own:** refinement
  buys **zero new information** — the destination already oversamples the
  source in both axes (§1.2) — and `verify_mask.py` **exits non-zero**, since
  neither harbour is in `KNOWN_DISCONNECTED`. Neither statement depends on any
  user setting.
- **Strong, and it decides this spike:** any resolution change re-opens
  `CONNECTIVITY_EXCEPTIONS_M`, exactly as #245 already anticipated for
  `TOLERANCE_M`. Those thresholds were derived (per `verify_mask.py`'s own
  comment) by scanning gate depths *against the 46 m mask*; they are
  resolution-coupled constants, not properties of the water.
- **Weaker, and stated as an observation rather than a conclusion:** the finer
  grid is arguably the *more honest* one here. It is not obviously a
  "regression" that a harbour whose approach is genuinely ~2.9 m stops
  claiming 3.0 m. What is certain is that `verify_mask.py` would exit non-zero
  (these harbours are not in `KNOWN_DISCONNECTED`), which is a hard blocker
  either way.

**Either reading forbids shipping a refined grid without re-deriving the
connectivity thresholds.** That re-derivation is a bathymetry-tuning exercise
of exactly the kind #9 and #6 already paid for, bought with zero new
information.

### 2.3 A previously undocumented fragility, worth its own issue

`aabenraa`'s connectivity resting on `3.0 ≥ 3.0` at the default gate is a
knife edge nobody recorded. It is not a bug today — the harbour *is* connected
in the shipped mask — but it means any change to the resampling blend, the
land polygons, the bbox, or the grid can silently flip it. It is invisible to
`verify_mask.py`, which reports a binary connected/disconnected and not the
margin. **Recommended follow-up: have `verify_mask.py` report each harbour's
snap-cell margin above its gate, and flag any harbour passing with < 0.2 m.**

---

## 3. What is the real constraint? (#245 Q4)

Established before optimising, because the four candidates point at different
solutions.

### 3.1 Transfer size — not the constraint

| Encoding | Bytes | vs. raw | vs. gzip |
|---|---|---|---|
| Raw `mask.bin` | 5,280,000 | 1.00× | — |
| `gzip -9` (GNU CLI) | **1,346,789** | 3.92× | baseline |
| brotli q11 (node `zlib`) | 987,004 | 5.35× | −26.7% |
| **greyscale PNG** (`mode='L'`, `compress_level=9`, `optimize`) | **799,073** | **6.61×** | **−40.7%** |

1.35 MB on the wire, against a 27.2 MB basemap in the same precache. Transfer
size is not what is hurting anyone.

### 3.2 Precache budget — not the constraint at 46 m or 23 m, hard wall at 12 m

| File | Bytes |
|---|---|
| `basemap.pmtiles.png` | 27,201,789 |
| `mask.bin` | 5,280,000 |
| `seamarks.json` | 343,466 |
| everything else in `app/public/data/` | 15,331 |
| **total** | **32,840,586** |

`maximumFileSizeToCacheInBytes = 40 * 1024 * 1024 = 41,943,040`
(`app/vite.config.ts:390`) is a **per-file** cap, so today's headroom for a
single file is 41,943,040 − 27,201,789 = **14,741,251 B**.

- At 23 m the mask is 21,120,000 B — under the per-file cap, total precache
  ~48.7 MB.
- At 12 m the mask is 84,480,000 B — **over the per-file cap**. Workbox would
  drop it from the precache manifest with only a build **warning** and no
  error, and the app would lose offline routing. (Read from the installed
  source, `app/node_modules/workbox-build/src/lib/maximum-size-transform.ts`:
  the oversized entry is filtered out of the manifest and a
  `"… won't be precached"` string is pushed onto `warnings` — so there *is* a
  signal, it simply is not a failure.) Noting this for completeness; §2 already
  disqualifies 12 m on correctness.

### 3.3 In-memory footprint — **this is the real constraint, and it is in app code**

`NavMask.cellsConnected` (`app/src/lib/mask.ts:201-202`) allocates, per call:

```
visited: Uint8Array(rows*cols)  =  1 × N bytes
queue:   Int32Array(rows*cols)  =  4 × N bytes
                                   ─────────────
                                   5 × N bytes per call
```

| Grid | N | One `cellsConnected()` call |
|---|---|---|
| 46 m | 5,280,000 | **26.40 MB** |
| 23 m | 21,120,000 | **105.60 MB** |
| 12 m | 84,480,000 | **422.40 MB** |

Calls per solve, counted from source rather than estimated:

- `planRoute.ts` — one `connectedAt(s.safetyDepthM)` fast-path probe.
- `relaxedDepth.ts` — a binary search of `ceil(log2(hiDm − loDm + 2))` probes.
  At the default `safetyDepthM = 3.0` and `BOAT_DRAFT_M = 2.1`:
  `hiDm = 29`, `loDm = 21`, so `ceil(log2(10)) = 4` probes.
- Each probe calls `cellsConnected` once **per consecutive waypoint pair**.

So a via-less default plan makes up to **5 calls**. These are sequential, so
*peak live* is one call's allocation, not the sum — but the churn is 5 × that
per solve, and the 4 MB-per-million-cells `Int32Array` dominates.

The queue is sized `rows*cols` while it only ever needs to hold the BFS
frontier. **This is the single highest-value, lowest-risk change this spike
found, and it is app-side, not pipeline-side** — it changes no asset, no
format, and no data, and it is worth doing *at the current resolution*.

### 3.4 The per-solve `.slice(0)` transfer — proportional, not dominant

5,280,000 B copied per solve today (21,120,000 B at 23 m). Real but an order
below §3.3's allocation.

**Answer to Q4: the constraint is in-memory allocation in `cellsConnected`,
not bytes, not the precache.** Every byte-oriented optimisation below is
therefore optional; the memory one is not.

---

## 4. Free accuracy from an encoding change alone? (#245 Q5)

Asked as "what is available with no resolution change". The honest answer is
*almost nothing*, and saying so is the point of a decision doc.

### 4.1 Depth histogram

| Band | Cells | % of water |
|---|---|---|
| bytes 1–29 (0.1–2.9 m) | 172,202 | 6.51% |
| bytes 30–49 (3.0–4.9 m) | 134,150 | 5.07% |
| bytes 50–99 (5.0–9.9 m) | 354,629 | 13.40% |
| bytes 100–149 (10.0–14.9 m) | 465,341 | 17.59% |
| bytes 150–253 (15.0–25.3 m) | 1,210,704 | 45.76% |
| byte 255 (≥ 25.4 m) | 309,021 | 11.68% |
| **byte 254 (reserved)** | **0** | — |

Water cells: 2,646,047. Byte 0: 2,633,953 (49.89% of grid). 255 of 256 byte
values occur.

### 4.2 A non-linear depth scale buys nothing — reject it

The band that matters for a 2.1 m draft boat (0.1–14.9 m) is 42.57% of water,
so there *is* a lot of byte budget spent on depths nobody routes by. But the
current quantum is already **0.1 m**, and a non-linear scale can only refine
*below* one decimetre in the shallow band.

Navigability is `cellDepth >= safetyDepthM`. `safetyDepthM` is a user setting
on a 0.1 m UI step, and cell depth is decimetre-quantised. **Sub-decimetre
precision cannot change the outcome of that comparison for any reachable
setting.** A finer scale would be free in bytes and worthless in decisions.

Not "an option with a modest payoff" — **rejected**.

### 4.3 A distinct `unknown` code — correct, and currently inert

Byte **254 is already reserved and never emitted** (measured: 0 occurrences),
so a distinct land/unknown code needs no format widening — the slot exists.
It is the right encoding. It would also change **zero cells today** (§1.3: no
unsurveyed cells in this bbox).

Verdict: **do it if and only if the bbox or the source ever changes**, and
record it as the designed meaning of 254 now so a future ingest cannot
accidentally claim it. Not worth a `MaskMeta` version bump and a coordinated
four-file change on its own.

### 4.4 The PNG container — the one measured, resolution-free win

799,073 B vs. 1,346,789 B is **−40.7% on the wire**, losslessly, at identical
resolution and identical accuracy. PNG's per-row filters exploit the depth
field's 2D spatial coherence, which gzip's 1D window cannot. And #118 already
established `image/png` as the CDN-exempt content type on GitHub Pages, so a
PNG-container mask would be served **uncompressed and intact**, where `.bin`
today is served gzipped as `application/octet-stream`.

**It is not free, and the cost is real:** it replaces a plain
`response.arrayBuffer()` with an image-decode + canvas readback path
(`createImageBitmap` + `OffscreenCanvas.getImageData` in the worker), and
`getImageData` returns **RGBA** — a 4 × N = 21.1 MB transient at 46 m, plus a
de-interleave pass to recover the single channel.

Recommended as a **follow-up issue to be settled by measurement** (decode time
and peak transient memory on a real mid-range phone, against the 547,716 B
saved), not adopted blind. Given §3.1 — transfer size is not the constraint —
its priority is low.

---

## 5. Variable resolution (#245 Q3) — the highest-value angle, and it still loses

The issue calls this "probably the highest-value one". It is disqualified by
the same measurement that disqualifies uniform refinement, and it is worth
being explicit about why, because the idea is genuinely good in the abstract.

A high-resolution patch near harbours and channels would be interpolating from
**the same 67 × 116 m source** as everywhere else. Finer patches over an
unchanged source add no information for exactly the reason §1/§2 establish
globally — and §2.2 shows the sharper mechanism: near harbours is precisely
where the coarse cell's borrowed depth is currently *holding connectivity
together*, so patches would land where refinement is most likely to *break*
something.

Variable resolution is the **right mechanism paired with the wrong input**. It
becomes worth revisiting if — and only if — a genuinely higher-resolution
source is licensed and ingested for those sub-areas (§6). Then the patch shape
is the correct way to spend the bytes. Today it is complexity, a format change
across four files, and a re-tuning of `TOLERANCE_M` and
`CONNECTIVITY_EXCEPTIONS_M`, bought with zero new information.

---

## 6. Better sources (#245 Q2) — OPEN, deliberately unquantified

**This spike did not settle this question, and this section deliberately states
no resolution figure for any source it did not open.** Citation discipline: a
resolution in metres sourced from a search summary is silently wrong rather
than obviously wrong, and this repo has a documented case (BSH INT-1) of a
correct citation later re-verifying as a fabrication because the same URL began
serving a re-laid-out edition.

What is established: the *current* source is EMODnet DTM 2024, cited in
`mask.meta.json` as
`doi:10.12770/cf51df64-56f9-4a99-b1aa-36b8d7b743a1 (CC-BY 4.0)`, delivered at
its native 1/16 arc-minute grid, licence-clear for shipping a derived asset.

Candidates, each with the measurement that would settle it:

| Candidate | What must be measured before it can be cited |
|---|---|
| EMODnet **HR DTM** tiles | Fetch the HR tile index for 54.3–55.3 N / 9.4–11.0 E; read grid spacing off the file header, not off a portal page. Confirm coverage is not partial. Pin the release year. |
| Danish national survey (GEUS / DCE / SDFI) | Coverage within bbox; native spacing from the file; **licence for redistributing a derived offline asset** — the decisive test, checked before any resolution work. |
| German BSH survey / ENC | Same three, plus edition pinning (see the INT-1 precedent above). |
| Official ENC S-57/S-101 `DEPARE` / `SOUNDG` | These are *vector depth areas and soundings*, not a raster — ingesting them is a different pipeline, not a resolution bump. Licence is the gate: most national ENC distribution forbids derived redistribution. |

**Ordering rule for whoever picks this up: settle licence first, resolution
second.** A source that cannot be shipped in a precached offline app is not a
candidate however fine it is, and licence is far cheaper to check.

Note the interaction with §2.2: a genuinely finer source would *also* re-open
`CONNECTIVITY_EXCEPTIONS_M`, and for the same reason. That is acceptable when
buying real information; it was not acceptable for interpolation.

---

## 7. RECOMMENDATION

1. **Do not change the mask resolution.** 46 m already oversamples its source
   3.58× by area, so refinement buys no information; and refinement to 23 m and
   12 m was measured to reconnect **0 of 5** #9 harbours while **disconnecting**
   `aabenraa` at the default 3.0 m gate (23 m and 12 m) and `augustenborg` at
   its 2.8 m exception gate (12 m), failing `verify_mask.py`. The
   disconnections are gate-conditional (§2.2); the zero information gain and
   the non-zero `verify_mask.py` exit are not.
2. **Do not change the depth quantization.** A non-linear scale cannot change
   the outcome of a decimetre-quantised `cellDepth >= safetyDepthM` comparison
   (§4.2).
3. **Fix the actual bottleneck, in app code:** size `cellsConnected`'s
   `Int32Array` queue to the frontier rather than `rows*cols`. 26.4 MB per call
   today, up to 5 calls per solve. Worth doing at the current resolution;
   nothing about it depends on this spike's other conclusions. **Queue sizing
   is allocation-only and cannot change `cellsConnected`'s return value for any
   input — a correctly-sized queue visits the same cells in the same order — so
   it triggers no #282 routing-behaviour sweep** despite living inside the
   `connectedAt` path #282 governs. *(Follow-up issue.)*
4. **Record byte 254 as the designated `unknown/unsurveyed` code** without
   emitting it yet — the slot is already reserved and unused, and claiming it
   now costs nothing and prevents a future ingest from taking it. *(Docs/comment
   change only.)*
5. **Add a connectivity-margin report to `verify_mask.py`** and flag harbours
   passing their gate by < 0.2 m. `aabenraa` currently passes on exactly
   `3.0 ≥ 3.0` and nothing records that. *(Follow-up issue.)*
6. **File the PNG-container change as a low-priority follow-up**, to be decided
   by measuring decode time and peak transient memory on a real device — not
   adopted on the byte count alone (§4.4).
7. **Keep the source question open**, with licence checked before resolution
   (§6). This is the only path that would make finer cells meaningful.

## 8. NOT RECOMMENDED — considered and rejected

| Option | Why it lost |
|---|---|
| **Uniform refinement to 23 m** | Reconnects 0 of 5 #9 harbours; disconnects `aabenraa` at the default 3.0 m gate; 4× asset (21.1 MB) and 105.6 MB per `cellsConnected` call; re-opens `TOLERANCE_M` **and** `CONNECTIVITY_EXCEPTIONS_M` tuning. Buys no information — the source is coarser than the destination in both axes. |
| **Uniform refinement to 12 m** | All of the above, worse: disconnects `aabenraa` (3.0 m gate) *and* `augustenborg` (2.8 m exception gate); 84.5 MB asset **exceeds** `maximumFileSizeToCacheInBytes` (41,943,040) and would be dropped from the precache with only a build warning, breaking offline; 422.4 MB per BFS call. |
| **Variable resolution / high-res patches** | Right mechanism, wrong input — patches interpolate from the same 67 × 116 m source, and would land exactly where coarse-cell smoothing is currently holding connectivity together (§2.2). Revisit only after a finer source is licensed. |
| **Non-linear depth scale** | Free in bytes, worthless in decisions: the gate compares two decimetre-quantised numbers, so sub-decimetre precision changes no outcome (§4.2). |
| **Distinct land/unknown codes, now** | Correct encoding, zero effect — this bbox has **0** unsurveyed cells at every resolution tested. Deferred, with byte 254 reserved for it (§4.3). |
| **Brotli precompression** | 987,004 B beats gzip by 26.7%, but GitHub Pages cannot set `Content-Encoding` for a precompressed asset, so it is not deployable here — and PNG beats it anyway at 799,073 B (§3.1). |
| **Raising `maximumFileSizeToCacheInBytes`** | Would "solve" only the 12 m per-file wall, which §2 already disqualifies on correctness. Treating a correctness blocker as a budget problem. |
| **Relaxing `KNOWN_DISCONNECTED` to absorb the refinement regressions** | Explicitly forbidden by #245's own constraints — the allowlist may shrink, never grow to accommodate a regression. Named here only to record that it was considered and refused. |
| **Fabricating depth in the #9 channels** (from a fairway centreline or otherwise) | Violates "never overstate depth". See [`244-buoyed-fairways.md`](./244-buoyed-fairways.md) §6.2, where it also fails on data before it fails on principle. |

## 9. Invariants checked against this recommendation

- **Navigability stays a query-time decision.** Nothing recommended here bakes
  a safety assumption into the asset; `safetyDepthM` remains a user setting and
  still requires no data regeneration.
- **`verify_mask.py` must exit 0** with `KNOWN_DISCONNECTED` unchanged or
  shrunk — the primary reason refinement is rejected (§2.2).
- **Never overstate depth** — no recommendation adds depth anywhere.
- **Offline-first** — recommendation 1 (leave the grid at 46 m) is what keeps
  the mask under the per-file precache cap that 12 m would have breached
  (§3.2).
- **#282** — recommendation 3 edits `cellsConnected`, inside the `connectedAt`
  path #282 governs, but is **allocation-only**: it cannot change the function's
  return value for any input, so it triggers no routing-behaviour sweep. No
  other recommendation touches a solver input at all.
- **No backend, no chart authority** — nothing here adds a runtime data source
  or a claim of chart accuracy.
