"""Sanity-probe the generated mask. Fails loudly if the mask is unusable."""

import json
import math
import pathlib
import re
import sys

import numpy as np
from scipy import ndimage

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent / "app" / "public" / "data"

meta = json.loads((OUT / "mask.meta.json").read_text())
grid = np.frombuffer((OUT / "mask.bin").read_bytes(), dtype=np.uint8).reshape(
    meta["rows"], meta["cols"]
)  # row 0 = south


def cells_per_degree(lo: float, hi: float, cells: int) -> int:
    """#1458: mirrors app/src/lib/mask.ts's `cellsPerDegree` — the integer
    cells-per-degree derivation #1259 moved the app onto, so a harbor snap
    lands in the same cell here as it does in the app."""
    raw = cells / (hi - lo)
    cpd = round(raw)
    if not (math.isfinite(raw) and cpd > 0 and abs(raw - cpd) <= 1e-9):
        raise AssertionError(f"mask axis is not an integer cells-per-degree: {cells} cells over [{lo}, {hi}]")
    return cpd


LAT_CPD = cells_per_degree(meta["south"], meta["north"], meta["rows"])
LON_CPD = cells_per_degree(meta["west"], meta["east"], meta["cols"])


def axis_index(v: float, lo: float, hi: float, cells: int, cpd: int) -> int:
    """Mirrors `GridAxis.index`: positions are computed from `origin` and the
    integer cells-per-degree, never from `(hi - lo) / cells`."""
    return cells if v >= hi else math.floor((v - lo) * cpd)


def rc_of(lat: float, lon: float) -> tuple[int, int]:
    row = axis_index(lat, meta["south"], meta["north"], meta["rows"], LAT_CPD)
    col = axis_index(lon, meta["west"], meta["east"], meta["cols"], LON_CPD)
    # #613: was a bare `assert` - Python strips those under -O/PYTHONOPTIMIZE,
    # silently disabling this mask-grid-bounds check. `if not (...): raise` is
    # not affected by either flag.
    if not (0 <= row < meta["rows"] and 0 <= col < meta["cols"]):
        raise AssertionError(f"probe {lat},{lon} maps outside the mask grid")
    return row, col


def depth_m(lat: float, lon: float) -> float:
    row, col = rc_of(lat, lon)
    b = int(grid[row, col])
    return 0.0 if b == 0 else (25.4 if b == 255 else b / 10.0)


WATER_PROBES = [  # (name, lat, lon, min expected depth m)
    ("Flensburg Fjord mid", 54.7996, 9.8895, 5.0),
    ("Sonderborg Bucht", 54.88, 9.83, 5.0),
    ("Als Fjord", 55.0338, 9.6815, 5.0),
    ("Little Belt south", 55.10, 9.85, 10.0),
    ("Aeroe SE open water", 54.75, 10.55, 5.0),
    ("Kiel Bight edge", 54.55, 10.30, 10.0),
    ("Fehmarnbelt", 54.57, 11.30, 10.0),  # #295 extension
    ("Great Belt west, off Nyborg", 55.30, 10.95, 10.0),  # #295 extension
]
LAND_PROBES = [
    ("Flensburg city", 54.79, 9.42),
    ("Als island center", 54.95, 9.85),
    ("Aeroe center", 54.87, 10.35),
    ("Langeland center", 54.90, 10.75),
    ("Angeln inland", 54.70, 9.70),
    ("Fehmarn centre", 54.47, 11.15),  # #295 extension
    ("Fyn inland north", 55.40, 10.30),  # #295 extension
]

failures = []
for name, lat, lon, want in WATER_PROBES:
    d = depth_m(lat, lon)
    if d < want:
        failures.append(f"WATER {name} ({lat},{lon}): {d} m < {want} m")
for name, lat, lon in LAND_PROBES:
    d = depth_m(lat, lon)
    if d != 0.0:
        failures.append(f"LAND {name} ({lat},{lon}): depth {d} m, expected land")

harbors = json.loads((OUT / "harbors.json").read_text())
for h in harbors:
    d = depth_m(h["snap"]["lat"], h["snap"]["lon"])
    if d < 2.2:
        failures.append(f"HARBOR {h['id']} snap ({h['snap']['lat']},{h['snap']['lon']}): {d} m < 2.2 m")


# ---- Per-boat derived gates (#54, spec C.3 and C.6) ----
# The gate is NOT a constant any more: it is derived per catalogue boat from
# that boat's own draft. Navigability is monotone in the gate, so a harbor
# verified at one gate says nothing about a deeper one.


def read_tolerance_m() -> float:
    """TOLERANCE_M, read out of build_mask.py rather than restated here.

    Anchored to a line that is ONLY the assignment: further up the same
    function, build_mask.py's derivation comment carries PROSE mentions of
    "TOLERANCE_M = <n>" at :144 and :163 - one of them the rejected 2.0, the
    other coincidentally correct-valued - so an unanchored regex finds a decoy
    above the real assignment. Same regex as app/src/test/maskTolerance.test.ts's
    readToleranceM(); change them together. Fails closed on zero matches AND on
    more than one, so a duplicated assignment cannot silently pick the wrong.
    """
    text = (HERE / "build_mask.py").read_text()
    found = re.findall(r"^[ \t]*TOLERANCE_M\s*=\s*([\d.]+)[ \t]*$", text, re.M)
    if len(found) != 1:
        sys.exit(
            f"build_mask.py: expected exactly one anchored TOLERANCE_M assignment, found {len(found)} "
            "- renamed, reformatted, moved or duplicated. Update this regex and "
            "app/src/test/maskTolerance.test.ts's readToleranceM() together."
        )
    return float(found[0])


TOLERANCE_M = read_tolerance_m()


def ceil_to_decimetre(x: float) -> float:
    """Quantise UP to a decimetre - the Python twin of app/src/lib/boatDepth.ts's
    ceilToDecimetre.

    NEVER round(): Python's is banker's rounding, so round(30.5) is 30, and a
    2.15 m boat's gate would land at 3.0 m - below its own draft + TOLERANCE_M.
    The 1e-9 nudge is not decoration either: (3.2 + 0.9) * 10 is
    41.00000000000001, so a bare math.ceil buys a decimetre of gate the boat
    never asked for. GATE_DERIVATION_CASES pins all three behaviours.
    """
    return math.ceil(x * 10 - 1e-9) / 10


def default_gate_m(draft_m: float) -> float:
    """Spec C.3: G = ceil10(draft + T).

    The guarantee "no cell the router may plan through reads below the hull on
    the conservative channel" holds iff G >= draft + T. T CANNOT be per-boat -
    one mask ships, one blend produced it, one constant governs it - so every
    per-boat lever is on the GATE side. Do not reach for TOLERANCE_M here.
    """
    return ceil_to_decimetre(draft_m + TOLERANCE_M)


# Cross-language twin table. app/src/test/verifyMaskBoatGate.test.ts reads these
# rows out of this file and asserts app/src/lib/boatDepth.ts's
# defaultSafetyDepthM() reproduces every one of them.
#
# What a row discriminates is a property of (draft + T) * 10, NOT of the draft:
# 3.20 sits on a decimetre and is still the only row that catches the nudge
# hazard. It is rows 1.73 and 2.15 that a table of decimetre drafts would lack.
#   2.10 -> 3.0  the shipping boat's anchor. Reds if TOLERANCE_M moves;
#                discriminates no quantiser - round, int and both ceils agree.
#   1.73 -> 2.7  (1.73 + 0.9) * 10 is 26.299999999999997; round() and int()
#                both give 2.6 - a gate under draft + T.
#   2.15 -> 3.1  the only row landing on an EXACT tie: (2.15 + 0.9) * 10 is
#                30.5, where Python's banker's round() picks the even
#                decimetre, 30 -> 3.0, a gate below draft + T.
#   3.20 -> 4.1  (3.2 + 0.9) * 10 is 41.00000000000001; math.ceil without the
#                1e-9 nudge gives 4.2. The residue is in the SUM, not the
#                draft, which is why a decimetre draft reaches this hazard.
GATE_DERIVATION_CASES: list[tuple[float, float]] = [
    (2.10, 3.0),
    (1.73, 2.7),
    (2.15, 3.1),
    (3.20, 4.1),
    (2.59, 3.5),
]
for _draft_m, _gate_m in GATE_DERIVATION_CASES:
    _got = default_gate_m(_draft_m)
    # #613: was a bare `assert` (stripped under -O/PYTHONOPTIMIZE). This is
    # the gate-derivation cross-check verifyMaskBoatGate.test.ts relies on
    # this file reproducing - it must be unconditional.
    if _got != _gate_m:
        raise AssertionError(f"gate derivation drifted: draft {_draft_m} m -> {_got} m, expected {_gate_m} m")


def dm(x: float) -> int:
    """Decimetre key for a value that is ALREADY a whole decimetre.

    The round() here is NOT quantising - that is ceil_to_decimetre's job two
    functions up, and must never be a round. It only turns a float the check
    below has already bounded to within 1e-6 of an integer into that integer,
    where int() would truncate 29.9999999 to 29. That check is what keeps the
    two roles from being confused: hand this a half-decimetre and banker's
    rounding would key it to the nearest even one silently, so it aborts
    instead.
    """
    tenths = x * 10
    key = int(round(tenths))
    # #613: was a bare `assert` (stripped under -O/PYTHONOPTIMIZE). This is
    # what keeps the rounding role (line above) and the drift-detection role
    # (here) from being confused - it must fire unconditionally.
    if abs(tenths - key) >= 1e-6:
        raise AssertionError(f"{x} m is not a whole decimetre - the mask encodes decimetres and every gate must be one")
    return key


def load_catalogue_boats() -> list[dict]:
    """Catalogue drafts, read from pipeline/polars-source.json.

    verify_mask.py is Python and app/src/data/boats.ts is TypeScript, so the
    draft has to reach this script through a Python-readable artifact.
    polars-source.json is already the per-boat pipeline source of truth and
    already carries a per-boat `validation` block of safety numbers, so this is
    one more field on a record that exists rather than a new artifact.
    app/src/test/verifyMaskBoatGate.test.ts is what keeps the two copies of
    draftM from drifting.

    Fails closed: a boat with no usable draftM aborts the run rather than
    falling back to any default, because a fallback would be another boat's
    draft and the gate below is derived from it.
    """
    src = json.loads((HERE / "polars-source.json").read_text())
    boats = src.get("boats")
    if not isinstance(boats, list) or not boats:
        sys.exit("polars-source.json: no boats - no gate can be derived")
    out = []
    for b in boats:
        bid = b.get("id")
        if not isinstance(bid, str) or not bid:
            sys.exit(f"polars-source.json: boat id missing or not a string: {bid!r}")
        draft = b.get("draftM")
        # isinstance(True, int) is True in Python, so bool is rejected first.
        if isinstance(draft, bool) or not isinstance(draft, (int, float)):
            sys.exit(f"polars-source.json: {bid}: draftM missing or not a number: {draft!r}")
        draft = float(draft)
        if not math.isfinite(draft) or draft <= 0:
            sys.exit(f"polars-source.json: {bid}: draftM must be a positive finite number, got {draft!r}")
        out.append(
            {
                "id": bid,
                "name": b.get("name") if isinstance(b.get("name"), str) else bid,
                "draftM": draft,
                "gateM": default_gate_m(draft),
            }
        )
    return out


CATALOGUE_BOATS = load_catalogue_boats()
CATALOGUE_GATE_DM = {dm(b["gateM"]) for b in CATALOGUE_BOATS}
CATALOGUE_BOAT_IDS = {b["id"] for b in CATALOGUE_BOATS}

# ---- Connectivity gate (issue #6) ----
# A harbor snap can sit on an individually-navigable cell (checked above) yet
# still be cut off from open water by land/depth artifacts elsewhere on the
# grid - that was exactly issue #6 (14/44 harbors, incl. Flensburg, stranded
# in disconnected pockets despite passing the per-cell probe). This gate
# 4-connected-flood-fills the navigable cells from a fixed open-water seed
# and asserts every harbor's snapped cell (#1584, app semantics: nearest
# navigable cell within 300 m) is reachable. 4-connectivity (not 8)
# is deliberate: a diagonal-only "connection" through a single pinched corner
# is not something a 4.2 m-beam boat can reliably thread, and this pipeline's
# rule is to never overstate navigability.
SEED_LAT, SEED_LON = 54.8455, 9.5216  # open Flensburg Fjord water

# Per-harbor override for a gate depth below a boat's derived gate, used ONLY
# when the harbor's own approachNote documents a genuinely shallower
# approach that the DTM/rasterization can't resolve as deep enough even at the
# current 46 m cell size - never by fudging the bathymetry. The checks below
# only verify that an approachNote *exists*; they can't verify the note's text
# actually supports the chosen number, so treat every entry here as a
# manual-review item at PR time, cited in the comment next to it (see PR #8,
# github.com/DocGerd/sail_command/pull/8, for the full investigation).
# Values were derived by scanning gate depths against the regenerated mask
# to find the threshold at which each harbor's snap cell actually reconnects
# to open water, then rounded down from that measured threshold to match
# the harbor's own documented figure, so the exception is never more
# permissive than the source text.
#
# #54 spec C.6: keyed by (harbor id, THE BOAT GATE IT WAS JUSTIFIED AGAINST).
# An exception justified against a 3.0 m gate says nothing about a 3.2 m one -
# dropping a 3.2 m gate to 2.8 m is a 0.4 m relaxation, not the 0.2 m the note
# was reviewed for. A boat whose derived gate has no entry here therefore gets
# no exception at all, which is what forces the evidence at its catalogue PR.
CONNECTIVITY_EXCEPTIONS_M: dict[tuple[str, float], float] = {
    # Judged snap-aware (#1584): augustenborg's former 3.0 m entry was dropped, its
    # snapped cell reaches open water at 3.0 m unaided.
    # "Buoyed approaches approx 3.2 m (N and W), 4.5 m from S; parts of the
    # yacht basin only approx 2 m." Reconnects at gate <= 2.3 m; 2.0 m is
    # the harbor's own documented figure for its shallowest reach and keeps
    # a safety margin below the measured 2.3 m threshold.
    ("marstal", 3.0): 2.0,
    # #54 spec N.6, for the Elan Impression 444 (draft 1.90 m -> derived gate
    # 2.8 m). Same harbor, same approachNote, same 2.0 m figure as the 3.0 m
    # entry above - a SEPARATE row because this table is keyed by (harbor, boat
    # gate) on purpose: an exception justified against one gate says nothing
    # about another, and a boat whose gate has no entry gets no exception at
    # all. That is the forcing function working as designed, and this is the
    # evidence it forced.
    #
    # The evidence is satisfied A FORTIORI by the entry above rather than by a
    # fresh investigation: dropping a 2.8 m gate to 2.0 m is a 0.8 m relaxation
    # against the 1.0 m already reviewed at 3.0 m (PR #8), so it is the STRICTLY
    # SMALLER concession. Marstal reconnects at <= 2.3 m either way - MEASURED
    # by this script's own descending sweep, which prints "marstal 2.3 m" in the
    # deepest-connecting-gate table, so the threshold is re-derived on every run
    # rather than remembered here.
    #
    # Control, run before this entry existed: with the Elan in the catalogue and
    # this row absent, the script exits 1 with "CONNECTIVITY marstal snap
    # (54.8579,10.528) not reachable from open water at gate depth 2.8 m (boat
    # elan-444, derived gate 2.8 m)". augustenborg needs no 2.8 m entry - it
    # reaches open water at exactly 2.8 m unaided, at 0.0 m of margin.
    ("marstal", 2.8): 2.0,
}

# Harbors investigated and confirmed disconnected at every gate depth this
# mask can offer - NOT a depth problem an exception could fix (see PR #8's
# report for the per-harbor evidence). Listing them here means a run against
# the shipped mask exits 0: a harbor in this map that's STILL disconnected
# is a known, already-tracked limitation, not a new regression, so it's
# reported but doesn't fail the build. To keep this list honest as the data
# improves, the gate below also fails the run if a listed harbor turns out
# to be connected - that means the entry is stale and must be removed.
#
# #54 spec C.6: NOT keyed by gate, deliberately, and the entries are strictly
# stronger for it. The claim each one makes is "disconnected at EVERY gate",
# and DEEPEST_CONNECTING_GATE_M below MEASURES that across the whole decimetre
# range the mask can express - so the stale check fires for any boat's gate,
# present or future, instead of only the ones somebody remembered to key.
# Gate-keying these would need one duplicate entry per catalogue gate and would
# still only cover the gates listed.
KNOWN_DISCONNECTED: dict[str, str] = {
    "arnis": "Schlei fairway ribbon narrower than EMODnet native resolution - issue #9",
    "kappeln": "Schlei fairway ribbon narrower than EMODnet native resolution - issue #9",
    "maasholm": "Schlei fairway ribbon narrower than EMODnet native resolution - issue #9",
    "dyvig": "~30 m buoyed channel narrower than one 46 m cell - issue #9",
    "graasten": "Egernsund bascule bridge deck land-rasterized - issue #9",
}

# ---- Per-boat expected-unreachable harbours (#1294, spec 1135 section 13 item 5) ----
# KNOWN_DISCONNECTED above means "unreachable at EVERY gate this mask can
# express" - a data limitation, boat-independent. This table is the
# boat-SPECIFIC counterpart: a harbour that a shallower boat reaches fine but
# THIS boat's own derived gate cuts off, because the boat's draft genuinely
# cannot get there - not a data defect. Prerequisite for #573 landing a
# deep-draft hull without every one of its stranded harbours reading as a
# mask regression.
#
# Keyed by BOAT id (not by gate, unlike CONNECTIVITY_EXCEPTIONS_M): an entry
# says nothing about any other boat. Checked for EXACTNESS below (both
# directions enforced in the per-boat loop) - a harbour genuinely unreachable
# for a boat that is NOT listed here fails as an undocumented regression, and
# a LISTED harbour that turns out reachable at that boat's gate fails as a
# stale entry. So an omitted boat is not a loophole: it commits that boat to
# reaching every harbour it does today.
EXPECTED_UNREACHABLE_BY_BOAT: dict[str, list[str]] = {
    # EASY GO! (#1575, 2.59 m draft, gate 3.5 m). Snap-aware verdicts (#1584):
    # the picker reads augustenborg and marstal unreachable and faldsled and
    # rudkoebing shallow-approach (reachable only through a relaxed approach).
    "salona-44-easy-go": [
        "augustenborg",
        "faldsled",
        "marstal",
        "rudkoebing",
    ],
}

# Flag any harbor whose snap cell clears its own gate by less than this. A
# binary gate cannot see a harbor that passes with nothing to spare, and two
# already do (#245 section 2.3, #455 section 3.4).
SNAP_MARGIN_FLOOR_M = 0.2

FOUR_CONNECTIVITY = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8)
_depth_grid = np.where(grid == 255, 25.4, np.where(grid == 0, 0.0, grid / 10.0))

seed_row, seed_col = rc_of(SEED_LAT, SEED_LON)
harbor_rc = {h["id"]: rc_of(h["snap"]["lat"], h["snap"]["lon"]) for h in harbors}
harbor_snap_depth_m = {h["id"]: depth_m(h["snap"]["lat"], h["snap"]["lon"]) for h in harbors}

# #1584: the app does not test a harbor's exact snap cell - `planRoute` and the
# picker first move it to the nearest navigable cell centre within 300 m
# (app/src/lib/mask.ts `snapToNavigable`, same ring walk, tie-break and
# distance formula), and only that cell must reach open water. Twin of that
# method; app/src/test/verifyMaskConnectivity.test.ts calls the real one.
SNAP_MAX_RADIUS_M = 300
EARTH_RADIUS_NM = 3440.065  # app/src/lib/geo.ts
NM_PER_M = 1 / 1852  # app/src/lib/mask.ts


def haversine_nm(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    d_lat = math.radians(b_lat - a_lat)
    d_lon = math.radians(b_lon - a_lon)
    s = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(d_lon / 2) ** 2
    )
    return 2 * EARTH_RADIUS_NM * math.asin(math.sqrt(s))


def snap_cell(byte_grid: np.ndarray, lat: float, lon: float, gate_m: float) -> tuple[int, int] | None:
    """Nearest cell with byte != 0 and depth >= gate_m whose centre is within
    SNAP_MAX_RADIUS_M of (lat, lon); None when there is none. Every ring up to
    max_ring is scanned, so the result is the true nearest. Ties keep the first
    cell in ring, then row-major order, as the app does."""
    rows, cols = byte_grid.shape
    row0, col0 = rc_of(lat, lon)
    cell_lat_m = 111_320 / LAT_CPD
    cell_lon_m = 111_320 / LON_CPD * math.cos(math.radians(lat))
    min_step_m = min(cell_lat_m, cell_lon_m)
    max_ring = math.ceil(SNAP_MAX_RADIUS_M / min_step_m) + 1
    best: tuple[int, int] | None = None
    best_d = 0.0
    for ring in range(max_ring + 1):
        for dr in range(-ring, ring + 1):
            for dc in range(-ring, ring + 1):
                if max(abs(dr), abs(dc)) != ring:
                    continue
                r, c = row0 + dr, col0 + dc
                if not (0 <= r < rows and 0 <= c < cols):
                    continue
                b = int(byte_grid[r, c])
                if b == 0 or (25.4 if b == 255 else b / 10.0) < gate_m:
                    continue
                centre_lat = meta["south"] + (r + 0.5) / LAT_CPD
                centre_lon = meta["west"] + (c + 0.5) / LON_CPD
                d_m = haversine_nm(lat, lon, centre_lat, centre_lon) / NM_PER_M
                if d_m <= SNAP_MAX_RADIUS_M and (best is None or d_m < best_d):
                    best, best_d = (r, c), d_m
    return best


def _snap_cell_reference(
    byte_grid: np.ndarray,
    lat: float,
    lon: float,
    gate_m: float,
    early_break: bool = False,
    ties_last: bool = False,
) -> tuple[int, int] | None:
    """True-nearest oracle, independent of snap_cell's ring walk and ring bound:
    every cell in a window well past the radius, nearest within range wins, ties
    to the first in ring then row-major order. `early_break=True` restates the
    pre-#1609 walk (stop at the first ring whose `ring * step` exceeds the best
    so far) and `ties_last=True` flips the tie-break; they are the two mutants
    the self-check below must tell apart from the real rule."""
    row0, col0 = rc_of(lat, lon)
    reach = 12
    cands: list[tuple[float, int, int, int]] = []
    for dr in range(-reach, reach + 1):
        for dc in range(-reach, reach + 1):
            r, c = row0 + dr, col0 + dc
            if not (0 <= r < byte_grid.shape[0] and 0 <= c < byte_grid.shape[1]):
                continue
            b = int(byte_grid[r, c])
            if b == 0 or (25.4 if b == 255 else b / 10.0) < gate_m:
                continue
            d_m = (
                haversine_nm(lat, lon, meta["south"] + (r + 0.5) / LAT_CPD, meta["west"] + (c + 0.5) / LON_CPD)
                / NM_PER_M
            )
            if d_m <= SNAP_MAX_RADIUS_M:
                cands.append((d_m, max(abs(dr), abs(dc)), dr, dc))
    sign = -1 if ties_last else 1
    if early_break:
        step_m = min(111_320 / LAT_CPD, 111_320 / LON_CPD * math.cos(math.radians(lat)))
        best: tuple[float, int, int, int] | None = None
        for ring in sorted({t[1] for t in cands}):
            if best is not None and ring * step_m > best[0]:
                break
            ring_best = min((t for t in cands if t[1] == ring), key=lambda t: (t[0], t[2], t[3]))
            if best is None or ring_best[0] < best[0]:
                best = ring_best
    else:
        best = min(cands, key=lambda t: (t[0], sign * t[1], sign * t[2], sign * t[3]), default=None)
    return None if best is None else (row0 + best[2], col0 + best[3])


# Self-check of snap_cell against _snap_cell_reference on a synthetic all-land
# grid seeded with a few navigable cells, probed at sub-cell positions around
# every harbor and on exact cell centres, corners and edge midpoints (where
# mirrored cells tie on distance). The positive controls prove the cases reach
# what each mutant would break: a snap, a None, a nearer cell in a farther ring
# that the pre-#1609 early break would skip, and a distance tie.
_snap_rng = np.random.default_rng(1584)
_snap_grid = np.zeros_like(grid)
_snap_cases = {"snap": 0, "none": 0, "early_break": 0, "tie": 0}


def _snap_selfcheck_case(lat: float, lon: float, cells: list[tuple[int, int]]) -> None:
    for r, c in cells:
        _snap_grid[r, c] = 40
    try:
        got = snap_cell(_snap_grid, lat, lon, 3.0)
        want = _snap_cell_reference(_snap_grid, lat, lon, 3.0)
        if got != want:
            raise AssertionError(f"snap_cell {got} != the true nearest {want} at ({lat}, {lon}), cells {cells}")
        _snap_cases["snap" if want is not None else "none"] += 1
        if want != _snap_cell_reference(_snap_grid, lat, lon, 3.0, early_break=True):
            _snap_cases["early_break"] += 1
        if want != _snap_cell_reference(_snap_grid, lat, lon, 3.0, ties_last=True):
            _snap_cases["tie"] += 1
    finally:
        for r, c in cells:
            _snap_grid[r, c] = 0


def _axis_edge(i: float, lo: float, cpd: int) -> float:
    return lo + i / cpd


for _h in harbors:
    _r0, _c0 = rc_of(_h["snap"]["lat"], _h["snap"]["lon"])
    if not (20 <= _r0 < meta["rows"] - 20 and 20 <= _c0 < meta["cols"] - 20):
        raise AssertionError(f"snap_cell self-check window leaves the grid at harbor {_h['id']}")
    for _ in range(40):
        _lat = _axis_edge(_r0 + _snap_rng.random(), meta["south"], LAT_CPD)
        _lon = _axis_edge(_c0 + _snap_rng.random(), meta["west"], LON_CPD)
        _cells = {
            (_r0 + int(a), _c0 + int(b)) for a, b in _snap_rng.integers(-9, 10, size=(int(_snap_rng.integers(0, 5)), 2))
        }
        _snap_selfcheck_case(_lat, _lon, sorted(_cells))
    # (lat offset, lon offset) in cells: centre, corner, and the two edge midpoints.
    for _lat_off, _lon_off in ((0.5, 0.5), (0.0, 0.0), (0.0, 0.5), (0.5, 0.0)):
        for _ in range(10):
            _a, _b = (int(v) for v in _snap_rng.integers(0, 7, size=2))
            _rows = {_r0 - 1 - _a, _r0 + _a} if _lat_off == 0.0 else {_r0 - _a, _r0 + _a}
            _cols = {_c0 - 1 - _b, _c0 + _b} if _lon_off == 0.0 else {_c0 - _b, _c0 + _b}
            _snap_selfcheck_case(
                _axis_edge(_r0 + _lat_off, meta["south"], LAT_CPD),
                _axis_edge(_c0 + _lon_off, meta["west"], LON_CPD),
                sorted((r, c) for r in _rows for c in _cols),
            )
for _name, _count in _snap_cases.items():
    if _count == 0:
        raise AssertionError(f"snap_cell self-check never exercised '{_name}': {_snap_cases}")
print(f"snap_cell self-check vs the true-nearest oracle: {_snap_cases}")

# Deepest gate at which each harbor's EXACT snap cell still reaches open water,
# or None if it never does. Deliberately not snap-aware (#1584): it backs the
# KNOWN_DISCONNECTED claim "disconnected at every gate", and the snapped cell
# changes with the gate, so snap-aware connectivity is not monotone in it.
# Spec C.6 asks the verify script's output to carry a per-harbor
# navigable-gate figure so a boat picker can mark unreachable harbors per boat
# instead of failing at plan time with snap-failed-destination.
#
# ONE descending pass over the decimetre scale, labelling each gate exactly
# once and dropping the array before the next, so peak memory is one label grid
# rather than one per gate visited. Retaining them cost 2,338,768 KB against
# BASE's 171,988 KB (measured with /usr/bin/time -v on this checkout), which is
# past what a 2 GB container can run the mask verifier in at all.
#
# Monotonicity does the rest: the navigable set only grows as the gate falls,
# so the FIRST gate at which a harbor reaches the seed on the way down is the
# deepest one, and every later "is it connected at G" question is answered by
# comparing G against that number instead of labelling again.
#
# The top of the sweep is the deepest snap cell, an exact bound rather than a
# chosen cap: above it the snap cell is itself not navigable, so no component
# can contain it. Raised to cover any catalogue gate deeper than every snap
# cell, which would otherwise fall outside the sweep and have no answer.
SWEEP_TOP_DM = max([dm(d) for d in harbor_snap_depth_m.values()] + sorted(CATALOGUE_GATE_DM))
DEEPEST_CONNECTING_GATE_DM: dict[str, int | None] = {h["id"]: None for h in harbors}
SEED_COMPONENT_CELLS: dict[int, int] = {}  # only at the gates a catalogue boat derives
# #1584: the snap-aware verdict per harbor at each gate a boat derives or an
# exception grants: (snapped cell, in the seed component). None = no navigable
# cell within SNAP_MAX_RADIUS_M.
SNAP_GATES_DM = CATALOGUE_GATE_DM | {dm(v) for v in CONNECTIVITY_EXCEPTIONS_M.values()}
SNAP_CONNECTED: dict[tuple[str, int], tuple[tuple[int, int] | None, bool]] = {}
_unresolved = set(DEEPEST_CONNECTING_GATE_DM)
for _gate_dm in range(SWEEP_TOP_DM, 0, -1):
    _labeled, _ = ndimage.label(_depth_grid >= _gate_dm / 10.0, structure=FOUR_CONNECTIVITY)
    _seed_label = int(_labeled[seed_row, seed_col])
    if _gate_dm in SNAP_GATES_DM:
        for _h in harbors:
            _cell = snap_cell(grid, _h["snap"]["lat"], _h["snap"]["lon"], _gate_dm / 10.0)
            SNAP_CONNECTED[(_h["id"], _gate_dm)] = (
                _cell,
                _cell is not None and _seed_label != 0 and int(_labeled[_cell]) == _seed_label,
            )
    if _gate_dm in CATALOGUE_GATE_DM:
        SEED_COMPONENT_CELLS[_gate_dm] = int((_labeled == _seed_label).sum()) if _seed_label else 0
    if _seed_label:
        for _hid in sorted(_unresolved):
            _row, _col = harbor_rc[_hid]
            if int(_labeled[_row, _col]) == _seed_label:
                DEEPEST_CONNECTING_GATE_DM[_hid] = _gate_dm
                _unresolved.discard(_hid)
    del _labeled

DEEPEST_CONNECTING_GATE_M: dict[str, float | None] = {
    hid: None if d is None else d / 10.0 for hid, d in DEEPEST_CONNECTING_GATE_DM.items()
}


def snap_connected_at(hid: str, gate_m: float) -> bool:
    """#1584: does the cell the app snaps this harbor to at `gate_m` reach open water."""
    return SNAP_CONNECTED[(hid, dm(gate_m))][1]


print(f"mask tolerance: TOLERANCE_M = {TOLERANCE_M} m (read from build_mask.py)")
print(f"catalogue: {len(CATALOGUE_BOATS)} boat(s)")
for b in CATALOGUE_BOATS:
    print(f"  {b['id']} ({b['name']}): draft {b['draftM']:.2f} m -> derived gate {b['gateM']:.1f} m")

# An exception keyed to a gate no catalogue boat derives is dead configuration:
# it silently applies to nothing while still reading as justification.
for (hid, exc_gate_m), exc_m in CONNECTIVITY_EXCEPTIONS_M.items():
    if dm(exc_gate_m) not in CATALOGUE_GATE_DM:
        failures.append(
            f"EXCEPTION {hid} is keyed to a {exc_gate_m} m gate that no catalogue boat derives "
            f"(catalogue gates: {sorted(g / 10.0 for g in CATALOGUE_GATE_DM)}) - remove the stale entry "
            "or add the boat it was written for"
        )
    if exc_m >= exc_gate_m:
        failures.append(
            f"EXCEPTION {hid} at gate {exc_gate_m} m is {exc_m} m, which does not lower the gate - "
            "an exception that matches or raises its own gate is a no-op"
        )

for hid, reason in KNOWN_DISCONNECTED.items():
    if hid not in DEEPEST_CONNECTING_GATE_M:
        failures.append(
            f"KNOWN_DISCONNECTED lists {hid}, which is not a harbor in harbors.json - remove the stale entry"
        )
    elif DEEPEST_CONNECTING_GATE_M[hid] is not None:
        failures.append(
            f"KNOWN_DISCONNECTED {hid} ({reason}) reaches open water at gate {DEEPEST_CONNECTING_GATE_M[hid]} m - "
            "the entry claims it is disconnected at every gate and it is not; remove it"
        )


# #1294: EXPECTED_UNREACHABLE_BY_BOAT structural validation - boat id and
# harbour id must be real, and a harbour already boat-independently
# KNOWN_DISCONNECTED needs no per-boat entry too. The stronger EXACTNESS
# checks (does the boat actually fail to reach it, is a listed harbour still
# genuinely unreachable) run per-boat below, where the effective gate is known.
#
# Extracted to a pure function (#1318) so the three rejections are each
# independently mutation-provable against a synthetic fixture, mirrored by
# app/src/test/verifyMaskConnectivity.test.ts's TS twin.
def structural_failures(
    table: dict[str, list[str]],
    catalogue_ids: set[str],
    harbour_ids: set[str],
    known_disconnected,
) -> list[str]:
    out: list[str] = []
    for bid, hids in table.items():
        if bid not in catalogue_ids:
            out.append(
                f"EXPECTED_UNREACHABLE_BY_BOAT lists boat '{bid}', which is not in the catalogue "
                "(polars-source.json) - remove the stale entry or add the boat"
            )
        for hid in hids:
            if hid not in harbour_ids:
                out.append(
                    f"EXPECTED_UNREACHABLE_BY_BOAT['{bid}'] lists '{hid}', which is not a harbor in "
                    "harbors.json - remove the stale entry"
                )
            elif hid in known_disconnected:
                out.append(
                    f"EXPECTED_UNREACHABLE_BY_BOAT['{bid}'] lists '{hid}', which is already in "
                    "KNOWN_DISCONNECTED (disconnected at every gate, boat-independent) - remove the "
                    "redundant per-boat entry"
                )
    return out


# Self-check, same style as GATE_DERIVATION_CASES: a synthetic fixture, never
# the real EXPECTED_UNREACHABLE_BY_BOAT table, so each of the three
# rejections is exercised independently of what today's table happens to hold.
STRUCTURAL_CASES: list[tuple[str, dict[str, list[str]], set[str], set[str], set[str], int]] = [
    ("accept", {"good-boat": ["good-harbor"]}, {"good-boat"}, {"good-harbor"}, set(), 0),
    ("unknown boat", {"ghost-boat": ["good-harbor"]}, {"good-boat"}, {"good-harbor"}, set(), 1),
    ("unknown harbour", {"good-boat": ["ghost-harbor"]}, {"good-boat"}, {"good-harbor"}, set(), 1),
    ("known-disconnected overlap", {"good-boat": ["sunk-harbor"]}, {"good-boat"}, {"sunk-harbor"}, {"sunk-harbor"}, 1),
]
for _label, _table, _cat_ids, _harb_ids, _known, _want in STRUCTURAL_CASES:
    _got = len(structural_failures(_table, _cat_ids, _harb_ids, _known))
    # #613: was a bare `assert` (stripped under -O/PYTHONOPTIMIZE). Unconditional
    # so a disabled rejection cannot silently pass its own self-check.
    if _got != _want:
        raise AssertionError(f"structural_failures[{_label}]: expected {_want} failure(s), got {_got}")

failures.extend(
    structural_failures(
        EXPECTED_UNREACHABLE_BY_BOAT,
        CATALOGUE_BOAT_IDS,
        set(DEEPEST_CONNECTING_GATE_M),
        KNOWN_DISCONNECTED,
    )
)

# #652: harbors.json's `knownDisconnected` field (build_harbors.mjs, sourced
# from this same KNOWN_DISCONNECTED dict) must name EXACTLY these ids - the
# harbor picker discloses it before a solve, so a stale field would either
# wrongly warn a harbor that has since become reachable, or worse, stay
# silent on one that is genuinely still disconnected. build_harbors.mjs
# parses this dict independently rather than hand-copying it, so this check
# is what catches the two artifacts drifting apart - e.g. a
# KNOWN_DISCONNECTED edit whose `npm --prefix pipeline run harbors` re-run
# was skipped. app/src/test/harborKnownDisconnected.test.ts promotes the
# same comparison into the REQUIRED `app` Vitest suite (this job is
# advisory, not required - see CLAUDE.md's "Python gates live OUTSIDE the
# app toolchain" bullet).
for h in harbors:
    flagged = h.get("knownDisconnected", False)
    should_flag = h["id"] in KNOWN_DISCONNECTED
    if flagged != should_flag:
        failures.append(
            f"harbors.json knownDisconnected={flagged} for {h['id']}, but KNOWN_DISCONNECTED "
            f"membership is {should_flag} - run `npm --prefix pipeline run harbors` to regenerate"
        )

for b in CATALOGUE_BOATS:
    gate_m = b["gateM"]
    print(f"\n=== {b['id']}: derived gate {gate_m:.1f} m (draft {b['draftM']:.2f} m + tolerance {TOLERANCE_M} m) ===")
    seed_cells = SEED_COMPONENT_CELLS[dm(gate_m)]
    # #613: was a bare `assert` (stripped under -O/PYTHONOPTIMIZE). Without
    # this, a bad connectivity seed would silently produce a false
    # "disconnected" verdict for every harbor at this gate.
    if seed_cells == 0:
        raise AssertionError(f"connectivity seed ({SEED_LAT},{SEED_LON}) is not itself navigable at {gate_m} m")
    print(f"open-water seed component: {seed_cells} cells at >= {gate_m} m")

    expected_unreachable = set(EXPECTED_UNREACHABLE_BY_BOAT.get(b["id"], []))
    connectivity_report = []
    for h in harbors:
        hid = h["id"]
        exception_m = CONNECTIVITY_EXCEPTIONS_M.get((hid, gate_m))
        if exception_m is not None:
            # #613: was a bare `assert` (stripped under -O/PYTHONOPTIMIZE),
            # which would silently allow an undocumented depth exception.
            if "approachNote" not in h:
                raise AssertionError(f"CONNECTIVITY_EXCEPTIONS_M[({hid}, {gate_m})] has no approachNote to justify it")
            if snap_connected_at(hid, gate_m):
                failures.append(
                    f"EXCEPTION {hid} is not needed at gate {gate_m} m - it reaches open water unaided; "
                    "remove the stale entry"
                )
        effective_gate_m = exception_m if exception_m is not None else gate_m
        connected = snap_connected_at(hid, effective_gate_m)

        if connected:
            status = "OK"
            if hid in KNOWN_DISCONNECTED:
                status = "FAIL"
                failures.append(
                    f"CONNECTIVITY {hid} is now connected at gate depth {effective_gate_m} m but is still listed "
                    f"in KNOWN_DISCONNECTED ({KNOWN_DISCONNECTED[hid]}) - remove the stale entry"
                )
            elif hid in expected_unreachable:
                # #1294 EXACTNESS, stale direction: the entry claims this
                # boat cannot reach {hid} and it can - the entry no longer
                # documents reality.
                status = "FAIL"
                failures.append(
                    f"EXPECTED_UNREACHABLE_BY_BOAT['{b['id']}'] lists {hid} but it reaches open water at "
                    f"gate {effective_gate_m} m for this boat - remove the stale entry"
                )
        elif hid in KNOWN_DISCONNECTED:
            status = "KNOWN"
        elif hid in expected_unreachable:
            # #1294 EXACTNESS, accept direction: a per-boat expected gap, not
            # a data defect - this is the only status EXPECTED_UNREACHABLE_BY_BOAT
            # entries can produce without an accompanying failure.
            status = "EXPECT"
        else:
            status = "FAIL"
            failures.append(
                f"CONNECTIVITY {hid} snap ({h['snap']['lat']},{h['snap']['lon']}) not reachable from open "
                f"water at gate depth {effective_gate_m} m (boat {b['id']}, derived gate {gate_m} m) - "
                "add an EXPECTED_UNREACHABLE_BY_BOAT entry if this boat's draft genuinely cannot reach it"
            )
        connectivity_report.append((hid, effective_gate_m, exception_m is not None, status))

    n_connected = sum(1 for _, _, _, status in connectivity_report if status == "OK")
    n_known = sum(1 for _, _, _, status in connectivity_report if status == "KNOWN")
    n_expected = sum(1 for _, _, _, status in connectivity_report if status == "EXPECT")
    n_exceptions = sum(1 for _, _, is_exc, status in connectivity_report if status == "OK" and is_exc)
    print(
        f"connectivity: {n_connected}/{len(connectivity_report)} harbors reach open water "
        f"({n_exceptions} via exception, {n_known} known-disconnected and tracked, "
        f"{n_expected} expected-unreachable for this boat)"
    )
    for hid, effective_gate_m, is_exc, status in connectivity_report:
        exc = f" (exception @ {effective_gate_m} m)" if is_exc and status == "OK" else ""
        known = f" [{KNOWN_DISCONNECTED[hid]}]" if hid in KNOWN_DISCONNECTED else ""
        print(f"  {status:6} {hid}{exc}{known}")

    # Snap-cell margin. A harbor can pass the binary gate above with nothing to
    # spare; aabenraa and augustenborg both do, at exactly 0.0 m. Reported, not
    # failed - the margin is a property of the bathymetry, and #245 measured
    # that refining the grid DISCONNECTS these two rather than helping them
    # (aabenraa at 23 m, augustenborg additionally at 12 m).
    snapped_depth_m = {
        hid: float(_depth_grid[cell]) if (cell := SNAP_CONNECTED[(hid, dm(eff))][0]) is not None else 0.0
        for hid, eff, _, _ in connectivity_report
    }
    margins = [
        (hid, snapped_depth_m[hid], eff, round(snapped_depth_m[hid] - eff, 1))
        for hid, eff, _, status in connectivity_report
        if status not in ("KNOWN", "EXPECT")
    ]
    low = [m for m in margins if m[3] < SNAP_MARGIN_FLOOR_M]
    print(f"snap-cell margin below {SNAP_MARGIN_FLOOR_M} m: {len(low)} of {len(margins)} scanned harbors")
    # #552 / spec §K: "each harbour's snap-cell margin", unconditionally — the
    # loop below used to print ONLY the entries under SNAP_MARGIN_FLOOR_M, so
    # a harbor with a healthy margin never appeared in the report at all.
    for hid, snap_m, eff_gate_m, margin_m in sorted(margins, key=lambda m: m[3]):
        flag = "LOW  " if margin_m < SNAP_MARGIN_FLOOR_M else "OK   "
        print(f"  {flag} {hid:16} snap {snap_m:.1f} m  gate {eff_gate_m:.1f} m  margin {margin_m:+.1f} m")

# Boat-independent, so printed once: what each harbor's connectivity ceiling
# actually is, rather than only whether it clears today's gates.
print("\ndeepest gate at which each harbor's EXACT snap cell still reaches open water (not the app's 300 m snap):")
for h in harbors:
    hid = h["id"]
    deepest = DEEPEST_CONNECTING_GATE_M[hid]
    shown = "none" if deepest is None else f"{deepest:.1f} m"
    print(f"  {hid:16} {shown:>7}  (exact snap cell {harbor_snap_depth_m[hid]:.1f} m)")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} mask probe failures")
print(f"\nall probes OK ({len(WATER_PROBES)} water, {len(LAND_PROBES)} land, {len(harbors)} harbor snaps)")
