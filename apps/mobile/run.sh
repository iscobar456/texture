#!/usr/bin/env bash
# Runs the app on a connected phone with Supabase settings from apps/mobile/.env.
# Picks the first physical Android/iOS device (else an emulator/simulator); never the
# web or desktop targets. Extra arguments go to `flutter run`, e.g. ./run.sh --release.
# Pass -d to choose the target yourself (./run.sh -d chrome for the web version).
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Missing apps/mobile/.env (copy .env.example and fill it in)" >&2; exit 1; }
command -v flutter >/dev/null || export PATH="$HOME/flutter/bin:$PATH"
# Silences the Java 25 native-access warning from the Gradle launcher.
export GRADLE_OPTS="${GRADLE_OPTS:-} --enable-native-access=ALL-UNNAMED"

for a in "$@"; do
  case "$a" in -d|--device-id|-d=*|--device-id=*) exec flutter run --dart-define-from-file=.env "$@" ;; esac
done

device=$(flutter devices --machine 2>/dev/null | python3 -c '
import json, sys
devs = [d for d in json.load(sys.stdin)
        if d["targetPlatform"].startswith(("android", "ios"))]
devs.sort(key=lambda d: d["emulator"])  # physical first
print(devs[0]["id"] if devs else "")
')
if [ -z "$device" ]; then
  echo "No phone found. Connect one with USB debugging on (check with: flutter devices)," >&2
  echo "or pass -d to pick another target, e.g. ./run.sh -d chrome" >&2
  exit 1
fi
exec flutter run -d "$device" --dart-define-from-file=.env "$@"
