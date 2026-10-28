#!/usr/bin/env bash
# #1894 §6 pooled rerun. Usage: SC_DATA=<data dir> run.sh fetch|analyse
# SC_DATA holds npz4/track{A..D}.npz, npz6/trackS0{0..3}.npz and wind4/ (the past_days cache);
# outputs go to $SC_DATA/wind_hist and $SC_DATA/run6. Tracks and outputs are never committed.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$DIR" rev-parse --show-toplevel)
D=${SC_DATA:?set SC_DATA}; W=$D/wind_hist; O=$D/run6
DOC=docs/spikes/1894-land-wind-shadow.md; SDIR=docs/spikes/1894-land-wind-shadow
ALL="A B C D S00 S01 S02 S03"
trk() { case $1 in S*) echo "$D/npz6/track$1.npz";; *) echo "$D/npz4/track$1.npz";; esac; }
echo "driver pid $$"

# §6 freeze: scripts (tree) and static inputs (blobs) as committed at HEAD; the doc too for a fetch.
state() {
  git -C "$REPO" rev-parse "HEAD:$SDIR"
  for f in mask.bin mask.meta.json harbors.json polars/salona-44-easy-go-fock.json polars/salona-44-easy-go-genoa.json; do
    git -C "$REPO" rev-parse "HEAD:app/public/data/$f"
  done
}
clean() {
  git -C "$REPO" diff --quiet HEAD -- "$DOC" "$SDIR" app/public/data &&
    [ -z "$(git -C "$REPO" status --porcelain -- "$DOC" "$SDIR" app/public/data)" ]
}
clean || { echo "doc, scripts or static inputs differ from HEAD"; exit 1; }
PY=${SC_PYTHON:-python3}
"$PY" -I -c 'import numpy' 2>/dev/null || { echo "$PY -I cannot import numpy; set SC_PYTHON to an interpreter whose own site-packages hold numpy"; exit 1; }
( cd "$D" && sha256sum -c --quiet "$DIR/inputs.sha256" ) || { echo "track or wind inputs differ from inputs.sha256"; exit 1; }

if [ "$1" = fetch ]; then
  mkdir -p "$W"
  [ -n "$(git -C "$REPO" branch -r --contains HEAD)" ] || { echo "HEAD is not pushed"; exit 1; }
  if [ ! -e "$W/FROZEN_AT" ]; then
    { git -C "$REPO" rev-parse HEAD; git -C "$REPO" rev-parse "HEAD:$DOC"; state; date -u -Is; } > "$W/FROZEN_AT"
  else
    [ "$(sed -n 2,8p "$W/FROZEN_AT")" = "$(git -C "$REPO" rev-parse "HEAD:$DOC"; state)" ] ||
      { echo "doc, scripts or static inputs changed since the freeze"; exit 1; }
  fi
  { echo "--- $(date -u -Is) $(git -C "$REPO" rev-parse HEAD)"; } >> "$W/FETCH_LOG"
  "$PY" -I "$DIR/fetch_hist.py" "$D/wind4/MANIFEST.json" "$W" $(for t in $ALL; do trk $t; done)
  exit 0
fi

[ "$1" = analyse ] || { echo "usage: run.sh fetch|analyse"; exit 2; }
[ -e "$W/FROZEN_AT" ] || { echo "no FROZEN_AT: fetch first"; exit 1; }
[ "$(sed -n 3,8p "$W/FROZEN_AT")" = "$(state)" ] || { echo "scripts or static inputs changed since the freeze"; exit 1; }
[ ! -e "$O" ] || { echo "$O exists; the first complete run binds (§6)"; exit 1; }
mkdir -p "$O"
( cd "$W" && find . -name 'full_app_*.json' | sort | xargs sha256sum ) > "$O/wind_hist.sha256"

# §6.2 drop rule
KEEP=""
for t in $ALL; do
  cov=$("$PY" -I "$DIR/check_coverage.py" "$W/track$t" "$(trk $t)")
  echo "{\"trip\":\"$t\",\"cov\":$cov}" >> "$O/coverage.jsonl"
  drop=$(printf '%s' "$cov" | "$PY" -I -c 'import json,sys; print(int(json.load(sys.stdin)["drop"]))')
  if [ "$drop" = 1 ]; then echo "DROPPED $t" | tee -a "$O/dropped.txt"; else KEEP="$KEEP $t"; fi
done
K26=$(for t in $KEEP; do case $t in S*) ;; *) printf '%s ' "$t";; esac; done)
K25=$(for t in $KEEP; do case $t in S*) printf '%s ' "$t";; esac; done)
if [ -n "$K26" ]; then
  "$PY" -I "$DIR/compare_sources.py" "$W" "$D/wind4" $(for t in $K26; do trk $t; done) > "$O/source_agreement.json"
fi

# trips.json per table run: index order = kept trips, 2026 then 2025
meta() { # $1 sail for 2025 trips
  "$PY" -I - "$1" $(for t in $KEEP; do echo "$t=$(trk $t)"; done) <<'PY'
import datetime as dt, json, sys
import numpy as np
s25, out = sys.argv[1], {}
for i, a in enumerate(sys.argv[2:]):
    name, path = a.split("=", 1)
    t0 = float(np.load(path)["t"].min())
    out[str(i)] = dict(sail=s25 if name.startswith("S") else "fock", cohort="2025" if name.startswith("S") else "2026",
                       ym=dt.datetime.fromtimestamp(t0, dt.timezone.utc).strftime("%Y-%m"))
print(json.dumps(out))
PY
}

per() { # $1 run tag, $2 trip, $3 sail, $4 cap ("" = §0's own)
  local dir=$O/per_$1/$2
  mkdir -p "$dir/in"; cp "$(trk $2)" "$dir/in/"
  SC_SAIL=$3 SC_LEG_R_MAX=$4 "$PY" -I "$DIR/samples.py" "$REPO" "$dir/in" "$W/track$2" full_app "$dir/samples_app.npz" > "$dir/app.log"
  SC_SAIL=$3 SC_LEG_R_MAX=$4 "$PY" -I "$DIR/samples.py" "$REPO" "$dir/in" "$W/track$2" full_app "$dir/samples_app_strict.npz" strict > "$dir/strict.log"
}
merged() { # $1 out dir, then run_tag:trip pairs
  local od=$1; shift; mkdir -p "$od"
  for set in app app_strict; do
    "$PY" -I "$DIR/merge_trips.py" "$od/samples_$set.npz" $(for x in "$@"; do echo "$O/per_${x%%:*}/${x#*:}/samples_$set.npz"; done) > /dev/null
  done
  "$PY" -I "$DIR/rays.py" "$REPO" "$od/samples_app.npz" "$od/rays_app.npz" > "$od/rays_app.log"
  "$PY" -I "$DIR/rays.py" "$REPO" "$od/samples_app_strict.npz" "$od/rays_strict.npz" > "$od/rays_strict.log"
}
for t in $K26; do per main "$t" fock 1.2; per old26 "$t" fock ""; done
for t in $K25; do per main "$t" genoa 1.2; per fock25 "$t" fock 1.2; done

# decision runs: 2025 trips under the genoa table, then under the fock table (§6.3)
merged "$O/genoa" $(for t in $KEEP; do echo "main:$t"; done)
meta genoa > "$O/genoa/trips.json"
merged "$O/fock" $(for t in $K26; do echo "main:$t"; done) $(for t in $K25; do echo "fock25:$t"; done)
meta fock > "$O/fock/trips.json"
for r in genoa fock; do
  "$PY" -I "$DIR/results6.py" "$O/$r/samples_app.npz" "$O/$r/samples_app_strict.npz" "$O/$r/rays_app.npz" \
    "$O/$r/rays_strict.npz" "$O/$r/trips.json" "$O/$r/results6.json" > "$O/$r/results6.log"
done
"$PY" -I "$DIR/decide.py" "$O/genoa/results6.json" "$O/fock/results6.json" "$O/decision.json" > /dev/null

# reported alongside: 2026 trips under the historical wind with §0's own rules (against §1.3/§1.9)
if [ -n "$K26" ]; then
  mkdir -p "$O/old26"
  for set in app app_strict; do
    "$PY" -I "$DIR/merge_trips.py" "$O/old26/samples_$set.npz" $(for t in $K26; do echo "$O/per_old26/$t/samples_$set.npz"; done) > /dev/null
    "$PY" -I "$DIR/results.py" "$O/old26/samples_$set.npz" "$O/old26/results_$set.json" > "$O/old26/results_$set.log"
  done
fi
# polar check (§0.6): fock cells from the 2026 trips; report-only genoa level for the 2025 trips
mkdir -p "$O/polar"
"$PY" -I - "$O" <<'PY'
import json, sys
import numpy as np
O = sys.argv[1]
z = dict(np.load(f"{O}/genoa/samples_app.npz"))
trips = json.load(open(f"{O}/genoa/trips.json"))
for coh in ("2026", "2025"):
    keep = np.isin(z["trip"], [int(k) for k, v in trips.items() if v["cohort"] == coh])
    if keep.any():
        np.savez(f"{O}/polar/{coh}.npz", **{k: v[keep] for k, v in z.items()})
PY
for c in 2026 2025; do
  if [ -e "$O/polar/$c.npz" ]; then
    "$PY" -I "$DIR/results.py" "$O/polar/$c.npz" "$O/polar/$c.json" > "$O/polar/$c.log"
  fi
done
echo ALLDONE
