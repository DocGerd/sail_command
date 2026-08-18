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


def rc_of(lat: float, lon: float) -> tuple[int, int]:
    row = int((lat - meta["south"]) / (meta["north"] - meta["south"]) * meta["rows"])
    col = int((lon - meta["west"]) / (meta["east"] - meta["west"]) * meta["cols"])
    assert 0 <= row < meta["rows"] and 0 <= col < meta["cols"], f"probe {lat},{lon} maps outside the mask grid"
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
]
LAND_PROBES = [
    ("Flensburg city", 54.79, 9.42),
    ("Als island center", 54.95, 9.85),
    ("Aeroe center", 54.87, 10.35),
    ("Langeland center", 54.90, 10.75),
    ("Angeln inland", 54.70, 9.70),
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
]
for _draft_m, _gate_m in GATE_DERIVATION_CASES:
    _got = default_gate_m(_draft_m)
    assert _got == _gate_m, f"gate derivation drifted: draft {_draft_m} m -> {_got} m, expected {_gate_m} m"


def dm(x: float) -> int:
    """Decimetre key for a value that is ALREADY a whole decimetre.

    The round() here is NOT quantising - that is ceil_to_decimetre's job two
    functions up, and must never be a round. It only turns a float the assert
    has already bounded to within 1e-6 of an integer into that integer, where
    int() would truncate 29.9999999 to 29. The assert is what keeps the two
    roles from being confused: hand this a half-decimetre and banker's rounding
    would key it to the nearest even one silently, so it aborts instead.
    """
    tenths = x * 10
    key = int(round(tenths))
    assert abs(tenths - key) < 1e-6, (
        f"{x} m is not a whole decimetre - the mask encodes decimetres and every gate must be one"
    )
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

# ---- Connectivity gate (issue #6) ----
# A harbor snap can sit on an individually-navigable cell (checked above) yet
# still be cut off from open water by land/depth artifacts elsewhere on the
# grid - that was exactly issue #6 (14/44 harbors, incl. Flensburg, stranded
# in disconnected pockets despite passing the per-cell probe). This gate
# 4-connected-flood-fills the navigable cells from a fixed open-water seed
# and asserts every harbor snap's cell is reachable. 4-connectivity (not 8)
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
    # "Buoyed fairway up Augustenborg Fjord, approx 3 m in the upper
    # reaches." Reconnects at gate <= 2.8 m; matches the approx-3 m note.
    ("augustenborg", 3.0): 2.8,
    # "Buoyed approaches approx 3.2 m (N and W), 4.5 m from S; parts of the
    # yacht basin only approx 2 m." Reconnects at gate <= 2.3 m; 2.0 m is
    # the harbor's own documented figure for its shallowest reach and keeps
    # a safety margin below the measured 2.3 m threshold.
    ("marstal", 3.0): 2.0,
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

# Flag any harbor whose snap cell clears its own gate by less than this. A
# binary gate cannot see a harbor that passes with nothing to spare, and two
# already do (#245 section 2.3, #455 section 3.4).
SNAP_MARGIN_FLOOR_M = 0.2

FOUR_CONNECTIVITY = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8)
_depth_grid = np.where(grid == 255, 25.4, np.where(grid == 0, 0.0, grid / 10.0))

seed_row, seed_col = rc_of(SEED_LAT, SEED_LON)
harbor_rc = {h["id"]: rc_of(h["snap"]["lat"], h["snap"]["lon"]) for h in harbors}
harbor_snap_depth_m = {h["id"]: depth_m(h["snap"]["lat"], h["snap"]["lon"]) for h in harbors}

# Deepest gate at which each harbor still reaches open water, or None if it
# never does. Spec C.6 asks the verify script's output to carry a per-harbor
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
_unresolved = set(DEEPEST_CONNECTING_GATE_DM)
for _gate_dm in range(SWEEP_TOP_DM, 0, -1):
    _labeled, _ = ndimage.label(_depth_grid >= _gate_dm / 10.0, structure=FOUR_CONNECTIVITY)
    _seed_label = int(_labeled[seed_row, seed_col])
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


def connected_at(hid: str, gate_m: float) -> bool:
    """Answered from the sweep above, not by labelling again.

    Same predicate as before the sweep existed - harbor and seed in one
    non-zero component - restated through monotonicity. A harbor connected at
    its deepest gate is connected at every shallower one, so `<=` against that
    number IS the connectivity test.
    """
    deepest_dm = DEEPEST_CONNECTING_GATE_DM[hid]
    return deepest_dm is not None and dm(gate_m) <= deepest_dm


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

for b in CATALOGUE_BOATS:
    gate_m = b["gateM"]
    print(f"\n=== {b['id']}: derived gate {gate_m:.1f} m (draft {b['draftM']:.2f} m + tolerance {TOLERANCE_M} m) ===")
    seed_cells = SEED_COMPONENT_CELLS[dm(gate_m)]
    assert seed_cells != 0, f"connectivity seed ({SEED_LAT},{SEED_LON}) is not itself navigable at {gate_m} m"
    print(f"open-water seed component: {seed_cells} cells at >= {gate_m} m")

    connectivity_report = []
    for h in harbors:
        hid = h["id"]
        exception_m = CONNECTIVITY_EXCEPTIONS_M.get((hid, gate_m))
        if exception_m is not None:
            assert "approachNote" in h, (
                f"CONNECTIVITY_EXCEPTIONS_M[({hid}, {gate_m})] has no approachNote to justify it"
            )
            if connected_at(hid, gate_m):
                failures.append(
                    f"EXCEPTION {hid} is not needed at gate {gate_m} m - it reaches open water unaided; "
                    "remove the stale entry"
                )
        effective_gate_m = exception_m if exception_m is not None else gate_m
        connected = connected_at(hid, effective_gate_m)

        if connected:
            status = "OK"
            if hid in KNOWN_DISCONNECTED:
                status = "FAIL"
                failures.append(
                    f"CONNECTIVITY {hid} is now connected at gate depth {effective_gate_m} m but is still listed "
                    f"in KNOWN_DISCONNECTED ({KNOWN_DISCONNECTED[hid]}) - remove the stale entry"
                )
        elif hid in KNOWN_DISCONNECTED:
            status = "KNOWN"
        else:
            status = "FAIL"
            failures.append(
                f"CONNECTIVITY {hid} snap ({h['snap']['lat']},{h['snap']['lon']}) not reachable from open "
                f"water at gate depth {effective_gate_m} m (boat {b['id']}, derived gate {gate_m} m)"
            )
        connectivity_report.append((hid, effective_gate_m, exception_m is not None, status))

    n_connected = sum(1 for _, _, _, status in connectivity_report if status == "OK")
    n_known = sum(1 for _, _, _, status in connectivity_report if status == "KNOWN")
    n_exceptions = sum(1 for _, _, is_exc, status in connectivity_report if status == "OK" and is_exc)
    print(
        f"connectivity: {n_connected}/{len(connectivity_report)} harbors reach open water "
        f"({n_exceptions} via exception, {n_known} known-disconnected and tracked)"
    )
    for hid, effective_gate_m, is_exc, status in connectivity_report:
        exc = f" (exception @ {effective_gate_m} m)" if is_exc and status == "OK" else ""
        known = f" [{KNOWN_DISCONNECTED[hid]}]" if hid in KNOWN_DISCONNECTED else ""
        print(f"  {status:5} {hid}{exc}{known}")

    # Snap-cell margin. A harbor can pass the binary gate above with nothing to
    # spare; aabenraa and augustenborg both do, at exactly 0.0 m. Reported, not
    # failed - the margin is a property of the bathymetry, and #245 measured
    # that refining the grid DISCONNECTS these two rather than helping them
    # (aabenraa at 23 m, augustenborg additionally at 12 m).
    margins = [
        (hid, harbor_snap_depth_m[hid], eff, round(harbor_snap_depth_m[hid] - eff, 1))
        for hid, eff, _, status in connectivity_report
        if status != "KNOWN"
    ]
    low = [m for m in margins if m[3] < SNAP_MARGIN_FLOOR_M]
    print(f"snap-cell margin below {SNAP_MARGIN_FLOOR_M} m: {len(low)} of {len(margins)} scanned harbors")
    for hid, snap_m, eff_gate_m, margin_m in sorted(low, key=lambda m: m[3]):
        print(f"  LOW   {hid:16} snap {snap_m:.1f} m  gate {eff_gate_m:.1f} m  margin {margin_m:+.1f} m")

# Boat-independent, so printed once: what each harbor's connectivity ceiling
# actually is, rather than only whether it clears today's gates.
print("\ndeepest gate at which each harbor still reaches open water:")
for h in harbors:
    hid = h["id"]
    deepest = DEEPEST_CONNECTING_GATE_M[hid]
    shown = "none" if deepest is None else f"{deepest:.1f} m"
    print(f"  {hid:16} {shown:>7}  (snap cell {harbor_snap_depth_m[hid]:.1f} m)")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} mask probe failures")
print(f"\nall probes OK ({len(WATER_PROBES)} water, {len(LAND_PROBES)} land, {len(harbors)} harbor snaps)")
