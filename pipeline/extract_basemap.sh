#!/usr/bin/env bash
# Extract the regional basemap from the Protomaps daily build.
# Usage: pipeline/extract_basemap.sh [YYYYMMDD]  (default: yesterday's build)
set -euo pipefail
cd "$(dirname "$0")"

BUILD_DATE="${1:-$(date -u -d yesterday +%Y%m%d)}"
BBOX="9.4,54.3,11.0,55.3"          # min_lon,min_lat,max_lon,max_lat
MAXZOOM=13                          # ~25 MB; z14 ≈ 2x, z15 (full) ≈ 91 MB (measured 2026-07-14)
PMTILES_VERSION="1.31.1"
BIN=bin/pmtiles

if [ ! -x "$BIN" ]; then
  mkdir -p bin
  echo "installing pmtiles CLI v${PMTILES_VERSION}..."
  curl -sL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" \
    | tar xz -C bin pmtiles
fi

"$BIN" extract "https://build.protomaps.com/${BUILD_DATE}.pmtiles" \
  ../app/public/data/basemap.pmtiles \
  --bbox="$BBOX" --maxzoom="$MAXZOOM"

echo "--- verify ---"
"$BIN" show ../app/public/data/basemap.pmtiles
