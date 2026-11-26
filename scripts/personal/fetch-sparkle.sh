#!/bin/bash
set -euo pipefail
output="${1:?usage: fetch-sparkle.sh <new output directory>}"
[[ "$output" == /* && ! -e "$output" ]] || { echo 'A new absolute tool directory is required.' >&2; exit 1; }
mkdir -p "$output"
curl --fail --location --retry 3 --proto '=https' -o "$output/tools.tar.xz" https://github.com/sparkle-project/Sparkle/releases/download/2.9.6/Sparkle-2.9.6.tar.xz
[[ "$(shasum -a 256 "$output/tools.tar.xz" | awk '{ print $1 }')" == 52bf9e88cdd972fc0c81501377a880e90d47031bd8ca5462488f843e2609e192 ]] || { echo 'Sparkle tools do not match the pinned digest.' >&2; exit 1; }
tar -xJf "$output/tools.tar.xz" -C "$output" bin Sparkle.framework
rm "$output/tools.tar.xz"
