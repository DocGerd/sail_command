# #1894 rerun scripts

The implementation of [§6 of the spike](../1894-land-wind-shadow.md#6-rerun-pre-registration-2025-trips).
No track data, positions or times are committed; `SC_DATA` points at them.

```sh
SC_DATA=<data dir> SC_PYTHON=<python> ./run.sh fetch     # records the freeze, then fetches the wind
SC_DATA=<data dir> SC_PYTHON=<python> ./run.sh analyse   # refuses if scripts or static inputs changed since the freeze
```

The scripts run under `-I`, so numpy must sit in the interpreter's own
site-packages (e.g. a venv); `SC_PYTHON` defaults to `python3`.

| Script | Step |
|---|---|
| `intake.py` | splits a GPX export into per-day tracks (the §6 intake) |
| `fetch_hist.py`, `d_points.py` | Historical Forecast API wind at the lattice points each trip reads (§6.2) |
| `check_coverage.py` | §6.2 drop rule |
| `compare_sources.py` | §6.2 agreement with the `past_days` cache (reported) |
| `samples.py` | §0 per-fix table; `SC_SAIL` and `SC_LEG_R_MAX` add §6.1 and §6.3 |
| `merge_trips.py`, `rays.py` | pooled samples; 72-ray distances and water width (§1.2) |
| `results6.py`, `decide.py` | §6.3 rules per table run, then the verdict over both runs |
| `results.py` | §0.4–§0.6 figures (the 2026 comparison and the polar check) |
