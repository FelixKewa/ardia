#!/usr/bin/env bash
# The engine's identity on one platform: one hash of every file that platform's engine is built from. Prebuilt engines
# are published and looked up under it (packages/ardiacore/prebuilt-engines.tsv for macOS,
# packages/ardiacore/prebuilt-engines-linux.tsv for Linux).
#
#   engine/engine-key.sh [--platform macos|linux] [<commit>]   the key of <commit> (default HEAD); fails if the commit
#                                                              lacks engine/ or the offline game
#   engine/engine-key.sh [--platform macos|linux] --paths      the paths the key covers in this checkout, one per line,
#                                                              relative to the repository
#
# A key covers engine/, apps/browser/assets/offline-game and its pipeline, minus what the platform never builds: the
# lines of engine/patches/series marked for the other platform (their patches, and their layers but for the files a
# layer of this platform copies from them), engine/engine-key.* and the build scripts' tests
# (engine/patches/build/tests). The series counts as the lines that apply, so a
# line for the other platform changes neither its patch's key nor the series'. Files a layer's apply.sh copies from
# outside engine/ ($here/../..) count too. --platform defaults to AC_TARGET_OS (mac or linux), else this machine's OS.
set -euo pipefail

roots=(engine apps/browser/assets/offline-game apps/browser/assets/offline-game-pipeline)
die() { echo "engine-key: $*" >&2; exit 1; }
platform="" mode=key commit=HEAD
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    --paths) mode=paths ;;
    --platform) [ $# -gt 1 ] || die "--platform takes macos or linux"; platform="$2"; shift ;;
    --platform=*) platform="${1#--platform=}" ;;
    -*) die "unknown option $1 (--help)" ;;
    *) commit="$1" ;;
  esac
  shift
done
if [ -z "$platform" ]; then
  platform="${AC_TARGET_OS:-}"
fi
if [ -z "$platform" ]; then
  case "$(uname -s)" in
    Darwin) platform=mac ;;
    Linux) platform=linux ;;
    *) die "no engine is built on $(uname -s): pass --platform macos or --platform linux" ;;
  esac
fi
case "$platform" in
  mac | macos) platform=mac ;;
  linux) ;;
  *) die "unknown platform $platform: macos or linux" ;;
esac
root="$(cd "$(dirname "$0")/.." && pwd -P)"

series_plan() {
  awk -v platform="$platform" '
    { sub(/#.*/, "") }
    NF == 0 { next }
    {
      selector = NF >= 3 ? $3 : "all"
      if (selector == "all" || selector == platform) print "step", $1, $2
      else if ($1 == "layer") print "skip-layer", $2
      else print "skip-patch", "engine/patches/" $2
    }'
}

borrowed_from() {
  local layer="$1"
  { grep -oE '\$\{?here\}?/\.\./[A-Za-z0-9_./+-]*' || true; } | sed -E 's#^\$\{?here\}?/##' | awk -v base="$layer" '
    {
      count = split(base "/" $0, parts, "/")
      depth = 0
      for (i = 1; i <= count; i++) {
        if (parts[i] == "..") { if (depth > 0) depth-- }
        else if (parts[i] != "." && parts[i] != "") kept[++depth] = parts[i]
      }
      path = ""
      for (i = 1; i <= depth; i++) path = path (i > 1 ? "/" : "") kept[i]
      if ($0 ~ /\/$/ && path != "") path = path "/"
      print path
    }'
}

if [ "$mode" = paths ]; then
  plan="$( [ ! -f "$root/engine/patches/series" ] || series_plan <"$root/engine/patches/series")"
  printf '%s\n' "${roots[@]}"
  while read -r kind step_kind name; do
    [ "$kind" = step ] && [ "$step_kind" = layer ] && [ -f "$root/$name/apply.sh" ] || continue
    borrowed_from "$name" <"$root/$name/apply.sh"
  done <<<"$plan" | while read -r path; do
    case "$path" in engine | engine/* | apps/browser/assets/offline-game | apps/browser/assets/offline-game/* | apps/browser/assets/offline-game-pipeline | apps/browser/assets/offline-game-pipeline/*) continue ;; esac
    path="${path%/}"
    while [ -n "$path" ] && [ ! -e "$root/$path" ]; do
      case "$path" in */*) path="${path%/*}" ;; *) path="" ;; esac
    done
    [ -z "$path" ] || echo "$path"
  done | sort -u
  exit 0
fi

g() { git -C "$root" "$@"; }
g rev-parse --verify --quiet "$commit^{tree}" >/dev/null || die "$commit isn't a commit or tree"
for path in "${roots[@]}"; do
  g rev-parse --verify --quiet "$commit:$path" >/dev/null || die "$commit has no $path"
done
plan=""
if series_id="$(g rev-parse --verify --quiet "$commit:engine/patches/series")"; then
  plan="$(g cat-file blob "$series_id" | series_plan)"
fi
borrowed="$(while read -r kind step_kind name; do
  [ "$kind" = step ] && [ "$step_kind" = layer ] || continue
  apply_id="$(g rev-parse --verify --quiet "$commit:$name/apply.sh")" || continue
  g cat-file blob "$apply_id" | borrowed_from "$name"
done <<<"$plan" | sort -u)"
outside=()
while read -r path; do
  [ -n "$path" ] || continue
  case "$path" in engine | engine/* | apps/browser/assets/offline-game | apps/browser/assets/offline-game/* | apps/browser/assets/offline-game-pipeline | apps/browser/assets/offline-game-pipeline/*) continue ;; esac
  case "$path" in */*) outside+=("${path%/*}") ;; *) outside+=("$path") ;; esac
done <<<"$borrowed"
files="$(g ls-tree -r --full-tree "$commit" -- "${roots[@]}" ${outside[@]+"${outside[@]}"} | PLAN="$plan" BORROWED="$borrowed" awk -F '\t' '
  BEGIN {
    count = split(ENVIRON["PLAN"], lines, "\n")
    for (i = 1; i <= count; i++) {
      split(lines[i], field, " ")
      if (field[1] == "skip-layer") skip_layers[++layers] = field[2] "/"
      else if (field[1] == "skip-patch") skip_patches[field[2]] = 1
    }
    borrows = split(ENVIRON["BORROWED"], prefixes, "\n")
  }
  {
    path = $2
    split($1, entry, " ")
    lent = 0
    for (i = 1; i <= borrows; i++) if (prefixes[i] != "" && index(path, prefixes[i]) == 1) lent = 1
    if (path !~ /^(engine|apps\/browser\/assets\/offline-game|apps\/browser\/assets\/offline-game-pipeline)\// && !lent) next
    if (path ~ /^engine\/(engine-key\.|patches\/build\/tests\/)/ || path == "engine/patches/series" || (path in skip_patches)) next
    for (i = 1; i <= layers; i++) if (index(path, skip_layers[i]) == 1 && !lent) next
    print entry[1], entry[3], path
  }')"
{
  echo "platform $platform"
  printf '%s\n' "$plan" | awk '$1 == "step" { print $2, $3 }'
  printf '%s\n' "$files"
} | g hash-object --stdin
