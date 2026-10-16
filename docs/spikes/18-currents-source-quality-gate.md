# Spike #18 — which current source, if any, may enter the isochrone cost?

- **Issue:** #18 (routing: currents/tides and sea state)
- **Date:** 2026-10-15
- **Status:** Decision / Recommendation
- **Verdict:** **The gate FAILS. Build nothing.** Every forecast
  candidate (DKSS, BSH GRIB, CMEMS, Open-Meteo) fails G1 (validated skill in
  the straits). The best browser path, DMI DKSS (CORS,
  CC BY 4.0, no key), also fails G2 (horizon); its operational blockers are in
  §4. Currents stay out of the cost function.

Maintainer decision, 2026-10-15: spike doc, no build.

This supplements the 2026-07-22 waves spec §2 (same outcome, wider grounds:
skill, horizon, access) and does not replace it. That section is headed "do
not revisit under this issue"; this spike is the maintainer-sanctioned
exception ([#18 comment of 2026-10-02](https://github.com/DocGerd/sail_command/issues/18#issuecomment-5949283989)). The spec's "real 1-3 kn tidal streams" wording is not carried
forward: §2 below says only that wind-driven flow can dominate in these
straits, from pilot-book text.

## 0. Provenance

Research date 2026-10-15. "Measured" means a request or parse run that day
against the live endpoint or downloaded file. Each figure carries its filter.
Every source page cited for a figure was re-downloaded with `curl` and
re-read verbatim in a separate verification pass; claims that failed
verification are corrected below, not carried. Two exceptions: the Havnelods
copyright notice (§2) and the Limfjord DMI validation (§4) rest on search
snippets. Bbox is 54.3-55.6 N, 9.4-11.6 E. Where the research says
UNVERIFIED, this document says UNVERIFIED.

## 1. The quality gate

A current source may enter the isochrone cost only if it passes **all** of:

| # | Criterion | Pass condition |
|---|---|---|
| G1 | Validated skill | Published validation against observed currents in the narrow straits the fleet uses: Als Sund, Lillebælt, Storebælt, Flensburg Fjord. |
| G2 | Horizon | The source natively covers the 6-day wind horizon. A shorter horizon fails G2; a disclosed no-current tail is a mitigation to design (§6), not a pass. |
| G3 | Licence | Compatible with an open-source PWA: reuse and redistribution allowed with attribution the app can show. |
| G4 | Browser access | CORS-readable from the browser, or a no-backend static repack (scheduled CI job publishing static assets). |
| G5 | Offline packability | Storable with the plan (IndexedDB, single-digit MB) and never re-fetched, as wind is. |
| G6 | Coverage | Resolves the inner-fjord and harbour cells the router starts and ends in, or the gap is handled by a disclosed rule. |

Rationale for G1 first: a wrong current is worse than none. Straits are where
currents matter and where grids are coarsest, so skill there decides.

## 2. Ground truth: why a forecast, not an atlas

The Danish harbour pilot (Den danske Havnelods, Geodatastyrelsen) describes
the strait currents as wind-dominated:

- Als Sund at Sønderborg: "i reglen svag N-gående, men kan i forbindelse med
  vejr og vind være meget hård, indtil 3 knob".
- Ny Lillebæltsbro: "typisk mellem 0 og 3 knob, men ... op på 5 knob"; "Den
  kraftigste strøm opstår efter pludselige vindskift".
- Svendborgsund: up to 6 kn in NW storm, 2-3 kn in prolonged calm, turning
  every 6 h only "under rolige vejrforhold".

Source: https://www.danskehavnelods.dk/Havnelodsen/harbours/ and `/bridges/`
pages (ids in `/data/havne.js`, `/data/broer.js`). Figures are pilot-book
"indtil" values, not measurements. The text is © Geodatastyrelsen, not
redistributable (read via a search snippet, medium confidence): use it as a
validation reference only. Wind-driven flow can dominate in these straits; an
astronomical atlas covers only the settled-weather part (Svendborgsund turns
every 6 h in calm weather, with a 0.3-0.5 m high/low water difference). A
routing input would have to be a forecast.

## 3. Candidates scored against the gate

| Source | G1 skill | G2 horizon | G3 licence | G4 access | G5 offline | G6 coverage |
|---|---|---|---|---|---|---|
| DMI DKSS (HBM), EDR API | fail: none published for the straits | fail: 120 h (tail disclosure would be needed) | pass: CC BY 4.0 | partial: CORS `*`, 429s, `/grib` deprecated | pass for data, terms limit refresh | partial |
| BSH GRIB "Oberfläche für Segler" | fail: none found | fail: 3 d | pass: CC BY 4.0 | fail in browser; CI repack only | partial: CI JPEG2000 decode | partial |
| CMEMS BAL PHY 003_006 | fail: r = 0.03-0.08 | pass: 6 d / 10 d | partial: Copernicus licence | partial: CORS `*` Zarr, whole-Baltic chunks | fail in browser; CI repack only | fail |
| Open-Meteo marine (SMOC) | fail: none published | UNVERIFIED for currents | partial: free API non-commercial | pass: CORS `*` (measured) | UNVERIFIED | fail |
| BSH Gezeitenstrom atlas | n/a: astronomical only | n/a | pass: GeoNutzV | pass: CORS `*` | pass | partial |
| Havnelods | reference only | n/a | fail: © Geodatastyrelsen | n/a | n/a | n/a |

### 3.1 DMI DKSS via the Forecast EDR API

Docs: https://www.dmi.dk/friedata/dokumentation/data/forecast-data-storm-surge-model-dkss
and https://www.dmi.dk/friedata/dokumentation/forecast-data-edr-api.

- **Model.** "DKSS is based on DMI's circulation model HBM"; 4 runs/day;
  "The forecast range is 5 days". Surface layer is 2 m thick in `dkss_idw` and
  `dkss_lb`, a layer mean.
- **Grid.** `dkss_idw` measured 49.999" lon x 30.005" lat (0.479 x 0.500 nm
  at 54.9 N), 12,079 wet of 24,648 cells in the bbox. `dkss_lb` measured
  10" x 10" (about 0.096 nm lon x 0.167 nm lat); it covers only northern
  Lillebælt (collection bbox 9.493-10.018 E, 55.246-55.71 N). Quote the 10"
  grid, not the 0.15 nm (DKSS page) or 0.2 nm (ocean.dmi.dk) labels, which
  disagree.
- **Horizon (G2).** Each instance spans 120 h (measured, `/instances`); data
  appears about 3.5 h after analysis time (one run). Short of the 6-day wind
  horizon by at least 24 h. A collection extent of about 5.75 d is the union
  of four retained runs, not one run's lead.
- **Licence (G3).** CC BY 4.0,
  https://www.dmi.dk/friedata/dokumentation/terms-of-use. Registration is no
  longer required.
- **Access (G4).** No key. `access-control-allow-origin: *` on GET and
  preflight for data endpoints and `/instances`; the collection-detail
  document `/collections/<id>` returns no CORS header (3 tries). Parameter
  names must be hard-coded or read from `/instances`.
- **Packing (G5).** One hour of u+v over the bbox: 451,687 B JSON, 70,409 B
  gzipped (measured). Wet-cell int16 packing: 48 KB/h, about 5.8 MB per
  120 h run (derived; a dense 158 x 156 grid is 98.6 KB/h). A per-plan fetch
  at the measured gzip size is about 8.4 MB over 120 h (derived, not
  measured). A full 121-step cube request was not attempted.
- **Coverage (G6).** Null on 1.11 % of navigable cells (mask depth byte >= 30,
  every 3rd mask cell, 472,711 cells, nearest-node rounding). The first
  sweep's 1.3 % (6,204) did not reproduce. Harbours more than 0.8 nm from a
  wet cell: Flensburg 0.86, Kappeln 0.88, Maasholm 1.71. Als Sund is one
  cell wide in the BSH sea mask (§3.2); DKSS IDW shares that grid.
- **Verdict.** Best browser path, still fails G1 and G2. §4 lists the
  operational blockers.

### 3.2 BSH "Oberflächenströmung für Segler" GRIB

README and licence at `ftp://ftp.bsh.de/Stroemungsvorhersagen/`; page
https://www.bsh.de/DE/DATEN/Vorhersagen/Stroemungen/Oberflaechenstroemung_fuer_Segler/oberflaechenstroemung_fuer_segler_node.html.

- CC BY 4.0, commercial reuse allowed with credit.
- Grid measured 30" lat x 50" lon; `wb` (412 x 387 points) covers the whole
  bbox; 15-min steps; top-5 m mean; two issues per day. Horizon 3 days (FTP
  listing `_00`, `_01`, `_02`; the README does not state it).
- GRIB2 with JPEG2000 packing (DRT 5.40). Files about 15 MB/day (`wb`) and
  3 MB/day (`blt`). FTP is unreachable from a browser; the Nextcloud filebox
  GET responses carry no CORS header. A repack needs a CI-side decode, which
  makes it a scheduled static-asset job that goes stale twice a day.
- Sea mask (measured): Als Sund is a single-cell thread; Middelfart narrows
  2-3 cells wide; Svendborgsund 2-3 cells wide. Flensburg harbour
  (54.796 N, 9.438 E) is land; the first sea cell is 54.804 N, 9.452 E.
- No current skill numbers found: the BSH HBM paper (Brüning et al. 2021,
  DOI 10.23784/HN118-01) validates tides, temperature and oxygen. No
  same-time value comparison with DKSS was made (no JPEG2000 decoder
  installed); the two share a model family and a grid.

### 3.3 CMEMS Baltic Sea Physics, BALTICSEA_ANALYSISFORECAST_PHY_003_006

STAC: https://stac.marine.copernicus.eu/metadata/BALTICSEA_ANALYSISFORECAST_PHY_003_006/product.stac.json;
QUID: https://documentation.marine.copernicus.eu/QUID/CMEMS-BAL-QUID-003-006.pdf.

- NEMO 4.2.1, 1 nm (measured 1.0 nm lat, 0.96 nm lon at 55 N), 15-min surface
  currents. "00Z production proving a 10 days forecast and from a 12Z
  production providing a 6 days forecast" (the only candidate with a
  documented horizon covering G2).
- **Skill (G1), the only published figures found for the region.** V202411
  hindcast at the shallowest mooring level, not the surface: Fehmarn Belt
  (10 m): bias 0.23 m/s, cRMSD 0.24 m/s, **r = 0.08**; LT Kiel (1 m): bias
  -0.08 m/s, cRMSD 0.13 m/s, **r = 0.03**. QUID overall: "a large variation
  between the measurements and the hindcast in both current velocity and
  direction". Four moorings in the summary table (seven in the QUID text). Nothing for Als Sund, Lillebælt
  or Storebælt.
- Access: ARCO Zarr is public with `access-control-allow-origin: *`, no
  credentials. Chunks are `[2, 774, 763]`, so every time step downloads the
  whole Baltic: measured 1,125,036 B (u) + 1,156,392 B (v) per 30 min. Not
  browser-practical; about 0.3 MB/day if pre-subset in CI (derived: hourly, int16,
  3,072 wet cells in the bbox). The fill value is `fill_value` -999.0 in `.zarray`, not
  `_FillValue`; a reader keying on the latter sees a false 0 % null.
- Licence: free of charge, credit must be "clearly visible on the home page
  ... or at least on the page allowing to access to the products"
  (https://marine.copernicus.eu/user-corner/service-commitments-and-licence);
  the no-charge commitment is dated to 2028-06-30. Not CC BY.
- Coverage: Schlei (Arnis) absent, 3.82 nm from the nearest wet cell; Flensburg
  1.83 nm; null on 2.2 % of navigable cells (same filter as §3.1).

### 3.4 Open-Meteo marine (MeteoFrance SMOC)

https://open-meteo.com/en/docs/marine-weather-api.

- 0.08 deg (about 8 km), hourly. Docs: "This is not suitable for coastal
  navigation".
- Re-probed with `cell_selection=sea`: Middelfart narrows (55.506 N, 9.735 E)
  returns the cell at 55.375 N, 9.708 E, about 14.6 km south; Als Sund at
  Sønderborg returns Sønderborg Bugt. Same-day (2026-10-15) maxima: Als Sund
  cell 0.4 km/h (0.2 kn), Lillebælt cell 0.9 km/h (0.5 kn), against the
  pilot's 0-3 kn routine and up to 5-6 kn.
- CORS `access-control-allow-origin: *` (measured). The research documents no
  current-forecast length for this API; the waves spec states a 16-day marine
  horizon for wave fields.
- Data CC BY 4.0, but the free API is non-commercial only (under
  10,000 calls/day). `marine-api.` would be a new CSP `connect-src` host.
- Fails G1 and G6. This is the basis of the waves spec §2.

### 3.5 BSH Gezeitenstrom tidal atlas (WMS/WFS)

https://gdi.bsh.de/mapservice_gs/Gezeitenstrom_Daten/wms (GetCapabilities).

- Spring/neap speed and direction keyed to high water Helgoland, from BSHcmod.
  11,930 points in the bbox, CORS `*`, GeoNutzV, one static JSON is enough.
- The speed unit is **UNVERIFIED** (the info sheet names none; sample values
  0.029-0.303 look like m/s, an inference only).
- Astronomical only, so it misses the wind-driven part of the flow (§2). Not a
  routing input.

### 3.6 Havnelods

Qualitative ground truth only (§2). Copyright forbids copying it into the app.
No published harmonic atlas for Als Sund or Lillebælt turned up from Danish
sources.

## 4. Considered and rejected

- **Route on DMI DKSS through the browser (rejected).**
  - **Terms of use.** "Applications for mobile units may not update with data
    via DMI's web services when the application is not active." The page
    also says "continuous updating of the application with data via DMI's web
    service must be avoided"
    (https://www.dmi.dk/friedata/dokumentation/terms-of-use). Inference, not
    stated by DMI: background refresh or service-worker prefetch would breach
    this, a fetch while the app is in use probably would not, and a
    CI-published static asset would avoid the clause. Whether an installed PWA
    counts as an "application for mobile units" is undecided.
  - **Horizon.** 120 h per run against a 6-day wind horizon.
  - **Reliability.** HTTP 429 "Server is busy" with no `Retry-After`: 6 of 8
    cube requests in one session, 6 of 7 in an independent re-run, even at 3 s
    spacing. Cause unknown (looks like a global busy signal, unverified). Latency was
    28.3 s once and 2.4 s once (two samples).
  - **Deprecation.** DMI's EDR page announces removal of the `/grib`
    endpoint (whole-domain files) on 2026-11-01 (read 2026-10-15).
  - **Als Sund.** One cell wide in the sea mask; only Lillebælt has a
    sub-0.2 nm nest.
  - **Skill.** No published validation in the straits. DMI HBM ADCP validation
    found only for the Limfjord (secondary, search result only).
- **Use CMEMS skill as a proxy for DKSS/BSH (rejected as evidence).**
  r = 0.03-0.08 is for a different model at two moorings. It shows the problem is hard, not that DKSS is poor, and it is no
  licence to assume DKSS is good.
- **Hybrid DKSS plus CMEMS tail (rejected).** Two models with different skill
  stitched at +120 h; CMEMS needs a CI repack and misses the fjords.
- **CI repack of BSH or DKSS as a static asset (deferred, not rejected).** It
  fits "no backend" and would pass G4; compatibility with the DMI terms is
  UNVERIFIED (§6). It does not fix G1, G2 or
  G6, and the assets go stale between runs. Revisit only if G1 clears.
- **Open-Meteo marine currents (rejected).** §3.4.
- **Tidal atlas as a routing term (rejected).** It omits the wind-driven
  part of the flow (§2).
- **Zero or nearest-wet current on null cells (rejected as a mitigation).**
  Silent extrapolation into Flensburg harbour (0.86 nm from the nearest DKSS
  wet cell, land in BSH's mask) would be overstated precision.

## 5. Recommendation

**Do not build a current term.** The gate fails at G1 for every forecast candidate (DKSS, BSH GRIB, CMEMS,
Open-Meteo):
there is no published validation in Als Sund, Lillebælt, Storebælt or
Flensburg Fjord for BSH, DMI or CMEMS, and the only published numbers
(CMEMS r = 0.03-0.08 at two moorings) are poor. Honest omission beats
pseudo-precision, as the issue's own constraints allow.

A possible future **display-only overlay** (arrows from DKSS, labelled as a
model forecast, never entering the cost) is an option and not a decision. It
would still owe the DMI terms (no background refresh), a 429 retry design, and
a disclosed tail beyond 120 h.

## 6. What would reopen this

- Published validation of a forecast model against observed currents in
  Lillebælt or Als Sund (or Storebælt, Flensburg Fjord), with skill clearly
  better than the CMEMS figures above.
- A source with a horizon of at least 6 days, or an accepted disclosed-tail
  design, together with a fine nest over Als Sund and Flensburg Fjord.
- A DMI statement that a keyed or bulk path relaxes the 429 behaviour and
  confirms static repack use under its terms.
- A maintainer ruling to ship a display-only overlay (§5), which needs no gate
  pass because it does not touch the cost.

## 7. Not measured

- Skill of any model in the straits (none found).
- A full 121-step DKSS cube: size, latency and 429 behaviour.
- A same-time numeric comparison of BSH, DKSS and Open-Meteo.
- DMI rate-limit policy; the 429 cause.
- BSH Gezeitenstrom speed unit: UNVERIFIED.
- Whether DKSS `current-u` equals `current-1m-u` for IDW.
- Channel distances in the source tables use hand-picked probe coordinates and
  are indicative.
