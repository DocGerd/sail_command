"""#1503: first pytest coverage for pipeline/build_mask.py — check_dtm_covers.

check_dtm_covers(bounds, res) raises SystemExit unless the raster extent
(rasterio's bounds order: left, bottom, right, top) covers the mask bbox
(WEST, SOUTH, EAST, NORTH), with half a source pixel of slack per axis
(tol_x, tol_y = abs(res[0]) / 2, abs(res[1]) / 2). The comparison is strict
(`>` / `<`), so a bound sitting exactly on the tolerance boundary passes.
"""

import pytest

from build_mask import EAST, NORTH, SOUTH, WEST, check_dtm_covers

RES = (0.008, 0.006)
TOL_X, TOL_Y = RES[0] / 2, RES[1] / 2
OVER = 0.001  # more than half a pixel of shortfall on the failing sides


def test_exact_bbox_passes():
    check_dtm_covers((WEST, SOUTH, EAST, NORTH), RES)


def test_within_half_pixel_slack_passes():
    bounds = (WEST + TOL_X, SOUTH + TOL_Y, EAST - TOL_X, NORTH - TOL_Y)
    check_dtm_covers(bounds, RES)


def test_west_short_by_more_than_half_pixel_raises():
    bounds = (WEST + TOL_X + OVER, SOUTH, EAST, NORTH)
    with pytest.raises(SystemExit):
        check_dtm_covers(bounds, RES)


def test_south_short_by_more_than_half_pixel_raises():
    bounds = (WEST, SOUTH + TOL_Y + OVER, EAST, NORTH)
    with pytest.raises(SystemExit):
        check_dtm_covers(bounds, RES)


def test_east_short_by_more_than_half_pixel_raises():
    bounds = (WEST, SOUTH, EAST - TOL_X - OVER, NORTH)
    with pytest.raises(SystemExit):
        check_dtm_covers(bounds, RES)


def test_north_short_by_more_than_half_pixel_raises():
    bounds = (WEST, SOUTH, EAST, NORTH - TOL_Y - OVER)
    with pytest.raises(SystemExit):
        check_dtm_covers(bounds, RES)


def test_negative_res_handled_via_abs():
    # abs(res[0]) / 2 == TOL_X regardless of sign; a negative-res raster
    # (e.g. a north-down affine) must tolerate the same slack as positive res.
    neg_res = (-RES[0], -RES[1])
    bounds = (WEST + TOL_X, SOUTH + TOL_Y, EAST - TOL_X, NORTH - TOL_Y)
    check_dtm_covers(bounds, neg_res)


def test_negative_res_still_raises_beyond_slack():
    neg_res = (-RES[0], -RES[1])
    bounds = (WEST + TOL_X + OVER, SOUTH, EAST, NORTH)
    with pytest.raises(SystemExit):
        check_dtm_covers(bounds, neg_res)
