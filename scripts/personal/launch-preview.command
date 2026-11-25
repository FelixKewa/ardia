#!/bin/bash
set -euo pipefail

preview_root="$(cd "$(dirname "$0")" && pwd -P)"
preview_app="$preview_root/Ardia.app"
preview_temp="$(getconf DARWIN_USER_TEMP_DIR)"
[[ -d "$preview_temp" && "$(stat -f %u "$preview_temp")" == "$(id -u)" ]] || { echo "The private user temporary folder is unavailable." >&2; exit 1; }
preview_data="${preview_temp%/}/ardia-webkit-preview-profile"
[[ -d "$preview_app" ]] || { echo "Ardia.app must be next to this launcher." >&2; exit 1; }
umask 077
if [[ -e "$preview_data" || -L "$preview_data" ]]; then
  [[ -d "$preview_data" && ! -L "$preview_data" && "$(stat -f %u "$preview_data")" == "$(id -u)" ]] || { echo "The preview profile is not a private folder." >&2; exit 1; }
else
  mkdir -m 700 "$preview_data"
fi
chmod 700 "$preview_data"
printf 'Opening the WebKit preview with a separate temporary profile:\n%s\n' "$preview_data"
open -n --env ARDIA_DATA_DIR="$preview_data" "$preview_app"
