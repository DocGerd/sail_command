#!/usr/bin/env bash
# Extract the regional basemap from the Protomaps daily build.
#
# Usage:
#   pipeline/extract_basemap.sh [YYYYMMDD] [--region <id> <min_lon,min_lat,max_lon,max_lat>] [--out-dir <dir>]
#
# Without --region: the CORE archive (basemap.pmtiles.png, bbox below).
# With --region: a lazy region archive, region-<id>.pmtiles.png (#1164/#295).
# The build date defaults to yesterday's UTC build; --out-dir defaults to
# app/public/data/ (a region archive written there enters the next build's
# region manifest).
set -euo pipefail
cd "$(dirname "$0")"

BUILD_DATE="$(date -u -d yesterday +%Y%m%d)"
if [ $# -gt 0 ] && [[ "$1" != --* ]]; then
  BUILD_DATE="$1"
  shift
fi

REGION_ID=""
REGION_BBOX=""
OUT_DIR="../app/public/data"
while [ $# -gt 0 ]; do
  case "$1" in
    --region)
      [ $# -ge 3 ] || { echo "--region needs <id> <bbox>" >&2; exit 2; }
      REGION_ID="$2"
      REGION_BBOX="$3"
      shift 3
      ;;
    --out-dir)
      [ $# -ge 2 ] || { echo "--out-dir needs <dir>" >&2; exit 2; }
      OUT_DIR="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

CORE_BBOX="9.4,54.3,11.0,55.3"      # min_lon,min_lat,max_lon,max_lat
MAXZOOM=13                          # ~25 MB; z14 ≈ 2x, z15 (full) ≈ 91 MB (measured 2026-07-14)
PMTILES_VERSION="1.31.1"
BIN=bin/pmtiles

if [ -z "$REGION_ID" ]; then
  BBOX="$CORE_BBOX"
  OUT_NAME="basemap.pmtiles.png"
  MIN_BYTES=$((10*1024*1024))
else
  # Must match vite.config.ts's REGION_ARCHIVE_FILENAME_RE, or the build fails.
  [[ "$REGION_ID" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "bad region id: $REGION_ID" >&2; exit 2; }
  NUM='-?[0-9]+(\.[0-9]+)?'
  [[ "$REGION_BBOX" =~ ^$NUM,$NUM,$NUM,$NUM$ ]] || { echo "bad bbox: $REGION_BBOX" >&2; exit 2; }
  BBOX="$REGION_BBOX"
  OUT_NAME="region-${REGION_ID}.pmtiles.png"
  MIN_BYTES=$((100*1024))
fi
OUT="${OUT_DIR}/${OUT_NAME}"

if [ ! -x "$BIN" ]; then
  mkdir -p bin
  echo "installing pmtiles CLI v${PMTILES_VERSION}..."
  curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" \
    | tar xz -C bin pmtiles
fi

# The .png suffix is DELIBERATE (#118): GitHub Pages/Fastly gzip-compresses
# application/octet-stream Range responses into un-inflatable fragments;
# image/png is served identity with true 206s. This is NOT a PNG — it is a
# PMTiles archive masquerading as one. Do NOT "fix" the extension.
# A region shares the core's MAXZOOM: the composite protocol advertises the
# core header's zoom range for every tile (compositeBasemapProtocol.ts).
"$BIN" extract "https://build.protomaps.com/${BUILD_DATE}.pmtiles" \
  "$OUT" \
  --bbox="$BBOX" --maxzoom="$MAXZOOM"

SIZE=$(stat -c%s "$OUT")
[ "$SIZE" -gt "$MIN_BYTES" ] || { echo "basemap suspiciously small: $SIZE bytes" >&2; exit 1; }

echo "--- verify ---"
"$BIN" show "$OUT"
